import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { atomicWriteFile } from '../platform/files.mjs';
import { resolveWindowsPowerShellPath, runProcess } from '../platform/process.mjs';
import { resolveToolPath, displayPath } from '../platform/paths.mjs';
import { resolveToolTimeoutMs, resolveToolTimeoutSeconds, TOOL_DEFINITIONS } from './schemas.mjs';
import { searchWorkspace } from '../retrieval/search.mjs';
import { isSensitivePath, isSensitiveResolvedPath, redactSecrets, redactStructuredSecrets } from '../platform/redaction.mjs';
import { runIsolatedProcess } from '../platform/sandbox.mjs';
import { assertFileChangeUnchanged } from './file-change-preview.mjs';
import { controlDesktop } from '../platform/desktop-automation.mjs';
import { MemoryStore } from '../memory/store.mjs';
import { isReadOnlySandbox, isReadOnlyTool, requiresProcessIsolation, resolveSandboxMode } from '../platform/sandbox-modes.mjs';

const DEFAULT_OUTPUT_LIMIT = 100_000;
const DEFAULT_FILE_LIMIT = 1_000_000;

export function createBuiltinTools({
  workspaceRoot,
  config = {},
  processManager = null,
  webSearchProvider = null,
  weatherProvider = null,
  subagentManager = null,
  semanticIndex = null,
  mcpManager = null,
  skillLibrary = null,
  globalMemoryStore = null,
  desktopController = controlDesktop,
}) {
  const unrestricted = config.tools?.autonomy === 'unrestricted';
  const shellEnabled = unrestricted || config.tools?.shell_enabled === true;
  const memoryStore = new MemoryStore(workspaceRoot);
  const definitions = [
    TOOL_DEFINITIONS.read_file,
    TOOL_DEFINITIONS.list_dir,
    TOOL_DEFINITIONS.search_files,
    TOOL_DEFINITIONS.propose_memory,
    TOOL_DEFINITIONS.write_file,
    TOOL_DEFINITIONS.edit_file,
  ];
  if (config.web_search?.enabled === true && webSearchProvider) definitions.splice(3, 0, TOOL_DEFINITIONS.web_search);
  if (weatherProvider) definitions.splice(3, 0, TOOL_DEFINITIONS.get_weather);
  if (config.subagents?.enabled === true && subagentManager)
    definitions.splice(3, 0, TOOL_DEFINITIONS.delegate_task, TOOL_DEFINITIONS.retry_subagent_task);
  if (config.retrieval?.semantic?.enabled === true && semanticIndex) definitions.splice(3, 0, TOOL_DEFINITIONS.semantic_search);
  if (config.memory?.global_enabled === true && globalMemoryStore) definitions.push(TOOL_DEFINITIONS.propose_global_memory);
  if (mcpManager) definitions.push(...mcpManager.definitions);
  if (config.skills?.enabled === true && skillLibrary) definitions.push(TOOL_DEFINITIONS.list_skills, TOOL_DEFINITIONS.load_skill);
  if (shellEnabled) definitions.push(TOOL_DEFINITIONS.run_process);
  if (shellEnabled) definitions.push(TOOL_DEFINITIONS.run_shell_script);
  if (shellEnabled && !requiresProcessIsolation(resolveSandboxMode(config)) && !isReadOnlySandbox(config))
    definitions.push(TOOL_DEFINITIONS.computer_control);
  if (shellEnabled && processManager)
    definitions.push(
      TOOL_DEFINITIONS.start_background_process,
      TOOL_DEFINITIONS.list_background_processes,
      TOOL_DEFINITIONS.read_background_process,
      TOOL_DEFINITIONS.send_background_input,
      TOOL_DEFINITIONS.stop_background_process,
    );
  for (let index = definitions.length - 1; index >= 0; index -= 1) {
    const definition = definitions[index];
    if (isReadOnlySandbox(config) && !isReadOnlyTool(definition.name)) definitions.splice(index, 1);
    else if (isReadOnlySandbox(config, definition.name) && !isReadOnlyTool(definition.name)) definitions.splice(index, 1);
  }

  const execute = {
    read_file: async (args) => readFile(workspaceRoot, args, config),
    list_dir: async (args) => listDir(workspaceRoot, args, config),
    search_files: async (args) => searchFiles(workspaceRoot, args, config),
    propose_memory: async (args) => {
      const item = await memoryStore.append(args.section, args.text, { source: 'agent-proposal' });
      return { id: item.id, section: args.section, text: item.text, source: item.source };
    },
    propose_global_memory: async (args) => {
      if (!globalMemoryStore) throw new Error('Global memory is disabled in user settings');
      const item = await globalMemoryStore.append(args.section, args.text, { source: 'agent-proposal' });
      return { id: item.id, section: args.section, text: item.text, source: item.source, scope: 'global' };
    },
    semantic_search: async (args, context) =>
      semanticIndex.search(args.query, {
        limit: args.max_results || 8,
        pathGlob: args.path_glob,
        signal: context.signal,
        sessionId: context.sessionId,
        usageLimits: context.unrestricted ? {} : undefined,
        timeoutMs: resolveToolTimeoutMs(TOOL_DEFINITIONS.semantic_search, config),
      }),
    web_search: async (args, context) =>
      webSearchProvider.search(args.query, {
        signal: context.signal,
        timeoutMs: resolveToolTimeoutMs(TOOL_DEFINITIONS.web_search, config),
      }),
    get_weather: async (args, context) => weatherProvider.getWeather(args.location, { signal: context.signal }),
    delegate_task: async (args, context) =>
      subagentManager.delegate({
        task: args.task,
        parentSessionId: context.sessionId,
        signal: context.signal,
        approveTool: context.approveTool,
        remainingBudget: context.remainingBudget,
        mcpServers: context.mcpServers,
        runtimeConfig: config,
      }),
    retry_subagent_task: async (args, context) =>
      subagentManager.retry({
        taskId: args.task_id,
        parentSessionId: context.sessionId,
        signal: context.signal,
        approveTool: context.approveTool,
        remainingBudget: context.remainingBudget,
        mcpServers: context.mcpServers,
        runtimeConfig: config,
      }),
    write_file: async (args, context) => writeFile(workspaceRoot, args, config, context),
    edit_file: async (args, context) => editFile(workspaceRoot, args, config, context),
    run_process: async (args, context) => runProcessTool(workspaceRoot, args, config, context, TOOL_DEFINITIONS.run_process),
    run_shell_script: async (args, context) => runShellScriptTool(workspaceRoot, args, config, context),
    computer_control: async (args, context) => {
      const result = await desktopController(args, {
        signal: context.signal,
        unrestricted,
        timeoutMs: resolveToolTimeoutMs(TOOL_DEFINITIONS.computer_control, config),
      });
      if (args.action === 'screenshot') return result;
      return unrestricted ? result : redactStructuredSecrets(result);
    },
    start_background_process: async (args, context) =>
      processManager.start({
        ...args,
        timeout_seconds:
          unrestricted && args.timeout_seconds === undefined
            ? null
            : resolveToolTimeoutSeconds(TOOL_DEFINITIONS.start_background_process, args),
        session_id: context.sessionId,
        cwd: args.cwd || context.workspaceRoot || workspaceRoot,
      }),
    send_background_input: async (args, context) => processManager.writeInput(args.id, args.input, { session_id: context.sessionId }),
    list_background_processes: async (_args, context) => processManager.list({ session_id: context.sessionId }),
    read_background_process: async (args, context) => processManager.read(args.id, { session_id: context.sessionId }),
    stop_background_process: async (args, context) => processManager.stop(args.id, { session_id: context.sessionId }),
    list_skills: async () => (await skillLibrary.list()).map(({ name, description }) => ({ name, description, trust: 'untrusted' })),
    load_skill: async (args) => skillLibrary.load(args.name),
  };
  return {
    definitions,
    has(name) {
      return definitions.some((tool) => tool.name === name);
    },
    async call(name, args, context) {
      const tool = definitions.find((item) => item.name === name);
      if (!tool) throw new Error(`Unknown or disabled tool: ${name}`);
      let result;
      if (execute[name]) result = await execute[name](args, context);
      else if (mcpManager?.has(name)) result = await mcpManager.call(name, args, context);
      else throw new Error(`Unknown or disabled tool: ${name}`);
      if (name === 'computer_control' && args.action === 'screenshot') return result;
      return truncate(JSON.stringify(result), toolOutputLimit(config));
    },
    metadata(name) {
      return definitions.find((tool) => tool.name === name);
    },
  };
}

async function readFile(root, args, config) {
  if (!isUnrestricted(config) && isSensitivePath(args.path))
    throw new Error('Reading credential or key material is blocked by the secret-safety policy');
  const filePath = await resolveToolPath(root, args.path, { mustExist: true, machineScope: machineScope(config) });
  if (!isUnrestricted(config) && (await isSensitiveResolvedPath(root, filePath)))
    throw new Error('Reading credential or key material is blocked by the secret-safety policy');
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(filePath, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Requested path is not a file');
    // Pin reads to one opened file identity. Re-resolving after open detects
    // most parent-link swaps between path validation and open; O_NOFOLLOW
    // additionally rejects a final-component symlink where supported.
    const [openedPath, currentStat] = await Promise.all([fs.realpath(filePath), fs.stat(filePath)]);
    if (!sameResolvedPath(openedPath, filePath) || stat.dev !== currentStat.dev || stat.ino !== currentStat.ino)
      throw new Error('File changed while opening; retry the read');
    const maxReadBytes = isUnrestricted(config) ? Number.MAX_SAFE_INTEGER : config.tools?.max_file_bytes || DEFAULT_FILE_LIMIT;
    if (stat.size > maxReadBytes) throw new Error('File is too large to read through this tool');
    const start = Math.max(1, args.start_line || 1);
    const requestedEnd = args.end_line || Number.MAX_SAFE_INTEGER;
    if (requestedEnd < start) throw new Error('end_line must be greater than or equal to start_line');
    const { lines, lineCount } = await readFileLines(handle, start, requestedEnd, maxReadBytes);
    const end = Math.min(lineCount, requestedEnd);
    if (end < start) throw new Error('end_line must be greater than or equal to start_line');
    const content = lines.join('\n');
    return {
      path: displayToolPath(root, filePath),
      start_line: start,
      end_line: end,
      content: isUnrestricted(config) ? content : redactSecrets(content),
    };
  } finally {
    await handle.close();
  }
}

function sameResolvedPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

async function assertToolPathUnchanged(root, requestedPath, resolvedPath, config) {
  const currentPath = await resolveToolPath(root, requestedPath, { machineScope: machineScope(config) });
  if (!sameResolvedPath(currentPath, resolvedPath)) throw new Error('File target changed while preparing the write; retry the operation');
}

async function readFileLines(handle, startLine, endLine, maxBytes) {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const selectedLines = [];
  let buffered = '';
  let lineCount = 0;
  let bytesRead = 0;
  const addLine = (line) => {
    if (line.includes('\u0000')) throw new Error('Binary file content is not supported');
    lineCount += 1;
    if (lineCount >= startLine && lineCount <= endLine) selectedLines.push(line);
  };

  for await (const chunk of handle.createReadStream({ autoClose: false })) {
    bytesRead += chunk.byteLength;
    if (bytesRead > maxBytes) throw new Error('File is too large to read through this tool');
    try {
      buffered += decoder.decode(chunk, { stream: true });
    } catch {
      throw new Error('File is not valid UTF-8 text');
    }
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      addLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      buffered = buffered.slice(newline + 1);
    }
  }
  try {
    buffered += decoder.decode();
  } catch {
    throw new Error('File is not valid UTF-8 text');
  }
  addLine(buffered);
  return { lines: selectedLines, lineCount };
}

async function readBoundedFile(handle, maxBytes) {
  const chunks = [];
  let bytesRead = 0;
  const stream = handle.createReadStream({ autoClose: false, start: 0, highWaterMark: Math.max(1, Math.min(64 * 1024, maxBytes + 1)) });
  for await (const chunk of stream) {
    bytesRead += chunk.byteLength;
    if (bytesRead > maxBytes) throw new Error('File is too large to edit through this tool');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytesRead);
}

async function listDir(root, args, config) {
  if (!isUnrestricted(config) && isSensitivePath(args.path))
    throw new Error('Listing protected paths is blocked by the secret-safety policy');
  const base = await resolveToolPath(root, args.path, { mustExist: true, machineScope: machineScope(config) });
  if (!isUnrestricted(config) && (await isSensitiveResolvedPath(root, base)))
    throw new Error('Listing protected paths is blocked by the secret-safety policy');
  const baseStat = await fs.stat(base);
  if (!baseStat.isDirectory()) throw new Error('Requested path is not a directory');
  const recursive = args.recursive === true;
  if (recursive && config.tools?.recursive_listing !== true && !isUnrestricted(config))
    throw new Error('Recursive directory listing is disabled in configuration');
  const entries = [];
  const pending = [base];
  const maxEntries = isUnrestricted(config) ? Number.MAX_SAFE_INTEGER : config.tools?.max_list_entries || 500;
  while (pending.length && entries.length < maxEntries) {
    const current = pending.shift();
    for (const item of await fs.readdir(current, { withFileTypes: true })) {
      if (!isUnrestricted(config) && isIgnoredName(item.name)) continue;
      const absolute = path.join(current, item.name);
      const relative = displayToolPath(root, absolute);
      entries.push({ path: relative, type: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other' });
      if (recursive && item.isDirectory()) pending.push(absolute);
      if (entries.length >= maxEntries) break;
    }
  }
  return { entries, truncated: pending.length > 0 || entries.length >= maxEntries };
}

async function writeFile(root, args, config, context = {}) {
  if (!isUnrestricted(config) && isSensitivePath(args.path))
    throw new Error('Writing credential or key files is blocked by the secret-safety policy');
  const content = context.approvedFileContent ?? args.content;
  if (!isUnrestricted(config) && Buffer.byteLength(content) > (config.tools?.max_write_bytes || DEFAULT_FILE_LIMIT))
    throw new Error('File content exceeds the configured write limit');
  const filePath = await resolveToolPath(root, args.path, { machineScope: machineScope(config) });
  if (!isUnrestricted(config) && (await isSensitiveResolvedPath(root, filePath)))
    throw new Error('Writing credential or key files is blocked by the secret-safety policy');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWrite(filePath, content, {
    beforeReplace: async () => {
      await assertToolPathUnchanged(root, args.path, filePath, config);
      await assertFileChangeUnchanged(root, args, config, context.expectedFileChange);
    },
  });
  return { path: displayToolPath(root, filePath), bytes_written: Buffer.byteLength(content), status: 'written' };
}

async function editFile(root, args, config, context = {}) {
  if (!isUnrestricted(config) && isSensitivePath(args.path))
    throw new Error('Editing credential or key files is blocked by the secret-safety policy');
  if (!args.old_string) throw new Error('old_string must not be empty');
  const filePath = await resolveToolPath(root, args.path, { mustExist: true, machineScope: machineScope(config) });
  if (!isUnrestricted(config) && (await isSensitiveResolvedPath(root, filePath)))
    throw new Error('Editing credential or key files is blocked by the secret-safety policy');
  await assertFileChangeUnchanged(root, args, config, context.expectedFileChange);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(filePath, constants.O_RDONLY | noFollow);
  let updated;
  let sourceSnapshot;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Requested path is not a file');
    const [openedPath, currentStat] = await Promise.all([fs.realpath(filePath), fs.stat(filePath)]);
    if (!sameResolvedPath(openedPath, filePath) || stat.dev !== currentStat.dev || stat.ino !== currentStat.ino)
      throw new Error('File changed while opening; retry the edit');
    const maxReadBytes = isUnrestricted(config) ? Number.MAX_SAFE_INTEGER : config.tools?.max_file_bytes || DEFAULT_FILE_LIMIT;
    if (stat.size > maxReadBytes) throw new Error('File is too large to edit through this tool');
    const bytes = await readBoundedFile(handle, maxReadBytes);
    let source;
    try {
      source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new Error('File is not valid UTF-8 text');
    }
    if (source.includes('\u0000')) throw new Error('Binary file content is not supported');
    const first = source.indexOf(args.old_string);
    if (first < 0) throw new Error('old_string was not found; no changes made');
    if (source.indexOf(args.old_string, first + args.old_string.length) >= 0)
      throw new Error('old_string matched multiple places; provide a more specific block');
    updated = context.approvedFileContent ?? source.slice(0, first) + args.new_string + source.slice(first + args.old_string.length);
    if (!isUnrestricted(config) && Buffer.byteLength(updated) > (config.tools?.max_write_bytes || DEFAULT_FILE_LIMIT))
      throw new Error('Updated file exceeds the configured write limit');
    sourceSnapshot = { target: filePath, exists: true, sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
  await atomicWrite(filePath, updated, {
    beforeReplace: async () => {
      await assertToolPathUnchanged(root, args.path, filePath, config);
      await assertFileChangeUnchanged(root, args, config, sourceSnapshot);
      await assertFileChangeUnchanged(root, args, config, context.expectedFileChange);
    },
  });
  return { path: displayToolPath(root, filePath), status: 'edited' };
}

async function searchFiles(root, args, config) {
  const searchRoot = args.root_path
    ? await resolveToolPath(root, args.root_path, { mustExist: true, machineScope: machineScope(config) })
    : await fs.realpath(root);
  if (args.root_path && !machineScope(config) && path.isAbsolute(args.root_path))
    throw new Error('Absolute search roots require machine filesystem scope');
  return searchWorkspace(searchRoot, args.query, {
    ...config.retrieval,
    pathGlob: args.path_glob,
    maxResults: args.max_results || config.retrieval?.max_results || 25,
    includeSensitive: isUnrestricted(config),
    redactOutput: !isUnrestricted(config),
    includeIgnored: isUnrestricted(config),
    absolutePaths: Boolean(args.root_path && machineScope(config) && path.isAbsolute(args.root_path)),
  });
}

async function runProcessTool(root, args, config, context = {}, definition = TOOL_DEFINITIONS.run_process) {
  if (!isShellEnabled(config)) throw new Error('Process execution is disabled');
  const options = {
    cwd: args.cwd ? await resolveToolPath(root, args.cwd, { mustExist: true, machineScope: machineScope(config) }) : root,
    timeoutMs: isUnrestricted(config) && args.timeout_seconds === undefined ? null : resolveToolTimeoutSeconds(definition, args) * 1000,
    maxOutputBytes: toolOutputLimit(config),
    signal: context.signal,
    ...(args.stdin !== undefined ? { input: args.stdin } : {}),
    ...(isUnrestricted(config) ? { env: process.env } : {}),
  };
  const sandboxMode = resolveSandboxMode(config, definition.name);
  if (sandboxMode === 'read-only') throw new Error('Process execution is disabled by the read-only sandbox policy');
  const sandboxedMode = requiresProcessIsolation(sandboxMode);
  const result = sandboxedMode
    ? await runIsolatedProcess(args.command, args.args || [], {
        ...options,
        workspaceRoot: await fs.realpath(root),
        sandboxMode,
      })
    : await runProcess(args.command, args.args || [], options);
  return {
    ...result,
    sandboxed: sandboxedMode ? result.sandboxed === true : false,
    stdout: isUnrestricted(config) ? result.stdout : redactSecrets(result.stdout),
    stderr: isUnrestricted(config) ? result.stderr : redactSecrets(result.stderr),
  };
}

async function runShellScriptTool(root, args, config, context = {}) {
  if (!isShellEnabled(config))
    throw new Error('Shell script execution requires tools.shell_enabled = true or tools.autonomy = "unrestricted"');
  if (process.platform !== 'win32' && process.platform !== 'linux')
    throw new Error(`Native shell script execution is not implemented for ${process.platform}`);
  const command = process.platform === 'win32' ? resolveWindowsPowerShellPath() : '/bin/bash';
  if (!command) throw new Error('Windows PowerShell was not found under SystemRoot or WINDIR');
  const shellArgs =
    process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', args.script] : ['-c', args.script];
  return runProcessTool(
    root,
    { command, args: shellArgs, cwd: args.cwd, timeout_seconds: args.timeout_seconds },
    config,
    context,
    TOOL_DEFINITIONS.run_shell_script,
  );
}

function isUnrestricted(config) {
  return config.tools?.autonomy === 'unrestricted';
}
function machineScope(config) {
  return isUnrestricted(config) || config.tools?.filesystem_scope === 'machine';
}
function isShellEnabled(config) {
  return isUnrestricted(config) || config.tools?.shell_enabled === true;
}
function toolOutputLimit(config) {
  return isUnrestricted(config) ? Number.MAX_SAFE_INTEGER : config.budgets?.max_tool_output_bytes || DEFAULT_OUTPUT_LIMIT;
}

async function atomicWrite(filePath, content, options) {
  await atomicWriteFile(filePath, content, options);
}
function displayToolPath(root, filePath) {
  return path.relative(root, filePath).split(path.sep)[0] === '..' ? filePath : displayPath(root, filePath);
}
function isIgnoredName(name) {
  return name === '.git' || name === '.agent' || name === 'node_modules' || name === 'dist' || name === 'coverage';
}
function truncate(text, maxBytes) {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  return `${buffer.subarray(0, Math.max(0, maxBytes - 64)).toString('utf8')}\n[tool output truncated at ${maxBytes} bytes]`;
}
