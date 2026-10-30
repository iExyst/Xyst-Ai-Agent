import test from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import {
  resolveWindowsPowerShellPath,
  resolveWindowsTaskkillPath,
  runProcess,
  safeProcessEnvironment,
  terminateProcessTree,
  withNodeRuntimePath,
} from '../src/platform/process.mjs';

test('desktop tool environment can run its bundled Node without a system Node on PATH', async () => {
  const original = { ...safeProcessEnvironment(process.env) };
  for (const key of Object.keys(original)) if (key.toUpperCase() === 'PATH') delete original[key];
  original[process.platform === 'win32' ? 'Path' : 'PATH'] = '';
  const environment = withNodeRuntimePath(original);
  const result = await runProcess('node', ['-p', 'process.execPath'], { env: environment });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim().toLowerCase(), process.execPath.toLowerCase());
  assert.equal(original[process.platform === 'win32' ? 'Path' : 'PATH'], '', 'the source environment is unchanged');
});

test('process adapter uses argv and captures bounded stdout and stderr', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('out');process.stderr.write('err')"], {
    maxOutputBytes: 6,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.truncated, false);
  assert.ok(Number.isFinite(result.elapsed_ms) && result.elapsed_ms >= 0);
});

test('process adapter enforces combined output cap', async () => {
  const result = await runProcess(process.execPath, ['-e', "process.stdout.write('123456789')"], { maxOutputBytes: 4 });
  assert.equal(result.stdout, '1234');
  assert.equal(result.truncated, true);
});

test('process adapter sends bounded one-shot stdin and closes the stream', async () => {
  const result = await runProcess(
    process.execPath,
    [
      '-e',
      "let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>process.stdout.write(s.toUpperCase()))",
    ],
    { input: 'hello process\n' },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'HELLO PROCESS\n');
  assert.throws(() => runProcess(process.execPath, ['-e', ''], { input: 'x'.repeat(65_537) }), /65536 bytes/);
});

test('process adapter captures an early stdin close instead of emitting an unhandled stream error', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.exit(0)'], {
    input: 'x'.repeat(2 * 1024 * 1024),
    maxInputBytes: 2 * 1024 * 1024,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(['EOF', 'EPIPE'].includes(result.stdinErrorCode), `unexpected stdin error code: ${result.stdinErrorCode}`);
});

test('process adapter supports an explicitly raised internal input bound without weakening the default', async () => {
  const result = await runProcess(
    process.execPath,
    ['-e', "let n=0;process.stdin.on('data',chunk=>n+=chunk.length);process.stdin.on('end',()=>process.stdout.write(String(n)))"],
    { input: 'x'.repeat(70_000), maxInputBytes: 100_000 },
  );
  assert.equal(result.stdout, '70000');
  assert.throws(() => runProcess(process.execPath, ['-e', ''], { maxInputBytes: 2 * 1024 * 1024 + 1 }), /maxInputBytes/);
});

test('process adapter can send an abort control message over an open stdin channel', async () => {
  const controller = new AbortController();
  const script =
    "let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',d=>{b+=d;let i;while((i=b.indexOf('\\n'))>=0){const line=b.slice(0,i);b=b.slice(i+1);if(line==='REQUEST')process.stdout.write('ready\\n');if(line==='CANCEL'){process.stdout.write('cancelled\\n');process.exit(0)}}})";
  const run = runProcess(process.execPath, ['-e', script], {
    input: 'REQUEST\n',
    keepStdinOpen: true,
    signal: controller.signal,
    onAbort: (child) => {
      child.stdin.write('CANCEL\n');
      return true;
    },
  });
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(run, (error) => error.code === 'ABORT_ERR' && /cancelled/.test(error.result?.stdout));
  } finally {
    clearTimeout(timer);
  }
});

test('process adapter audit redaction helper omits interactive input fields', async () => {
  const { ToolAuditStore } = await import('../src/tools/audit.mjs');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xyst-input-audit-'));
  try {
    const record = await new ToolAuditStore(root).record({
      sessionId: 's',
      toolCallId: 'c',
      tool: 'send_background_input',
      args: { id: 'p', input: 'password=canary' },
      decision: 'allow',
      outcome: 'started',
    });
    assert.equal(record.arguments.input, '[OMITTED]');
    assert.doesNotMatch(JSON.stringify(record), /password=canary/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('process adapter captures the optional structured sandbox status descriptor', async () => {
  const result = await runProcess(process.execPath, ['-e', "require('node:fs').writeSync(3, '{\\\"child-pid\\\":42}\\n')"], {
    captureStatusFd: true,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.statusOutput, /"child-pid":42/);
  assert.equal(result.statusTruncated, false);
});

test('process adapter bounds optional structured status descriptor output', async () => {
  const result = await runProcess(process.execPath, ['-e', "require('node:fs').writeSync(3, Buffer.alloc(8192, 65))"], {
    captureStatusFd: true,
  });
  assert.equal(result.statusOutput.length, 4096);
  assert.equal(result.statusTruncated, true);
});

test('process adapter escalates a timeout when a child ignores graceful termination', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows process termination is not signal based');
  const start = Date.now();
  await assert.rejects(
    runProcess(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setTimeout(()=>{},5000)"], { timeoutMs: 50 }),
    (error) => error.code === 'ETIMEDOUT' && Number.isFinite(error.result?.elapsed_ms) && error.result.elapsed_ms >= 0,
  );
  assert.ok(Date.now() - start < 2500);
});

test('process timeout kills descendants in the child process tree', async (t) => {
  await assertDescendantStops(t, false);
});

test('process cancellation kills descendants in the child process tree', async (t) => {
  await assertDescendantStops(t, true);
});

async function assertDescendantStops(t, cancel) {
  // Check the actual descendant after termination. A marker written before a slow
  // Windows taskkill finishes does not demonstrate that the descendant survived.
  const childCode = "process.on('SIGTERM',()=>{});setTimeout(()=>{},60000)";
  const parentCode = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});console.log(child.pid);setTimeout(()=>{},60000)`;
  const controller = new AbortController();
  const timer = cancel ? setTimeout(() => controller.abort(), 400) : null;
  t.after(() => clearTimeout(timer));
  let descendant;
  await assert.rejects(
    runProcess(process.execPath, ['-e', parentCode], cancel ? { signal: controller.signal } : { timeoutMs: 400 }),
    (error) => {
      descendant = Number(error.result?.stdout.trim());
      return error.code === (cancel ? 'ABORT_ERR' : 'ETIMEDOUT');
    },
  );
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0, 'the test must observe a real descendant');
  t.after(() => {
    try {
      process.kill(descendant, 'SIGKILL');
    } catch {}
  });
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(descendant, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`descendant ${descendant} is still present after process-tree termination`);
}

test('process adapter reports timeout and cancellation distinctly', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 50 }),
    (error) => error.code === 'ETIMEDOUT',
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { signal: controller.signal }),
    (error) => error.code === 'ABORT_ERR',
  );
  assert.throws(() => runProcess('node', ['-e', ''], { shell: true }), /Shell interpretation/);
});

test('process adapter permits an explicitly unbounded run while preserving cancellation', async () => {
  const result = await runProcess(process.execPath, ['-e', "setTimeout(()=>process.stdout.write('finished'),25)"], { timeoutMs: null });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'finished');
  assert.equal(result.timedOut, false);
});

test('assisted child environment filters credential handles, credentials, and runtime injection variables', () => {
  const environment = safeProcessEnvironment({
    PATH: 'bin',
    HOME: '/home/user',
    OPENAI_API_KEY: 'one',
    AWS_SECRET_ACCESS_KEY: 'two',
    SESSION_TOKEN: 'three',
    NPM_CONFIG__AUTH: 'four',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    GIT_ASKPASS: '/tmp/askpass',
    NODE_OPTIONS: '--require attacker.js',
    PYTHONPATH: '/tmp/injected-python',
    LD_PRELOAD: '/tmp/injected-library.so',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.pager',
    GIT_CONFIG_VALUE_0: 'attacker-command',
    GIT_DIR: '/tmp/attacker-repository',
    GIT_WORK_TREE: '/tmp/attacker-worktree',
    GIT_INDEX_FILE: '/tmp/attacker-index',
    LANG: 'en_US.UTF-8',
  });
  assert.deepEqual(environment, { PATH: 'bin', HOME: '/home/user', LANG: 'en_US.UTF-8' });
});

test('process adapter launches Node without inherited environment injection hooks in the assisted profile', async () => {
  const env = safeProcessEnvironment({
    ...process.env,
    XYST_SAFE_CANARY: 'retained',
    NODE_OPTIONS: '--require missing-assisted-test-module',
    SSH_AUTH_SOCK: 'filtered-agent-socket',
  });
  const result = await runProcess(
    process.execPath,
    [
      '-e',
      'process.stdout.write(JSON.stringify({safe:process.env.XYST_SAFE_CANARY,nodeOptions:process.env.NODE_OPTIONS,sshAgent:process.env.SSH_AUTH_SOCK}))',
    ],
    { env },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), { safe: 'retained' });
});

test('Windows process-tree termination resolves taskkill from SystemRoot, never PATH', () => {
  assert.equal(
    resolveWindowsTaskkillPath({ SystemRoot: 'C:\\Windows', PATH: 'C:\\attacker;C:\\Windows\\System32' }),
    'C:\\Windows\\System32\\taskkill.exe',
  );
  assert.equal(
    resolveWindowsTaskkillPath({ SystemRoot: 'relative\\windows', WINDIR: 'D:\\Windows' }),
    'D:\\Windows\\System32\\taskkill.exe',
  );
  assert.equal(resolveWindowsTaskkillPath({ PATH: 'C:\\attacker' }), null);
  assert.equal(resolveWindowsTaskkillPath({ SystemRoot: 'relative\\windows', PATH: 'C:\\attacker' }), null);
  assert.equal(resolveWindowsTaskkillPath({ SystemRoot: '\\\\attacker\\share\\Windows' }), null);
});

test('Windows PowerShell resolution uses only a local SystemRoot or WINDIR, never PATH', () => {
  assert.equal(
    resolveWindowsPowerShellPath({ SystemRoot: 'C:\\Windows', PATH: 'C:\\attacker' }),
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(
    resolveWindowsPowerShellPath({ SystemRoot: 'relative\\windows', WINDIR: 'D:\\Windows', PATH: 'C:\\attacker' }),
    'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.equal(resolveWindowsPowerShellPath({ SystemRoot: '\\\\attacker\\share\\Windows', PATH: 'C:\\attacker' }), null);
  assert.equal(resolveWindowsPowerShellPath({ PATH: 'C:\\attacker' }), null);
});

test('process-tree termination does not signal a child Node has already observed as exited', () => {
  let killCalled = false;
  terminateProcessTree({
    pid: undefined,
    exitCode: 0,
    signalCode: null,
    kill() {
      killCalled = true;
    },
  });
  assert.equal(killCalled, false);
});
