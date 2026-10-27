import { resolveModelApiKey } from '../config/load.mjs';
import { OpenAICompatibleEmbeddingProvider } from '../providers/embeddings.mjs';
import { SemanticWorkspaceIndex } from './semantic-index.mjs';

export function createSemanticIndex({
  workspaceRoot,
  config,
  fetchImpl = fetch,
  secretStore,
  usageBudgetStore,
  watchWorkspace = false,
} = {}) {
  const semantic = config?.retrieval?.semantic;
  if (semantic?.enabled !== true) return null;
  return new SemanticWorkspaceIndex(workspaceRoot, {
    model: semantic.model,
    usageBudgetStore,
    usageLimits: Object.fromEntries(
      [
        'max_daily_input_tokens',
        'max_daily_output_tokens',
        'max_monthly_input_tokens',
        'max_monthly_output_tokens',
        'max_daily_cost',
        'max_monthly_cost',
      ]
        .filter((key) => config.budgets?.[key] !== undefined)
        .map((key) => [key, config.budgets[key]]),
    ),
    maxFiles: config.retrieval.max_files,
    maxFileBytes: config.retrieval.max_file_bytes,
    watchWorkspace,
    embed: async (texts, options) => {
      const apiKey = await resolveModelApiKey(semantic, { secretStore });
      const provider = new OpenAICompatibleEmbeddingProvider({
        baseUrl: semantic.base_url,
        model: semantic.model,
        apiKey,
        timeoutMs: options.timeoutMs || semantic.timeout_ms || 60_000,
        fetchImpl,
      });
      const store = options.usageBudgetStore;
      const limits = options.usageLimits || {};
      const estimated = texts.reduce((sum, text) => sum + Math.max(1, Buffer.byteLength(text)), 0);
      const costFor = (tokens) =>
        Number.isFinite(semantic.input_cost_per_million) ? (tokens * semantic.input_cost_per_million) / 1_000_000 : null;
      const reservation = store
        ? await store.reserve({
            inputTokens: estimated,
            outputTokens: 0,
            costUsd: costFor(estimated),
            limits,
            sessionId: options.sessionId,
            model: semantic.model,
          })
        : null;
      let settled = false;
      const settle = async (usage) => {
        if (!store || settled) return;
        settled = true;
        const details = { ...usage, costUsd: costFor(usage.inputTokens), sessionId: options.sessionId, model: semantic.model };
        if (reservation) await store.settle(reservation, details);
        else await store.recordUsage(details);
      };
      try {
        return await provider.embed(texts, { ...options, onUsage: settle });
      } catch (error) {
        if (!settled)
          await settle({
            inputTokens: estimated,
            outputTokens: 0,
            costUsd: costFor(estimated),
            inputTokenSource: 'estimated',
            outputTokenSource: 'estimated',
          }).catch(() => {});
        throw error;
      }
    },
  });
}
