import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMcpResultType } from '../src/tools/mcp-protocol.mjs';

test('MCP result type validation accepts complete and legacy results', () => {
  const complete = { resultType: 'complete', content: [] };
  const implicitComplete = { content: [] };
  assert.equal(validateMcpResultType(complete, { protocolVersion: '2026-07-28', method: 'tools/call' }), complete);
  assert.throws(
    () => validateMcpResultType(implicitComplete, { protocolVersion: '2026-07-28', serverName: 'fixture', method: 'tools/call' }),
    { code: 'MCP_INVALID_RESPONSE' },
  );
  assert.equal(validateMcpResultType(implicitComplete, { protocolVersion: '2025-11-25', method: 'tools/call' }), implicitComplete);
  assert.equal(validateMcpResultType({ resultType: 'task' }, { protocolVersion: '2025-11-25' }).resultType, 'task');
});

test('MCP tool-call results validate content blocks and standard flags', () => {
  const result = {
    resultType: 'complete',
    isError: false,
    content: [
      { type: 'text', text: 'ok' },
      { type: 'image', data: 'Zm9v', mimeType: 'image/png' },
      { type: 'audio', data: 'Zm9v', mimeType: 'audio/wav' },
      { type: 'resource_link', uri: 'file:///workspace/a.txt', name: 'a.txt' },
      { type: 'resource', resource: { uri: 'file:///workspace/a.txt', text: 'contents' } },
    ],
    structuredContent: { answer: 'ok' },
  };
  assert.equal(validateMcpResultType(result, { protocolVersion: '2026-07-28', serverName: 'fixture', method: 'tools/call' }), result);
  for (const invalid of [
    { resultType: 'complete', content: [{ type: 'text', text: 1 }] },
    { resultType: 'complete', content: [{ type: 'image', data: 'abc' }] },
    { resultType: 'complete', content: [{ type: 'resource', resource: { uri: 'file:///workspace/a.txt', blob: 42 } }] },
    { resultType: 'complete', content: [], isError: 'false' },
  ]) {
    assert.throws(() => validateMcpResultType(invalid, { protocolVersion: '2026-07-28', serverName: 'fixture', method: 'tools/call' }), {
      code: 'MCP_INVALID_RESPONSE',
    });
  }
  assert.throws(
    () => validateMcpResultType({ resultType: 'complete' }, { protocolVersion: '2025-11-25', serverName: 'fixture', method: 'tools/call' }),
    { code: 'MCP_INVALID_RESPONSE' },
  );
});

test('MCP result type validation rejects unsupported control flow and unknown modern results', () => {
  for (const [resultType, code] of [
    ['input_required', 'MCP_INTERACTIVE_INPUT_UNSUPPORTED'],
    ['task', 'MCP_TASK_UNSUPPORTED'],
    ['future-control-flow', 'MCP_INVALID_RESPONSE'],
  ]) {
    assert.throws(
      () => validateMcpResultType({ resultType }, { protocolVersion: '2026-07-28', serverName: 'fixture', method: 'tools/call' }),
      { code },
    );
  }
});
