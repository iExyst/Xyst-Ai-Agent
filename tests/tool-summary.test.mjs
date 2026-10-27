import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolResult } from '../src/core/tool-summary.mjs';

test('tool summaries expose metadata without copying file or process output', () => {
  assert.equal(summarizeToolResult('read_file', { content: 'secret line\nanother line' }), 'Read 2 lines (24 bytes).');
  assert.equal(summarizeToolResult('write_file', { path: 'C:/private/file', bytes_written: 12, status: 'written' }), 'Wrote 12 bytes.');
  assert.equal(
    summarizeToolResult('run_process', { exitCode: 0, stdout: 'private output', stderr: '' }),
    'Process exited 0; 14 stdout bytes, 0 stderr bytes.',
  );
  assert.equal(
    summarizeToolResult('run_process', { exitCode: 0, stdout: '', stderr: '', stdinErrorCode: 'EPIPE' }),
    'Process exited 0; 0 stdout bytes, 0 stderr bytes; stdin error EPIPE.',
  );
  assert.equal(summarizeToolResult('mcp__server__tool', { value: 'private result' }), 'Completed; result is in the conversation.');
});

test('tool summaries handle malformed values and cap reported status to known values', () => {
  assert.equal(summarizeToolResult('read_file', '{bad json'), 'Completed; result is in the conversation.');
  assert.equal(
    summarizeToolResult('delegate_task', { status: 'private attacker text', changed_paths: ['a', 'b'] }),
    'Child task finished; 2 changed paths reported.',
  );
});
