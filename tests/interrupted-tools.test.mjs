import assert from 'node:assert/strict';
import test from 'node:test';
import { recoverInterruptedToolCalls } from '../src/core/interrupted-tools.mjs';

test('interrupted calls receive an unknown-outcome result without changing completed calls', () => {
  const assistant = {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'completed', function: { name: 'read_file', arguments: '{}' } },
      { id: 'pending', function: { name: 'write_file', arguments: '{}' } },
    ],
  };
  const existingResult = { role: 'tool', tool_call_id: 'completed', content: 'saved result' };
  const laterUser = { role: 'user', content: 'Continue the task.' };
  const original = [assistant, existingResult, laterUser];

  const result = recoverInterruptedToolCalls(original);

  assert.equal(result.recovered, 1);
  assert.deepEqual(result.messages.slice(0, 2), [assistant, existingResult]);
  assert.equal(result.messages[2].role, 'tool');
  assert.equal(result.messages[2].tool_call_id, 'pending');
  const observation = JSON.parse(result.messages[2].content);
  assert.equal(observation.content.outcome, 'unknown');
  assert.match(observation.content.error, /outcome is unknown/);
  assert.equal(result.messages[3], laterUser);

  const repeated = recoverInterruptedToolCalls(result.messages);
  assert.equal(repeated.recovered, 0);
  assert.equal(repeated.messages, result.messages);
});

test('complete and unrelated saved transcripts remain unchanged', () => {
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'done', function: { name: 'read_file' } }] },
    { role: 'tool', tool_call_id: 'done', content: 'saved result' },
    { role: 'assistant', content: 'finished' },
  ];
  const result = recoverInterruptedToolCalls(messages);
  assert.equal(result.recovered, 0);
  assert.equal(result.messages, messages);
});
