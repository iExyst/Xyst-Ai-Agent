import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson, readBoundedFileHandle, restoreAtomicWriteBackup } from '../platform/files.mjs';

const VERSION = 1;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const RESERVATION_TTL_MS = 15 * 60 * 1000;
const MAX_DAILY_SESSION_ATTRIBUTION = 100;
const MAX_MONTHLY_SESSION_ATTRIBUTION = 400;
const MAX_MODEL_ATTRIBUTION = 128;
const SHARED_LIMIT_FIELDS = [
  'max_daily_input_tokens',
  'max_daily_output_tokens',
  'max_monthly_input_tokens',
  'max_monthly_output_tokens',
  'max_daily_cost',
  'max_monthly_cost',
];

/** Cross-process daily/monthly usage ledger with conservative in-flight reservations. */
export class UsageBudgetStore {
  constructor(stateRoot, { lockWaitMs = 10_000 } = {}) {
    this.directory = path.join(stateRoot, '.agent', 'usage');
    this.file = path.join(this.directory, 'budgets.json');
    this.lock = path.join(this.directory, 'budgets.lock');
    this.lockWaitMs = lockWaitMs;
  }

  async reserve({ inputTokens, outputTokens, costUsd = 0, limits = {}, sessionId, model, now = Date.now() } = {}) {
    validateUsage(inputTokens, outputTokens);
    validateAttribution({ sessionId, model, inputTokenSource: 'estimated', outputTokenSource: 'estimated' });
    if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0))
      throw new TypeError('costUsd must be a non-negative number or null');
    const enabled = Object.values(limits).some((value) => value !== undefined);
    if (!enabled) return null;
    const date = new Date(now).toISOString().slice(0, 10);
    const month = date.slice(0, 7);
    const id = randomUUID();
    await this.#mutate((state) => {
      recoverExpiredReservations(state, now);
      const day = (state.days[date] ||= emptyUsage());
      const monthUsage = (state.months[month] ||= emptyUsage());
      const pendingDay = sumReservations(state, 'date', date);
      const pendingMonth = sumReservations(state, 'month', month);
      enforceLimit('daily input token', day.input_tokens + pendingDay.input_tokens + inputTokens, limits.max_daily_input_tokens);
      enforceLimit('daily output token', day.output_tokens + pendingDay.output_tokens + outputTokens, limits.max_daily_output_tokens);
      enforceLimit(
        'monthly input token',
        monthUsage.input_tokens + pendingMonth.input_tokens + inputTokens,
        limits.max_monthly_input_tokens,
      );
      enforceLimit(
        'monthly output token',
        monthUsage.output_tokens + pendingMonth.output_tokens + outputTokens,
        limits.max_monthly_output_tokens,
      );
      const costCaps = [limits.max_daily_cost, limits.max_monthly_cost].filter((value) => value !== undefined);
      if (costCaps.length && costUsd === null)
        throw budgetError('Cost limits require configured input and output prices for the selected model');
      enforceLimit('daily cost', day.cost_usd + pendingDay.cost_usd + costUsd, limits.max_daily_cost);
      enforceLimit('monthly cost', monthUsage.cost_usd + pendingMonth.cost_usd + costUsd, limits.max_monthly_cost);
      state.reservations[id] = {
        date,
        month,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cost_usd: costUsd || 0,
        cost_unknown: costUsd === null,
        limits: Object.fromEntries(
          SHARED_LIMIT_FIELDS.filter((field) => limits[field] !== undefined).map((field) => [field, limits[field]]),
        ),
        session_id: sessionId,
        model,
        expires_at: now + RESERVATION_TTL_MS,
      };
    }, now);
    return id;
  }

  async settle(
    id,
    {
      inputTokens,
      outputTokens,
      cachedInputTokens = null,
      costUsd = 0,
      sessionId,
      model,
      inputTokenSource = 'estimated',
      outputTokenSource = 'estimated',
      now = Date.now(),
    } = {},
  ) {
    validateUsage(inputTokens, outputTokens, cachedInputTokens);
    if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0))
      throw new TypeError('costUsd must be a non-negative number or null');
    return this.#mutate((state) => {
      recoverExpiredReservations(state, now);
      const reservation = state.reservations[id];
      if (!reservation)
        throw Object.assign(new Error('Usage budget reservation is missing or expired'), { code: 'BUDGET_RESERVATION_MISSING' });
      validateReservationLimits(reservation);
      addUsage((state.days[reservation.date] ||= emptyUsage()), inputTokens, outputTokens, costUsd, cachedInputTokens);
      addUsage((state.months[reservation.month] ||= emptyUsage()), inputTokens, outputTokens, costUsd, cachedInputTokens);
      addAttribution(state, reservation.date, reservation.month, {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        costUsd,
        sessionId: sessionId || reservation.session_id,
        model: model || reservation.model,
        inputTokenSource,
        outputTokenSource,
      });
      delete state.reservations[id];
      enforceSettledLimits(state, reservation, costUsd);
    }, now);
  }

  /** Record usage when hard budgets are disabled; reporting never imposes a limit. */
  async recordUsage({
    inputTokens,
    outputTokens,
    cachedInputTokens = null,
    costUsd = null,
    sessionId,
    model,
    inputTokenSource = 'estimated',
    outputTokenSource = 'estimated',
    now = Date.now(),
  } = {}) {
    validateUsage(inputTokens, outputTokens, cachedInputTokens);
    validateAttribution({ sessionId, model, inputTokenSource, outputTokenSource });
    if (costUsd !== null && (!Number.isFinite(costUsd) || costUsd < 0))
      throw new TypeError('costUsd must be a non-negative number or null');
    const date = new Date(now).toISOString().slice(0, 10);
    const month = date.slice(0, 7);
    return this.#mutate((state) => {
      addUsage((state.days[date] ||= emptyUsage()), inputTokens, outputTokens, costUsd, cachedInputTokens);
      addUsage((state.months[month] ||= emptyUsage()), inputTokens, outputTokens, costUsd, cachedInputTokens);
      addAttribution(state, date, month, {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        costUsd,
        sessionId,
        model,
        inputTokenSource,
        outputTokenSource,
      });
    }, now);
  }

  async snapshot({ now = Date.now() } = {}) {
    return this.#mutate(
      (state) => {
        recoverExpiredReservations(state, now);
        const date = new Date(now).toISOString().slice(0, 10);
        const month = date.slice(0, 7);
        return {
          daily: structuredClone(state.days[date] || emptyUsage()),
          monthly: structuredClone(state.months[month] || emptyUsage()),
          attribution: {
            daily: structuredClone(state.attribution.days[date] || emptyAttribution()),
            monthly: structuredClone(state.attribution.months[month] || emptyAttribution()),
            days: Object.entries(state.days)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([day, totals]) => ({
                date: day,
                input_tokens: totals.input_tokens,
                output_tokens: totals.output_tokens,
                cached_input_tokens: totals.cached_input_tokens || 0,
                cache_usage_calls: totals.cache_usage_calls || 0,
                cache_hit_calls: totals.cache_hit_calls || 0,
                cache_miss_calls: totals.cache_miss_calls || 0,
                estimated_cost_usd: totals.cost_usd,
                attribution_available: Boolean(state.attribution.days[day]),
                ...(state.attribution.days[day] ? structuredClone(state.attribution.days[day]) : {}),
              })),
            retention_days: 45,
            truncated: [...Object.values(state.attribution.days), ...Object.values(state.attribution.months)].some(
              (usage) => usage.truncated,
            ),
          },
          reserved_daily: sumReservations(state, 'date', date),
          reserved_monthly: sumReservations(state, 'month', month),
          active_reservations: Object.keys(state.reservations).length,
        };
      },
      now,
      { write: true },
    );
  }

  async #read() {
    try {
      const info = await fs.lstat(this.file, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1n || info.size > BigInt(MAX_FILE_BYTES))
        throw new Error('Usage budget ledger is not a bounded regular file');
      const handle = await fs.open(this.file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.nlink > 1n || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
          throw new Error('Usage budget ledger changed while it was being opened');
        if (opened.size > BigInt(MAX_FILE_BYTES)) throw new Error('Usage budget ledger is not a bounded regular file');
        const bytes = await readBoundedFileHandle(handle, MAX_FILE_BYTES);
        if (bytes === null) throw new Error('Usage budget ledger is not a bounded regular file');
        const [after, current] = await Promise.all([handle.stat({ bigint: true }), fs.lstat(this.file, { bigint: true })]);
        if (!sameUsageFileVersion(opened, after) || !sameUsageFileVersion(opened, current))
          throw new Error('Usage budget ledger changed while it was being read');
        return decodeUsageState(bytes.toString('utf8'));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        const recovered = await restoreAtomicWriteBackup(this.file, { maxBytes: MAX_FILE_BYTES, decode: decodeUsageState });
        return recovered ?? emptyLedger();
      }
      throw error;
    }
  }

  async #mutate(change, now, { write = true } = {}) {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockWaitMs;
    let handle;
    while (!handle && Date.now() <= deadline) {
      try {
        handle = await fs.open(this.lock, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST' && !(await isExistingLockContention(error, this.lock))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    if (!handle)
      throw Object.assign(new Error('Timed out waiting for usage budget ledger lock; inspect .agent/usage/budgets.lock before recovery'), {
        code: 'BUDGET_LEDGER_LOCKED',
      });
    const lockRecord = JSON.stringify({ lock_id: randomUUID(), pid: process.pid, started_at: new Date().toISOString() });
    let lockIdentity;
    try {
      lockIdentity = await handle.stat();
      await handle.writeFile(lockRecord);
      const state = await this.#read();
      let result;
      try {
        result = change(state);
      } catch (error) {
        prunePeriods(state, now);
        const serialized = JSON.stringify(state);
        if (Buffer.byteLength(serialized) <= MAX_FILE_BYTES) await atomicWriteJson(this.file, state, { mode: 0o600 });
        throw error;
      }
      prunePeriods(state, now);
      if (write) {
        const serialized = JSON.stringify(state);
        if (Buffer.byteLength(serialized) > MAX_FILE_BYTES)
          throw Object.assign(new Error('Usage budget ledger exceeded its size limit'), { code: 'BUDGET_LEDGER_LIMIT' });
        await atomicWriteJson(this.file, state, { mode: 0o600 });
      }
      return result;
    } finally {
      await handle.close().catch(() => {});
      if (lockIdentity) {
        const current = await fs.lstat(this.lock).catch(() => null);
        const stableIdentity = Number.isFinite(lockIdentity.ino) && lockIdentity.ino !== 0;
        if (
          current?.isFile() &&
          !current.isSymbolicLink() &&
          (!stableIdentity || (current.dev === lockIdentity.dev && current.ino === lockIdentity.ino))
        ) {
          const currentRecord = await fs.readFile(this.lock, 'utf8').catch(() => null);
          if (currentRecord === lockRecord) await fs.rm(this.lock, { force: true }).catch(() => {});
        }
      }
    }
  }
}

function emptyLedger() {
  return { version: VERSION, days: {}, months: {}, reservations: {}, attribution: { version: 1, days: {}, months: {} } };
}

function sameUsageFileVersion(first, second) {
  return (
    second.isFile() &&
    !second.isSymbolicLink() &&
    second.nlink <= 1n &&
    second.dev === first.dev &&
    second.ino === first.ino &&
    second.size === first.size &&
    second.mtimeNs === first.mtimeNs &&
    second.ctimeNs === first.ctimeNs
  );
}

function decodeUsageState(serialized) {
  const state = JSON.parse(serialized);
  if (state.version !== VERSION || !isRecord(state.days) || !isRecord(state.months) || !isRecord(state.reservations))
    throw new Error('Usage budget ledger is invalid; inspect it before recovery');
  if (state.attribution === undefined) state.attribution = { version: 1, days: {}, months: {} };
  if (
    !isRecord(state.attribution) ||
    state.attribution.version !== 1 ||
    !isRecord(state.attribution.days) ||
    !isRecord(state.attribution.months)
  )
    throw new Error('Usage attribution ledger is invalid; inspect it before recovery');
  migrateCacheMetrics(state);
  return state;
}

async function isExistingLockContention(error, lockPath) {
  // Windows may report EPERM/EACCES instead of EEXIST when another process
  // created the exclusive lock file and still has it open.
  if (process.platform !== 'win32' || !['EACCES', 'EPERM'].includes(error.code)) return false;
  try {
    await fs.lstat(lockPath);
    return true;
  } catch (statError) {
    if (statError.code === 'ENOENT') return false;
    throw statError;
  }
}

function recoverExpiredReservations(state, now) {
  for (const [id, reservation] of Object.entries(state.reservations)) {
    if (!Number.isFinite(reservation.expires_at) || reservation.expires_at > now) continue;
    addUsage((state.days[reservation.date] ||= emptyUsage()), reservation.input_tokens, reservation.output_tokens, reservation.cost_usd);
    addUsage((state.months[reservation.month] ||= emptyUsage()), reservation.input_tokens, reservation.output_tokens, reservation.cost_usd);
    addAttribution(state, reservation.date, reservation.month, {
      inputTokens: reservation.input_tokens,
      outputTokens: reservation.output_tokens,
      costUsd: reservation.cost_unknown ? null : reservation.cost_usd,
      sessionId: reservation.session_id,
      model: reservation.model,
      inputTokenSource: 'estimated',
      outputTokenSource: 'estimated',
    });
    delete state.reservations[id];
  }
}

function sumReservations(state, periodField, period) {
  const total = emptyUsage();
  for (const reservation of Object.values(state.reservations)) {
    if (reservation[periodField] !== period) continue;
    total.input_tokens += reservation.input_tokens;
    total.output_tokens += reservation.output_tokens;
    total.cost_usd += reservation.cost_usd;
  }
  return total;
}

function enforceSettledLimits(state, reservation, costUsd) {
  const limits = reservation.limits || {};
  if (!Object.values(limits).some((value) => value !== undefined)) return;
  const day = state.days[reservation.date] || emptyUsage();
  const month = state.months[reservation.month] || emptyUsage();
  const pendingDay = sumReservations(state, 'date', reservation.date);
  const pendingMonth = sumReservations(state, 'month', reservation.month);
  enforceLimit('daily input token', day.input_tokens + pendingDay.input_tokens, limits.max_daily_input_tokens);
  enforceLimit('daily output token', day.output_tokens + pendingDay.output_tokens, limits.max_daily_output_tokens);
  enforceLimit('monthly input token', month.input_tokens + pendingMonth.input_tokens, limits.max_monthly_input_tokens);
  enforceLimit('monthly output token', month.output_tokens + pendingMonth.output_tokens, limits.max_monthly_output_tokens);
  const hasCostCap = limits.max_daily_cost !== undefined || limits.max_monthly_cost !== undefined;
  if (hasCostCap && costUsd === null) throw budgetError('Actual usage cost is unknown under a configured shared cost cap');
  enforceLimit('daily cost', day.cost_usd + pendingDay.cost_usd, limits.max_daily_cost);
  enforceLimit('monthly cost', month.cost_usd + pendingMonth.cost_usd, limits.max_monthly_cost);
}

function validateReservationLimits(reservation) {
  if (reservation.limits === undefined) return;
  if (!isRecord(reservation.limits)) throw invalidBudgetLedger('A usage reservation has invalid limits');
  for (const [field, value] of Object.entries(reservation.limits)) {
    if (!SHARED_LIMIT_FIELDS.includes(field)) throw invalidBudgetLedger(`A usage reservation contains an unknown limit: ${field}`);
    const valid = field.endsWith('_cost') ? Number.isFinite(value) && value >= 0 : Number.isSafeInteger(value) && value >= 0;
    if (!valid) throw invalidBudgetLedger(`A usage reservation has an invalid ${field} value`);
  }
}

function enforceLimit(label, amount, limit) {
  if (limit !== undefined && amount > limit) throw budgetError(`The ${label} budget is exhausted`);
}

function addUsage(bucket, inputTokens, outputTokens, costUsd, cachedInputTokens = null) {
  bucket.input_tokens += inputTokens;
  bucket.output_tokens += outputTokens;
  if (cachedInputTokens !== null) {
    bucket.cached_input_tokens += cachedInputTokens;
    bucket.cache_usage_calls += 1;
    if (cachedInputTokens > 0) bucket.cache_hit_calls += 1;
    else bucket.cache_miss_calls += 1;
  }
  if (costUsd !== null) bucket.cost_usd += costUsd;
}

function addAttribution(state, date, month, usage) {
  validateAttribution(usage);
  const daily = (state.attribution.days[date] ||= emptyAttribution());
  const monthly = (state.attribution.months[month] ||= emptyAttribution());
  addAttributionBucket(daily, usage, MAX_DAILY_SESSION_ATTRIBUTION);
  addAttributionBucket(monthly, usage, MAX_MONTHLY_SESSION_ATTRIBUTION);
}

function addAttributionBucket(bucket, usage, sessionLimit) {
  bucket.input_tokens += usage.inputTokens;
  bucket.output_tokens += usage.outputTokens;
  bucket.input_tokens_by_source[usage.inputTokenSource] += usage.inputTokens;
  bucket.output_tokens_by_source[usage.outputTokenSource] += usage.outputTokens;
  if (usage.cachedInputTokens != null) {
    bucket.cached_input_tokens += usage.cachedInputTokens;
    bucket.cache_usage_calls += 1;
    if (usage.cachedInputTokens > 0) bucket.cache_hit_calls += 1;
    else bucket.cache_miss_calls += 1;
  }
  if (usage.costUsd === null) bucket.unknown_cost_calls += 1;
  else bucket.estimated_cost_usd += usage.costUsd;
  if (usage.model) addAttributedCounter(bucket.by_model, usage.model, usage, MAX_MODEL_ATTRIBUTION, bucket);
  if (usage.sessionId) addAttributedCounter(bucket.by_session, usage.sessionId, usage, sessionLimit, bucket);
}

function addAttributedCounter(target, key, usage, limit, bucket) {
  const attributionKey = Object.hasOwn(target, key) ? key : Object.keys(target).length < limit ? key : 'other';
  if (attributionKey === 'other' && key !== 'other') bucket.truncated = true;
  if (!Object.hasOwn(target, attributionKey))
    Object.defineProperty(target, attributionKey, {
      value: emptyAttributionCounter(),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  const counter = target[attributionKey];
  counter.input_tokens += usage.inputTokens;
  counter.output_tokens += usage.outputTokens;
  counter.input_tokens_by_source[usage.inputTokenSource] += usage.inputTokens;
  counter.output_tokens_by_source[usage.outputTokenSource] += usage.outputTokens;
  if (usage.cachedInputTokens != null) {
    counter.cached_input_tokens += usage.cachedInputTokens;
    counter.cache_usage_calls += 1;
    if (usage.cachedInputTokens > 0) counter.cache_hit_calls += 1;
    else counter.cache_miss_calls += 1;
  }
  if (usage.costUsd === null) counter.unknown_cost_calls += 1;
  else counter.estimated_cost_usd += usage.costUsd;
}

function validateAttribution({ sessionId, model, inputTokenSource, outputTokenSource }) {
  if (
    sessionId !== undefined &&
    (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionId))
  )
    throw new TypeError('sessionId must be a UUID');
  if (model !== undefined && (typeof model !== 'string' || !model.trim() || model.length > 200))
    throw new TypeError('model must be a non-empty name up to 200 characters');
  if (!['provider_reported', 'estimated'].includes(inputTokenSource)) throw new TypeError('inputTokenSource is invalid');
  if (!['provider_reported', 'estimated'].includes(outputTokenSource)) throw new TypeError('outputTokenSource is invalid');
}

function emptyAttribution() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_usage_calls: 0,
    cache_hit_calls: 0,
    cache_miss_calls: 0,
    input_tokens_by_source: { provider_reported: 0, estimated: 0 },
    output_tokens_by_source: { provider_reported: 0, estimated: 0 },
    estimated_cost_usd: 0,
    unknown_cost_calls: 0,
    by_model: {},
    by_session: {},
    truncated: false,
  };
}

function emptyAttributionCounter() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_usage_calls: 0,
    cache_hit_calls: 0,
    cache_miss_calls: 0,
    input_tokens_by_source: { provider_reported: 0, estimated: 0 },
    output_tokens_by_source: { provider_reported: 0, estimated: 0 },
    estimated_cost_usd: 0,
    unknown_cost_calls: 0,
  };
}

function validateUsage(inputTokens, outputTokens, cachedInputTokens = null) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0)
    throw new TypeError('Usage tokens must be non-negative safe integers');
  if (cachedInputTokens !== null && (!Number.isSafeInteger(cachedInputTokens) || cachedInputTokens < 0 || cachedInputTokens > inputTokens))
    throw new TypeError('Cached input tokens must be a non-negative safe integer no greater than input tokens');
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
    cache_usage_calls: 0,
    cache_hit_calls: 0,
    cache_miss_calls: 0,
    cost_usd: 0,
  };
}

function migrateCacheMetrics(state) {
  for (const periods of [state.days, state.months])
    for (const bucket of Object.values(periods)) {
      bucket.cached_input_tokens ??= 0;
      bucket.cache_usage_calls ??= 0;
      bucket.cache_hit_calls ??= 0;
      bucket.cache_miss_calls ??= 0;
    }
  for (const periods of [state.attribution.days, state.attribution.months])
    for (const bucket of Object.values(periods)) {
      ensureCacheAttribution(bucket);
      for (const collection of [bucket.by_model, bucket.by_session])
        for (const counter of Object.values(collection)) ensureCacheAttribution(counter);
    }
}

function ensureCacheAttribution(bucket) {
  bucket.cached_input_tokens ??= 0;
  bucket.cache_usage_calls ??= 0;
  bucket.cache_hit_calls ??= 0;
  bucket.cache_miss_calls ??= 0;
}
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function budgetError(message) {
  return Object.assign(new Error(message), { code: 'BUDGET_EXCEEDED' });
}
function invalidBudgetLedger(message) {
  return Object.assign(new Error(message), { code: 'BUDGET_LEDGER_INVALID' });
}
function prunePeriods(state, now) {
  const date = new Date(now);
  const cutoff = new Date(date.getTime() - 45 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const monthCutoffDate = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 13, 1));
  const monthCutoff = monthCutoffDate.toISOString().slice(0, 7);
  for (const key of Object.keys(state.days))
    if (key < cutoff && !Object.values(state.reservations).some((item) => item.date === key)) delete state.days[key];
  for (const key of Object.keys(state.months))
    if (key < monthCutoff && !Object.values(state.reservations).some((item) => item.month === key)) delete state.months[key];
  for (const key of Object.keys(state.attribution.days)) if (key < cutoff) delete state.attribution.days[key];
  for (const key of Object.keys(state.attribution.months)) if (key < monthCutoff) delete state.attribution.months[key];
}
