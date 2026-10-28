import test from 'node:test';
import assert from 'node:assert/strict';
import { formatModelFallbackActivity } from '../src/core/model-fallback.mjs';

test('model fallback activity explains the failure and route without exposing controls or credentials', () => {
  const activity = formatModelFallbackActivity({
    from_model: 'local\u001b[2J api_key=private-canary',
    to_model: 'remote',
    cause: 'CONNECTION_FAILED',
    reason: 'configured fallback 1 after local',
  });

  assert.equal(
    activity,
    'Model fallback · local [2J api_key=[REDACTED] → remote · provider connection failed · configured fallback 1 after local',
  );
  assert.doesNotMatch(activity, /private-canary|[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(activity.length < 500);
});

test('model fallback activity bounds malformed labels and gives unknown causes a safe explanation', () => {
  const activity = formatModelFallbackActivity({ from_model: 'x'.repeat(1000), to_model: 'backup', cause: 'unexpected error' });

  assert.match(activity, /provider request failed/);
  assert.ok(activity.length < 300);
});
