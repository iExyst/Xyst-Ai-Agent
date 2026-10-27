import { sanitizeTerminalText } from './terminal-text.mjs';

export const CLI_HISTORY_LIMIT = 100;
const MAX_HISTORY_ENTRY_CHARS = 20_000;

/** Return recent user prompts in readline's newest-first history order. */
export function sessionPromptHistory(session, limit = CLI_HISTORY_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('history limit must be a non-negative integer');
  const result = [];
  const seen = new Set();
  for (let index = (session?.messages?.length || 0) - 1; index >= 0 && result.length < limit; index -= 1) {
    const message = session.messages[index];
    if (message?.role !== 'user' || typeof message.content !== 'string') continue;
    const prompt = sanitizeTerminalText(message.content);
    if (!prompt.trim() || prompt.length > MAX_HISTORY_ENTRY_CHARS || seen.has(prompt)) continue;
    seen.add(prompt);
    result.push(prompt);
  }
  return result;
}
