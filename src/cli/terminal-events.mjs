import { sanitizeTerminalText } from './terminal-text.mjs';
import { createTerminalTheme } from './terminal-theme.mjs';
import { redactSecrets } from '../platform/redaction.mjs';
import { formatModelFallbackActivity } from '../core/model-fallback.mjs';

export function writeRuntimeEvent(event, { stdout, stderr, jsonOutput = false }) {
  if (jsonOutput) return;
  const theme = createTerminalTheme(stderr);
  if (event.type === 'tool_proposed')
    stderr.write(
      `\n${theme.cyan('[tool]')} ${sanitizeTerminalText(event.tool)}: ${sanitizeTerminalText(event.permission?.summary || event.permission?.reason)}\n`,
    );
  if (event.type === 'model_call_started')
    stderr.write(
      `\n${theme.cyan(`[${sanitizeTerminalText(event.model)}, turn ${safeCount(event.turn, '?')}]`)} ${theme.violet('Thinking...')}\n`,
    );
  if (event.type === 'model_fallback')
    stderr.write(`${theme.warning(`[model] ${sanitizeTerminalText(formatModelFallbackActivity(event))}`)}\n`);
  if (event.type === 'assistant_delta') stdout.write(sanitizeTerminalText(event.text));
  if (event.type === 'tool_started') stderr.write(`${theme.cyan('[tool]')} ${sanitizeTerminalText(event.tool)} started\n`);
  if (event.type === 'tool_finished') {
    const duration = Number.isFinite(event.duration_ms) && event.duration_ms >= 0 ? ` in ${Math.round(event.duration_ms)} ms` : '';
    const hunks = Array.isArray(event.applied_hunks) ? ` (${event.applied_hunks.length} diff hunks applied)` : '';
    const summary = typeof event.summary === 'string' ? sanitizeTerminalText(redactSecrets(event.summary)).slice(0, 240) : '';
    stderr.write(
      `${theme.mint('[tool]')} ${sanitizeTerminalText(event.tool)} finished${duration}${hunks}${summary ? ` — ${summary}` : ''}\n`,
    );
  }
  if (event.type === 'compaction_started')
    stderr.write(`${theme.violet('[compaction]')} started (${formatCompactionReason(event.trigger_reason)})\n`);
  if (event.type === 'compaction_finished') {
    const duration = Number.isFinite(event.duration_ms) && event.duration_ms >= 0 ? ` in ${Math.round(event.duration_ms)} ms` : '';
    stderr.write(
      `${theme.violet('[compaction]')} complete: archived ${safeCount(event.archived_messages, '?')} messages, kept ${safeCount(event.retained_messages, '?')} recent${duration}\n`,
    );
  }
  if (event.type === 'compaction_failed') {
    const code = typeof event.code === 'string' ? sanitizeTerminalText(event.code).slice(0, 80) : 'COMPACTION_FAILED';
    const message = typeof event.message === 'string' ? sanitizeTerminalText(redactSecrets(event.message)).slice(0, 500) : '';
    stderr.write(`${theme.danger('[compaction]')} failed (${code})${message ? `: ${message}` : ''}\n`);
  }
  if (event.type === 'run_finished' || event.type === 'run_stopped') stdout.write('\n');
  if (event.type === 'tool_failed')
    stderr.write(`${theme.danger('[tool error]')} ${sanitizeTerminalText(event.tool)}: ${sanitizeTerminalText(event.message)}\n`);
  if (event.type === 'run_failed') {
    const message = typeof event.message === 'string' ? event.message : 'The run failed without an error message.';
    stderr.write(`${theme.danger('[run error]')} ${sanitizeTerminalText(redactSecrets(message)).slice(0, 2000)}\n`);
  }
  if (event.type === 'tool_grant_limit_reached')
    stderr.write(
      `${theme.warning('[approval]')} session already has ${safeCount(event.limit, '?')} active grants; this approval applies only to the current action\n`,
    );
  if (event.type === 'run_stopped') stderr.write(`${theme.violet('[stopped]')} ${sanitizeTerminalText(event.reason)}\n`);
}

function safeCount(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : fallback;
}

function formatCompactionReason(reason) {
  if (reason === 'context') return 'context limit';
  if (reason === 'budget') return 'budget limit';
  if (reason === 'context_and_budget') return 'context and budget limits';
  return 'requested';
}
