import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../src/core/agent.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { preflightLmStudioModel, validateLiveModelEndpoint, validateLiveModelId } from './smoke-live-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const model = validateLiveModelId(process.env.XYST_LIVE_MODEL);
const baseUrl = validateLiveModelEndpoint(process.env.XYST_LIVE_MODEL_BASE_URL);
const status = await preflightLmStudioModel(baseUrl, model);
await fs.mkdir(path.join(root, '.test-tmp'), { recursive: true });
const workspace = await fs.mkdtemp(path.join(root, '.test-tmp', 'live-internet-'));
const runtime = new AgentRuntime({
  workspaceRoot: workspace,
  sessionStore: new SessionStore(workspace),
  config: {
    default_model: 'live-internet',
    models: {
      'live-internet': {
        provider: 'openai-compatible',
        base_url: baseUrl,
        model,
        local: true,
        supports_tools: true,
        context_length: status.contextLength || 8192,
        timeout_ms: 180_000,
        temperature: 0,
      },
    },
    tools: { autonomy: 'assisted', filesystem_scope: 'workspace', shell_enabled: false },
    web_search: { enabled: true, provider: 'automatic', max_results: 3, timeout_ms: 15_000 },
    budgets: { max_turns: 5, max_input_tokens: 24_000, max_output_tokens: 2_000, max_tool_output_bytes: 12_000 },
  },
});
try {
  const result = await runtime.run({
    prompt:
      'What are two recent public headlines about artificial intelligence? I need current internet information. Briefly summarize them and cite their source URLs. Do not inspect or change local files.',
    signal: AbortSignal.timeout(360_000),
    approveTool: async ({ tool }) => ['web_search', 'web_fetch'].includes(tool.name),
  });
  const searches = result.session.messages
    .filter((message) => message.role === 'tool')
    .flatMap((message) => {
      const observation = JSON.parse(message.content);
      if (observation.source?.name !== 'web_search') return [];
      const value = observation.content?.result;
      const search = typeof value === 'string' ? JSON.parse(value) : value;
      return search?.results || [];
    });
  const cited = searches.filter((item) => typeof item.url === 'string' && result.content?.includes(item.url));
  const report = { status: result.status, retrieved_results: searches.length, cited_retrieved_sources: cited.length, model };
  console.log(JSON.stringify(report, null, 2));
  assert.equal(result.status, 'complete', 'Live internet run must complete');
  assert.ok(searches.length > 0, 'Agent must retrieve real search results');
  assert.ok(cited.length > 0, 'Answer must cite a URL actually returned by live search');
} finally {
  await runtime.close();
  await fs.rm(workspace, { recursive: true, force: true });
}
