import assert from 'node:assert/strict';
import test from 'node:test';
import { withStartupTimeout } from '../gui/startup.mjs';

test('startup requests return their result and do not abort after completing', async () => {
  let requestSignal;
  const result = await withStartupTimeout(
    'runtime health check',
    async (signal) => {
      requestSignal = signal;
      return { status: 'ready' };
    },
    100,
  );

  assert.deepEqual(result, { status: 'ready' });
  assert.equal(requestSignal.aborted, false);
});

test('startup request timeouts abort the request and provide a labeled retry message', async () => {
  let requestSignal;
  await assert.rejects(
    withStartupTimeout(
      'runtime settings',
      (signal) => {
        requestSignal = signal;
        return new Promise(() => {});
      },
      10,
    ),
    (error) => {
      assert.equal(error.name, 'TimeoutError');
      assert.match(error.message, /runtime settings/);
      assert.match(error.message, /Reload Xyst AI Assistant to try again/);
      return true;
    },
  );
  assert.equal(requestSignal.aborted, true);
});

test('startup request failures preserve the original error', async () => {
  const failure = new Error('service rejected the request');
  await assert.rejects(
    withStartupTimeout('runtime health check', () => Promise.reject(failure), 100),
    failure,
  );
});
