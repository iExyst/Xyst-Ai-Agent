import test from 'node:test';
import assert from 'node:assert/strict';
import { formatActiveGoalsContext, MAX_ACTIVE_GOAL_CONTEXT_BYTES } from '../src/goals/context.mjs';

test('active goal context stays bounded and prioritizes recent active goals', () => {
  const goals = Array.from({ length: 30 }, (_, index) => ({
    id: `goal-${index}`,
    title: `Goal ${index}`,
    details: 'd'.repeat(1_000),
    progress: [],
  }));
  const context = formatActiveGoalsContext(goals);
  const serialized = context.slice(context.indexOf('\n') + 1);
  const included = JSON.parse(serialized);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= MAX_ACTIVE_GOAL_CONTEXT_BYTES);
  assert.ok(included.some((goal) => goal.id === 'goal-29'));
  assert.ok(!included.some((goal) => goal.id === 'goal-0'));
  const indexes = included.map((goal) => Number(goal.id.slice(5)));
  assert.deepEqual(
    indexes,
    [...indexes].sort((a, b) => a - b),
  );
});

test('active goal context labels its contents untrusted and redacts secrets', () => {
  const context = formatActiveGoalsContext([
    {
      id: 'goal-1',
      title: 'Use API_KEY=goal-context-canary',
      details: 'Keep this goal as context only',
      progress: [{ text: 'Confirmed', reference: 'token=goal-context-reference', source: 'user', created_at: '2026-10-21T00:00:00.000Z' }],
    },
  ]);
  assert.match(context, /untrusted user-maintained references/);
  assert.match(context, /\[REDACTED\]/);
  assert.doesNotMatch(context, /goal-context-canary|goal-context-reference/);
});
