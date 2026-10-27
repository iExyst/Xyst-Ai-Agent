import assert from 'node:assert/strict';
import test from 'node:test';
import { isInterruptedSession } from '../gui/session-status.mjs';

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
