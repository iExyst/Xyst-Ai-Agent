export const INJECTION_SIGNAL_VERSION = 'xyst-patterns-3';

const MAX_SCAN_CHARACTERS = 65_536;
const MAX_SCAN_NODES = 4_096;
const MAX_SCAN_DEPTH = 12;

const PATTERNS = Object.freeze([
  {
    code: 'instruction_override',
    pattern:
      /\b(?:ignore|disregard|forget|override|replace)\b[\s\S]{0,80}\b(?:all|previous|prior|above|system|developer)\b[\s\S]{0,40}\b(?:instructions?|rules?|policy|prompt)\b/i,
  },
  {
    code: 'role_impersonation',
    pattern: /^\s*(?:system|developer)\s+(?:message|prompt|instruction)\s*:/im,
  },
  {
    code: 'credential_exfiltration',
    pattern:
      /\b(?:reveal|print|expose|send|share|upload|exfiltrate|dump)\b[\s\S]{0,80}\b(?:credentials?|api[\s_-]*keys?|passwords?|secrets?|private[\s_-]*keys?|tokens?)\b/i,
  },
  {
    code: 'approval_bypass',
    pattern: /\b(?:bypass|disable|circumvent|ignore|turn off)\b[\s\S]{0,64}\b(?:approval|sandbox|safety|security policy|permissions?)\b/i,
  },
]);

/**
 * Report likely instruction-manipulation patterns without retaining or returning
 * any part of the inspected content. A missing signal is not evidence of safety.
 */
export function inspectUntrustedContent(value) {
  const text = boundedText(value);
  if (!text) return null;
  const signals = PATTERNS.filter(({ pattern }) => hasUnnegatedMatch(text, pattern)).map(({ code }) => code);
  return signals.length ? { detector_version: INJECTION_SIGNAL_VERSION, signals } : null;
}

function hasUnnegatedMatch(text, pattern) {
  const matcher = new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of text.matchAll(matcher)) {
    const precedingText = text.slice(Math.max(0, match.index - 64), match.index);
    if (
      !/\b(?:do not|don't|never|must not|should not)(?:\s*,?\s+(?:ever|under\s+any\s+circumstances|in\s+any\s+way|at\s+any\s+time|by\s+any\s+means|for\s+any\s+reason))*\s*,?\s*$/i.test(
        precedingText,
      )
    )
      return true;
  }
  return false;
}

function boundedText(root) {
  const pending = [{ value: root, depth: 0 }];
  const seen = new WeakSet();
  const parts = [];
  let remaining = MAX_SCAN_CHARACTERS;
  let visited = 0;

  try {
    while (pending.length && remaining > 0 && visited < MAX_SCAN_NODES) {
      const current = pending.pop();
      visited += 1;
      if (typeof current.value === 'string') {
        const part = current.value.slice(0, remaining);
        if (part) {
          parts.push(part);
          remaining -= part.length;
        }
        continue;
      }
      if (!current.value || typeof current.value !== 'object' || current.depth >= MAX_SCAN_DEPTH || seen.has(current.value)) continue;
      seen.add(current.value);
      const entries = [];
      const remainingNodes = MAX_SCAN_NODES - visited;
      if (Array.isArray(current.value)) {
        const length = Math.min(current.value.length, remainingNodes);
        for (let index = 0; index < length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index));
          if (descriptor && Object.hasOwn(descriptor, 'value')) entries.push(descriptor.value);
        }
      } else {
        for (const key in current.value) {
          if (!Object.hasOwn(current.value, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
          if (descriptor && Object.hasOwn(descriptor, 'value')) entries.push(descriptor.value);
          if (entries.length >= remainingNodes) break;
        }
      }
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (typeof entry === 'string' || (entry && typeof entry === 'object')) pending.push({ value: entry, depth: current.depth + 1 });
      }
    }
  } catch {
    // Unusual tool-result objects must never make the observation pipeline fail.
  }

  return parts.join('\n');
}
