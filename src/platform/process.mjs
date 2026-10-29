import { spawn } from 'node:child_process';
import path from 'node:path';

const RESTRICTED_PROCESS_ENVIRONMENT_KEYS = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_ASKPASS',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_NAMESPACE',
  'SSH_ASKPASS',
  'GPG_AGENT_INFO',
  'NODE_OPTIONS',
  'NODE_PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'RUBYOPT',
  'RUBYLIB',
  'PERL5OPT',
  'PERL5LIB',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'GIT_CONFIG_PARAMETERS',
  'NPM_CONFIG_USERCONFIG',
  'NPM_CONFIG_GLOBALCONFIG',
  'DOCKER_AUTH_CONFIG',
  'KUBECONFIG',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CONFIG_DIR',
  'CLOUDSDK_CONFIG',
]);

/** Make the same trusted Node runtime hosting Xyst available to its child tools,
 * including desktop installs on machines without a system-wide Node install. */
export function withNodeRuntimePath(source = process.env) {
  const environment = { ...source };
  const key = Object.keys(environment).find((name) => name.toUpperCase() === 'PATH') || 'PATH';
  const directory = path.dirname(process.execPath);
  const entries = (environment[key] || '').split(path.delimiter).filter(Boolean);
  const same = (entry) => (process.platform === 'win32' ? entry.toLowerCase() === directory.toLowerCase() : entry === directory);
  environment[key] = [directory, ...entries.filter((entry) => !same(entry))].join(path.delimiter);
  return environment;
}

export function runProcess(command, args = [], options = {}) {
  const {
    cwd,
    env = safeProcessEnvironment(process.env),
    timeoutMs = 30_000,
    maxOutputBytes = 100_000,
    signal,
    shell = false,
    captureStatusFd = false,
    input,
    maxInputBytes = 65_536,
    keepStdinOpen = false,
    onAbort,
  } = options;
  if (typeof command !== 'string' || !command.trim()) throw new TypeError('command must be a non-empty string');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) throw new TypeError('args must be an array of strings');
  if (shell !== false) throw new Error('Shell interpretation is not supported by the process adapter; pass an executable and argv');
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs < 1))
    throw new TypeError('timeoutMs must be positive or null for no automatic timeout');
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0) throw new TypeError('maxOutputBytes must be a non-negative integer');
  if (!Number.isInteger(maxInputBytes) || maxInputBytes < 0 || maxInputBytes > 2 * 1024 * 1024)
    throw new TypeError('maxInputBytes must be an integer between 0 and 2097152');
  if (typeof keepStdinOpen !== 'boolean' || (keepStdinOpen && input === undefined))
    throw new TypeError('keepStdinOpen requires input and must be a boolean');
  if (onAbort !== undefined && typeof onAbort !== 'function') throw new TypeError('onAbort must be a function');
  if (input !== undefined && (typeof input !== 'string' || Buffer.byteLength(input) > maxInputBytes))
    throw new TypeError(`input must be a string of at most ${maxInputBytes} bytes`);

  // Child tools can invoke `node` even when the desktop bundle is the only
  // Node installation available on the host.
  const childEnvironment = withNodeRuntimePath(env);

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const stdinMode = input === undefined ? 'ignore' : 'pipe';
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: captureStatusFd ? [stdinMode, 'pipe', 'pipe', 'pipe'] : [stdinMode, 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const statusOutput = [];
    let statusBytes = 0;
    let statusTruncated = false;
    let bytes = 0;
    let truncated = false;
    let settled = false;
    let timedOut = false;
    let cancellationHandled = false;
    let stdinErrorCode = null;
    let killTimer;

    if (input !== undefined) {
      child.stdin.on('error', (error) => {
        stdinErrorCode = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code) ? error.code : 'STDIN_ERROR';
      });
      if (keepStdinOpen) child.stdin.write(input);
      else child.stdin.end(input);
    }

    const append = (target) => (chunk) => {
      const remaining = Math.max(0, maxOutputBytes - bytes);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.length, remaining);
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout.on('data', append(stdout));
    child.stderr.on('data', append(stderr));
    if (captureStatusFd)
      child.stdio[3].on('data', (chunk) => {
        const remaining = Math.max(0, 4096 - statusBytes);
        if (remaining > 0) statusOutput.push(chunk.subarray(0, remaining));
        statusBytes += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) statusTruncated = true;
      });

    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const terminate = () => {
      terminateProcessTree(child, process.platform === 'win32' ? 'force' : 'graceful');
      killTimer = setTimeout(() => {
        if (!settled) terminateProcessTree(child, 'force');
      }, 500);
    };
    const abort = () => {
      if (onAbort) {
        try {
          if (onAbort(child) !== false) {
            cancellationHandled = true;
            return;
          }
        } catch {
          /* fall through to terminating the child process tree */
        }
      }
      terminate();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs !== null)
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, timeoutMs);

    child.once('error', (error) => finish(signal?.aborted ? Object.assign(new Error('Process cancelled'), { code: 'ABORT_ERR' }) : error));
    child.once('close', (code, terminationSignal) => {
      if ((signal?.aborted && !cancellationHandled) || timedOut) terminateProcessTree(child, 'force');
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        exitCode: code,
        signal: terminationSignal,
        timedOut,
        truncated,
        elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(stdinErrorCode ? { stdinErrorCode } : {}),
        ...(captureStatusFd ? { statusOutput: Buffer.concat(statusOutput).toString('utf8'), statusTruncated } : {}),
      };
      if (timedOut) finish(Object.assign(new Error(`Process timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT', result }));
      else if (signal?.aborted) finish(Object.assign(new Error('Process cancelled'), { code: 'ABORT_ERR', result }));
      else finish(null, result);
    });
  });
}

export function terminateProcessTree(child, mode = 'force') {
  const exited = (child.exitCode !== null && child.exitCode !== undefined) || (child.signalCode !== null && child.signalCode !== undefined);
  if (!child.pid) {
    if (!exited) child.kill();
    return;
  }
  if (process.platform === 'win32') {
    if (exited) return;
    const taskkill = resolveWindowsTaskkillPath();
    if (!taskkill) {
      child.kill();
      return;
    }
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('error', () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    killer.once('close', (code) => {
      if (code !== 0 && child.exitCode === null && child.signalCode === null) child.kill();
    });
    return;
  }
  const signal = mode === 'force' ? 'SIGKILL' : 'SIGTERM';
  try {
    // A detached POSIX process group can outlive its leader, so keep signaling the group after the direct child exits.
    process.kill(-child.pid, signal);
  } catch {
    if (!exited) child.kill(signal);
  }
}

export function resolveWindowsTaskkillPath(env = process.env) {
  const systemRoot = resolveWindowsSystemRoot(env);
  return systemRoot ? path.win32.join(systemRoot, 'System32', 'taskkill.exe') : null;
}

export function resolveWindowsPowerShellPath(env = process.env) {
  const systemRoot = resolveWindowsSystemRoot(env);
  return systemRoot ? path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null;
}

function resolveWindowsSystemRoot(env) {
  for (const systemRoot of [env.SystemRoot, env.WINDIR]) {
    if (typeof systemRoot !== 'string' || !path.win32.isAbsolute(systemRoot)) continue;
    const normalizedRoot = path.win32.normalize(systemRoot);
    if (normalizedRoot.startsWith('\\\\')) continue;
    return normalizedRoot;
  }
  return null;
}

export function safeProcessEnvironment(source) {
  const essential =
    process.platform === 'win32'
      ? new Set([
          'PATH',
          'PATHEXT',
          'SYSTEMROOT',
          'WINDIR',
          'COMSPEC',
          'TEMP',
          'TMP',
          'USERPROFILE',
          'HOMEDRIVE',
          'HOMEPATH',
          'APPDATA',
          'LOCALAPPDATA',
        ])
      : new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'USER', 'LOGNAME']);
  const result = {};
  for (const [key, value] of Object.entries(source || {})) {
    const normalizedKey = key.toUpperCase();
    if (
      typeof value !== 'string' ||
      RESTRICTED_PROCESS_ENVIRONMENT_KEYS.has(normalizedKey) ||
      normalizedKey.startsWith('GIT_CONFIG_') ||
      /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|(?:^|[_-])AUTH(?:$|[_-]))/i.test(key)
    )
      continue;
    if (essential.has(key.toUpperCase()) || !/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(key)) result[key] = value;
  }
  return result;
}
