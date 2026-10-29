import { estimateTokens } from './router.mjs';

export class ContextOverflowError extends Error {
  constructor(availableTokens, requiredTokens) {
    super(`The current task needs about ${requiredTokens} context tokens, above the ${availableTokens} token limit`);
    this.name = 'ContextOverflowError';
    this.code = 'CONTEXT_OVERFLOW';
    this.availableTokens = availableTokens;
    this.requiredTokens = requiredTokens;
  }
}

const OMITTED_TOOL_HISTORY_NOTE =
  '[Earlier tool exchanges from this request were omitted from the model context to fit the provider window. Their full transcript remains saved. Re-read only the minimum lines or regions needed to recover omitted observations; use bounded read_file line ranges for large files. Do not reread large files in full or repeat edits blindly.]';

/** Drop complete older turns. On an explicit overflow recovery, also drop the
 * oldest complete tool exchanges from the active turn while retaining the
 * current request and at least its most recent tool exchange.
 */
export function prepareContext({
  policy,
  memory = '',
  retrieval = '',
  history,
  maxTokens,
  trimActiveToolHistory = false,
  dropActiveToolHistory = false,
}) {
  const fixed = [{ role: 'system', content: policy }];
  if (memory) fixed.push({ role: 'user', content: memory });
  let retrievalMessage = retrieval ? [{ role: 'user', content: retrieval }] : [];
  let retained = [...history];
  let droppedTurns = 0;
  let droppedToolCalls = 0;
  let compactedToolResults = 0;
  let omittedToolHistoryNoteAdded = false;
  let messages = [...fixed, ...retrievalMessage, ...retained];
  let tokenEstimate = estimateTokens(messages);

  if (dropActiveToolHistory) {
    let exchange = oldestRemovableToolExchange(retained);
    while (exchange) {
      retained.splice(exchange.start, exchange.length);
      droppedToolCalls += exchange.calls;
      exchange = oldestRemovableToolExchange(retained);
    }
    const activeTurnStart = retained.findLastIndex((message) => message?.role === 'user');
    for (let index = activeTurnStart + 1; index < retained.length; index += 1) {
      if (retained[index]?.role !== 'tool') continue;
      const webExcerpt = compactWebObservation(retained[index].content, 1600);
      retained[index] = {
        ...retained[index],
        content:
          webExcerpt ||
          '[Tool result omitted after provider context overflow. Reread only the needed lines or regions with bounded tool arguments.]',
      };
      compactedToolResults += 1;
    }
    if (droppedToolCalls || compactedToolResults) {
      fixed[0].content = `${fixed[0].content}\n\n${OMITTED_TOOL_HISTORY_NOTE}`;
      omittedToolHistoryNoteAdded = true;
      messages = [...fixed, ...retrievalMessage, ...retained];
      tokenEstimate = estimateTokens(messages);
    }
  }

  while (tokenEstimate > maxTokens) {
    const starts = [];
    for (let index = 0; index < retained.length; index += 1) if (retained[index].role === 'user') starts.push(index);
    if (starts.length > 1) {
      retained = retained.slice(starts[1]);
      droppedTurns += 1;
    } else if (retrievalMessage.length) retrievalMessage = [];
    else if (trimActiveToolHistory) {
      const exchange = oldestRemovableToolExchange(retained);
      if (!exchange) {
        // A single page (or parallel fetch batch) may exceed the whole window.
        // Keep source metadata and a bounded excerpt instead of losing all evidence.
        let candidate = -1;
        let excerpt;
        for (let index = 0; index < retained.length; index += 1) {
          const message = retained[index];
          if (message.role !== 'tool' || typeof message.content !== 'string') continue;
          if (candidate >= 0 && message.content.length <= retained[candidate].content.length) continue;
          const compacted = compactWebObservation(message.content, Math.max(256, Math.floor(message.content.length / 4)));
          if (compacted && compacted.length < message.content.length) {
            candidate = index;
            excerpt = compacted;
          }
        }
        if (candidate < 0) throw new ContextOverflowError(maxTokens, tokenEstimate);
        retained[candidate] = { ...retained[candidate], content: excerpt };
        compactedToolResults += 1;
        messages = [...fixed, ...retrievalMessage, ...retained];
        tokenEstimate = estimateTokens(messages);
        continue;
      }
      retained.splice(exchange.start, exchange.length);
      if (!omittedToolHistoryNoteAdded) fixed[0].content = `${fixed[0].content}\n\n${OMITTED_TOOL_HISTORY_NOTE}`;
      omittedToolHistoryNoteAdded = true;
      droppedToolCalls += exchange.calls;
    } else throw new ContextOverflowError(maxTokens, tokenEstimate);
    messages = [...fixed, ...retrievalMessage, ...retained];
    tokenEstimate = estimateTokens(messages);
  }
  return {
    messages,
    droppedTurns,
    droppedToolCalls,
    compactedToolResults,
    estimatedTokens: tokenEstimate,
  };
}

function compactWebObservation(content, textLimit) {
  try {
    const observation = JSON.parse(content);
    if (observation.type !== 'untrusted_observation' || !['web_fetch', 'web_search'].includes(observation.source?.name)) return null;
    if (typeof observation.content?.error === 'string') return content;
    const result = JSON.parse(observation.content.result);
    if (typeof result.content === 'string') {
      if (result.content.length <= textLimit) return content;
      result.content = result.content.slice(0, textLimit);
      result.truncated = true;
    } else if (Array.isArray(result.results)) {
      const limit = Math.max(128, Math.floor(textLimit / Math.max(1, result.results.length)));
      let changed = false;
      result.results = result.results.map((item) => {
        if (typeof item.snippet !== 'string' || item.snippet.length <= limit) return item;
        changed = true;
        return { ...item, snippet: item.snippet.slice(0, limit) };
      });
      if (!changed) return content;
    } else return null;
    observation.content.result = JSON.stringify(result);
    observation.content.context_note =
      'Excerpt shortened to fit the model context. Use only facts visible here; fetch a relevant source again if details are missing. Full results remain in the saved transcript.';
    return JSON.stringify(observation);
  } catch {
    return null;
  }
}

function oldestRemovableToolExchange(history) {
  let activeTurnStart = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user') {
      activeTurnStart = index;
      break;
    }
  }
  if (activeTurnStart < 0) return null;
  const exchanges = [];
  for (let index = activeTurnStart + 1; index < history.length; index += 1) {
    const message = history[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;
    const callIds = new Set(message.tool_calls.map((call) => call?.id).filter((id) => typeof id === 'string' && id));
    if (callIds.size !== message.tool_calls.length) continue;
    const resultIds = new Set();
    let end = index;
    for (let next = index + 1; next < history.length && resultIds.size < callIds.size; next += 1) {
      const result = history[next];
      if (result?.role !== 'tool' || !callIds.has(result.tool_call_id) || resultIds.has(result.tool_call_id)) break;
      resultIds.add(result.tool_call_id);
      end = next;
    }
    if (resultIds.size === callIds.size) exchanges.push({ start: index, length: end - index + 1, calls: callIds.size });
  }
  return exchanges.length > 1 ? exchanges[0] : null;
}
