import test from 'node:test';
import assert from 'node:assert/strict';
import { validateControlApiTerminalEvent } from '../src/api/run-events.mjs';

const UUID = '123e4567-e89b-42d3-a456-426614174000';

test('Control API terminal event validation accepts complete status and bounded failure details', () => {
  assert.equal(validateControlApiTerminalEvent('api_run_finished', { status: 'complete', session_id: UUID }), null);
  assert.equal(validateControlApiTerminalEvent('api_run_finished', { status: 'cancelled', session_id: null }), null);
  assert.equal(
    validateControlApiTerminalEvent('api_run_failed', {
      status: 'failed',
      error: { code: 'PROVIDER_ERROR', message: 'Provider request failed' },
    }),
    null,
  );
});

test('Control API terminal event validation rejects invalid statuses and incomplete payloads', () => {
  assert.match(validateControlApiTerminalEvent('api_run_finished', { status: 'running', session_id: null }), /status/);
  assert.match(validateControlApiTerminalEvent('api_run_finished', { status: 'complete' }), /session_id/);
  assert.match(validateControlApiTerminalEvent('api_run_finished', { status: 'complete', session_id: 'bad' }), /session_id/);
  assert.match(validateControlApiTerminalEvent('api_run_failed', { status: 'budget_exceeded', error: {} }), /status/);
  assert.match(validateControlApiTerminalEvent('api_run_failed', { status: 'failed', error: { code: '', message: 'x' } }), /error/);
  assert.match(
    validateControlApiTerminalEvent('api_run_failed', { status: 'failed', error: { code: 'X', message: 'x'.repeat(4_001) } }),
    /size limits/,
  );
  assert.match(
    validateControlApiTerminalEvent('api_run_finished', { type: 'api_run_failed', status: 'complete', session_id: null }),
    /does not match/,
  );
});
