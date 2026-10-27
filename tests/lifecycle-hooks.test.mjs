import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleHookRunner } from '../src/extensions/lifecycle-hooks.mjs';
import { validateConfig } from '../src/config/load.mjs';

test('lifecycle hooks receive bounded JSON over stdin with argv and safe environment', async () => {
  let observed;
  const runner = new LifecycleHookRunner({
    config: { tools: { shell_enabled: true }, hooks: { pre_tool: { command: 'node', args: ['hook.js'], timeout_ms: 2500 } } },
    workspaceRoot: 'C:\\workspace',
    processRunner: async (command, args, options) => {
      observed = { command, args, options };
      return { exitCode: 0, truncated: false };
    },
  });
  await runner.run('pre_tool', { tool: 'write_file', tool_call_id: 'call-1' }, { sessionId: 'session-1', required: true });
  assert.equal(observed.command, 'node');
  assert.deepEqual(observed.args, ['hook.js']);
  assert.deepEqual(JSON.parse(observed.options.input), {
    schema_version: 1,
    event: 'pre_tool',
    session_id: 'session-1',
    tool: 'write_file',
    tool_call_id: 'call-1',
  });
  assert.equal(observed.options.timeoutMs, 2500);
  assert.equal(observed.options.maxOutputBytes, 8192);
  assert.equal(observed.options.maxInputBytes, 65536);
  assert.equal(observed.options.env.API_KEY, undefined);
});

test('required hook failure blocks and reports without exposing process output', async () => {
  const events = [];
  const runner = new LifecycleHookRunner({
    config: { tools: { shell_enabled: true }, hooks: { pre_model: { command: 'hook' } } },
    workspaceRoot: 'C:\\workspace',
    processRunner: async () => ({ exitCode: 4, stderr: 'private output', truncated: false }),
    emit: (event) => events.push(event),
  });
  await assert.rejects(runner.run('pre_model', { model: 'local' }, { sessionId: 's', required: true }), {
    code: 'LIFECYCLE_HOOK_FAILED',
  });
  assert.deepEqual(events, [{ type: 'hook_failed', session_id: 's', hook_event: 'pre_model', code: 'HOOK_EXIT_NONZERO' }]);
});

test('advisory hook failures are reported and never turn a completed action into a failure', async () => {
  const events = [];
  const runner = new LifecycleHookRunner({
    config: { tools: { shell_enabled: true }, hooks: { post_tool: { command: 'hook' } } },
    workspaceRoot: 'C:\\workspace',
    processRunner: async () => ({ exitCode: 0, truncated: true }),
    emit: (event) => events.push(event),
  });
  await assert.doesNotReject(runner.run('post_tool', { tool: 'write_file' }, { sessionId: 's' }));
  assert.deepEqual(events, [{ type: 'hook_failed', session_id: 's', hook_event: 'post_tool', code: 'HOOK_OUTPUT_TOO_LARGE' }]);
});

test('required sandbox routes hooks through isolated process runner', async () => {
  let observed;
  const runner = new LifecycleHookRunner({
    config: { sandbox: { mode: 'required' }, tools: { shell_enabled: true }, hooks: { post_tool: { command: 'hook' } } },
    workspaceRoot: 'C:\\workspace',
    isolatedRunner: async (command, args, options) => {
      observed = { command, args, options };
      return { exitCode: 0, truncated: false };
    },
  });
  await runner.run('post_tool', { tool: 'read_file' });
  assert.equal(observed.command, 'hook');
  assert.equal(observed.options.workspaceRoot, 'C:\\workspace');
});

test('hook configuration is opt-in, bounded, and only available to authorized users', () => {
  assert.doesNotThrow(() =>
    validateConfig({ hooks: { pre_tool: { command: 'node', args: ['hook.js'], timeout_ms: 1000 } }, tools: { shell_enabled: true } }),
  );
  assert.throws(
    () => validateConfig({ hooks: { pre_tool: { command: 'node', timeout_ms: 10_001 } }, tools: { shell_enabled: true } }),
    /timeout_ms/,
  );
  assert.throws(() => validateConfig({ hooks: { pre_tool: { command: 'node' } } }), /authorization/);
});
