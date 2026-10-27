import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../src/core/agent.mjs';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { preflightLmStudioModel, validateLiveModelEndpoint, validateLiveModelId } from './smoke-live-model.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const successMarker = 'OVERFLOW_RECOVERED';
const maximumLoadedContext = 65_536;
const maximumFileBytes = 24_000;
const maximumPayloadFiles = 8;
const syntheticAlphabet = [
  ...'这是一个用于上下文溢出恢复验证的纯合成测试文本没有任何用户内容甲乙丙丁戊己庚辛壬癸天地玄黄宇宙洪荒日月星辰山川草木风雨雷电',
].filter((character, index, all) => all.indexOf(character) === index);

function createSyntheticPayload(length, seed) {
  let state = seed >>> 0;
  let text = '';
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    text += syntheticAlphabet[(state >>> 0) % syntheticAlphabet.length];
  }
  return text;
}

export function planOverflowPayloads(contextLength) {
  if (!Number.isSafeInteger(contextLength) || contextLength < 4_096 || contextLength > maximumLoadedContext) {
    throw new RangeError(`Overflow smoke supports loaded model contexts from 4,096 to ${maximumLoadedContext} tokens`);
  }
  const payloadLength = Math.min(Math.floor(contextLength * 0.9), Math.floor((maximumFileBytes - 512) / 3));
  const estimatedPromptTokensPerPayload = Math.ceil(payloadLength * 1.05 + 1_200);
  const payloadCount = Math.min(maximumPayloadFiles, Math.max(1, Math.floor(contextLength / estimatedPromptTokensPerPayload) + 1));
  return {
    payloadLength,
    payloadCount,
    recoveryLength: Math.floor(Math.min(contextLength, 8_192) * 0.15),
  };
}

export function createOverflowPrompt(payloadCount = 1) {
  if (!Number.isSafeInteger(payloadCount) || payloadCount < 1 || payloadCount > maximumPayloadFiles) {
    throw new RangeError(`Overflow smoke supports 1 to ${maximumPayloadFiles} payload files`);
  }
  const files = Array.from({ length: payloadCount + 1 }, (_, index) => `payload-${index + 1}.txt`);
  return `Read each of these files in order: ${files.join(', ')}. Before any context recovery, read each listed file in full using only its path, with no start_line or end_line; the large synthetic contents are required to exercise provider context overflow. After a provider context recovery, continue with the first file you have not read yet. If you need a filename or header from an omitted result, use read_file with start_line=1 and end_line=1; never reread a completed large file in full. Do not list other files, use other tools, or write files. After reading every listed file, return exactly ${successMarker}.`;
}

async function main() {
  const model = validateLiveModelId(process.env.XYST_LIVE_MODEL);
  const baseUrl = validateLiveModelEndpoint(process.env.XYST_LIVE_MODEL_BASE_URL);
  const lmStudio = await preflightLmStudioModel(baseUrl, model);
  if (!lmStudio.supported || !lmStudio.loaded || !lmStudio.contextLength) {
    throw new Error('Live overflow smoke requires a loaded LM Studio model with a reported context length');
  }

  const provider = new OpenAICompatibleProvider({ baseUrl, model, timeoutMs: 10_000 });
  const availableModels = await provider.listModels();
  if (!availableModels.some((item) => item.id === model)) {
    throw new Error(`Selected model '${model}' is not currently listed by the loopback endpoint`);
  }

  const loadedContextLength = lmStudio.contextLength;
  const { payloadLength, payloadCount, recoveryLength } = planOverflowPayloads(loadedContextLength);
  // The smoke-only profile intentionally overstates the loaded limit slightly;
  // this lets LM Studio reject a request before Xyst's local estimate does.
  const contextLimit = Math.floor(loadedContextLength * 1.83);
  const tempRoot = path.join(repositoryRoot, '.test-tmp');
  await fs.mkdir(tempRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(path.join(tempRoot, 'live-overflow-smoke-'));
  const events = [];
  let refusedApprovals = 0;
  let runtime;

  try {
    const payloadSeeds = [0x41c64e6d, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35, 0x27d4eb2f, 0x165667b1, 0xd3a2646c, 0x7f4a7c15];
    for (let index = 1; index <= payloadCount; index += 1) {
      await fs.writeFile(
        path.join(workspaceRoot, `payload-${index}.txt`),
        `SYNTHETIC_PAYLOAD_${index}\n${createSyntheticPayload(payloadLength, payloadSeeds[index - 1])}\n`,
        { flag: 'wx' },
      );
    }
    await fs.writeFile(
      path.join(workspaceRoot, `payload-${payloadCount + 1}.txt`),
      `SYNTHETIC_RECOVERY_SENTINEL\n${createSyntheticPayload(recoveryLength, 0x9e3779b9)}\n`,
      { flag: 'wx' },
    );
    runtime = new AgentRuntime({
      config: {
        default_model: 'live-overflow',
        models: {
          'live-overflow': {
            provider: 'openai-compatible',
            base_url: baseUrl,
            model,
            local: true,
            supports_tools: true,
            context_length: contextLimit,
            input_cost_per_million: 0,
            output_cost_per_million: 0,
            timeout_ms: 120_000,
            temperature: 0,
          },
        },
        tools: { autonomy: 'assisted', filesystem_scope: 'workspace', shell_enabled: false, max_file_bytes: maximumFileBytes },
        budgets: {
          max_turns: Math.min(48, (payloadCount + 1) * 2 + 8),
          max_input_tokens: Math.min(524_288, Math.max(65_536, loadedContextLength * 6)),
          max_output_tokens: 500,
          max_tool_output_bytes: maximumFileBytes,
        },
      },
      workspaceRoot,
      sessionStore: new SessionStore(workspaceRoot),
      onEvent: (event) => {
        if (
          [
            'model_call_started',
            'model_call_failed',
            'model_call_finished',
            'tool_finished',
            'tool_denied',
            'context_trimmed',
            'run_stopped',
          ].includes(event.type)
        ) {
          events.push(event);
        }
        if (process.env.XYST_LIVE_MODEL_PROGRESS === '1') {
          if (event.type === 'model_call_started') process.stderr.write(`[live-overflow] model call ${event.turn} started\n`);
          else if (event.type === 'model_call_failed') process.stderr.write(`[live-overflow] model call failed: ${event.code}\n`);
          else if (event.type === 'context_trimmed')
            process.stderr.write(`[live-overflow] context recovery dropped ${event.dropped_tool_calls} tool call(s)\n`);
          else if (event.type === 'tool_finished') process.stderr.write(`[live-overflow] tool ${event.tool} finished\n`);
        }
      },
    });

    const result = await runtime.run({
      prompt: createOverflowPrompt(payloadCount),
      signal: AbortSignal.timeout(600_000),
      approveTool: async () => {
        refusedApprovals += 1;
        return false;
      },
    });

    const failedCalls = events.filter((event) => event.type === 'model_call_failed');
    const recoveries = events.filter((event) => event.type === 'context_trimmed' && event.reason === 'provider_context_overflow');
    const recovery = recoveries.find((event) => event.dropped_tool_calls > 0 || event.compacted_tool_results > 0);
    const readTools = events.filter((event) => event.type === 'tool_finished').map((event) => event.tool);
    const readCalls = result.session.messages
      .flatMap((message) => message.tool_calls || [])
      .filter((call) => call.function?.name === 'read_file')
      .map((call) => ({ path: JSON.parse(call.function.arguments).path, ...JSON.parse(call.function.arguments) }));
    const readPaths = readCalls.map((call) => call.path);
    const expectedReadSequence = Array.from({ length: payloadCount + 1 }, (_, index) => `payload-${index + 1}.txt`);
    let lastSequenceIndex = -1;
    const verifiedReadSequence = expectedReadSequence.every((filePath) => {
      lastSequenceIndex = readPaths.indexOf(filePath, lastSequenceIndex + 1);
      return lastSequenceIndex >= 0;
    });
    const boundedRecoveryRead = readCalls.some(
      (call) => /^payload-\d+\.txt$/.test(call.path) && call.start_line === 1 && call.end_line === 1,
    );
    const onlyReadFile = readTools.length >= expectedReadSequence.length && readTools.every((tool) => tool === 'read_file');
    const passed =
      result.status === 'complete' &&
      result.content?.trim() === successMarker &&
      recovery &&
      verifiedReadSequence &&
      onlyReadFile &&
      refusedApprovals === 0;
    const report = {
      status: passed ? 'passed' : 'failed',
      model,
      loaded_context_length: loadedContextLength,
      payload_files: payloadCount,
      payload_characters: payloadLength,
      smoke_context_limit: contextLimit,
      model_calls: events.filter((event) => event.type === 'model_call_started').length,
      estimated_input_tokens: events.filter((event) => event.type === 'model_call_started').map((event) => event.estimated_input_tokens),
      provider_usage: events
        .filter((event) => event.type === 'model_call_finished')
        .map(({ turn, usage }) => ({ turn, input_tokens: usage?.inputTokens ?? null, output_tokens: usage?.outputTokens ?? null })),
      provider_failure_codes: failedCalls.map((event) => event.code),
      provider_overflow_recovered: Boolean(recovery),
      recovery_dropped_tool_calls: recovery?.dropped_tool_calls ?? 0,
      recovery_compacted_tool_results: recovery?.compacted_tool_results ?? 0,
      bounded_recovery_read: boundedRecoveryRead,
      context_recoveries: recoveries.map(
        ({ dropped_turns, dropped_tool_calls, compacted_tool_results, dropped_tools, retained_tokens }) => ({
          dropped_turns,
          dropped_tool_calls,
          compacted_tool_results: compacted_tool_results ?? 0,
          dropped_tools: dropped_tools ?? [],
          retained_tokens,
        }),
      ),
      context_trim_events: events
        .filter((event) => event.type === 'context_trimmed')
        .map(({ reason, dropped_turns, dropped_tool_calls, compacted_tool_results, dropped_tools, retained_tokens }) => ({
          reason: reason ?? null,
          dropped_turns: dropped_turns ?? 0,
          dropped_tool_calls: dropped_tool_calls ?? 0,
          compacted_tool_results: compacted_tool_results ?? 0,
          dropped_tools: dropped_tools ?? [],
          retained_tokens: retained_tokens ?? null,
        })),
      tool_calls: readTools,
      read_paths: readPaths,
      read_calls: readCalls,
      refused_approvals: refusedApprovals,
      result_status: result.status,
      recovery_answer_verified: result.content?.trim() === successMarker,
      context_error: result.status === 'context_overflow' ? String(result.content).slice(0, 240) : null,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!passed) process.exitCode = 1;
  } finally {
    await runtime?.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code = typeof error.code === 'string' ? ` (${error.code})` : '';
    process.stderr.write(`Live overflow smoke failed${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
