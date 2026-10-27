import path from 'node:path';
import fs from 'node:fs/promises';
import { resolveToolPath, isPathInside } from '../platform/paths.mjs';
import { isSensitivePath } from '../platform/redaction.mjs';

/** Evaluate explicit workspace policy after hard runtime denials but before
 * asking the user. Deny rules always win; allow rules never broaden a path
 * beyond the canonical workspace target or a process beyond its argv pattern.
 */
export async function evaluateApprovalRules({ workspaceRoot, config = {}, tool, args, ruleStore = null }) {
  const rules = config.approvals || {};
  const dynamicRules = ruleStore ? (await ruleStore.list()).filter((rule) => rule.status === 'active' && rule.tool === tool.name) : [];
  const toolDenial = dynamicRules.find((rule) => rule.scope === 'tool' && rule.decision === 'deny');
  if (matches(rules.deny_tools, tool.name)) return deny(`tool '${tool.name}' is denied by configuration`);
  if (toolDenial) return deny(`tool '${tool.name}' is denied by an expiring approval rule`, 'persistent_rule', toolDenial.id);
  if (['read_file', 'list_dir', 'write_file', 'edit_file'].includes(tool.name) && isSensitivePath(args.path))
    return deny('path is protected by the sensitive-data policy');

  let canonicalPath = null;
  const pathRules = dynamicRules.filter((rule) => rule.scope === 'path_glob');
  if (
    ['write_file', 'edit_file'].includes(tool.name) &&
    (rules.deny_write_paths?.length || rules.auto_approve_write_paths?.length || pathRules.length)
  ) {
    try {
      canonicalPath = await canonicalToolPath(workspaceRoot, args.path, config.tools?.filesystem_scope === 'machine');
    } catch {
      return deny('path could not be verified within the configured filesystem scope');
    }
    if (isSensitivePath(canonicalPath)) return deny('canonical path is protected by the sensitive-data policy');
    const pathDenial = pathRules.find(
      (rule) =>
        rule.decision === 'deny' &&
        matchesGlob(rule.pattern, canonicalPath, { pathMode: true, caseInsensitive: process.platform === 'win32' }),
    );
    if (matchesAny(rules.deny_write_paths, canonicalPath, true)) return deny(`path '${canonicalPath}' is denied by configuration`);
    if (pathDenial) return deny(`path '${canonicalPath}' is denied by an expiring approval rule`, 'persistent_rule', pathDenial.id);
  }

  let command = null;
  let commandRules = [];
  if (['run_process', 'start_background_process'].includes(tool.name)) {
    command = formatArgv([args.command, ...(args.args || [])]);
    commandRules = dynamicRules.filter((rule) => rule.scope === 'command_glob');
    const commandDenial = commandRules.find((rule) => rule.decision === 'deny' && matchesGlob(rule.pattern, command));
    if (matchesAny(rules.deny_process_commands, command)) return deny(`command '${command}' is denied by configuration`);
    if (commandDenial) return deny(`command '${command}' is denied by an expiring approval rule`, 'persistent_rule', commandDenial.id);
  }

  const pathAllow = pathRules.find(
    (rule) =>
      rule.decision === 'allow' &&
      canonicalPath !== null &&
      matchesGlob(rule.pattern, canonicalPath, { pathMode: true, caseInsensitive: process.platform === 'win32' }),
  );
  if (canonicalPath !== null && matchesAny(rules.auto_approve_write_paths, canonicalPath, true))
    return allow(`path '${canonicalPath}' is allowed by configuration`);
  if (pathAllow) return allow(`path '${canonicalPath}' is allowed by an expiring approval rule`, 'persistent_rule', pathAllow.id);

  const commandAllow = commandRules.find((rule) => rule.decision === 'allow' && command !== null && matchesGlob(rule.pattern, command));
  if (command !== null && matchesAny(rules.auto_approve_process_commands, command))
    return allow(`command '${command}' is allowed by configuration`);
  if (commandAllow) return allow(`command '${command}' is allowed by an expiring approval rule`, 'persistent_rule', commandAllow.id);

  const toolAllow = dynamicRules.find((rule) => rule.scope === 'tool' && rule.decision === 'allow');
  if (toolAllow) return allow(`tool '${tool.name}' is allowed by an expiring approval rule`, 'persistent_rule', toolAllow.id);
  if (matches(rules.auto_approve_tools, tool.name)) return allow(`tool '${tool.name}' is allowed by configuration`);
  return null;
}

export function matchesGlob(pattern, value, { pathMode = false, caseInsensitive = false } = {}) {
  const escapeCharacter = (character) => (/[|\\{}()[\]^$+?.]/.test(character) ? `\\${character}` : character);
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      index += 1;
      if (pathMode && pattern[index + 1] === '/') {
        index += 1;
        source += '(?:.*/)?';
      } else source += '.*';
    } else if (character === '*') source += pathMode ? '[^/]*' : '.*';
    else if (character === '?') source += pathMode ? '[^/]' : '.';
    else source += escapeCharacter(character);
  }
  return new RegExp(`^${source}$`, caseInsensitive ? 'i' : '').test(value);
}

function matchesAny(patterns, value, pathMode = false) {
  return (
    Array.isArray(patterns) &&
    patterns.some((pattern) =>
      matchesGlob(pattern, value, {
        pathMode,
        caseInsensitive: process.platform === 'win32',
      }),
    )
  );
}

function matches(patterns, value) {
  return Array.isArray(patterns) && patterns.includes(value);
}

export async function canonicalWorkspacePath(root, requestedPath) {
  const realRoot = await fs.realpath(root);
  const resolved = await resolveToolPath(realRoot, requestedPath);
  return path.relative(realRoot, resolved).split(path.sep).join('/') || '.';
}

async function canonicalToolPath(root, requestedPath, machineScope) {
  const realRoot = await fs.realpath(root);
  const resolved = await resolveToolPath(realRoot, requestedPath, { machineScope });
  if (isPathInside(realRoot, resolved)) return path.relative(realRoot, resolved).split(path.sep).join('/') || '.';
  return resolved.split(path.sep).join('/');
}

export function formatArgv(argv) {
  return argv.map((part) => (/^[A-Za-z0-9_./:=+-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

function deny(reason, source = 'configuration', ruleId = null) {
  return { decision: 'deny', reason, source, rule_id: ruleId };
}
function allow(reason, source = 'configuration', ruleId = null) {
  return { decision: 'allow', reason, source, rule_id: ruleId };
}
