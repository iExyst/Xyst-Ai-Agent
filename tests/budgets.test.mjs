import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunBudgetChange, sanitizeRunBudgetAdjustments, validateRunBudgetChange } from '../src/core/budgets.mjs';

test('run budget changes validate supported fields, numeric domains, and final-response relationships', () => {
  assert.deepEqual(validateRunBudgetChange({ max_turns: 12, max_session_cost: 1.25 }), {
    max_turns: 12,
    max_session_cost: 1.25,
  });
  assert.deepEqual(validateRunBudgetChange({ recovery_summary_input_tokens: 0 }), { recovery_summary_input_tokens: 0 });
  assert.throws(() => validateRunBudgetChange({ unexpected: 1 }), /not a supported setting/);
  assert.throws(() => validateRunBudgetChange({ max_output_tokens: 1.5 }), /positive integer/);
  assert.throws(() => validateRunBudgetChange({ max_daily_cost: Number.POSITIVE_INFINITY }), /non-negative number/);
  assert.throws(
    () => validateRunBudgetChange({ max_output_tokens: 400, final_response_reserve_tokens: 400 }),
    /smaller than max_output_tokens/,
  );
  assert.throws(() => validateRunBudgetChange({}), /at least one supported setting/);
});

test('run budget patches reset to run-start values and validate the merged settings', () => {
  const initial = { max_output_tokens: 2_000, max_session_cost: 3 };
  const current = { ...initial, max_turns: 12, final_response_reserve_tokens: 400 };
  assert.deepEqual(resolveRunBudgetChange(initial, current, { max_output_tokens: 1_000 }), {
    max_output_tokens: 1_000,
    max_session_cost: 3,
    max_turns: 12,
    final_response_reserve_tokens: 400,
  });
  assert.deepEqual(resolveRunBudgetChange(initial, current, { max_turns: null, max_session_cost: null }), {
    max_output_tokens: 2_000,
    max_session_cost: 3,
    final_response_reserve_tokens: 400,
  });
  assert.throws(() => resolveRunBudgetChange(initial, current, { max_output_tokens: 300 }), /smaller than max_output_tokens/);
  assert.deepEqual(resolveRunBudgetChange(initial, current, { max_output_tokens: 300, final_response_reserve_tokens: 100 }), {
    max_output_tokens: 300,
    max_session_cost: 3,
    max_turns: 12,
    final_response_reserve_tokens: 100,
  });
});

test('budget adjustment history is rebuilt from allowlisted numeric fields', () => {
  const updatedAt = '2026-10-22T12:00:00.000Z';
  const safe = sanitizeRunBudgetAdjustments([
    {
      updated_at: updatedAt,
      requested: { max_output_tokens: 1_000, credential: 'access_token=do-not-persist' },
      effective: { max_output_tokens: 1_000, credential: 'access_token=do-not-persist' },
    },
    {
      updated_at: 'not-a-date',
      requested: { max_output_tokens: 1_000 },
      effective: { max_output_tokens: 1_000 },
    },
  ]);
  assert.deepEqual(safe, [
    {
      updated_at: updatedAt,
      requested: { max_output_tokens: 1_000 },
      effective: { max_output_tokens: 1_000 },
    },
  ]);
  assert.equal(JSON.stringify(safe).includes('do-not-persist'), false);
});
