import readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { ApprovalRuleStore } from '../tools/approval-rule-store.mjs';
import { canonicalWorkspacePath, formatArgv } from '../tools/approval-rules.mjs';
import { sanitizeTerminalText } from './terminal-text.mjs';
import { createTerminalTheme } from './terminal-theme.mjs';

/** Interactive approval with one-time, session, and narrowly scoped expiring choices. */
export async function approveInTerminal({ permission, tool, args, signal, fileChange }, assumeYes, terminalInput, workspaceRoot, io = {}) {
  const input = io.stdin || stdin;
  const output = io.stdout || stdout;
  const errors = io.stderr || stderr;
  const environment = io.environment || process.env;
  const theme = createTerminalTheme(output, environment);
  const errorTheme = createTerminalTheme(errors, environment);
  const createInterface = io.createInterface || ((options) => readline.createInterface(options));
  if (assumeYes) {
    errors.write(`${errorTheme.lime('[approval]')} --yes accepted ${tool.name}\n`);
    return true;
  }
  if (!input.isTTY || !output.isTTY) {
    errors.write(
      `${errorTheme.warning('[approval]')} denied because no interactive terminal is available; use --yes only when you intend to approve tool changes\n`,
    );
    return false;
  }
  const terminal = terminalInput || createInterface({ input, output, terminal: true });
  try {
    if (['write_file', 'edit_file'].includes(tool.name) && fileChange) output.write(renderFileChange(fileChange, theme));
    const canGrantPath = ['write_file', 'edit_file'].includes(tool.name);
    const exactCommand = tool.name === 'run_process' ? formatArgv([args.command, ...(args.args || [])]) : null;
    const canGrantCommand = exactCommand !== null && !/[?*]/.test(exactCommand);
    const choices = [
      '[y] once',
      '[s] same exact action for this session',
      ...(canGrantPath ? ['[p] this exact workspace path for 1 hour'] : []),
      ...(canGrantCommand ? ['[c] this exact command for 1 hour'] : []),
      '[N] deny',
    ].join(', ');
    if (signal?.aborted) return false;
    if (typeof output.write === 'function')
      output.write(`${theme.warning('[approval]')} Review the proposed action and approve only what you intend.\n`);
    const answer = await terminal.question(`Approve ${permission.summary}? Arguments: ${JSON.stringify(args)} (${choices}): `, { signal });
    if (/^s$/i.test(answer.trim())) return { approved: true, grant_scope: 'session', grant_duration_ms: 60 * 60 * 1000 };
    if (/^p$/i.test(answer.trim()) && canGrantPath) {
      const pattern = await canonicalWorkspacePath(workspaceRoot, args.path);
      await new ApprovalRuleStore(workspaceRoot).add({
        tool: tool.name,
        scope: 'path_glob',
        pattern,
        decision: 'allow',
        durationMs: 60 * 60 * 1000,
      });
      return true;
    }
    if (/^c$/i.test(answer.trim()) && canGrantCommand) {
      await new ApprovalRuleStore(workspaceRoot).add({
        tool: tool.name,
        scope: 'command_glob',
        pattern: exactCommand,
        decision: 'allow',
        durationMs: 60 * 60 * 1000,
      });
      return true;
    }
    return /^y(es)?$/i.test(answer.trim());
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return false;
    throw error;
  } finally {
    if (!terminalInput) terminal.close();
  }
}

function renderFileChange(preview, theme) {
  const location = typeof preview.path === 'string' ? sanitizeTerminalText(preview.path) : '(unknown path)';
  const operation = typeof preview.operation === 'string' ? sanitizeTerminalText(preview.operation) : 'file change';
  let details;
  if (typeof preview.diff === 'string' && preview.diff) {
    details = sanitizeTerminalText(preview.diff);
    if (!details.endsWith('\n')) details += '\n';
  } else {
    const reason =
      typeof preview.unavailable_reason === 'string' ? sanitizeTerminalText(preview.unavailable_reason) : 'No text preview is available.';
    details = `[Diff unavailable: ${reason}]\n`;
  }
  return `\n${theme.violet(`[${operation}]`)} ${theme.cyan(location)}\n${details}`;
}
