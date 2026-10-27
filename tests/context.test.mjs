import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareContext, ContextOverflowError } from '../src/core/context.mjs';

test('context trimming removes complete older turns and preserves active tool exchanges', () => {
  const history = [
    { role: 'user', content: 'old'.repeat(500) },
    { role: 'assistant', content: 'old answer'.repeat(500) },
    { role: 'user', content: 'current request' },
    { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'tool result' },
  ];
  const result = prepareContext({ policy: 'policy', memory: 'memory reference', history, maxTokens: 200 });
  assert.equal(result.droppedTurns, 1);
  assert.deepEqual(result.messages.slice(-3), history.slice(-3));
  assert.equal(result.messages[0].role, 'system');
  assert.match(result.messages[1].content, /memory reference/);
});

test('context trimming reports overflow when the active request alone exceeds limit', () => {
  assert.throws(
    () => prepareContext({ policy: 'policy', history: [{ role: 'user', content: 'huge'.repeat(1000) }], maxTokens: 20 }),
    ContextOverflowError,
  );
});

test('context trimming drops automatic retrieval before the active request when space is insufficient', () => {
  const result = prepareContext({
    policy: 'policy',
    retrieval: 'retrieval reference '.repeat(200),
    history: [{ role: 'user', content: 'current request' }],
    maxTokens: 30,
  });
  assert.deepEqual(result.messages.at(-1), { role: 'user', content: 'current request' });
  assert.equal(
    result.messages.some((message) => String(message.content).includes('retrieval reference')),
    false,
  );
});

test('overflow recovery drops oldest complete tool exchanges but preserves the latest and full source history', () => {
  const history = [
    { role: 'user', content: 'Inspect and fix the project.' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"old.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'old-call', content: 'old observation '.repeat(500) },
    {
      role: 'assistant',
      tool_calls: [{ id: 'latest-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"latest.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'latest-call', content: 'latest observation' },
  ];
  const result = prepareContext({ policy: 'policy', history, maxTokens: 250, trimActiveToolHistory: true });
  assert.equal(result.droppedToolCalls, 1);
  assert.equal(
    result.messages.some((message) => message.tool_call_id === 'old-call'),
    false,
  );
  assert.equal(result.messages.at(-2).tool_calls[0].id, 'latest-call');
  assert.equal(result.messages.at(-1).tool_call_id, 'latest-call');
  assert.match(result.messages.map((message) => message.content || '').join('\n'), /Earlier tool exchanges from this request were omitted/);
  assert.equal(history[2].content, 'old observation '.repeat(500), 'context recovery must not mutate the saved transcript');
});

test('overflow recovery preserves tool-call/result pairing and fails when the latest exchange cannot fit', () => {
  const history = [
    { role: 'user', content: 'Continue.' },
    { role: 'assistant', tool_calls: [{ id: 'one', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'one', content: 'first'.repeat(500) },
    { role: 'assistant', tool_calls: [{ id: 'two', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'two', content: 'second' },
  ];
  assert.throws(() => prepareContext({ policy: 'policy', history, maxTokens: 20, trimActiveToolHistory: true }), ContextOverflowError);
  const result = prepareContext({ policy: 'policy', history, maxTokens: 150, trimActiveToolHistory: true });
  assert.equal(result.droppedToolCalls, 1);
  assert.deepEqual(
    result.messages.slice(-2).map((message) => message.tool_call_id || message.tool_calls?.[0]?.id),
    ['two', 'two'],
  );
});

test('provider overflow recovery drops complete active tool exchanges even when the estimate fits', () => {
  const history = [
    { role: 'user', content: 'Follow the chain and report the result.' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'seed-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"seed.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'seed-call', content: 'NEXT=payload.txt' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'payload-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"payload.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'payload-call', content: 'large provider-tokenized payload' },
  ];

  const result = prepareContext({ policy: 'policy', history, maxTokens: 10_000, dropActiveToolHistory: true });

  assert.equal(result.droppedToolCalls, 1);
  assert.equal(
    result.messages.some((message) => message.tool_call_id === 'seed-call'),
    false,
  );
  assert.equal(result.messages.at(-2).tool_calls[0].id, 'payload-call');
  assert.equal(result.messages.at(-1).tool_call_id, 'payload-call');
  assert.match(result.messages.at(-1).content, /Tool result omitted after provider context overflow/);
  assert.equal(result.compactedToolResults, 1);
  assert.match(result.messages[0].content, /Earlier tool exchanges from this request were omitted/);
  assert.equal(history.length, 5, 'provider projection trimming must not mutate the saved transcript');
});

test('provider overflow recovery compacts a single latest tool result even without an older call to drop', () => {
  const history = [
    { role: 'user', content: 'Read the file and summarize it.' },
    {
      role: 'assistant',
      tool_calls: [{ id: 'only-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"large.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'only-call', content: 'large provider-tokenized payload' },
  ];

  const result = prepareContext({ policy: 'policy', history, maxTokens: 10_000, dropActiveToolHistory: true });

  assert.equal(result.droppedToolCalls, 0);
  assert.equal(result.compactedToolResults, 1);
  assert.equal(result.messages.at(-2).tool_calls[0].id, 'only-call');
  assert.equal(result.messages.at(-1).tool_call_id, 'only-call');
  assert.match(result.messages.at(-1).content, /Tool result omitted after provider context overflow/);
});

test('provider overflow recovery compacts every result in one multi-tool exchange', () => {
  const history = [
    { role: 'user', content: 'Read both requested files.' },
    {
      role: 'assistant',
      tool_calls: [
        { id: 'first', type: 'function', function: { name: 'read_file', arguments: '{"path":"first.txt"}' } },
        { id: 'second', type: 'function', function: { name: 'read_file', arguments: '{"path":"second.txt"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'first', content: 'large first result' },
    { role: 'tool', tool_call_id: 'second', content: 'large second result' },
  ];

  const result = prepareContext({ policy: 'policy', history, maxTokens: 10_000, dropActiveToolHistory: true });

  assert.equal(result.compactedToolResults, 2);
  assert.deepEqual(
    result.messages.slice(-2).map((message) => message.tool_call_id),
    ['first', 'second'],
  );
  assert.ok(result.messages.slice(-2).every((message) => /Tool result omitted/.test(message.content)));
});
