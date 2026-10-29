import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  buildBubblewrapArgs,
  findBubblewrap,
  findWindowsSandboxHelper,
  runIsolatedProcess,
  validateBubblewrapWorkspace,
} from '../src/platform/sandbox.mjs';
import { BackgroundProcessManager } from '../src/platform/background-processes.mjs';
import { runProcess } from '../src/platform/process.mjs';
import { createTempDirectory } from './helpers.mjs';

test('Bubblewrap isolates host files and networking while allowing workspace writes', async (t) => {
  if (process.platform !== 'linux') return t.skip('Bubblewrap integration requires Linux');
  const bwrap = await findBubblewrap();
  if (!bwrap) {
    if (process.env.XYST_REQUIRE_BWRAP_TEST === 'true') throw new Error('Linux CI requires a trusted system Bubblewrap executable');
    return t.skip('Trusted system Bubblewrap is not installed');
  }

  const parent = await createTempDirectory('xyst-bwrap-');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const workspace = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const approvalState = path.join(workspace, '.agent', 'approvals', 'rules.json');
  await fs.mkdir(path.dirname(approvalState), { recursive: true });
  await fs.writeFile(approvalState, '{"rules":["host-approval-canary"]}');
  const subagentTaskState = path.join(workspace, '.agent', 'subagents', 'tasks.json');
  await fs.mkdir(path.dirname(subagentTaskState), { recursive: true });
  await fs.writeFile(subagentTaskState, '{"tasks":["host-task-canary"]}');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'host-only-secret');
  await fs.symlink(outside, path.join(workspace, 'outside-link'), 'dir');

  const hardLinkedOutsideFile = path.join(outside, 'hard-linked-secret.txt');
  await fs.writeFile(hardLinkedOutsideFile, 'host-only-hard-linked-secret');
  await fs.link(hardLinkedOutsideFile, path.join(workspace, 'hard-linked-secret.txt'));
  await assert.rejects(
    runIsolatedProcess('/usr/bin/true', [], { workspaceRoot: workspace, timeoutMs: 10_000 }),
    (error) => error.code === 'SANDBOX_WORKSPACE_UNSAFE' && /hard-linked outside/.test(error.message),
  );
  await fs.unlink(path.join(workspace, 'hard-linked-secret.txt'));

  const hostProbe = path.join(outside, 'must-not-exist.txt');
  const hostWrite = await runIsolatedProcess('/usr/bin/touch', [hostProbe], { workspaceRoot: workspace, timeoutMs: 10_000 });
  assert.notEqual(hostWrite.exitCode, 0, 'sandbox must not write absolute paths outside the workspace');
  await assert.rejects(fs.access(hostProbe), 'host path outside the workspace must remain absent');

  const envCanary = 'XYST_SANDBOX_ENV_CANARY';
  const envResult = await runIsolatedProcess('/usr/bin/printenv', [envCanary], {
    workspaceRoot: workspace,
    env: { [envCanary]: 'host-secret-canary' },
    timeoutMs: 10_000,
  });
  assert.notEqual(envResult.exitCode, 0, 'host environment variables must not enter sandbox');
  assert.doesNotMatch(envResult.stdout, /host-secret-canary/);

  const tempProbe = `xyst-host-tmp-${process.pid}-${Date.now()}`;
  const tempWrite = await runIsolatedProcess('/usr/bin/touch', [`/tmp/${tempProbe}`], { workspaceRoot: workspace, timeoutMs: 10_000 });
  assert.equal(tempWrite.exitCode, 0, tempWrite.stderr);
  await assert.rejects(fs.access(path.join('/tmp', tempProbe)), 'sandbox /tmp must not expose writes to host /tmp');

  const write = await runIsolatedProcess('/usr/bin/touch', ['/workspace/sandbox-write-probe'], {
    workspaceRoot: workspace,
    timeoutMs: 10_000,
  });
  assert.equal(write.sandboxed, true);
  assert.equal(write.exitCode, 0, write.stderr);
  assert.equal(await fs.readFile(path.join(workspace, 'sandbox-write-probe'), 'utf8'), '');

  const stateProbe = await runIsolatedProcess(
    '/bin/sh',
    [
      '-c',
      'test ! -e /workspace/.agent/approvals/rules.json && test ! -e /workspace/.agent/subagents/tasks.json && mkdir -p /workspace/.agent/approvals /workspace/.agent/subagents && printf forged > /workspace/.agent/approvals/rules.json && printf private-task-state > /workspace/.agent/subagents/tasks.json && cat /workspace/.agent/approvals/rules.json /workspace/.agent/subagents/tasks.json',
    ],
    {
      workspaceRoot: workspace,
      timeoutMs: 10_000,
    },
  );
  assert.equal(stateProbe.sandboxed, true);
  assert.equal(stateProbe.exitCode, 0, stateProbe.stderr);
  assert.equal(stateProbe.stdout, 'forgedprivate-task-state', 'the process should see only its private temporary state view');
  assert.equal(
    await fs.readFile(approvalState, 'utf8'),
    '{"rules":["host-approval-canary"]}',
    'sandbox writes must not alter host approval policy',
  );
  assert.equal(
    await fs.readFile(subagentTaskState, 'utf8'),
    '{"tasks":["host-task-canary"]}',
    'sandbox writes must not alter host subagent task records',
  );

  const readOnlyTarget = path.join(workspace, 'sandbox-read-only-probe');
  const readOnlyWrite = await runIsolatedProcess('/usr/bin/touch', ['/workspace/sandbox-read-only-probe'], {
    workspaceRoot: workspace,
    sandboxMode: 'workspace-read',
    timeoutMs: 10_000,
  });
  assert.equal(readOnlyWrite.sandboxed, true);
  assert.notEqual(readOnlyWrite.exitCode, 0, 'workspace-read processes must not create workspace files');
  await assert.rejects(fs.access(readOnlyTarget), 'read-only workspace mounts must reject writes');

  const hidden = await runIsolatedProcess('/usr/bin/test', ['-r', '/workspace/outside-link/secret.txt'], {
    workspaceRoot: workspace,
    timeoutMs: 10_000,
  });
  assert.equal(hidden.exitCode, 1, 'sandbox must not resolve an absolute workspace symlink back to the host');
  const hostHome = await runIsolatedProcess('/usr/bin/test', ['-e', process.env.HOME || '/root'], {
    workspaceRoot: workspace,
    timeoutMs: 10_000,
  });
  assert.equal(hostHome.exitCode, 1, 'host home directory must not be mounted');

  await fs.access('/usr/bin/unshare');
  const nestedUserNamespace = await runIsolatedProcess('/usr/bin/unshare', ['--user', '--map-root-user', '/usr/bin/true'], {
    workspaceRoot: workspace,
    timeoutMs: 10_000,
  });
  assert.notEqual(nestedUserNamespace.exitCode, 0, 'a process inside the sandbox must not create a nested user namespace');

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    const script =
      "import socket,sys; s=socket.socket(); s.settimeout(1);\ntry: s.connect(('127.0.0.1', int(sys.argv[1]))); print('connected')\nexcept OSError: print('blocked')";
    const network = await runIsolatedProcess('/usr/bin/python3', ['-c', script, String(port)], {
      workspaceRoot: workspace,
      timeoutMs: 10_000,
    });
    assert.equal(network.exitCode, 0, network.stderr);
    assert.match(network.stdout, /blocked/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const manager = new BackgroundProcessManager(workspace, {
    tools: { shell_enabled: true },
    sandbox: { mode: 'required' },
    budgets: { max_tool_output_bytes: 4096 },
  });
  t.after(async () => {
    for (const record of await manager.list().catch(() => []))
      if (['starting', 'running', 'stopping'].includes(record.status)) await manager.stop(record.id).catch(() => {});
    await manager.settle();
  });
  const background = await manager.start({
    command: '/usr/bin/python3',
    args: ['-c', "print('background-sandbox-marker')"],
  });
  assert.equal(background.sandboxed, true);
  assert.ok(['running', 'exited'].includes(background.status));
  let completed = await manager.read(background.id);
  for (let attempt = 0; attempt < 100 && completed.status === 'running'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    completed = await manager.read(background.id);
  }
  assert.equal(completed.status, 'exited');
  assert.equal(completed.sandboxed, true);
  assert.match(completed.stdout, /background-sandbox-marker/);

  await manager.settle();
  const validatedWorkspace = await validateBubblewrapWorkspace(workspace, { includeIdentity: true });
  const displacedWorkspace = path.join(parent, 'displaced-workspace');
  const replacementWorkspace = path.join(parent, 'replacement-workspace');
  await fs.mkdir(replacementWorkspace);
  await fs.rename(workspace, displacedWorkspace);
  await fs.rename(replacementWorkspace, workspace);
  const failureToken = randomUUID();
  const swappedWorkspaceRun = await runProcess(
    bwrap,
    buildBubblewrapArgs({
      workspaceRoot: validatedWorkspace.path,
      workspaceIdentity: validatedWorkspace.identity,
      workspaceIdentityFailureToken: failureToken,
      command: '/usr/bin/touch',
      args: ['/workspace/must-not-run-after-workspace-swap'],
      bwrap,
    }),
    { cwd: '/', env: {}, shell: false, captureStatusFd: true, timeoutMs: 10_000 },
  );
  assert.notEqual(swappedWorkspaceRun.exitCode, 0, 'a stale workspace identity must prevent the requested command from starting');
  assert.match(swappedWorkspaceRun.stderr, new RegExp(`XYST_WORKSPACE_IDENTITY_MISMATCH:${failureToken}`));
  await assert.rejects(fs.access(path.join(workspace, 'must-not-run-after-workspace-swap')));
});

test('Windows AppContainer helper reaches the shared Node process path and fails closed on escapes', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows AppContainer integration requires Windows');
  const parent = await createTempDirectory('xyst-appcontainer-integration-');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const helper = await findWindowsSandboxHelper({ workspaceRoot: parent });
  if (!helper) {
    if (process.env.XYST_REQUIRE_WINDOWS_SANDBOX_TEST === 'true')
      throw new Error('Windows desktop CI requires the packaged AppContainer helper');
    return t.skip('Packaged Windows AppContainer helper is unavailable');
  }

  const workspace = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  const environment = { ...process.env };
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const nestedDirectory = path.join(workspace, 'existing', 'nested');
  await fs.mkdir(nestedDirectory, { recursive: true });
  await fs.writeFile(path.join(nestedDirectory, 'existing.txt'), 'before sandbox');
  const approvalState = path.join(workspace, '.agent', 'approvals', 'rules.json');
  await fs.mkdir(path.dirname(approvalState), { recursive: true });
  await fs.writeFile(approvalState, '{"rules":["host-approval-canary"]}');
  const subagentTaskState = path.join(workspace, '.agent', 'subagents', 'tasks.json');
  await fs.mkdir(path.dirname(subagentTaskState), { recursive: true });
  await fs.writeFile(subagentTaskState, '{"tasks":["host-task-canary"]}');

  const streams = await runIsolatedProcess('cmd.exe', ['/d', '/c', 'echo stdout-marker & echo stderr-marker 1>&2'], {
    workspaceRoot: workspace,
    cwd: workspace,
    env: environment,
    timeoutMs: 10_000,
  });
  assert.equal(streams.sandboxed, true);
  assert.equal(streams.exitCode, 0);
  assert.match(streams.stdout, /stdout-marker/);
  assert.match(streams.stderr, /stderr-marker/);

  const stdin = await runIsolatedProcess('cmd.exe', ['/d', '/c', 'more'], {
    workspaceRoot: workspace,
    cwd: workspace,
    env: environment,
    timeoutMs: 10_000,
    input: 'stdin-marker\r\n',
  });
  assert.equal(stdin.exitCode, 0);
  assert.match(stdin.stdout, /stdin-marker/);

  const workspaceFile = path.join(workspace, 'allowed-write.txt');
  const workspaceWrite = await runIsolatedProcess('cmd.exe', ['/d', '/c', 'echo allowed > allowed-write.txt'], {
    workspaceRoot: workspace,
    cwd: workspace,
    env: environment,
    timeoutMs: 10_000,
  });
  assert.equal(workspaceWrite.exitCode, 0, workspaceWrite.stderr);
  assert.equal((await fs.readFile(workspaceFile, 'utf8')).trim(), 'allowed');

  const stateProbeScript = [
    "$p = Join-Path $PWD '.agent\\approvals\\rules.json'",
    'try { Get-Content -LiteralPath $p -ErrorAction Stop; exit 21 } catch {}',
    "try { Set-Content -LiteralPath $p -Value 'forged' -ErrorAction Stop; exit 22 } catch {}",
    "$p = Join-Path $PWD '.agent\\subagents\\tasks.json'",
    'try { Get-Content -LiteralPath $p -ErrorAction Stop; exit 23 } catch {}',
    "try { Set-Content -LiteralPath $p -Value 'forged-task-state' -ErrorAction Stop; exit 24 } catch {}",
    "Write-Output 'approval-state-protected'",
  ].join('; ');
  const stateProbe = await runIsolatedProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', stateProbeScript], {
    workspaceRoot: workspace,
    cwd: workspace,
    env: environment,
    timeoutMs: 10_000,
  });
  assert.equal(stateProbe.exitCode, 0, stateProbe.stderr);
  assert.match(stateProbe.stdout, /approval-state-protected/);
  assert.equal(
    await fs.readFile(approvalState, 'utf8'),
    '{"rules":["host-approval-canary"]}',
    'AppContainer must not read or mutate saved approval policy',
  );
  assert.equal(
    await fs.readFile(subagentTaskState, 'utf8'),
    '{"tasks":["host-task-canary"]}',
    'AppContainer must not read or mutate saved subagent task records',
  );

  const readOnlyFile = path.join(workspace, 'read-only-write.txt');
  const readOnlyWrite = await runIsolatedProcess('cmd.exe', ['/d', '/c', 'echo denied > read-only-write.txt'], {
    workspaceRoot: workspace,
    cwd: workspace,
    env: environment,
    sandboxMode: 'workspace-read',
    timeoutMs: 10_000,
  });
  assert.notEqual(readOnlyWrite.exitCode, 0, 'workspace-read AppContainers must reject workspace writes');
  await assert.rejects(fs.access(readOnlyFile));

  const nestedRead = await runIsolatedProcess('cmd.exe', ['/d', '/c', 'type existing\\nested\\existing.txt'], {
    workspaceRoot: workspace,
    cwd: workspace,
    env: environment,
    timeoutMs: 10_000,
  });
  assert.equal(nestedRead.exitCode, 0, nestedRead.stderr);
  assert.match(nestedRead.stdout, /before sandbox/);
  const nestedWrite = await runIsolatedProcess('cmd.exe', ['/d', '/c', 'echo after sandbox > existing\\nested\\existing.txt'], {
    workspaceRoot: workspace,
    cwd: workspace,
    env: environment,
    timeoutMs: 10_000,
  });
  assert.equal(nestedWrite.exitCode, 0, nestedWrite.stderr);
  assert.equal(await fs.readFile(path.join(nestedDirectory, 'existing.txt'), 'utf8').then((text) => text.trim()), 'after sandbox');

  const tempName = `xyst-private-temp-${process.pid}-${Date.now()}.txt`;
  const tempProbe = `$ErrorActionPreference = 'Stop'; $file = Join-Path $env:TEMP '${tempName}'; Set-Content -LiteralPath $file -Value 'private'; Get-Content -LiteralPath $file`;
  const privateTemp = await runIsolatedProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', tempProbe], {
    workspaceRoot: workspace,
    cwd: workspace,
    env: environment,
    timeoutMs: 10_000,
  });
  assert.equal(privateTemp.exitCode, 0, privateTemp.stderr);
  assert.match(privateTemp.stdout, /private/);

  const outsideFile = path.join(outside, 'must-not-exist.txt');
  const siblingWrite = await runIsolatedProcess('cmd.exe', ['/d', '/c', `echo escape-attempt > "${outsideFile}"`], {
    workspaceRoot: workspace,
    cwd: workspace,
    env: environment,
    timeoutMs: 10_000,
  });
  assert.notEqual(siblingWrite.exitCode, 0, 'AppContainer must not write to a sibling host directory');
  await assert.rejects(fs.access(outsideFile));

  const hostSibling = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve, reject) => {
    hostSibling.once('spawn', resolve);
    hostSibling.once('error', reject);
  });
  t.after(async () => {
    if (hostSibling.exitCode !== null || hostSibling.signalCode !== null) return;
    const closed = new Promise((resolve) => hostSibling.once('close', resolve));
    hostSibling.kill();
    await closed;
  });
  const processAccessProbe = [
    "$ErrorActionPreference = 'Stop'",
    '$source = \'using System; using System.Runtime.InteropServices; public static class XystSandboxProcessAccessProbe { [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int processId); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle); }\'',
    'Add-Type -TypeDefinition $source -ErrorAction Stop',
    '$targets = @(@{ name = "parent"; pid = [int]$env:XYST_SANDBOX_HOST_PID }, @{ name = "sibling"; pid = [int]$env:XYST_SANDBOX_SIBLING_PID })',
    '$rights = @(@{ name = "terminate"; mask = 0x0001 }, @{ name = "create-thread"; mask = 0x0002 }, @{ name = "vm-operation"; mask = 0x0008 }, @{ name = "vm-read"; mask = 0x0010 }, @{ name = "vm-write"; mask = 0x0020 }, @{ name = "duplicate-handle"; mask = 0x0040 }, @{ name = "create-process"; mask = 0x0080 }, @{ name = "set-quota"; mask = 0x0100 }, @{ name = "set-information"; mask = 0x0200 }, @{ name = "suspend-resume"; mask = 0x0800 }, @{ name = "write-dac"; mask = 0x00040000 }, @{ name = "write-owner"; mask = 0x00080000 })',
    '$denied = [System.Collections.Generic.List[string]]::new()',
    '$failures = [System.Collections.Generic.List[string]]::new()',
    'foreach ($target in $targets) { foreach ($right in $rights) { $handle = [XystSandboxProcessAccessProbe]::OpenProcess([uint32]$right.mask, $false, $target.pid); if ($handle -eq [IntPtr]::Zero) { $denied.Add($target.name + ":" + $right.name) } else { [void][XystSandboxProcessAccessProbe]::CloseHandle($handle); $failures.Add($target.name + ":" + $right.name) } } }',
    '$result = [ordered]@{ denied = @($denied); failures = @($failures) }',
    '[Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))',
    'if ($failures.Count -ne 0) { exit 19 }',
  ].join('; ');
  const processAccess = await runIsolatedProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', processAccessProbe], {
    workspaceRoot: workspace,
    cwd: workspace,
    env: {
      ...environment,
      XYST_SANDBOX_HOST_PID: String(process.pid),
      XYST_SANDBOX_SIBLING_PID: String(hostSibling.pid),
    },
    timeoutMs: 10_000,
  });
  assert.equal(processAccess.exitCode, 0, processAccess.stderr);
  const processAccessResult = JSON.parse(processAccess.stdout);
  const expectedDeniedProcessRights = [
    'terminate',
    'create-thread',
    'vm-operation',
    'vm-read',
    'vm-write',
    'duplicate-handle',
    'create-process',
    'set-quota',
    'set-information',
    'suspend-resume',
    'write-dac',
    'write-owner',
  ];
  assert.deepEqual(processAccessResult.failures, []);
  assert.deepEqual(
    processAccessResult.denied.sort(),
    ['parent', 'sibling'].flatMap((target) => expectedDeniedProcessRights.map((right) => `${target}:${right}`)).sort(),
  );

  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  try {
    const script = `$client = New-Object System.Net.Sockets.TcpClient; try { $task = $client.ConnectAsync('127.0.0.1', ${port}); if ($task.Wait(2000)) { $task.GetAwaiter().GetResult(); 'connected' } else { 'blocked' } } catch { 'blocked' } finally { $client.Dispose() }`;
    const network = await runIsolatedProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', script], {
      workspaceRoot: workspace,
      cwd: workspace,
      env: environment,
      timeoutMs: 10_000,
    });
    assert.equal(network.exitCode, 0, network.stderr);
    assert.match(network.stdout, /blocked/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  await assert.rejects(
    runIsolatedProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 5'], {
      workspaceRoot: workspace,
      cwd: workspace,
      env: environment,
      timeoutMs: 1000,
    }),
    (error) => error.code === 'ETIMEDOUT' && error.result?.sandboxed === true,
  );

  const controller = new AbortController();
  const cancelTimer = setTimeout(() => controller.abort(), 500);
  try {
    await assert.rejects(
      runIsolatedProcess('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', 'Start-Sleep -Seconds 5'], {
        workspaceRoot: workspace,
        cwd: workspace,
        env: environment,
        timeoutMs: 10_000,
        signal: controller.signal,
      }),
      (error) => error.code === 'ABORT_ERR' && error.result?.sandboxed === true,
    );
  } finally {
    clearTimeout(cancelTimer);
  }
});
