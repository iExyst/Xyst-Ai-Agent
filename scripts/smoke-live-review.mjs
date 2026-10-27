import fs from 'node:fs/promises';
import osPath from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../src/core/agent.mjs';
import { preflightLmStudioModel, validateLiveModelEndpoint, validateLiveModelId } from './smoke-live-model.mjs';
import { SessionStore } from '../src/session/store.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = osPath.resolve(osPath.dirname(scriptPath), '..');

async function main() {
  const model = validateLiveModelId(process.env.XYST_LIVE_MODEL);
  const baseUrl = validateLiveModelEndpoint(process.env.XYST_LIVE_MODEL_BASE_URL);
  const lmStudio = await preflightLmStudioModel(baseUrl, model);
  if (!lmStudio.loaded) throw new Error(`Selected LM Studio model '${model}' is not loaded`);
  if (!Number.isSafeInteger(lmStudio.contextLength) || lmStudio.contextLength < 1)
    throw new Error(`LM Studio did not report a valid context length for '${model}'`);

  const tempRoot = osPath.join(repositoryRoot, '.test-tmp');
  await fs.mkdir(tempRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(osPath.join(tempRoot, 'live-review-smoke-'));
  const events = [];
  const requestTrace = [];
  const runtime = new AgentRuntime({
    config: {
      default_model: 'live-review',
      models: {
        'live-review': {
          provider: 'openai-compatible',
          base_url: baseUrl,
          model,
          local: true,
          supports_tools: true,
          context_length: lmStudio.contextLength,
          input_cost_per_million: 0,
          output_cost_per_million: 0,
          timeout_ms: 300_000,
          temperature: 0,
        },
      },
      tools: { autonomy: 'assisted', filesystem_scope: 'workspace', shell_enabled: false },
      budgets: { max_turns: 2, max_input_tokens: 7_000, max_output_tokens: 1_500, max_tool_output_bytes: 5_000 },
    },
    workspaceRoot,
    sessionStore: new SessionStore(workspaceRoot),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requestTrace.push({
        streaming: body.stream === true,
        has_structured_format: Boolean(body.response_format),
        tool_names: (body.tools || []).map((tool) => tool.function?.name),
        messages: body.messages.map((message) => ({
          role: message.role,
          content: String(typeof message.content === 'string' ? message.content : JSON.stringify(message.content) || '').slice(-1_500),
          tool_calls: message.tool_calls?.map((call) => call.function?.name),
        })),
      });
      return fetch(url, options);
    },
    onEvent: (event) => {
      if (['model_call_finished', 'tool_finished', 'tool_denied', 'run_finished', 'run_stopped'].includes(event.type)) events.push(event);
    },
  });

  try {
    await fs.mkdir(osPath.join(workspaceRoot, 'src'), { recursive: true });
    await fs.mkdir(osPath.join(workspaceRoot, 'tests'), { recursive: true });
    await fs.writeFile(
      osPath.join(workspaceRoot, 'src', 'retry-policy.mjs'),
      '/** Another retry is allowed only when the zero-based attempt is strictly less than maxRetries. */\nexport function shouldRetry(attempt, maxRetries) {\n  return attempt <= maxRetries;\n}\n',
      { flag: 'wx' },
    );
    await fs.writeFile(
      osPath.join(workspaceRoot, 'tests', 'retry-policy.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { shouldRetry } from '../src/retry-policy.mjs';\n\ntest('allows retries below the configured cap', () => {\n  assert.equal(shouldRetry(0, 3), true);\n  assert.equal(shouldRetry(2, 3), true);\n});\n\ntest('stops when the configured number of retries has been reached', () => {\n  assert.equal(shouldRetry(3, 3), false);\n});\n",
      { flag: 'wx' },
    );

    const result = await runtime.run({
      mode: 'review',
      streaming: true,
      signal: AbortSignal.timeout(300_000),
      prompt:
        'Review the synthetic source and test for concrete defects. Call read_file exactly once for src/retry-policy.mjs and exactly once for tests/retry-policy.test.mjs. Do not use list_dir, search_files, or read any other path. The source contract explicitly says another retry is allowed only when attempt is strictly less than maxRetries. Evaluate equality (attempt=3, maxRetries=3) against the implementation and the test expectation, which requires false. The defect can cause at most one extra retry per operation and has no demonstrated security or availability impact; classify it as medium severity, not high or critical. Return only supported findings with exact workspace-relative paths and line numbers; if no defect is supported, return no findings.',
    });
    const inspectedPaths = new Set(
      result.session.messages
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => message.tool_calls || [])
        .filter((call) => call.function?.name === 'read_file')
        .map((call) => {
          try {
            return JSON.parse(call.function.arguments).path?.replaceAll('\\', '/').replace(/^\.\//, '');
          } catch {
            return null;
          }
        }),
    );
    const expectedPathsRead = ['src/retry-policy.mjs', 'tests/retry-policy.test.mjs'].every((file) => inspectedPaths.has(file));
    const finding = result.session.review_findings?.find((item) => item.file === 'src/retry-policy.mjs');
    const findingLocationCorrect = finding?.line === 3;
    const severityCalibrated = finding?.severity === 'medium';
    const report = {
      status: result.status === 'complete' && expectedPathsRead && findingLocationCorrect && severityCalibrated ? 'passed' : 'failed',
      model,
      context_length: lmStudio.contextLength,
      model_calls: events.filter((event) => event.type === 'model_call_finished').length,
      tools: events.filter((event) => event.type === 'tool_finished').map((event) => event.tool),
      inspected_paths: [...inspectedPaths].filter(Boolean),
      findings: result.session.review_findings || null,
      final_response: String(result.content ?? '').slice(0, 1_500),
      severity_calibrated: severityCalibrated,
      ...(process.env.XYST_LIVE_REVIEW_DEBUG === '1' ? { request_trace: requestTrace } : {}),
      failure_reasons: [
        ...(result.status === 'complete' ? [] : [`review ended with status '${result.status}'`]),
        ...(expectedPathsRead ? [] : ['model did not read both the synthetic source and test files']),
        ...(finding ? [] : ['no supported finding was reported for the known retry-cap off-by-one']),
        ...(findingLocationCorrect ? [] : [`expected finding line 3, received '${finding?.line ?? 'no finding'}'`]),
        ...(severityCalibrated
          ? []
          : [`expected medium severity for the bounded retry-cap defect, received '${finding?.severity ?? 'no finding'}'`]),
      ],
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
  } finally {
    await runtime.close();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && osPath.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    const code = typeof error.code === 'string' ? ` (${error.code})` : '';
    process.stderr.write(`Live Review smoke failed${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
