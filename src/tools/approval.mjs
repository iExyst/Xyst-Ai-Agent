import { redactSecrets } from '../platform/redaction.mjs';

export function decideToolPermission(tool, args, { shellEnabled = false, unrestricted = false } = {}) {
  if (unrestricted) return { decision: 'allow', source: 'unrestricted_autonomy', reason: 'unrestricted autonomy is enabled' };
  if (
    [
      'run_process',
      'run_shell_script',
      'computer_control',
      'start_background_process',
      'send_background_input',
      'list_background_processes',
      'read_background_process',
      'stop_background_process',
    ].includes(tool.name) &&
    !shellEnabled
  )
    return { decision: 'deny', reason: 'process execution is disabled in configuration' };
  if (tool.approval === 'auto' && !tool.destructive) return { decision: 'allow', reason: 'read-only tool' };
  return {
    decision: 'require_approval',
    reason: tool.destructive ? 'tool can modify files or run a process' : 'tool policy requires confirmation',
    summary: summarize(tool.name, args),
  };
}

function summarize(name, args) {
  if (name === 'web_search') return `Send this query to the configured web search provider: ${JSON.stringify(args.query)}`;
  if (name === 'web_fetch') return `Read this source URL: ${JSON.stringify(redactSecrets(args.url))}`;
  if (name === 'semantic_search')
    return `Send redacted workspace text and this query to the configured embedding service: ${JSON.stringify(args.query)}`;
  if (name === 'delegate_task') return `Create a separate Git worktree and delegate: ${JSON.stringify(args.task.slice(0, 240))}`;
  if (name === 'write_file') return `Write ${args.path}`;
  if (name === 'edit_file') return `Edit ${args.path}`;
  if (name === 'propose_memory')
    return `Save to project memory (${args.section}): ${JSON.stringify(redactSecrets(args.text).slice(0, 240))}`;
  if (name === 'propose_global_memory')
    return `Save to global memory (${args.section}): ${JSON.stringify(redactSecrets(args.text).slice(0, 240))}`;
  if (name === 'run_shell_script') return `Run native shell script: ${JSON.stringify(args.script.slice(0, 240))}`;
  if (name === 'computer_control') {
    if (['click_at', 'scroll_at'].includes(args.action))
      return `Use desktop ${args.action} at screen coordinates (${args.x}, ${args.y})${args.action === 'click_at' ? ` with ${args.button || 'left'} button` : ` by ${args.delta_y} wheel units`}`;
    return `Use desktop accessibility action ${args.action}${args.expected_name ? ` on ${JSON.stringify(args.expected_name)}` : ''}`;
  }
  if (['run_process', 'start_background_process'].includes(name))
    return `Run ${args.command}${args.args?.length ? ` ${args.args.join(' ')}` : ''}${args.cwd ? ` in ${args.cwd}` : ''}`;
  if (name === 'stop_background_process') return `Stop process ${args.id}`;
  if (name === 'send_background_input') return `Send input to process ${args.id}`;
  return `Run ${name}`;
}
