import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildBubblewrapArgs,
  bubblewrapLauncherEnvironment,
  buildWindowsSandboxRequest,
  findBubblewrap,
  findWindowsSandboxHelper,
  isWindowsSandboxHelperOutsideWorkspace,
  parseBubblewrapStatus,
  parseWindowsSandboxResponse,
  validateBubblewrapWorkspace,
} from '../src/platform/sandbox.mjs';
import { validateConfig } from '../src/config/load.mjs';
import { createBuiltinTools } from '../src/tools/builtins.mjs';
import { resolveSandboxMode } from '../src/platform/sandbox-modes.mjs';
import { createTempDirectory } from './helpers.mjs';

async function createHardLinkOrSkip(t, target, link) {
  try {
    await fs.link(target, link);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) {
      t.skip(`Hard-link creation is unavailable: ${error.code}`);
      return false;
    }
    throw error;
  }
}

test('Bubblewrap workspace validation rejects hard links that reach outside the workspace', async (t) => {
  const parent = await createTempDirectory('xyst-bwrap-links-');
  const workspace = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  t.after(() => fs.rm(parent, { recursive: true, force: true }));

  const outsideFile = path.join(outside, 'shared.txt');
  await fs.writeFile(outsideFile, 'shared inode');
  if (!(await createHardLinkOrSkip(t, outsideFile, path.join(workspace, 'shared.txt')))) return;
  await assert.rejects(
    validateBubblewrapWorkspace(workspace, { platform: 'linux' }),
    (error) => error.code === 'SANDBOX_WORKSPACE_UNSAFE' && /hard-linked outside/.test(error.message),
  );
});

test('Bubblewrap workspace validation permits hard links contained within the workspace', async (t) => {
  const workspace = await createTempDirectory('xyst-bwrap-internal-links-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const first = path.join(workspace, 'first.txt');
  const second = path.join(workspace, 'nested', 'second.txt');
  await fs.mkdir(path.dirname(second));
  await fs.writeFile(first, 'shared inode');
  if (!(await createHardLinkOrSkip(t, first, second))) return;

  assert.equal(await validateBubblewrapWorkspace(workspace, { platform: 'linux' }), await fs.realpath(workspace));
});

test('Bubblewrap workspace validation can return an identity to verify the later bind mount', async (t) => {
  const workspace = await createTempDirectory('xyst-bwrap-identity-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const stat = await fs.stat(workspace, { bigint: true });
  const validated = await validateBubblewrapWorkspace(workspace, { platform: 'linux', includeIdentity: true });
  assert.equal(validated.path, await fs.realpath(workspace));
  assert.equal(validated.identity, `${stat.dev}:${stat.ino}`);
});

test('Bubblewrap workspace validation rejects a canonical filesystem root', async (t) => {
  const workspace = await createTempDirectory('xyst-bwrap-root-alias-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const originalRealpath = fs.realpath;
  fs.realpath = async (target, ...args) => (target === workspace ? '/' : originalRealpath(target, ...args));
  try {
    await assert.rejects(
      validateBubblewrapWorkspace(workspace, { platform: 'linux', mountInfo: '' }),
      (error) => error.code === 'SANDBOX_WORKSPACE_UNSAFE' && /filesystem root/.test(error.message),
    );
  } finally {
    fs.realpath = originalRealpath;
  }
});

test('Bubblewrap cannot mount Xyst state as the selected workspace', async (t) => {
  const workspace = await createTempDirectory('xyst-bwrap-state-root-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const stateDirectory = path.join(workspace, '.agent');
  await fs.mkdir(stateDirectory);
  await assert.rejects(
    validateBubblewrapWorkspace(stateDirectory, { platform: 'linux', mountInfo: '' }),
    (error) => error.code === 'SANDBOX_WORKSPACE_UNSAFE' && /state directory/.test(error.message),
  );
  assert.throws(
    () =>
      buildBubblewrapArgs({
        workspaceRoot: stateDirectory,
        command: 'id',
        workspaceIdentity: '1:2',
        workspaceIdentityFailureToken: '00000000-0000-0000-0000-000000000000',
        platform: 'linux',
      }),
    (error) => error.code === 'SANDBOX_WORKSPACE_UNSAFE' && /state directory/.test(error.message),
  );
});

test('Bubblewrap workspace validation rejects a bind-mounted filesystem root alias', async (t) => {
  const workspace = await createTempDirectory('xyst-bwrap-root-mount-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const originalRealpath = fs.realpath;
  const originalLstat = fs.lstat;
  const filesystemRootStat = await fs.stat('/', { bigint: true });
  const rootAlias = path.join(path.dirname(workspace), 'root-alias');
  fs.realpath = async (target, ...args) => (target === workspace ? rootAlias : originalRealpath(target, ...args));
  fs.lstat = async (target, options) => (target === rootAlias ? filesystemRootStat : originalLstat(target, options));
  try {
    await assert.rejects(
      validateBubblewrapWorkspace(workspace, { platform: 'linux', mountInfo: '' }),
      (error) => error.code === 'SANDBOX_WORKSPACE_UNSAFE' && /filesystem root/.test(error.message),
    );
  } finally {
    fs.realpath = originalRealpath;
    fs.lstat = originalLstat;
  }
});

test('Bubblewrap argument builder rejects filesystem root aliases', () => {
  for (const workspaceRoot of ['/', '/tmp/..']) {
    assert.throws(
      () =>
        buildBubblewrapArgs({
          workspaceRoot,
          command: 'id',
          workspaceIdentity: '1:2',
          workspaceIdentityFailureToken: '00000000-0000-0000-0000-000000000000',
          platform: 'linux',
        }),
      (error) => error.code === 'SANDBOX_WORKSPACE_UNSAFE' && /filesystem root/.test(error.message),
    );
  }
});

test('Bubblewrap workspace validation rejects nested filesystem boundaries', async (t) => {
  const workspace = await createTempDirectory('xyst-bwrap-filesystem-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const rootStat = await fs.stat(workspace, { bigint: true });
  const nestedDirectory = path.join(workspace, 'nested-mount');
  await fs.mkdir(nestedDirectory);
  const escapedWorkspace = workspace.replaceAll(' ', '\\040');
  const escapedSibling = `${escapedWorkspace}-sibling`;
  const mountLine = (id, parent, mountpoint) => `${id} ${parent} ${rootStat.dev}:${id} / ${mountpoint} rw,relatime - ext4 /dev/test rw`;
  const rootMount = mountLine(36, 25, escapedWorkspace);
  const siblingMount = mountLine(37, 36, escapedSibling);
  const nestedMount = mountLine(38, 36, nestedDirectory.replaceAll(' ', '\\040'));

  assert.equal(
    await validateBubblewrapWorkspace(workspace, { platform: 'linux', mountInfo: rootMount }),
    await fs.realpath(workspace),
    'the workspace itself may be a mount point',
  );
  assert.equal(
    await validateBubblewrapWorkspace(workspace, { platform: 'linux', mountInfo: `${rootMount}\n${siblingMount}` }),
    await fs.realpath(workspace),
    'a sibling with the workspace as a string prefix is not nested inside it',
  );
  await assert.rejects(
    validateBubblewrapWorkspace(workspace, { platform: 'linux', mountInfo: `${rootMount}\n${nestedMount}` }),
    (error) => error.code === 'SANDBOX_WORKSPACE_UNSAFE' && /nested filesystem mount/.test(error.message),
  );
});

test('Bubblewrap workspace validation fails closed on malformed Linux mount metadata', async (t) => {
  const workspace = await createTempDirectory('xyst-bwrap-bad-mountinfo-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await assert.rejects(
    validateBubblewrapWorkspace(workspace, { platform: 'linux', mountInfo: 'malformed mount metadata' }),
    (error) => error.code === 'SANDBOX_WORKSPACE_INVALID' && /mount information is malformed/.test(error.message),
  );
});

test('Bubblewrap workspace validation catches cross-device directories as a fallback', async (t) => {
  const workspace = await createTempDirectory('xyst-bwrap-device-fallback-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const rootStat = await fs.stat(workspace, { bigint: true });
  const nestedDirectory = path.join(workspace, 'cross-device');
  await fs.mkdir(nestedDirectory);

  const originalLstat = fs.lstat;
  fs.lstat = async (target, options) => {
    if (target !== nestedDirectory) return originalLstat(target, options);
    const stat = await originalLstat(target, options);
    return new Proxy(stat, {
      get: (value, property, receiver) => (property === 'dev' ? rootStat.dev + 1n : Reflect.get(value, property, receiver)),
    });
  };
  try {
    await assert.rejects(
      validateBubblewrapWorkspace(workspace, { platform: 'linux', mountInfo: '' }),
      (error) => error.code === 'SANDBOX_WORKSPACE_UNSAFE' && /nested filesystem mount/.test(error.message),
    );
  } finally {
    fs.lstat = originalLstat;
  }
});

test('Bubblewrap command is fail-closed and isolates mounts, network, processes, and environment', () => {
  const args = buildBubblewrapArgs({
    workspaceRoot: '/home/user/project',
    command: 'git',
    args: ['status', '--short'],
    bwrap: '/usr/bin/bwrap',
    workspaceIdentity: '2049:91022',
    workspaceIdentityFailureToken: '00000000-0000-0000-0000-000000000000',
    platform: 'linux',
  });
  const joined = args.join('\0');
  assert.ok(joined.includes('--unshare-net'));
  assert.ok(joined.includes('--unshare-pid'));
  assert.ok(joined.includes('--unshare-ipc'));
  assert.ok(joined.includes('--disable-userns'));
  assert.ok(joined.includes('--assert-userns-disabled'));
  assert.ok(joined.includes('--cap-drop\0ALL'));
  assert.ok(joined.includes('--new-session'));
  assert.ok(joined.includes('--clearenv'));
  assert.ok(joined.includes('--ro-bind\0/usr\0/usr'));
  assert.ok(joined.includes('--bind\0/home/user/project\0/workspace'));
  assert.ok(joined.includes('--tmpfs\0/tmp'));
  assert.ok(joined.includes('--tmpfs\0/workspace/.agent'));
  assert.ok(joined.includes('/usr/bin/stat -c "%d:%i" /workspace'));
  assert.ok(joined.includes('exec "$@"'));
  assert.ok(joined.includes('2049:91022'));
  assert.ok(joined.includes('XYST_WORKSPACE_IDENTITY_MISMATCH:00000000-0000-0000-0000-000000000000'));
  assert.equal(joined.includes('/home/user\0'), false);
  assert.deepEqual(args.slice(-4), ['XYST_WORKSPACE_IDENTITY_MISMATCH:00000000-0000-0000-0000-000000000000', 'git', 'status', '--short']);
});

test('Bubblewrap mounts the workspace read-only when the workspace-read mode is selected', () => {
  const args = buildBubblewrapArgs({
    workspaceRoot: '/home/user/project',
    command: 'git',
    args: ['status', '--short'],
    workspaceIdentity: '2049:91022',
    workspaceIdentityFailureToken: '00000000-0000-0000-0000-000000000000',
    workspaceReadOnly: true,
    platform: 'linux',
  });
  const joined = args.join('\0');
  assert.ok(joined.includes('--ro-bind\0/home/user/project\0/workspace'));
  assert.equal(joined.includes('--bind\0/home/user/project\0/workspace'), false);
  assert.ok(joined.includes('--tmpfs\0/tmp'), 'the isolated process keeps its private writable temporary directory');
  assert.ok(joined.includes('--tmpfs\0/workspace/.agent'), 'Xyst state remains hidden in read-only process sandboxes');
});

test('Bubblewrap supports bounded read-only extension mounts and an in-sandbox working directory', () => {
  const args = buildBubblewrapArgs({
    workspaceRoot: '/home/user/project',
    command: '/xyst-runtime/node',
    args: ['/xyst-extension/server.mjs'],
    workspaceIdentity: '2049:91022',
    workspaceIdentityFailureToken: '00000000-0000-0000-0000-000000000000',
    cwd: '/xyst-extension',
    readOnlyMounts: [
      { source: '/home/user/.config/xyst/extensions/mcp/server/1.0.0', target: '/xyst-extension', directory: true },
      { source: '/opt/node/bin/node', target: '/xyst-runtime/node' },
    ],
    platform: 'linux',
  });
  const joined = args.join('\0');
  assert.ok(joined.includes('--ro-bind\0/home/user/.config/xyst/extensions/mcp/server/1.0.0\0/xyst-extension'));
  assert.ok(joined.includes('--ro-bind\0/opt/node/bin/node\0/xyst-runtime/node'));
  assert.ok(joined.includes('--chdir\0/xyst-extension'));
  assert.ok(joined.includes('--unshare-net'));
  assert.ok(joined.includes('--bind\0/home/user/project\0/workspace'));
  assert.ok(joined.includes('/usr/bin/stat -c "%d:%i" /workspace'));
  assert.throws(
    () =>
      buildBubblewrapArgs({
        workspaceRoot: '/work',
        command: 'node',
        workspaceIdentity: '1:2',
        workspaceIdentityFailureToken: '00000000-0000-0000-0000-000000000000',
        readOnlyMounts: [{ source: '/etc', target: '/workspace/secrets' }],
        platform: 'linux',
      }),
    /invalid source or target/,
  );
  assert.throws(
    () =>
      buildBubblewrapArgs({
        workspaceRoot: '/work',
        command: 'node',
        workspaceIdentity: '1:2',
        workspaceIdentityFailureToken: '00000000-0000-0000-0000-000000000000',
        readOnlyMounts: [
          { source: '/opt/node', target: '/xyst-runtime', directory: true },
          { source: '/etc/passwd', target: '/xyst-runtime/node' },
        ],
        platform: 'linux',
      }),
    /invalid source or target/,
  );
  assert.throws(
    () =>
      buildBubblewrapArgs({
        workspaceRoot: '/work',
        workspaceIdentity: '1:2',
        workspaceIdentityFailureToken: '00000000-0000-0000-0000-000000000000',
        command: 'node',
        cwd: '/workspace/../etc',
        platform: 'linux',
      }),
    /cwd must be an absolute in-sandbox path/,
  );
});

test('Bubblewrap builder validates command inputs and rejects unsupported platforms', () => {
  assert.throws(
    () =>
      buildBubblewrapArgs({
        workspaceRoot: 'relative',
        workspaceIdentity: '1:2',
        workspaceIdentityFailureToken: '00000000-0000-0000-0000-000000000000',
        command: 'id',
        platform: 'linux',
      }),
    /absolute path/,
  );
  assert.throws(
    () =>
      buildBubblewrapArgs({
        workspaceRoot: '/work',
        workspaceIdentity: '1:2',
        workspaceIdentityFailureToken: '00000000-0000-0000-0000-000000000000',
        command: 'id',
        args: [1],
        platform: 'linux',
      }),
    /array of strings/,
  );
  assert.throws(
    () =>
      buildBubblewrapArgs({
        workspaceRoot: 'C:\\work',
        workspaceIdentity: '1:2',
        workspaceIdentityFailureToken: '00000000-0000-0000-0000-000000000000',
        command: 'whoami',
        platform: 'win32',
      }),
    /only on Linux/,
  );
});

test('Bubblewrap startup status accepts only structured child-start events', () => {
  assert.deepEqual(parseBubblewrapStatus('{"child-pid":2}\n{"exit-code":0}\n'), [{ 'child-pid': 2 }, { 'exit-code': 0 }]);
  assert.deepEqual(parseBubblewrapStatus('{broken}\n{"exit-code":1}\n'), [{ 'exit-code': 1 }]);
});

test('Bubblewrap host launcher receives only fixed environment values', () => {
  assert.deepEqual(bubblewrapLauncherEnvironment(), {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp',
  });
  assert.equal('NODE_OPTIONS' in bubblewrapLauncherEnvironment(), false);
  assert.equal('LD_PRELOAD' in bubblewrapLauncherEnvironment(), false);
});

test('sandbox mode is validated instead of silently accepting typos', () => {
  assert.throws(() => validateConfig({ sandbox: { mode: 'best-effort' } }), /sandbox.mode/);
  const legacyMode = { sandbox: { mode: 'required' } };
  validateConfig(legacyMode);
  assert.equal(legacyMode.sandbox.mode, 'workspace-write');
  const readMode = { sandbox: { mode: 'workspace-read' } };
  validateConfig(readMode);
  assert.equal(readMode.sandbox.mode, 'workspace-read');
  assert.throws(() => validateConfig({ sandbox: { tools: { write_file: 'read-only' } } }), /not a process-capable tool/);
});

test('sandbox per-tool overrides may tighten global isolation but cannot weaken it', () => {
  assert.equal(
    resolveSandboxMode({ sandbox: { mode: 'none', tools: { run_process: 'workspace-read' } } }, 'run_process'),
    'workspace-read',
  );
  assert.equal(
    resolveSandboxMode({ sandbox: { mode: 'workspace-read', tools: { run_process: 'workspace-write' } } }, 'run_process'),
    'workspace-read',
  );
  assert.equal(resolveSandboxMode({ sandbox: { mode: 'read-only', tools: { run_process: 'none' } } }, 'run_process'), 'read-only');
});

test('read-only sandbox exposes only built-in inspection tools and can disable one process tool', () => {
  const readOnly = createBuiltinTools({
    workspaceRoot: path.resolve('workspace'),
    config: { sandbox: { mode: 'read-only' }, tools: { shell_enabled: true } },
  });
  assert.deepEqual(
    readOnly.definitions.map(({ name }) => name),
    ['read_file', 'list_dir', 'search_files'],
  );

  const selective = createBuiltinTools({
    workspaceRoot: path.resolve('workspace'),
    config: { sandbox: { mode: 'none', tools: { run_process: 'read-only' } }, tools: { shell_enabled: true } },
  });
  assert.equal(selective.has('run_process'), false);
  assert.equal(selective.has('run_shell_script'), true);
});

test('Bubblewrap discovery only considers trusted system locations, never PATH', async () => {
  const executable = await findBubblewrap({ PATH: '/tmp/attacker-controlled' });
  assert.ok(
    executable === null ||
      ['/usr/bin/bwrap', '/bin/bwrap'].some((candidate) => executable === candidate || executable.startsWith(`${candidate}/`)),
  );
});

test('Windows sandbox helper protocol validates bounded absolute launch inputs and preserves stdin bytes', () => {
  const request = buildWindowsSandboxRequest({
    executable: 'C:\\Windows\\System32\\cmd.exe',
    args: ['/d', '/c', 'more'],
    workspaceRoot: 'C:\\work',
    currentDirectory: 'C:\\work',
    workspaceReadOnly: true,
    environment: { Path: 'C:\\Windows\\System32', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
    timeoutMs: 5000,
    stdinBase64: Buffer.from('stdin payload').toString('base64'),
  });
  assert.equal(request.version, 1);
  assert.equal(request.workspace_read_only, true);
  assert.equal(request.timeout_ms, 5000);
  assert.equal(request.stdin_base64, Buffer.from('stdin payload').toString('base64'));
  assert.deepEqual(request.args, ['/d', '/c', 'more']);
  assert.throws(() => buildWindowsSandboxRequest({ executable: 'cmd.exe' }), /absolute Windows path/);
  assert.throws(
    () =>
      buildWindowsSandboxRequest({
        executable: 'C:\\Windows\\System32\\cmd.exe',
        args: ['bad\0arg'],
        workspaceRoot: 'C:\\work',
        currentDirectory: 'C:\\work',
        environment: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
        timeoutMs: 5000,
      }),
    /NUL bytes/,
  );
});

test('Windows sandbox helper response validation rejects malformed or failed launch records', () => {
  const response = parseWindowsSandboxResponse({
    stdout: JSON.stringify({
      ok: true,
      result: {
        exit_code: 7,
        timed_out: false,
        cancelled: false,
        elapsed_ms: 15,
        stdout_base64: Buffer.from('out').toString('base64'),
        stderr_base64: Buffer.from('err').toString('base64'),
        stdout_truncated: false,
        stderr_truncated: false,
      },
    }),
    stderr: '',
    exitCode: 0,
    truncated: false,
  });
  assert.equal(response.exit_code, 7);
  assert.equal(response.elapsed_ms, 15);
  assert.equal(Buffer.from(response.stdout_base64, 'base64').toString(), 'out');
  assert.throws(
    () =>
      parseWindowsSandboxResponse({
        stdout: JSON.stringify({ ok: false, error: 'AppContainer setup failed' }),
        stderr: '',
        exitCode: 1,
        truncated: false,
      }),
    /AppContainer setup failed/,
  );
  assert.throws(() => parseWindowsSandboxResponse({ stdout: '{bad json}', stderr: '', exitCode: 0, truncated: false }), /invalid response/);
  const invalidDuration = JSON.stringify({
    ok: true,
    result: {
      exit_code: 0,
      timed_out: false,
      cancelled: false,
      elapsed_ms: -1,
      stdout_base64: '',
      stderr_base64: '',
      stdout_truncated: false,
      stderr_truncated: false,
    },
  });
  assert.throws(
    () => parseWindowsSandboxResponse({ stdout: invalidDuration, stderr: '', exitCode: 0, truncated: false }),
    /malformed command result/,
  );
});

test('Windows sandbox helper discovery does not guess on Linux', async () => {
  assert.equal(await findWindowsSandboxHelper({ platform: 'linux' }), null);
});

test('Windows sandbox helper paths inside or equal to the workspace are rejected', () => {
  assert.equal(isWindowsSandboxHelperOutsideWorkspace('C:\\repo\\helper.exe', 'C:\\repo'), false);
  assert.equal(isWindowsSandboxHelperOutsideWorkspace('c:\\REPO\\nested\\helper.exe', 'C:\\repo'), false);
  assert.equal(isWindowsSandboxHelperOutsideWorkspace('C:\\repo-tools\\helper.exe', 'C:\\repo'), true);
  assert.equal(isWindowsSandboxHelperOutsideWorkspace('C:\\other\\helper.exe', 'C:\\repo'), true);
  assert.equal(isWindowsSandboxHelperOutsideWorkspace('helper.exe', 'C:\\repo'), false);
});

test('Windows sandbox helper discovery requires a valid workspace context', async () => {
  assert.equal(await findWindowsSandboxHelper({ platform: 'win32' }), null);
  assert.equal(await findWindowsSandboxHelper({ platform: 'win32', workspaceRoot: 'relative-workspace' }), null);
});
