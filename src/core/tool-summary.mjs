const KNOWN_STATUSES = new Set(['written', 'edited', 'complete', 'completed', 'failed', 'stopped', 'cancelled', 'timed_out']);

/** Produce a metadata-only progress summary. Tool output and paths are never copied into the event. */
export function summarizeToolResult(tool, result) {
  const value = typeof result === 'string' ? parseResult(result) : result;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'Completed; result is in the conversation.';

  if (tool === 'read_file' && typeof value.content === 'string') {
    const bytes = Buffer.byteLength(value.content);
    let lines = 0;
    for (const character of value.content) if (character === '\n') lines += 1;
    if (value.content.length && !value.content.endsWith('\n')) lines += 1;
    return `Read ${lines} lines (${bytes} bytes).`;
  }
  if (tool === 'list_dir' && Array.isArray(value.entries))
    return `Listed ${value.entries.length} entries${value.truncated === true ? ' (more available)' : ''}.`;
  if (tool === 'write_file' && Number.isSafeInteger(value.bytes_written) && value.bytes_written >= 0)
    return `Wrote ${value.bytes_written} bytes.`;
  if (tool === 'edit_file') return value.status === 'edited' ? 'Applied the file edit.' : 'Completed the file edit.';
  if (tool === 'run_process' || tool === 'run_shell_script') {
    const code = Number.isInteger(value.exitCode) ? value.exitCode : 'unknown';
    const stdout = typeof value.stdout === 'string' ? Buffer.byteLength(value.stdout) : 0;
    const stderr = typeof value.stderr === 'string' ? Buffer.byteLength(value.stderr) : 0;
    const stdinError =
      typeof value.stdinErrorCode === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(value.stdinErrorCode)
        ? `; stdin error ${value.stdinErrorCode}`
        : '';
    return `Process exited ${code}; ${stdout} stdout bytes, ${stderr} stderr bytes${stdinError}.`;
  }
  if (tool === 'delegate_task' || tool === 'retry_subagent_task') {
    const status = KNOWN_STATUSES.has(value.status) ? value.status : 'finished';
    const paths = Array.isArray(value.changed_paths) ? value.changed_paths.length : 0;
    return `Child task ${status}; ${paths} changed paths reported.`;
  }
  if (tool === 'web_search' && Array.isArray(value.results)) return `Found ${value.results.length} results.`;
  if (tool === 'web_fetch' && typeof value.content === 'string')
    return `Read ${value.content.length} characters from source${value.truncated ? ' (truncated)' : ''}.`;

  return 'Completed; result is in the conversation.';
}

function parseResult(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
