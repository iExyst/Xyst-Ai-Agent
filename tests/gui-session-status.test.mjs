import assert from 'node:assert/strict';
import test from 'node:test';
import { getRememberedSessionId, isInterruptedSession, rememberSessionId } from '../gui/session-status.mjs';

test('interrupted sessions include a persisted assistant tool proposal without its result', () => {
  assert.equal(isInterruptedSession({ status: 'active', last_message_role: 'assistant', last_message_has_tool_calls: true }), true);
});

test('completed assistant responses and live runs are not labeled interrupted', () => {
  assert.equal(isInterruptedSession({ status: 'active', last_message_role: 'assistant', last_message_has_tool_calls: false }), false);
  assert.equal(
    isInterruptedSession({ status: 'active', last_message_role: 'assistant', last_message_has_tool_calls: true }, { running: true }),
    false,
  );
  assert.equal(isInterruptedSession({ status: 'complete', last_message_role: 'assistant', last_message_has_tool_calls: true }), false);
});

test('user and tool tail messages remain recognizable as unfinished turns', () => {
  assert.equal(isInterruptedSession({ status: 'active', last_message_role: 'user' }), true);
  assert.equal(isInterruptedSession({ status: 'active', last_message_role: 'tool' }), true);
});

test('desktop and browser session recovery remembers only a session in the current workspace list', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  rememberSessionId(sessionId, storage);
  assert.equal(getRememberedSessionId([{ id: sessionId }], storage), sessionId);
  assert.equal(getRememberedSessionId([{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], storage), null);
  assert.equal(values.has('xyst.activeSessionId'), false);
  rememberSessionId('not-a-session-id', storage);
  assert.equal(values.has('xyst.activeSessionId'), false);
});
