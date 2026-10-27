import test from 'node:test';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { sessionPromptHistory } from '../src/cli/interactive-history.mjs';

test('session prompt history is bounded, unique, newest-first, and strips terminal controls', () => {
  const session = {
    messages: [
      { role: 'user', content: 'first request' },
      { role: 'assistant', content: 'response' },
      { role: 'user', content: 'second request\u001b[2J' },
      { role: 'user', content: 'first request' },
      { role: 'user', content: { text: 'multimodal payload' } },
      { role: 'user', content: '   ' },
      { role: 'tool', content: 'tool output' },
    ],
  };
  assert.deepEqual(sessionPromptHistory(session), ['first request', 'second request[2J']);
  assert.deepEqual(sessionPromptHistory(session, 1), ['first request']);
  assert.throws(() => sessionPromptHistory(session, -1), /history limit/);
});

test('session prompt history does not read beyond its bounded recent-message window', () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({ role: 'user', content: `prompt-${index}` }));
  assert.deepEqual(sessionPromptHistory({ messages }, 3), ['prompt-4', 'prompt-3', 'prompt-2']);
});

test('readline receives the saved prompts in arrow-up history order', () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  const output = new PassThrough();
  output.isTTY = true;
  output.columns = 80;
  const terminal = readline.createInterface({
    input,
    output,
    terminal: true,
    history: sessionPromptHistory({
      messages: [
        { role: 'user', content: 'older' },
        { role: 'user', content: 'newer' },
      ],
    }),
    historySize: 100,
    removeHistoryDuplicates: true,
  });
  try {
    assert.deepEqual(terminal.history, ['newer', 'older']);
  } finally {
    terminal.close();
  }
});
