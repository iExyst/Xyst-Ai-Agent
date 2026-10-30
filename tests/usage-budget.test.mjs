import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTempDirectory } from './helpers.mjs';
import { UsageBudgetStore } from '../src/session/usage-budget.mjs';

const execFileAsync = promisify(execFile);

for (const [field, metric] of [
  ['max_daily_input_tokens', 'inputTokens'],
  ['max_daily_output_tokens', 'outputTokens'],
  ['max_monthly_input_tokens', 'inputTokens'],
  ['max_monthly_output_tokens', 'outputTokens'],
  ['max_daily_cost', 'costUsd'],
  ['max_monthly_cost', 'costUsd'],
])
  test(`${field} enforces pending and settled usage and responds to a changed limit`, async (t) => {
    const root = await createTempDirectory('xyst-individual-shared-cap-');
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new UsageBudgetStore(root);
    const amount = (value) => ({ inputTokens: 0, outputTokens: 0, costUsd: 0, [metric]: value });
    const limits = { [field]: 10 };
    const first = await store.reserve({ ...amount(6), limits });
    const boundary = await store.reserve({ ...amount(4), limits });
    await assert.rejects(store.reserve({ ...amount(1), limits }), { code: 'BUDGET_EXCEEDED' });
    await store.settle(first, amount(6));
    await store.settle(boundary, amount(0));
    await assert.rejects(store.reserve({ ...amount(5), limits }), { code: 'BUDGET_EXCEEDED' });
    const raised = await store.reserve({ ...amount(5), limits: { [field]: 20 } });
    await store.settle(raised, amount(0));
    assert.equal(await store.reserve({ ...amount(100), limits: {} }), null, 'removing the cap restores uncapped reservations');
  });

test('usage ledger restores one validated atomic-replacement backup instead of resetting totals', async (t) => {
  const root = await createTempDirectory('xyst-usage-budget-backup-recovery-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const store = new UsageBudgetStore(root);
  const reservation = await store.reserve({
    inputTokens: 17,
    outputTokens: 4,
    costUsd: 0.02,
    limits: { max_daily_input_tokens: 100 },
    now,
  });
  await store.settle(reservation, { inputTokens: 17, outputTokens: 4, costUsd: 0.02, now });
  const backup = `${store.file}.00000000-0000-4000-8000-000000000001.bak`;
  await fs.rename(store.file, backup);

  const snapshot = await store.snapshot({ now });
  assert.equal(snapshot.daily.input_tokens, 17);
  assert.equal(snapshot.daily.output_tokens, 4);
  assert.equal(snapshot.active_reservations, 0);
  await assert.rejects(fs.lstat(backup), { code: 'ENOENT' });
});

test('usage ledger preserves ambiguous replacement backups and refuses an empty reset', async (t) => {
  const root = await createTempDirectory('xyst-usage-budget-backup-ambiguous-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  const store = new UsageBudgetStore(root);
  const reservation = await store.reserve({
    inputTokens: 17,
    outputTokens: 4,
    costUsd: 0.02,
    limits: { max_daily_input_tokens: 100 },
    now,
  });
  await store.settle(reservation, { inputTokens: 17, outputTokens: 4, costUsd: 0.02, now });
  const first = `${store.file}.00000000-0000-4000-8000-000000000001.bak`;
  const second = `${store.file}.00000000-0000-4000-8000-000000000002.bak`;
  await fs.rename(store.file, first);
  await fs.copyFile(first, second);

  await assert.rejects(store.snapshot({ now }), { code: 'ATOMIC_WRITE_RECOVERY_REQUIRED' });
  assert.equal(await fs.readFile(first, 'utf8'), await fs.readFile(second, 'utf8'));
  await assert.rejects(fs.lstat(store.file), { code: 'ENOENT' });
});

test('usage ledger reads stop at the configured size limit plus one byte during concurrent growth', async (t) => {
  const root = await createTempDirectory('xyst-usage-budget-bounded-read-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const now = Date.parse('2026-10-27T12:00:00.000Z');
  await store.snapshot({ now });

  const probe = await fs.open(store.file, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const read = fileHandlePrototype.read;
  let bytesRead = 0;
  fileHandlePrototype.read = async (buffer, offset, length) => {
    buffer.fill(0, offset, offset + length);
    bytesRead += length;
    return { bytesRead: length, buffer };
  };
  try {
    await assert.rejects(store.snapshot({ now }), /Usage budget ledger is not a bounded regular file/);
    assert.equal(bytesRead, 4 * 1024 * 1024 + 1);
  } finally {
    fileHandlePrototype.read = read;
  }
  assert.ok((await fs.stat(store.file)).isFile());
});

test('usage ledger write failure preserves committed totals, releases its lock, and permits retry', async (t) => {
  const root = await createTempDirectory('xyst-usage-budget-write-failure-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const now = Date.parse('2026-10-28T12:00:00.000Z');
  const firstReservation = await store.reserve({ inputTokens: 2, outputTokens: 1, limits: { max_daily_input_tokens: 100 }, now });
  await store.settle(firstReservation, { inputTokens: 2, outputTokens: 1, now });
  const committedRecord = await fs.readFile(store.file, 'utf8');

  const probe = await fs.open(path.join(root, 'probe'), 'w');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const writeFile = fileHandlePrototype.writeFile;
  let writeCount = 0;
  fileHandlePrototype.writeFile = async function (...args) {
    writeCount += 1;
    if (writeCount === 2) throw Object.assign(new Error('simulated usage ledger write failure'), { code: 'EIO' });
    return writeFile.apply(this, args);
  };
  try {
    await assert.rejects(store.reserve({ inputTokens: 3, outputTokens: 0, limits: { max_daily_input_tokens: 100 }, now }), { code: 'EIO' });
  } finally {
    fileHandlePrototype.writeFile = writeFile;
  }

  assert.equal(await fs.readFile(store.file, 'utf8'), committedRecord);
  assert.deepEqual(await fs.readdir(path.dirname(store.file)), ['budgets.json']);
  const retry = await store.reserve({ inputTokens: 3, outputTokens: 0, limits: { max_daily_input_tokens: 100 }, now });
  await store.settle(retry, { inputTokens: 3, outputTokens: 0, now });
  const snapshot = await store.snapshot({ now });
  assert.equal(snapshot.daily.input_tokens, 5);
  assert.equal(snapshot.daily.output_tokens, 1);
  assert.equal(snapshot.active_reservations, 0);
});

test('usage budget waits for an existing lock file instead of failing on Windows sharing errors', async (t) => {
  const root = await createTempDirectory('xyst-usage-budget-existing-lock-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root, { lockWaitMs: 60 });
  await fs.mkdir(path.dirname(store.lock), { recursive: true });
  await fs.writeFile(store.lock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));

  await assert.rejects(store.snapshot(), { code: 'BUDGET_LEDGER_LOCKED' });
  await assert.rejects(fs.access(store.file), { code: 'ENOENT' });
});

test('usage budget lock cleanup preserves a replacement lock owned by another writer', async (t) => {
  const root = await createTempDirectory('xyst-usage-budget-lock-replacement-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const rename = fs.rename;
  let replaced = false;
  let replacementUnavailable;
  fs.rename = async (source, destination) => {
    const result = await rename(source, destination);
    if (!replaced && path.resolve(destination) === path.resolve(store.file)) {
      try {
        await fs.rm(store.lock);
        await fs.writeFile(store.lock, 'replacement budget writer lock');
        replaced = true;
      } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) replacementUnavailable = error.code;
        else throw error;
      }
    }
    return result;
  };
  try {
    await store.reserve({ inputTokens: 1, outputTokens: 0, limits: { max_daily_input_tokens: 10 } });
  } finally {
    fs.rename = rename;
  }
  if (replacementUnavailable) return t.skip(`Open lock replacement is unavailable: ${replacementUnavailable}`);
  assert.equal(replaced, true);
  assert.equal(await fs.readFile(store.lock, 'utf8'), 'replacement budget writer lock');
});

test('daily reservations enforce the shared cap across independent processes', async (t) => {
  const root = await createTempDirectory('xyst-usage-budget-processes-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/session/usage-budget.mjs', import.meta.url).href;
  const worker = `
    import { UsageBudgetStore } from ${JSON.stringify(moduleUrl)};
    const store = new UsageBudgetStore(process.argv[1]);
    try {
      const id = await store.reserve({ inputTokens: 10, outputTokens: 0, limits: { max_daily_input_tokens: 30 } });
      process.stdout.write(JSON.stringify({ reserved: true, id }));
    } catch (error) {
      if (error.code !== 'BUDGET_EXCEEDED') throw error;
      process.stdout.write(JSON.stringify({ reserved: false }));
    }
  `;
  const results = await Promise.all(
    Array.from({ length: 8 }, async () => {
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', worker, root], {
        windowsHide: true,
        timeout: 20_000,
      });
      return JSON.parse(stdout);
    }),
  );
  assert.equal(results.filter((result) => result.reserved).length, 3);
  assert.equal(results.filter((result) => !result.reserved).length, 5);
  const snapshot = await new UsageBudgetStore(root).snapshot();
  assert.equal(snapshot.reserved_daily.input_tokens, 30);
  assert.equal(snapshot.active_reservations, 3);
});

test('daily reservations account for concurrent calls and settle actual usage', async (t) => {
  const root = await createTempDirectory('xyst-usage-budget-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const limits = { max_daily_input_tokens: 10 };
  const sessionId = 'ed05ab01-e7d3-4ca2-9391-0fdbd9f7267d';
  const reservations = await Promise.allSettled([
    store.reserve({ inputTokens: 6, outputTokens: 0, limits, sessionId, model: 'local-coder' }),
    store.reserve({ inputTokens: 6, outputTokens: 0, limits, sessionId, model: 'local-coder' }),
  ]);
  assert.equal(reservations.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(reservations.filter((entry) => entry.status === 'rejected' && entry.reason.code === 'BUDGET_EXCEEDED').length, 1);
  const id = reservations.find((entry) => entry.status === 'fulfilled').value;
  await store.settle(id, {
    inputTokens: 4,
    outputTokens: 0,
    costUsd: 0,
    inputTokenSource: 'provider_reported',
    outputTokenSource: 'provider_reported',
  });
  const next = await store.reserve({ inputTokens: 6, outputTokens: 0, limits });
  assert.ok(next);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.daily.input_tokens, 4);
  assert.equal(snapshot.reserved_daily.input_tokens, 6);
  assert.equal(snapshot.reserved_monthly.input_tokens, 6);
  assert.equal(snapshot.active_reservations, 1);
  assert.equal(snapshot.attribution.daily.by_session[sessionId].input_tokens, 4);
  assert.equal(snapshot.attribution.daily.by_model['local-coder'].input_tokens_by_source.provider_reported, 4);
});

test('settlement records provider overruns and blocks further shared usage under concurrent reservations', async (t) => {
  const root = await createTempDirectory('xyst-usage-overrun-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const limits = {
    max_daily_input_tokens: 10,
    max_monthly_input_tokens: 10,
    max_daily_cost: 0.2,
    max_monthly_cost: 0.2,
  };
  const first = await store.reserve({ inputTokens: 4, outputTokens: 0, costUsd: 0.08, limits });
  const second = await store.reserve({ inputTokens: 6, outputTokens: 0, costUsd: 0.12, limits });
  await assert.rejects(store.settle(first, { inputTokens: 8, outputTokens: 0, costUsd: 0.16, inputTokenSource: 'provider_reported' }), {
    code: 'BUDGET_EXCEEDED',
  });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.daily.input_tokens, 8, 'actual provider usage must be retained when over budget');
  assert.equal(snapshot.daily.cost_usd, 0.16);
  assert.equal(snapshot.reserved_daily.input_tokens, 6, 'the other in-flight request must remain reserved');
  assert.equal(snapshot.active_reservations, 1, 'the settled overrun reservation must be released');
  await assert.rejects(store.reserve({ inputTokens: 1, outputTokens: 0, costUsd: 0.01, limits }), { code: 'BUDGET_EXCEEDED' });
  await store.settle(second, { inputTokens: 2, outputTokens: 0, costUsd: 0.04 });
});

test('settlement records actual cost above a shared cap and rejects subsequent reservations', async (t) => {
  const root = await createTempDirectory('xyst-usage-cost-overrun-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const limits = { max_daily_cost: 0.2, max_monthly_cost: 0.2 };
  const reservation = await store.reserve({ inputTokens: 20, outputTokens: 0, costUsd: 0.1, limits });
  await assert.rejects(store.settle(reservation, { inputTokens: 5, outputTokens: 0, costUsd: 0.25 }), { code: 'BUDGET_EXCEEDED' });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.daily.cost_usd, 0.25);
  assert.equal(snapshot.active_reservations, 0);
  await assert.rejects(store.reserve({ inputTokens: 1, outputTokens: 0, costUsd: 0.01, limits }), { code: 'BUDGET_EXCEEDED' });
});

test('settlement refuses malformed persisted reservation limits without recording usage', async (t) => {
  const root = await createTempDirectory('xyst-usage-invalid-limits-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const now = Date.UTC(2026, 9, 22, 12);
  const reservation = await store.reserve({
    inputTokens: 10,
    outputTokens: 2,
    costUsd: 0.1,
    limits: { max_daily_input_tokens: 100 },
    now,
  });
  const ledger = JSON.parse(await fs.readFile(store.file, 'utf8'));
  ledger.reservations[reservation].limits.max_daily_input_tokens = '100';
  await fs.writeFile(store.file, JSON.stringify(ledger));

  await assert.rejects(store.settle(reservation, { inputTokens: 7, outputTokens: 1, costUsd: 0.07, now }), {
    code: 'BUDGET_LEDGER_INVALID',
  });
  const snapshot = await store.snapshot({ now });
  assert.equal(snapshot.daily.input_tokens, 0);
  assert.equal(snapshot.daily.cost_usd, 0);
  assert.equal(snapshot.active_reservations, 1);
});

test('usage attribution accepts configured model identifiers up to the provider configuration limit', async (t) => {
  const root = await createTempDirectory('xyst-usage-model-name-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const model = 'm'.repeat(200);
  await store.recordUsage({ model, inputTokens: 1, outputTokens: 0, costUsd: null });
  const snapshot = await store.snapshot();
  assert.equal(snapshot.attribution.daily.by_model[model].input_tokens, 1);
});

test('usage reporting retains per-day, model, and session attribution with reported-versus-estimated token sources', async (t) => {
  const root = await createTempDirectory('xyst-usage-attribution-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const sessionId = '9b1b061e-3f04-4a03-91df-59f79be2ac70';
  const date = Date.UTC(2026, 9, 21, 16);
  await store.recordUsage({
    sessionId,
    model: 'local-coder',
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.001,
    inputTokenSource: 'provider_reported',
    outputTokenSource: 'provider_reported',
    now: date,
  });
  await store.recordUsage({
    sessionId,
    model: 'local-coder',
    inputTokens: 25,
    outputTokens: 7,
    costUsd: null,
    inputTokenSource: 'estimated',
    outputTokenSource: 'estimated',
    now: date,
  });

  const snapshot = await store.snapshot({ now: date });
  assert.equal(snapshot.daily.input_tokens, 125);
  assert.equal(snapshot.daily.output_tokens, 27);
  assert.equal(snapshot.attribution.daily.input_tokens_by_source.provider_reported, 100);
  assert.equal(snapshot.attribution.daily.input_tokens_by_source.estimated, 25);
  assert.equal(snapshot.attribution.daily.output_tokens_by_source.provider_reported, 20);
  assert.equal(snapshot.attribution.daily.output_tokens_by_source.estimated, 7);
  assert.equal(snapshot.attribution.daily.estimated_cost_usd, 0.001);
  assert.equal(snapshot.attribution.daily.unknown_cost_calls, 1);
  assert.deepEqual(snapshot.attribution.daily.by_model['local-coder'], snapshot.attribution.daily.by_session[sessionId]);
  assert.equal(snapshot.attribution.days[0].date, '2026-10-21');
  assert.equal(snapshot.attribution.days[0].by_session[sessionId].input_tokens, 125);
});

test('cached input usage is aggregated for daily, monthly, and model/session reports', async (t) => {
  const root = await createTempDirectory('xyst-usage-cache-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const sessionId = '9b1b061e-3f04-4a03-91df-59f79be2ac70';
  const now = Date.UTC(2026, 9, 21, 16);
  const reservation = await store.reserve({ inputTokens: 10, outputTokens: 3, limits: { max_daily_input_tokens: 100 }, now });
  await store.settle(reservation, {
    inputTokens: 8,
    outputTokens: 2,
    cachedInputTokens: 5,
    sessionId,
    model: 'local-coder',
    inputTokenSource: 'provider_reported',
    outputTokenSource: 'provider_reported',
    now,
  });
  await store.recordUsage({
    inputTokens: 4,
    outputTokens: 1,
    cachedInputTokens: 0,
    sessionId,
    model: 'local-coder',
    now,
  });
  const snapshot = await store.snapshot({ now });
  assert.equal(snapshot.daily.cached_input_tokens, 5);
  assert.equal(snapshot.daily.cache_usage_calls, 2);
  assert.equal(snapshot.daily.cache_hit_calls, 1);
  assert.equal(snapshot.daily.cache_miss_calls, 1);
  assert.equal(snapshot.monthly.cached_input_tokens, 5);
  assert.equal(snapshot.monthly.cache_hit_calls, 1);
  assert.equal(snapshot.monthly.cache_miss_calls, 1);
  assert.equal(snapshot.attribution.daily.cached_input_tokens, 5);
  assert.equal(snapshot.attribution.daily.cache_usage_calls, 2);
  assert.equal(snapshot.attribution.daily.cache_hit_calls, 1);
  assert.equal(snapshot.attribution.daily.cache_miss_calls, 1);
  assert.equal(snapshot.attribution.daily.by_model['local-coder'].cached_input_tokens, 5);
  assert.equal(snapshot.attribution.daily.by_session[sessionId].cache_usage_calls, 2);
  await assert.rejects(store.recordUsage({ inputTokens: 2, outputTokens: 0, cachedInputTokens: 3, now }), /no greater than input tokens/);
});

test('usage snapshots upgrade existing aggregate-only ledgers without changing their totals', async (t) => {
  const root = await createTempDirectory('xyst-usage-legacy-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.agent', 'usage');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, 'budgets.json'),
    JSON.stringify({
      version: 1,
      days: { '2026-10-21': { input_tokens: 40, output_tokens: 8, cost_usd: 0.02 } },
      months: { '2026-10': { input_tokens: 40, output_tokens: 8, cost_usd: 0.02 } },
      reservations: {},
    }),
  );
  const snapshot = await new UsageBudgetStore(root).snapshot({ now: Date.UTC(2026, 9, 21) });
  assert.equal(snapshot.daily.input_tokens, 40);
  assert.equal(snapshot.daily.output_tokens, 8);
  assert.equal(snapshot.daily.cost_usd, 0.02);
  assert.equal(snapshot.daily.cached_input_tokens, 0);
  assert.equal(snapshot.daily.cache_usage_calls, 0);
  assert.deepEqual(snapshot.attribution.daily.by_model, {});
  assert.deepEqual(snapshot.attribution.daily.by_session, {});
  assert.equal(snapshot.attribution.days[0].date, '2026-10-21');
  assert.equal(snapshot.attribution.days[0].input_tokens, 40);
  assert.equal(snapshot.attribution.days[0].estimated_cost_usd, 0.02);
  assert.equal(snapshot.attribution.days[0].cached_input_tokens, 0);
  assert.equal(snapshot.attribution.days[0].attribution_available, false);
});

test('monthly caps span daily rollover and reject costs with unknown pricing', async (t) => {
  const root = await createTempDirectory('xyst-usage-budget-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const id = await store.reserve({
    inputTokens: 8,
    outputTokens: 0,
    costUsd: 0.1,
    limits: { max_monthly_input_tokens: 10, max_monthly_cost: 1 },
    now: Date.UTC(2026, 0, 15, 23),
  });
  await store.settle(id, { inputTokens: 8, outputTokens: 0, costUsd: 0.1, now: Date.UTC(2026, 0, 15, 23) });
  await assert.rejects(
    store.reserve({
      inputTokens: 3,
      outputTokens: 0,
      costUsd: 0.1,
      limits: { max_monthly_input_tokens: 10 },
      now: Date.UTC(2026, 0, 16, 0, 1),
    }),
    { code: 'BUDGET_EXCEEDED' },
  );
  await assert.rejects(
    store.reserve({ inputTokens: 1, outputTokens: 0, costUsd: null, limits: { max_daily_cost: 1 } }),
    /configured input and output prices/,
  );
});

test('expired reservations are charged conservatively before a later reservation', async (t) => {
  const root = await createTempDirectory('xyst-usage-budget-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new UsageBudgetStore(root);
  const now = Date.UTC(2026, 4, 2, 12);
  await store.reserve({ inputTokens: 5, outputTokens: 2, costUsd: 0.25, limits: { max_daily_input_tokens: 10 }, now });
  await assert.rejects(
    store.reserve({ inputTokens: 6, outputTokens: 0, limits: { max_daily_input_tokens: 10 }, now: now + 16 * 60 * 1000 }),
    { code: 'BUDGET_EXCEEDED' },
  );
  const snapshot = await store.snapshot({ now: now + 16 * 60 * 1000 });
  assert.equal(snapshot.daily.input_tokens, 5);
  assert.equal(snapshot.active_reservations, 0);
  assert.equal(snapshot.reserved_daily.input_tokens, 0);
});
