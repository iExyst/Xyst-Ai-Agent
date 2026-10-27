export const RUN_BUDGET_FIELDS = Object.freeze([
  'max_turns',
  'max_input_tokens',
  'max_output_tokens',
  'max_tool_output_bytes',
  'max_session_input_tokens',
  'max_session_output_tokens',
  'recovery_summary_input_tokens',
  'final_response_reserve_tokens',
  'max_session_cost',
  'max_daily_input_tokens',
  'max_daily_output_tokens',
  'max_monthly_input_tokens',
  'max_monthly_output_tokens',
  'max_daily_cost',
  'max_monthly_cost',
]);

const runBudgetFieldSet = new Set(RUN_BUDGET_FIELDS);

export function validateRunBudgetChange(budgets, { allowEmpty = false } = {}) {
  if (!isRecord(budgets) || (!allowEmpty && Object.keys(budgets).length === 0))
    throw new TypeError('A budget change must contain at least one supported setting');
  for (const [field, amount] of Object.entries(budgets)) {
    if (!runBudgetFieldSet.has(field)) throw new TypeError(`budgets.${field} is not a supported setting`);
    const isCost = field.endsWith('_cost');
    if (
      amount !== null &&
      (typeof amount !== 'number' ||
        !Number.isFinite(amount) ||
        amount < 0 ||
        (!isCost && (!Number.isSafeInteger(amount) || (field !== 'recovery_summary_input_tokens' && amount < 1) || amount > 1_000_000_000)))
    )
      throw new TypeError(`budgets.${field} must be null or a non-negative ${isCost ? 'number' : 'positive integer'}`);
  }
  if (
    budgets.final_response_reserve_tokens !== undefined &&
    budgets.final_response_reserve_tokens !== null &&
    budgets.max_output_tokens !== undefined &&
    budgets.max_output_tokens !== null &&
    budgets.final_response_reserve_tokens >= budgets.max_output_tokens
  )
    throw new TypeError('budgets.final_response_reserve_tokens must be smaller than max_output_tokens');
  return budgets;
}

/** Resolve a paused run's partial budget edit against its start-of-run settings. */
export function resolveRunBudgetChange(initialBudgets, currentBudgets, requestedBudgets) {
  if (!isRecord(initialBudgets) || !isRecord(currentBudgets)) throw new TypeError('The run budget state is invalid');
  validateRunBudgetChange(requestedBudgets);
  const nextBudgets = { ...currentBudgets };
  for (const [field, value] of Object.entries(requestedBudgets)) {
    if (value === null) {
      if (Object.hasOwn(initialBudgets, field)) nextBudgets[field] = initialBudgets[field];
      else delete nextBudgets[field];
    } else nextBudgets[field] = value;
  }
  if (
    nextBudgets.final_response_reserve_tokens !== undefined &&
    nextBudgets.max_output_tokens !== undefined &&
    nextBudgets.final_response_reserve_tokens >= nextBudgets.max_output_tokens
  )
    throw new TypeError('budgets.final_response_reserve_tokens must be smaller than max_output_tokens');
  return nextBudgets;
}

export function sanitizeRunBudgetAdjustments(value, limit = 31) {
  if (!Array.isArray(value) || !Number.isSafeInteger(limit) || limit < 0) return [];
  if (limit === 0) return [];
  const sanitized = [];
  for (const entry of value.slice(-limit)) {
    if (!isRecord(entry) || typeof entry.updated_at !== 'string' || entry.updated_at.length > 32) continue;
    const updatedAt = new Date(entry.updated_at);
    if (!Number.isFinite(updatedAt.valueOf()) || updatedAt.toISOString() !== entry.updated_at) continue;
    if (!isRecord(entry.requested) || !isRecord(entry.effective)) continue;
    const requested = Object.fromEntries(Object.entries(entry.requested).filter(([field]) => runBudgetFieldSet.has(field)));
    try {
      validateRunBudgetChange(requested);
    } catch {
      continue;
    }
    const effective = {};
    let valid = true;
    for (const field of RUN_BUDGET_FIELDS) {
      if (!Object.hasOwn(entry.effective, field)) continue;
      const amount = entry.effective[field];
      if (
        amount !== null &&
        (typeof amount !== 'number' ||
          !Number.isFinite(amount) ||
          amount < 0 ||
          (!field.endsWith('_cost') && !Number.isSafeInteger(amount)))
      ) {
        valid = false;
        break;
      }
      effective[field] = amount;
    }
    if (valid) sanitized.push({ updated_at: entry.updated_at, requested, effective });
  }
  return sanitized;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
