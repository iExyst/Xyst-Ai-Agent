import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  isAllowedSmokeProcess,
  isAllowedSmokeShell,
  isAllowedSmokeWrite,
  createFileSmokePrompt,
  liveModelContextLength,
  preflightLmStudioModel,
  validateLiveModelEndpoint,
  validateLiveModelId,
} from '../scripts/smoke-live-model.mjs';
import { createTempDirectory } from './helpers.mjs';
import { isAllowedDelegationWrite, isExpectedDelegationRequest } from '../scripts/smoke-live-delegation.mjs';
import { createOverflowPrompt, planOverflowPayloads } from '../scripts/smoke-live-overflow.mjs';
import { isChatCompletionRequest, readRunEventTypes } from '../scripts/smoke-live-resume.mjs';

test('live model smoke only accepts credential-free HTTP loopback OpenAI-compatible endpoints', () => {
  assert.equal(validateLiveModelEndpoint(undefined), 'http://127.0.0.1:1234/v1');
  assert.equal(validateLiveModelEndpoint('http://[::1]:8080/v1/'), 'http://[::1]:8080/v1');
  assert.throws(() => validateLiveModelEndpoint('https://127.0.0.1:1234/v1'), /unauthenticated HTTP loopback/);
  assert.throws(() => validateLiveModelEndpoint('http://localhost:1234/v1'), /unauthenticated HTTP loopback/);
  assert.throws(() => validateLiveModelEndpoint('http://192.168.1.5:1234/v1'), /unauthenticated HTTP loopback/);
  assert.throws(() => validateLiveModelEndpoint('http://user:secret@127.0.0.1:1234/v1'), /unauthenticated HTTP loopback/);
  assert.throws(() => validateLiveModelEndpoint('http://127.0.0.1:1234/v1?key=secret'), /unauthenticated HTTP loopback/);
  assert.throws(() => validateLiveModelEndpoint('http://127.0.0.1:1234'), /unauthenticated HTTP loopback/);
});

test('live model smoke validates model IDs and approves only its one fixture file', async () => {
  assert.equal(validateLiveModelId(' qwen3-coder '), 'qwen3-coder');
  assert.throws(() => validateLiveModelId(''), /non-empty model ID/);
  assert.throws(() => validateLiveModelId(`x${'a'.repeat(256)}`), /at most 256 characters/);
  const workspace = await createTempDirectory('xyst-live-smoke-policy-');
  const expected = path.join(workspace, 'result.txt');
  assert.equal(isAllowedSmokeWrite(workspace, 'write_file', { path: 'result.txt' }), true);
  assert.equal(isAllowedSmokeWrite(workspace, 'edit_file', { path: expected }), true);
  assert.equal(isAllowedSmokeWrite(workspace, 'write_file', { path: 'second-result.txt' }, ['result.txt', 'second-result.txt']), true);
  assert.equal(isAllowedSmokeWrite(workspace, 'write_file', { path: 'source.txt' }), false);
  assert.equal(isAllowedSmokeWrite(workspace, 'write_file', { path: '../outside.txt' }), false);
  assert.equal(isAllowedSmokeWrite(workspace, 'run_process', { path: 'result.txt' }), false);
  assert.equal(isAllowedSmokeWrite(workspace, 'write_file', { path: '' }), false);
});

test('live delegation smoke approves only the exact child task and one expected child file', () => {
  const task = 'Create delegated-result.txt and verify it.';
  assert.equal(isExpectedDelegationRequest('delegate_task', { task }, task), true);
  assert.equal(isExpectedDelegationRequest('delegate_task', { task: `${task} extra` }, task), false);
  assert.equal(isExpectedDelegationRequest('delegate_task', { task, additional: true }, task), false);
  assert.equal(isExpectedDelegationRequest('write_file', { task }, task), false);

  assert.equal(isAllowedDelegationWrite('write_file', { path: 'delegated-result.txt', content: 'XYST_AGENT_DELEGATION_OK' }), true);
  assert.equal(isAllowedDelegationWrite('write_file', { path: 'delegated-result.txt', content: 'XYST_AGENT_DELEGATION_OK\n' }), true);
  assert.equal(isAllowedDelegationWrite('write_file', { path: '../outside.txt', content: 'XYST_AGENT_DELEGATION_OK' }), false);
  assert.equal(isAllowedDelegationWrite('write_file', { path: 'delegated-result.txt', content: 'other' }), false);
  assert.equal(
    isAllowedDelegationWrite('write_file', { path: 'delegated-result.txt', content: 'XYST_AGENT_DELEGATION_OK', overwrite: true }),
    false,
  );
  assert.equal(isAllowedDelegationWrite('run_shell_script', { script: 'anything' }), false);
});

test('live model smoke honors verified LM Studio context and bounds fallback values', () => {
  assert.equal(liveModelContextLength({ model_context_lengths: { model: 8192 } }, 'model'), 8192);
  assert.equal(liveModelContextLength({ model_context_lengths: { model: 0 } }, 'model'), 32_768);
  assert.equal(liveModelContextLength({ model_context_lengths: { model: Number.MAX_SAFE_INTEGER } }, 'model'), 32_768);
  assert.equal(liveModelContextLength(null, 'model'), 32_768);
});

test('live file golden prompt requires reading fixture values without revealing expected outputs', () => {
  const prompt = createFileSmokePrompt();
  assert.match(prompt, /Read source\.txt and second-source\.txt exactly once each before writing/);
  assert.match(prompt, /make exactly two successful writes/);
  assert.match(prompt, /After both writes, read each result file exactly once/);
  assert.doesNotMatch(prompt, /kestrel: 38|sparrow: 25/);
});

test('live overflow prompt requests sequential read-only tool calls and a bounded recovery marker', () => {
  const prompt = createOverflowPrompt();
  assert.match(prompt, /payload-1\.txt, payload-2\.txt/);
  assert.match(prompt, /read each listed file in full using only its path/);
  assert.match(prompt, /continue with the first file you have not read yet/);
  assert.match(prompt, /start_line=1 and end_line=1/);
  assert.match(prompt, /Do not list other files, use other tools, or write files/);
  assert.match(prompt, /return exactly OVERFLOW_RECOVERED/);
  assert.throws(() => createOverflowPrompt(9), /supports 1 to 8 payload files/);
});

test('live overflow smoke plans bounded fixtures for common LM Studio context sizes', () => {
  const small = planOverflowPayloads(8_192);
  const medium = planOverflowPayloads(32_768);
  const large = planOverflowPayloads(65_536);

  assert.equal(small.payloadCount, 1);
  assert.equal(small.payloadLength, Math.floor(8_192 * 0.9));
  assert.equal(medium.payloadCount, 4);
  assert.equal(large.payloadCount, 7);
  for (const plan of [small, medium, large]) {
    assert.ok(plan.payloadLength * 3 + 128 < 24_000, 'each UTF-8 CJK payload remains below the fixture byte limit');
    assert.ok(plan.payloadCount <= 8);
  }
  assert.throws(() => planOverflowPayloads(2_048), /supports loaded model contexts/);
  assert.throws(() => planOverflowPayloads(131_072), /supports loaded model contexts/);
});

test('live model smoke approves only its exact process and native-shell marker commands', async () => {
  const workspace = await createTempDirectory('xyst-live-smoke-command-policy-');
  const executable = process.execPath;
  const processArgs = ['-e', "process.stdout.write('PROCESS_MARKER')"];
  const shellScript = 'print a marker';
  assert.equal(
    isAllowedSmokeProcess(
      workspace,
      'run_process',
      { command: executable, args: processArgs, cwd: '.', timeout_seconds: 20 },
      executable,
      processArgs,
    ),
    true,
  );
  assert.equal(
    isAllowedSmokeProcess(
      workspace,
      'run_process',
      { command: executable, args: [...processArgs, 'extra'], cwd: workspace, timeout_seconds: 20 },
      executable,
      processArgs,
    ),
    false,
  );
  assert.equal(
    isAllowedSmokeProcess(
      workspace,
      'run_process',
      { command: executable, args: processArgs, cwd: path.dirname(workspace), timeout_seconds: 20 },
      executable,
      processArgs,
    ),
    false,
  );
  assert.equal(
    isAllowedSmokeShell(workspace, 'run_shell_script', { script: shellScript, cwd: '.', timeout_seconds: 20 }, shellScript),
    true,
  );
  assert.equal(
    isAllowedSmokeShell(
      workspace,
      'run_shell_script',
      { script: shellScript, cwd: '.', timeout_seconds: 20, stdin: 'unexpected' },
      shellScript,
    ),
    false,
  );
});

test('live resume smoke gates only the OpenAI chat-completions request', () => {
  assert.equal(isChatCompletionRequest('http://127.0.0.1:1234/v1/chat/completions'), true);
  assert.equal(isChatCompletionRequest(new URL('http://127.0.0.1:1234/v1/chat/completions')), true);
  assert.equal(isChatCompletionRequest(new Request('http://127.0.0.1:1234/v1/models')), false);
  assert.equal(isChatCompletionRequest('not a URL'), false);
});

test('live resume smoke reads event names from SSE frames across arbitrary chunk boundaries', async () => {
  const chunks = [
    'retry: 3000\r\n\r\nevent: run_pa',
    'used\r\nid: 4\r\ndata: {"type":"run_paused"}\r\n\r\nevent: run_resumed\n',
    'id: 5\ndata: {"type":"run_resumed"}\n\n',
  ];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  assert.deepEqual(await readRunEventTypes(body), ['run_paused', 'run_resumed']);
});

test('LM Studio preflight distinguishes loaded, unloaded, and non-LM Studio endpoints', async () => {
  const loaded = await preflightLmStudioModel('http://127.0.0.1:1234/v1', 'test-model', async (url) => {
    assert.equal(new URL(url).pathname, '/api/v1/models');
    return Response.json({ models: [{ key: 'test-model', loaded_instances: [{ id: 'instance-1', config: { context_length: 8192 } }] }] });
  });
  assert.deepEqual(loaded, { supported: true, loaded: true, contextLength: 8192 });

  const loadedDuplicate = await preflightLmStudioModel('http://127.0.0.1:1234/v1', 'test-model', async () =>
    Response.json({
      models: [
        { key: 'test-model', loaded_instances: [] },
        { key: 'test-model', loaded_instances: [{ id: 'instance-2', config: { context_length: 16_384 } }] },
      ],
    }),
  );
  assert.deepEqual(loadedDuplicate, { supported: true, loaded: true, contextLength: 16_384 });

  const missingContext = await preflightLmStudioModel('http://127.0.0.1:1234/v1', 'test-model', async () =>
    Response.json({ models: [{ key: 'test-model', loaded_instances: [{ id: 'instance-1' }] }] }),
  );
  assert.deepEqual(missingContext, { supported: true, loaded: true, contextLength: null });

  for (const contextLength of [0, -1, Number.MAX_SAFE_INTEGER, '8192']) {
    const invalidContext = await preflightLmStudioModel('http://127.0.0.1:1234/v1', 'test-model', async () =>
      Response.json({
        models: [{ key: 'test-model', loaded_instances: [{ id: 'instance-1', config: { context_length: contextLength } }] }],
      }),
    );
    assert.deepEqual(invalidContext, { supported: true, loaded: true, contextLength: null });
  }

  await assert.rejects(
    preflightLmStudioModel('http://127.0.0.1:1234/v1', 'test-model', async () =>
      Response.json({ models: [{ key: 'test-model', loaded_instances: [] }] }),
    ),
    (error) => error.code === 'MODEL_NOT_LOADED' && /installed but not loaded/.test(error.message),
  );

  const unsupported = await preflightLmStudioModel(
    'http://127.0.0.1:1234/v1',
    'test-model',
    async () => new Response(null, { status: 404 }),
  );
  assert.deepEqual(unsupported, { supported: false, loaded: null, contextLength: null });
});
