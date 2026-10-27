export const MAX_TOOL_DETAIL_CHARACTERS = 12_000;
import { redactSecrets } from '../src/core/redaction.mjs';

const COMPACTION_REASONS = Object.freeze({
  context: 'context limit',
  budget: 'budget limit',
  context_and_budget: 'context and budget limits',
});

const INJECTION_SIGNAL_LABELS = Object.freeze({
  instruction_override: 'instruction override',
  role_impersonation: 'system/developer role impersonation',
  credential_exfiltration: 'credential disclosure request',
  approval_bypass: 'approval or sandbox bypass',
});
const SUPPORTED_INJECTION_SIGNAL_VERSIONS = new Set(['xyst-patterns-1', 'xyst-patterns-2', 'xyst-patterns-3']);

export function formatUntrustedContentSignal(event) {
  if (event?.type !== 'untrusted_content_signal' || !SUPPORTED_INJECTION_SIGNAL_VERSIONS.has(event.detector_version)) return null;
  const signals = Array.isArray(event.signals)
    ? [...new Set(event.signals.filter((signal) => Object.hasOwn(INJECTION_SIGNAL_LABELS, signal)))].slice(0, 4)
    : [];
  if (!signals.length) return null;
  const tool = typeof event.tool === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(event.tool) ? event.tool : 'tool';
  const labels = signals.map((signal) => INJECTION_SIGNAL_LABELS[signal]).join(', ');
  return `Possible unsafe-instruction pattern in ${tool} output (${labels}). This heuristic can be wrong and does not change tool permissions.`;
}

export function formatRunFailure(failure) {
  const code = typeof failure?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(failure.code) ? failure.code : 'RUN_FAILED';
  const message =
    typeof failure?.message === 'string' && failure.message.trim()
      ? redactSecrets(failure.message)
          .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 1000)
      : 'No error details were provided.';
  const guidance =
    code === 'REQUEST_TIMEOUT'
      ? '. The model did not respond in time; this is not a missing API key. Retry with Auto routing or choose a faster loaded model.'
      : code === 'AUTHENTICATION_FAILED'
        ? '. The provider rejected its credential. Check the selected model provider’s credential settings.'
        : code === 'CONNECTION_FAILED' || code === 'PROVIDER_UNAVAILABLE'
          ? '. Check that the selected model server is running and its endpoint is correct.'
          : '';
  return `Run failed · ${code}: ${message}${guidance}`;
}

export function formatCompactionActivity(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : event;
  if (event?.type === 'compaction_started') return `Compaction started · ${COMPACTION_REASONS[data?.trigger_reason] || 'requested'}`;
  if (event?.type === 'compaction_finished')
    return `Compaction complete · archived ${safeCount(data?.archived_messages)} messages, kept ${safeCount(data?.retained_messages)} recent${formatDuration(data?.duration_ms)}`;
  if (event?.type === 'compaction_failed') {
    const code = typeof data?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(data.code) ? data.code : 'COMPACTION_FAILED';
    return `Compaction failed · ${code}`;
  }
  return null;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : '?';
}

function formatDuration(value) {
  return Number.isFinite(value) && value >= 0 ? ` · ${Math.round(value)} ms` : '';
}

export function formatMemoryProvenance(item) {
  if (!item || typeof item !== 'object') return '';
  const source = safeMetadataLabel(redactSecrets(typeof item.source === 'string' ? item.source : 'unknown source'));
  const createdBy = safeActor(item.created_by);
  const createdAt = safeMetadataLabel(item.created_at || 'unknown time');
  const updated = item.updated_at ? ` · last edited by ${safeActor(item.updated_by)} at ${safeMetadataLabel(item.updated_at)}` : '';
  return `source: ${source} · created by ${createdBy} at ${createdAt}${updated}`;
}

function safeActor(value) {
  return ['agent', 'import', 'unknown', 'user'].includes(value) ? value : 'unknown';
}

function safeMetadataLabel(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function formatToolDetail(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    text = '[Tool details could not be displayed]';
  }
  if (typeof text !== 'string') text = String(value);
  return text.length > MAX_TOOL_DETAIL_CHARACTERS ? `${text.slice(0, MAX_TOOL_DETAIL_CHARACTERS)}\n… [details truncated]` : text;
}

export function parseStoredToolObservation(content) {
  if (typeof content !== 'string') return null;
  try {
    const value = JSON.parse(content);
    if (value?.type !== 'untrusted_observation' || value.source?.kind !== 'tool') return null;
    return {
      name: typeof value.source.name === 'string' ? value.source.name : 'Tool',
      tool_call_id: typeof value.source.tool_call_id === 'string' ? value.source.tool_call_id : null,
      trust: value.trust === 'untrusted' ? 'untrusted' : 'unspecified',
      content: value.content,
    };
  } catch {
    return null;
  }
}

export function parseStoredToolArguments(call) {
  const args = call?.function?.arguments;
  if (typeof args !== 'string') return args && typeof args === 'object' ? args : {};
  try {
    return JSON.parse(args);
  } catch {
    return { malformed_arguments: args };
  }
}
