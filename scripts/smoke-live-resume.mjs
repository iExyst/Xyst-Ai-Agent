import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlToken, LocalControlServer } from '../src/api/server.mjs';
import { preflightLmStudioModel, validateLiveModelEndpoint, validateLiveModelId } from './smoke-live-model.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pauseDirection =
  'This is an interruption and resume check. Ignore the earlier exact-response request and reply with exactly RESUMED.';

export function isChatCompletionRequest(input) {
  try {
    const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    return typeof requestUrl === 'string' && new URL(requestUrl).pathname.endsWith('/chat/completions');
  } catch {
    return false;
  }
}

export async function readRunEventTypes(body) {
  if (!body || typeof body.getReader !== 'function') throw new TypeError('Run event response has no readable body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const eventTypes = [];
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let separator;
    while ((separator = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      const eventLine = frame.split(/\r?\n/).find((line) => line.startsWith('event:'));
      if (eventLine) eventTypes.push(eventLine.slice('event:'.length).trim());
    }
    if (done) break;
  }
  return eventTypes;
}

async function main() {
  const model = validateLiveModelId(process.env.XYST_LIVE_MODEL);
  const baseUrl = validateLiveModelEndpoint(process.env.XYST_LIVE_MODEL_BASE_URL);
  const lmStudio = await preflightLmStudioModel(baseUrl, model);
  const tempRoot = path.join(repositoryRoot, '.test-tmp');
  await fs.mkdir(tempRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(path.join(tempRoot, 'live-resume-smoke-'));

  let announceChatStarted;
  const chatStarted = new Promise((resolve) => {
    announceChatStarted = resolve;
  });
  let releaseFirstChat;
  const firstChatGate = new Promise((resolve) => {
    releaseFirstChat = resolve;
  });
  let gatedFirstChat = false;
  let modelCalls = 0;
  let server;
  try {
    const fetchImpl = async (input, init) => {
      if (isChatCompletionRequest(input)) {
        modelCalls += 1;
        if (!gatedFirstChat) {
          gatedFirstChat = true;
          announceChatStarted();
          await firstChatGate;
        }
      }
      return fetch(input, init);
    };
    const config = {
      default_model: 'live-resume',
      models: {
        'live-resume': {
          provider: 'openai-compatible',
          base_url: baseUrl,
          model,
          local: true,
          supports_tools: false,
          context_length: lmStudio.contextLength ?? 32_768,
          input_cost_per_million: 0,
          output_cost_per_million: 0,
          timeout_ms: 120_000,
        },
      },
      tools: { autonomy: 'assisted', filesystem_scope: 'workspace', shell_enabled: false },
      budgets: { max_turns: 4, max_input_tokens: 16_000, max_output_tokens: 1_000, max_tool_output_bytes: 4_000 },
    };
    server = new LocalControlServer({
      config,
      workspaceRoot,
      token: createControlToken(),
      fetchImpl,
    });
    const { url, token } = await server.start();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const startedResponse = await fetch(`${url}/v1/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'live-resume', prompt: 'Reply with exactly READY and nothing else.' }),
    });
    if (startedResponse.status !== 202) throw new Error(`Live resume run could not start (${startedResponse.status})`);
    const { run_id: runId, events_url: eventsUrl } = await startedResponse.json();

    await withTimeout(chatStarted, 30_000, 'Local model did not start its first chat request');
    const pauseResponse = await fetch(`${url}/v1/runs/${runId}/pause`, { method: 'POST', headers, body: '{}' });
    if (pauseResponse.status !== 202) throw new Error(`Live resume pause was rejected (${pauseResponse.status})`);
    const directionResponse = await fetch(`${url}/v1/runs/${runId}/directions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: pauseDirection }),
    });
    if (directionResponse.status !== 202) throw new Error(`Live resume direction was rejected (${directionResponse.status})`);
    releaseFirstChat();

    const paused = await waitForRunStatus(url, headers, runId, 'paused', 150_000);
    const originalSessionId = paused.session_id;
    if (!originalSessionId) throw new Error('Paused live run did not retain a session ID');
    const resumeResponse = await fetch(`${url}/v1/runs/${runId}/resume`, { method: 'POST', headers, body: '{}' });
    if (resumeResponse.status !== 202) throw new Error(`Live resume request was rejected (${resumeResponse.status})`);

    const completed = await waitForRunStatus(url, headers, runId, 'complete', 180_000);
    const eventResponse = await fetch(`${url}${eventsUrl}`, { headers });
    if (!eventResponse.ok) throw new Error(`Live run event history could not be read (${eventResponse.status})`);
    const eventTypes = await readRunEventTypes(eventResponse.body);
    const session = await server.sessionStore.load(originalSessionId);
    const resumedMessagePersisted = session.messages.some((message) => message.role === 'user' && message.content === pauseDirection);
    const result = completed.result?.content?.trim();
    const complete =
      completed.session_id === originalSessionId &&
      resumedMessagePersisted &&
      result === 'RESUMED' &&
      eventTypes.includes('run_paused') &&
      eventTypes.includes('run_resumed') &&
      modelCalls >= 2;
    const report = {
      status: complete ? 'passed' : 'failed',
      model,
      model_calls: modelCalls,
      run_id: runId,
      session_preserved: completed.session_id === originalSessionId,
      pause_event: eventTypes.includes('run_paused'),
      resume_event: eventTypes.includes('run_resumed'),
      direction_persisted: resumedMessagePersisted,
      resumed_answer_verified: result === 'RESUMED',
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!complete) process.exitCode = 1;
  } finally {
    releaseFirstChat();
    try {
      await server?.close();
    } finally {
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}

async function waitForRunStatus(url, headers, runId, expectedStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/v1/runs/${runId}`, { headers });
    if (!response.ok) throw new Error(`Live run status lookup failed (${response.status})`);
    latest = await response.json();
    if (latest.status === expectedStatus) return latest;
    if (!['running', 'paused'].includes(latest.status)) {
      const code = typeof latest.error?.code === 'string' ? ` (${latest.error.code})` : '';
      throw new Error(`Live run ended as '${latest.status}'${code} before reaching '${expectedStatus}'`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for live run status '${expectedStatus}' (last status: ${latest?.status || 'unknown'})`);
}

function withTimeout(promise, timeoutMs, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = typeof error.code === 'string' ? ` (${error.code})` : '';
    process.stderr.write(`Live resume smoke failed${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
