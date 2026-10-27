import assert from 'node:assert/strict';
import test from 'node:test';
import { validateMcpResultType } from '../src/tools/mcp-protocol.mjs';

test('MCP result type validation accepts complete and legacy results', () => {
  const complete = { resultType: 'complete', content: [] };
  const implicitComplete = { content: [] };
  assert.equal(validateMcpResultType(complete, { protocolVersion: '2026-07-28' }), complete);
  assert.equal(validateMcpResultType(implicitComplete, { protocolVersion: '2026-07-28' }), implicitComplete);
  assert.equal(validateMcpResultType({ resultType: 'task' }, { protocolVersion: '2025-11-25' }).resultType, 'task');
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
