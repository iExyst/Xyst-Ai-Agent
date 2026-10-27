import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetRemainingRows, routingSummary } from '../gui/run-inspector.mjs';

test('routing inspector reports chosen profile, reason, bounded alternatives, and capabilities', () => {
  const summary = routingSummary(
    {
      model: 'local',
      reason: 'configured default model',
      factors: { required_context_tokens: 12_000, required_tools: true, prefer_local: true, strategy: 'balanced' },
      alternatives: Array.from({ length: 12 }, (_, index) => ({
        name: `other-${index}`,
        eligible: index !== 0,
        reason: 'context unavailable',
      })),
    },
    { local: { model: 'coder:8b', provider: 'lm-studio', local: true } },
  );
  assert.equal(summary.profile, 'local');
  assert.equal(summary.model, 'coder:8b');
  assert.equal(summary.locality, 'Local');
  assert.equal(summary.reason, 'configured default model');
  assert.equal(summary.factors.required_tools, true);
  assert.equal(summary.alternatives.length, 8);
  assert.equal(summary.alternatives[0].eligible, false);
});

test('budget inspector subtracts settled usage and in-flight reservations from configured caps', () => {
  const rows = budgetRemainingRows(
    {
      budgets: {
        max_daily_input_tokens: 1000,
        max_daily_cost: 2,
        max_monthly_output_tokens: 5000,
      },
    },
    {
      daily: { input_tokens: 300, output_tokens: 0, cost_usd: 0.25 },
      reserved_daily: { input_tokens: 100, output_tokens: 25, cost_usd: 0.5 },
      monthly: { input_tokens: 0, output_tokens: 1000, cost_usd: 0.2 },
      reserved_monthly: { input_tokens: 0, output_tokens: 250, cost_usd: 0.1 },
    },
  );
  assert.deepEqual(
    rows.map(({ period, label, remaining }) => [period, label, remaining]),
    [
      ['Today', 'Input tokens', 600],
      ['Today', 'Estimated cost', 1.25],
      ['This month', 'Output tokens', 3750],
    ],
  );
});

test('budget inspector handles missing usage and clamps over-cap figures at zero', () => {
  assert.deepEqual(budgetRemainingRows({ budgets: { max_daily_input_tokens: 10 } }, null), []);
  assert.equal(budgetRemainingRows({ budgets: { max_daily_input_tokens: 10 } }, { daily: { input_tokens: 12 } })[0].remaining, 0);
  assert.equal(routingSummary(null), null);
});
