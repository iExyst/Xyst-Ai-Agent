import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WINDOWS_HELPER_RESPONSE_LIMIT = 4 * 1024 * 1024;
const WORKSPACE_GUARD_FAILURE_PREFIX = 'XYST_WORKSPACE_IDENTITY_MISMATCH:';

/** Return the command line for an isolated Linux process.
 * The host filesystem is not mounted wholesale: only system executables,
 * runtime libraries, the selected workspace, and private temporary mounts are
 * visible. The workspace is the only writable host mount.
 */
export function buildBubblewrapArgs({
  workspaceRoot,
  command,
  args = [],
  bwrap = 'bwrap',
  cwd = '/workspace',
  workspaceReadOnly = false,
  readOnlyMounts = [],
  workspaceIdentity,
  workspaceIdentityFailureToken,
  platform = process.platform,
}) {
  if (platform !== 'linux') throw new Error('Bubblewrap isolation is available only on Linux');
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot))
    throw new TypeError('Sandbox workspaceRoot must be an absolute path');
  if (path.posix.resolve(workspaceRoot) === '/')
    throw Object.assign(new Error('The filesystem root cannot be used as a Bubblewrap workspace'), { code: 'SANDBOX_WORKSPACE_UNSAFE' });
  if (typeof command !== 'string' || !command.trim()) throw new TypeError('Sandbox command must be a non-empty string');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('Sandbox args must be an array of strings');
  if (typeof bwrap !== 'string' || !bwrap.trim()) throw new TypeError('Bubblewrap executable must be a non-empty string');
  if (!isSandboxPath(cwd)) throw new TypeError('Sandbox cwd must be an absolute in-sandbox path without traversal');
  if (typeof workspaceIdentity !== 'string' || !/^\d+:\d+$/.test(workspaceIdentity))
    throw new TypeError('Sandbox workspace identity must contain a device and inode');
  if (typeof workspaceIdentityFailureToken !== 'string' || !/^[0-9a-f-]{36}$/i.test(workspaceIdentityFailureToken))
    throw new TypeError('Sandbox workspace identity failure token must be a UUID');
  if (typeof workspaceReadOnly !== 'boolean') throw new TypeError('Sandbox workspaceReadOnly must be a boolean');
  if (!Array.isArray(readOnlyMounts) || readOnlyMounts.length > 16)
    throw new TypeError('Sandbox readOnlyMounts must contain at most 16 mounts');
  const targets = new Set();
  const mountTargets = [];
  for (const mount of readOnlyMounts) {
    if (
      !mount ||
      typeof mount !== 'object' ||
      Array.isArray(mount) ||
      Object.keys(mount).some((key) => !['source', 'target', 'directory'].includes(key)) ||
      typeof mount.source !== 'string' ||
      !path.isAbsolute(mount.source) ||
      typeof mount.target !== 'string' ||
      !isSandboxPath(mount.target) ||
      !mount.target.startsWith('/xyst-') ||
      (mount.directory !== undefined && typeof mount.directory !== 'boolean') ||
      targets.has(mount.target) ||
      mountTargets.some((target) => target.startsWith(`${mount.target}/`) || mount.target.startsWith(`${target}/`))
    )
      throw new TypeError('Sandbox read-only mount has an invalid source or target');
    targets.add(mount.target);
    mountTargets.push(mount.target);
  }

  const commandArgs = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-net',
    '--disable-userns',
    '--assert-userns-disabled',
    '--cap-drop',
    'ALL',
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin:/bin',
    '--setenv',
    'HOME',
    '/tmp',
    '--setenv',
    'TMPDIR',
    '/tmp',
    '--ro-bind',
    '/usr',
    '/usr',
    '--symlink',
    'usr/bin',
    '/bin',
    '--symlink',
    'usr/sbin',
    '/sbin',
    '--symlink',
    'usr/lib',
    '/lib',
    '--symlink',
    'usr/lib64',
    '/lib64',
    '--ro-bind',
    '/etc',
    '/etc',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    workspaceReadOnly ? '--ro-bind' : '--bind',
    workspaceRoot,
    '/workspace',
  ];
  const createdDirectories = new Set();
  for (const mount of readOnlyMounts) {
    const parent = path.posix.dirname(mount.target);
    const directories = [];
    let current = parent;
    while (current !== '/') {
      directories.unshift(current);
      current = path.posix.dirname(current);
    }
    for (const directory of directories) {
      if (createdDirectories.has(directory)) continue;
      createdDirectories.add(directory);
      commandArgs.push('--dir', directory);
    }
    if (mount.directory === true) commandArgs.push('--dir', mount.target);
    commandArgs.push('--ro-bind', mount.source, mount.target);
  }
  const workspaceGuard =
    'expected="$1"; failure="$2"; shift 2; actual=$(/usr/bin/stat -c "%d:%i" /workspace 2>/dev/null) || { printf "%s\\n" "$failure" >&2; exit 125; }; if [ "$actual" != "$expected" ]; then printf "%s\\n" "$failure" >&2; exit 125; fi; exec "$@"';
  commandArgs.push(
    '--chdir',
    cwd,
    '--json-status-fd',
    '3',
    '--',
    '/bin/sh',
    '-c',
    workspaceGuard,
    'xyst-workspace-guard',
    workspaceIdentity,
    `${WORKSPACE_GUARD_FAILURE_PREFIX}${workspaceIdentityFailureToken}`,
    command,
    ...args,
  );
  return commandArgs;
}

/** Keep the host-side Bubblewrap process free of caller-controlled runtime injection. */
export function bubblewrapLauncherEnvironment() {
  return { PATH: '/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp' };
}

/**
 * A bind-mounted workspace must not expose an inode that also has a name
 * outside the workspace. Count links in the tree so ordinary in-workspace
 * hard links remain usable (for example, package-manager layouts).
 */
export async function validateBubblewrapWorkspace(workspaceRoot, { platform = process.platform, mountInfo, includeIdentity = false } = {}) {
  if (platform !== 'linux') throw new Error('Bubblewrap workspace validation is available only on Linux');
  if (typeof workspaceRoot !== 'string' || !path.isAbsolute(workspaceRoot))
    throw new TypeError('Sandbox workspaceRoot must be an absolute path');

  const root = await fs.realpath(workspaceRoot);
  if (path.posix.resolve(root) === '/')
    throw Object.assign(new Error('The filesystem root cannot be used as a Bubblewrap workspace'), { code: 'SANDBOX_WORKSPACE_UNSAFE' });
  const rootStat = await fs.lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw Object.assign(new Error('Bubblewrap workspace must resolve to a real directory'), { code: 'SANDBOX_WORKSPACE_INVALID' });
  const filesystemRootStat = await fs.stat('/', { bigint: true });
  if (rootStat.dev === filesystemRootStat.dev && rootStat.ino === filesystemRootStat.ino)
    throw Object.assign(new Error('The filesystem root cannot be used as a Bubblewrap workspace'), { code: 'SANDBOX_WORKSPACE_UNSAFE' });

  // st_dev alone misses bind mounts on the same filesystem. Linux mountinfo
  // identifies those boundaries so the hard-link scan cannot silently skip names.
  const activeMountInfo = mountInfo ?? (process.platform === 'linux' ? await fs.readFile('/proc/self/mountinfo', 'utf8') : null);
  if (activeMountInfo !== null) {
    for (const mountpoint of parseLinuxMountPoints(activeMountInfo)) {
      if (mountpoint !== root && isPathWithin(root, mountpoint, path)) {
        throw Object.assign(new Error(`Bubblewrap workspace contains a nested filesystem mount: ${mountpoint}`), {
          code: 'SANDBOX_WORKSPACE_UNSAFE',
        });
      }
    }
  }

  const pending = [root];
  const files = new Map();
  while (pending.length) {
    const directory = pending.pop();
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const stat = await fs.lstat(entryPath, { bigint: true });
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        // Keep the scan on one filesystem as a fallback if mountinfo is absent.
        if (stat.dev !== rootStat.dev) {
          throw Object.assign(new Error(`Bubblewrap workspace contains a nested filesystem mount: ${entryPath}`), {
            code: 'SANDBOX_WORKSPACE_UNSAFE',
          });
        }
        pending.push(entryPath);
        continue;
      }
      if (!stat.isFile()) {
        throw Object.assign(new Error(`Bubblewrap workspace contains an unsupported special file: ${entryPath}`), {
          code: 'SANDBOX_WORKSPACE_UNSAFE',
        });
      }
      if (stat.nlink <= 1n) continue;
      const identity = `${stat.dev}:${stat.ino}`;
      const record = files.get(identity) || { count: 0, links: stat.nlink, path: entryPath };
      record.count += 1;
      if (stat.nlink > record.links) record.links = stat.nlink;
      files.set(identity, record);
    }
  }

  for (const record of files.values()) {
    if (record.links > BigInt(record.count)) {
      throw Object.assign(new Error(`Bubblewrap workspace contains a file hard-linked outside the workspace: ${record.path}`), {
        code: 'SANDBOX_WORKSPACE_UNSAFE',
      });
    }
  }
  return includeIdentity ? { path: root, identity: `${rootStat.dev}:${rootStat.ino}` } : root;
}

function parseLinuxMountPoints(mountInfo) {
  if (typeof mountInfo !== 'string') throw new TypeError('Linux mount information must be text');
  return mountInfo
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const fields = line.split(' ');
      if (fields.length < 6) throw Object.assign(new Error('Linux mount information is malformed'), { code: 'SANDBOX_WORKSPACE_INVALID' });
      return fields[4].replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
    });
}

function isSandboxPath(value) {
  return (
    typeof value === 'string' &&
    value.startsWith('/') &&
    !value.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !value.split('/').some((segment) => segment === '..')
  );
}

export async function findBubblewrap() {
  if (process.platform !== 'linux') return null;
  const candidates = ['/usr/bin/bwrap', '/bin/bwrap'];
  for (const candidate of candidates) {
    try {
      const resolved = await fs.realpath(candidate);
      await fs.access(resolved, constants.X_OK);
      const file = await fs.stat(resolved);
      if (!file.isFile() || file.uid !== 0 || (file.mode & 0o022) !== 0) continue;
      let directory = path.dirname(resolved);
      while (true) {
        const stat = await fs.stat(directory);
        if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) break;
        if (directory === '/') return resolved;
        directory = path.dirname(directory);
      }
    } catch {
      /* candidate is missing or not trusted */
    }
  }
  return null;
}

export async function findWindowsSandboxHelper({ platform = process.platform, workspaceRoot } = {}) {
  if (platform !== 'win32') return null;
  if (typeof workspaceRoot !== 'string' || !path.win32.isAbsolute(workspaceRoot)) return null;
  let resolvedWorkspace;
  try {
    resolvedWorkspace = await fs.realpath(workspaceRoot);
  } catch {
    return null;
  }
  const candidates = [
    path.join(APP_ROOT, 'runtime', 'native', `windows-${process.arch}`, 'xyst-sandbox-helper.exe'),
    path.join(APP_ROOT, 'resources', 'native', `windows-${process.arch}`, 'xyst-sandbox-helper.exe'),
    path.join(APP_ROOT, 'dist', 'desktop-runtime', 'native', `windows-${process.arch}`, 'xyst-sandbox-helper.exe'),
    path.join(APP_ROOT, 'gui', 'desktop', 'src-tauri', 'target', 'release', 'xyst-sandbox-helper.exe'),
    path.join(APP_ROOT, 'gui', 'desktop', 'src-tauri', 'target', 'debug', 'xyst-sandbox-helper.exe'),
  ];
  for (const candidate of candidates) {
    try {
      const entry = await fs.lstat(candidate);
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const resolved = await fs.realpath(candidate);
      if (!isPathWithin(APP_ROOT, resolved, path.win32)) continue;
      if (!isWindowsSandboxHelperOutsideWorkspace(resolved, resolvedWorkspace)) continue;
      return resolved;
    } catch {
      /* helper is absent; continue through the fixed application locations */
    }
  }
  return null;
}

export function isWindowsSandboxHelperOutsideWorkspace(helperPath, workspaceRoot) {
  if (
    typeof helperPath !== 'string' ||
    !path.win32.isAbsolute(helperPath) ||
    typeof workspaceRoot !== 'string' ||
    !path.win32.isAbsolute(workspaceRoot)
  )
    return false;
  const normalizedHelper = path.win32.resolve(helperPath).toLowerCase();
  const normalizedWorkspace = path.win32.resolve(workspaceRoot).toLowerCase();
  return !isPathWithin(normalizedWorkspace, normalizedHelper, path.win32);
}

export async function runIsolatedProcess(command, args, { workspaceRoot, sandboxMode = 'workspace-write', ...options } = {}) {
  if (!['workspace-write', 'workspace-read'].includes(sandboxMode))
    throw new TypeError('Isolated process sandboxMode must be workspace-write or workspace-read');
  if (process.platform === 'win32') return runWindowsIsolatedProcess(command, args, workspaceRoot, { ...options, sandboxMode });
  if (process.platform !== 'linux') {
    throw new Error(`Required process isolation is not implemented for ${process.platform}; refusing to run unsandboxed`);
  }
  const workspace = await validateBubblewrapWorkspace(workspaceRoot, { includeIdentity: true });
  const bwrap = await findBubblewrap();
  if (!bwrap) throw new Error('Required process isolation needs a trusted system Bubblewrap executable; refusing to run unsandboxed');
  const { runProcess } = await import('./process.mjs');
  const workspaceIdentityFailureToken = randomUUID();
  const sandboxArgs = buildBubblewrapArgs({
    workspaceRoot: workspace.path,
    workspaceIdentity: workspace.identity,
    workspaceIdentityFailureToken,
    workspaceReadOnly: sandboxMode === 'workspace-read',
    command,
    args,
    bwrap,
  });
  const result = await runProcess(bwrap, sandboxArgs, { ...options, cwd: '/', env: {}, shell: false, captureStatusFd: true });
  const status = parseBubblewrapStatus(result.statusOutput);
  delete result.statusOutput;
  if (result.stderr.includes(`${WORKSPACE_GUARD_FAILURE_PREFIX}${workspaceIdentityFailureToken}`))
    throw Object.assign(new Error('Sandbox workspace changed during launch; requested command was not started'), {
      code: 'SANDBOX_WORKSPACE_CHANGED',
      result,
    });
  if (!status.some((entry) => Number.isInteger(entry['child-pid']))) {
    throw Object.assign(
      new Error(`Bubblewrap failed before the isolated process started${result.stderr ? `: ${result.stderr.trim()}` : ''}`),
      { code: 'SANDBOX_SETUP_FAILED', result },
    );
  }
  return { ...result, sandboxed: true };
}

async function runWindowsIsolatedProcess(command, args, workspaceRoot, options) {
  if (typeof workspaceRoot !== 'string' || !path.win32.isAbsolute(workspaceRoot))
    throw new TypeError('Sandbox workspaceRoot must be an absolute Windows path');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('Sandbox args must be an array of strings');
  if (typeof command !== 'string' || !command.trim()) throw new TypeError('Sandbox command must be a non-empty string');
  const workspace = await fs.realpath(workspaceRoot);
  const helper = await findWindowsSandboxHelper({ workspaceRoot: workspace });
  if (!helper)
    throw Object.assign(
      new Error('Required process isolation needs the packaged Windows AppContainer helper; refusing to run unsandboxed'),
      {
        code: 'SANDBOX_SETUP_FAILED',
      },
    );

  const cwd = options.cwd || workspaceRoot;
  const environment = options.env || process.env;
  const executable = await resolveWindowsExecutable(command, cwd, environment);
  const currentDirectory = await fs.realpath(cwd);
  const stdin = options.input === undefined ? '' : Buffer.from(options.input, 'utf8').toString('base64');
  const request = buildWindowsSandboxRequest({
    executable,
    args,
    workspaceRoot: workspace,
    currentDirectory,
    environment,
    workspaceReadOnly: options.sandboxMode === 'workspace-read',
    timeoutMs: options.timeoutMs ?? 30_000,
    stdinBase64: stdin,
  });
  const { runProcess, safeProcessEnvironment, terminateProcessTree } = await import('./process.mjs');
  let response;
  let cancelledByHost = false;
  try {
    response = await runProcess(helper, [], {
      cwd: path.dirname(helper),
      env: safeProcessEnvironment(process.env),
      timeoutMs: request.timeout_ms + 30_000,
      maxOutputBytes: WINDOWS_HELPER_RESPONSE_LIMIT,
      maxInputBytes: 2 * 1024 * 1024,
      input: `${JSON.stringify(request)}\n`,
      keepStdinOpen: true,
      onAbort: (child) => {
        if (!child.stdin || child.stdin.destroyed || child.exitCode !== null) return false;
        try {
          child.stdin.write('CANCEL\n', (error) => {
            if (error) terminateProcessTree(child, 'force');
          });
          return true;
        } catch {
          return false;
        }
      },
      signal: options.signal,
      shell: false,
    });
  } catch (error) {
    if (error.code === 'ABORT_ERR' && error.result?.exitCode === 0 && typeof error.result.stdout === 'string') {
      response = error.result;
      cancelledByHost = true;
    } else {
      if (error.code === 'ABORT_ERR' || error.code === 'ETIMEDOUT') error.result = { ...(error.result || {}), sandboxed: true };
      throw error;
    }
  }
  const payload = parseWindowsSandboxResponse(response);
  const stdoutBytes = Buffer.from(payload.stdout_base64, 'base64');
  const stderrBytes = Buffer.from(payload.stderr_base64, 'base64');
  const limit = options.maxOutputBytes ?? 100_000;
  const stdoutLength = Math.min(stdoutBytes.length, limit);
  const stderrLength = Math.min(stderrBytes.length, Math.max(0, limit - stdoutLength));
  const truncated =
    payload.stdout_truncated || payload.stderr_truncated || stdoutLength < stdoutBytes.length || stderrLength < stderrBytes.length;
  const result = {
    stdout: stdoutBytes.subarray(0, stdoutLength).toString('utf8'),
    stderr: stderrBytes.subarray(0, stderrLength).toString('utf8'),
    exitCode: payload.exit_code,
    signal: null,
    timedOut: payload.timed_out,
    truncated,
    elapsed_ms: payload.elapsed_ms,
    sandboxed: true,
  };
  if (payload.cancelled || cancelledByHost) throw Object.assign(new Error('Process cancelled'), { code: 'ABORT_ERR', result });
  if (payload.timed_out) throw Object.assign(new Error(`Process timed out after ${request.timeout_ms} ms`), { code: 'ETIMEDOUT', result });
  return result;
}

export function buildWindowsSandboxRequest({
  executable,
  args,
  workspaceRoot,
  currentDirectory,
  environment,
  workspaceReadOnly = false,
  timeoutMs,
  stdinBase64 = '',
}) {
  if (typeof executable !== 'string' || !path.win32.isAbsolute(executable))
    throw new TypeError('Sandbox executable must be an absolute Windows path');
  if (typeof workspaceRoot !== 'string' || !path.win32.isAbsolute(workspaceRoot))
    throw new TypeError('Sandbox workspaceRoot must be an absolute Windows path');
  if (typeof currentDirectory !== 'string' || !path.win32.isAbsolute(currentDirectory))
    throw new TypeError('Sandbox currentDirectory must be an absolute Windows path');
  if (!Array.isArray(args) || args.length > 256 || args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))
    throw new TypeError('Sandbox args must be an array of at most 256 strings without NUL bytes');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0xffff_fffe)
    throw new TypeError('Sandbox timeout must be between 1 ms and 4294967294 ms');
  if (typeof stdinBase64 !== 'string' || stdinBase64.length > 88_000) throw new TypeError('Sandbox stdin encoding exceeds the limit');
  if (typeof workspaceReadOnly !== 'boolean') throw new TypeError('Sandbox workspaceReadOnly must be a boolean');
  const safeEnvironment = {};
  for (const [key, value] of Object.entries(environment || {})) {
    if (typeof value !== 'string' || !key || key.includes('=') || key.includes('\0') || value.includes('\0'))
      throw new TypeError('Sandbox environment contains an invalid entry');
    safeEnvironment[key] = value;
  }
  if (Object.keys(safeEnvironment).length === 0) throw new TypeError('Sandbox environment must not be empty');
  return {
    version: 1,
    executable,
    args,
    workspace_root: workspaceRoot,
    workspace_read_only: workspaceReadOnly,
    current_directory: currentDirectory,
    environment: safeEnvironment,
    timeout_ms: timeoutMs,
    stdin_base64: stdinBase64,
  };
}

export function parseWindowsSandboxResponse(response) {
  if (response.truncated)
    throw Object.assign(new Error('Windows sandbox helper response exceeded its output limit'), {
      code: 'SANDBOX_SETUP_FAILED',
      result: response,
    });
  let payload;
  try {
    payload = JSON.parse(response.stdout);
  } catch {
    throw Object.assign(new Error('Windows sandbox helper returned an invalid response'), {
      code: 'SANDBOX_SETUP_FAILED',
      result: response,
    });
  }
  if (payload?.ok !== true || !payload.result || typeof payload.result !== 'object') {
    throw Object.assign(new Error(typeof payload?.error === 'string' ? payload.error : 'Windows sandbox helper rejected the request'), {
      code: 'SANDBOX_SETUP_FAILED',
      result: response,
    });
  }
  if (response.exitCode !== 0)
    throw Object.assign(new Error('Windows sandbox helper exited unsuccessfully'), {
      code: 'SANDBOX_SETUP_FAILED',
      result: response,
    });
  const result = payload.result;
  if (
    !Number.isInteger(result.exit_code) ||
    result.exit_code < 0 ||
    result.exit_code > 0xffff_ffff ||
    !Number.isFinite(result.elapsed_ms) ||
    result.elapsed_ms < 0 ||
    typeof result.timed_out !== 'boolean' ||
    typeof result.cancelled !== 'boolean' ||
    typeof result.stdout_truncated !== 'boolean' ||
    typeof result.stderr_truncated !== 'boolean' ||
    !isBase64(result.stdout_base64) ||
    !isBase64(result.stderr_base64)
  ) {
    throw Object.assign(new Error('Windows sandbox helper returned a malformed command result'), {
      code: 'SANDBOX_SETUP_FAILED',
      result: response,
    });
  }
  const stdoutBytes = Buffer.from(result.stdout_base64, 'base64');
  const stderrBytes = Buffer.from(result.stderr_base64, 'base64');
  if (stdoutBytes.length > 1024 * 1024 || stderrBytes.length > 1024 * 1024)
    throw Object.assign(new Error('Windows sandbox helper exceeded its output limit'), { code: 'SANDBOX_SETUP_FAILED' });
  return result;
}

async function resolveWindowsExecutable(command, cwd, environment) {
  const commandPath = path.win32.isAbsolute(command) ? command : path.win32.resolve(cwd, command);
  const hasDirectory = path.win32.isAbsolute(command) || /[\\/]/.test(command);
  const directories = hasDirectory
    ? [path.win32.dirname(commandPath)]
    : String(getEnvironmentValue(environment, 'PATH') || '').split(path.win32.delimiter);
  const extensions = path.win32.extname(command) ? [''] : String(getEnvironmentValue(environment, 'PATHEXT') || '.COM;.EXE').split(';');
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = hasDirectory ? `${commandPath}${extension}` : path.win32.join(directory, `${command}${extension}`);
      try {
        const stat = await fs.stat(candidate);
        if (!stat.isFile()) continue;
        return await fs.realpath(candidate);
      } catch {
        /* try the next Windows PATH and PATHEXT candidate */
      }
    }
  }
  throw Object.assign(new Error(`Could not resolve an executable for required Windows sandbox: ${command}`), {
    code: 'ENOENT',
  });
}

function isBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function getEnvironmentValue(environment, name) {
  const entry = Object.entries(environment || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function isPathWithin(root, candidate, pathApi) {
  const relative = pathApi.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${pathApi.sep}`) && relative !== '..' && !pathApi.isAbsolute(relative));
}

export function parseBubblewrapStatus(output) {
  return String(output || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
