import test from 'node:test';
import assert from 'node:assert/strict';
import { writeRuntimeEvent } from '../src/cli/terminal-events.mjs';
import { createTerminalTheme } from '../src/cli/terminal-theme.mjs';

function capture() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    streams: { stdout: { write: (text) => stdout.push(text) }, stderr: { write: (text) => stderr.push(text) } },
  };
}

test('CLI runtime events show tool lifecycle and sanitize model/tool text before terminal output', () => {
  const output = capture();
  writeRuntimeEvent({ type: 'tool_started', tool: 'read_file\u001b[2J' }, output.streams);
  writeRuntimeEvent(
    {
      type: 'model_fallback',
      from_model: 'primary\u001b[2J',
      to_model: 'backup',
      cause: 'CONNECTION_FAILED',
      reason: 'configured fallback 1 after primary',
    },
    output.streams,
  );
  writeRuntimeEvent(
    { type: 'tool_finished', tool: 'edit_file', duration_ms: 2.6, applied_hunks: ['h1', 'h2'], summary: 'Applied the file edit.' },
    output.streams,
  );
  writeRuntimeEvent({ type: 'assistant_delta', text: 'answer\u001b]52;c;payload\u0007' }, output.streams);
  writeRuntimeEvent({ type: 'tool_failed', tool: 'run_process', message: 'failed\u001b[31m\u0007' }, output.streams);

  assert.match(output.stderr.join(''), /read_file\[2J started/);
  assert.match(
    output.stderr.join(''),
    /Model fallback · primary \[2J → backup · provider connection failed · configured fallback 1 after primary/,
  );
  assert.match(output.stderr.join(''), /edit_file finished in 3 ms \(2 diff hunks applied\) — Applied the file edit\./);
  assert.match(output.stderr.join(''), /run_process: failed\[31m/);
  assert.match(output.stdout.join(''), /answer\]52;c;payload/);
  assert.doesNotMatch(`${output.stdout.join('')}${output.stderr.join('')}`, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
});

test('CLI tool summaries are bounded, redacted, and sanitized before display', () => {
  const output = capture();
  writeRuntimeEvent(
    { type: 'tool_finished', tool: 'mcp__private__fetch', duration_ms: 4, summary: `key=private-value ${'x'.repeat(600)}\u001b[31m` },
    output.streams,
  );
  const message = output.stderr.join('');
  assert.match(message, /key=\[REDACTED\]/);
  assert.doesNotMatch(message, /private-value/);
  assert.doesNotMatch(message, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
  assert.ok(message.length < 350);
});

test('CLI runtime events use the Xyst palette only on an enabled interactive terminal', () => {
  const output = capture();
  const streams = {
    stdout: { isTTY: true, write: (text) => output.stdout.push(text) },
    stderr: { isTTY: true, write: (text) => output.stderr.push(text) },
  };
  writeRuntimeEvent({ type: 'tool_started', tool: 'read_file' }, streams);
  const theme = createTerminalTheme(streams.stderr, process.env);
  assert.equal(output.stderr[0], `${theme.cyan('[tool]')} read_file started\n`);

  const plainTheme = createTerminalTheme({ isTTY: false }, {});
  const noColorTheme = createTerminalTheme({ isTTY: true }, { NO_COLOR: '' });
  assert.equal(plainTheme.lime('ready'), 'ready');
  assert.equal(noColorTheme.cyan('Xyst'), 'Xyst');
});

test('CLI runtime events do not write human-readable output in JSON mode', () => {
  const output = capture();
  writeRuntimeEvent({ type: 'tool_started', tool: 'write_file' }, { ...output.streams, jsonOutput: true });
  writeRuntimeEvent({ type: 'assistant_delta', text: 'response' }, { ...output.streams, jsonOutput: true });
  writeRuntimeEvent({ type: 'run_failed', message: 'request failed' }, { ...output.streams, jsonOutput: true });
  assert.deepEqual(output.stdout, []);
  assert.deepEqual(output.stderr, []);
});

test('CLI shows compaction lifecycle and bounds/redacts failure details', () => {
  const output = capture();
  writeRuntimeEvent({ type: 'compaction_started', trigger_reason: 'context_and_budget' }, output.streams);
  writeRuntimeEvent({ type: 'compaction_finished', archived_messages: 8, retained_messages: 4, duration_ms: 12.6 }, output.streams);
  writeRuntimeEvent(
    { type: 'compaction_failed', code: 'REQUEST_TIMEOUT', message: `key=private-value\u001b[31m ${'x'.repeat(800)}` },
    output.streams,
  );

  const message = output.stderr.join('');
  assert.match(message, /\[compaction\] started \(context and budget limits\)/);
  assert.match(message, /complete: archived 8 messages, kept 4 recent in 13 ms/);
  assert.match(message, /failed \(REQUEST_TIMEOUT\): key=\[REDACTED\] x{0,500}/);
  assert.doesNotMatch(message, /private-value/);
  assert.doesNotMatch(message, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
});

test('CLI shows bounded run failures with secret redaction and terminal-control sanitization', () => {
  const output = capture();
  writeRuntimeEvent({ type: 'run_failed', message: `Provider failed\u001b[31m api_key=private-value ${'x'.repeat(2500)}` }, output.streams);

  const message = output.stderr.join('');
  assert.match(message, /^\[run error\] Provider failed\[31m api_key=\[REDACTED\] x{0,2000}\n$/);
  assert.doesNotMatch(message, /private-value/);
  assert.doesNotMatch(message, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);
  assert.ok(message.length < 2050);
});
