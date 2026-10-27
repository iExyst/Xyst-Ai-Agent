const EXACT_TOKEN_PATTERNS = [
  /\b(?:answer|respond|reply|return)\s+exactly\s+(?:the\s+)?(?:single\s+token\s+)?([A-Z][A-Z0-9_-]{0,63})\b/g,
  /\bentire\s+final\s+response\s+must\s+be\s+the\s+single\s+token\s+([A-Z][A-Z0-9_-]{0,63})\b/g,
];

export function requestedExactFinalToken(prompt) {
  if (typeof prompt !== 'string') return null;
  const candidates = new Set();
  for (const pattern of EXACT_TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of prompt.matchAll(pattern)) candidates.add(match[1]);
  }
  return candidates.size === 1 ? candidates.values().next().value : null;
}

export function normalizeExactFinalToken(prompt, response) {
  const requested = requestedExactFinalToken(prompt);
  if (!requested || typeof response !== 'string') return response;
  const finalLine = response.trim().split(/\r?\n/).at(-1)?.trim();
  return finalLine === requested ? requested : response;
}
