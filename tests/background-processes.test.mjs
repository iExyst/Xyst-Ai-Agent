import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import { BackgroundProcessManager } from '../src/platform/background-processes.mjs';
import {
  captureProcessIdentity,
  terminateVerifiedLinuxProcessGroup,
  terminateVerifiedWindowsProcess,
  verifyProcessIdentity,
} from '../src/platform/process-identity.mjs';
import { createSymlinkOrSkip, createTempDirectory } from './helpers.mjs';

const enabled = { tools: { shell_enabled: true }, budgets: { max_tool_output_bytes: 4096 } };

test('background process manager refuses symbolic links in its persistent state directory', async (t) => {
  for (const linkProcessesDirectory of [false, true]) {
    const root = await createTempDirectory(`xyst-process-state-link-root-${linkProcessesDirectory ? 'processes' : 'agent'}`);
    const external = await createTempDirectory(`xyst-process-state-link-target-${linkProcessesDirectory ? 'processes' : 'agent'}`);
    t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(external, { recursive: true, force: true })]));
    const agentDirectory = path.join(root, '.agent');
    if (linkProcessesDirectory) await fs.mkdir(agentDirectory);
    const link = linkProcessesDirectory ? path.join(agentDirectory, 'processes') : agentDirectory;
    if (!(await createSymlinkOrSkip(t, external, link))) return;
    const manager = new BackgroundProcessManager(root, enabled);
    await assert.rejects(manager.initialize(), { code: 'PROCESS_STATE_PATH_UNSAFE' });
    assert.deepEqual(await fs.readdir(external), []);
  }
});

test('background process manager skips linked and oversized persisted records', async (t) => {
  const root = await createTempDirectory('xyst-process-record-validation-');
  const external = await createTempDirectory('xyst-process-record-target-');
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(external, { recursive: true, force: true })]));
  const directory = path.join(root, '.agent', 'processes');
  await fs.mkdir(directory, { recursive: true });
  const linkedId = '55a81aaf-9d50-4a49-961d-4cf4a5c13611';
  const linkedTarget = path.join(external, 'linked-process.json');
  await fs.writeFile(linkedTarget, JSON.stringify({ id: linkedId, status: 'exited' }));
  if (!(await createSymlinkOrSkip(t, linkedTarget, path.join(directory, `${linkedId}.json`), 'file'))) return;

  const oversizedId = '755f944f-4518-44e5-bd65-c4e43d128782';
  const oversizedRecord = path.join(directory, `${oversizedId}.json`);
  const probe = await fs.open(oversizedRecord, 'w');
  await probe.truncate(8 * 1024 * 1024 + 1);
  await probe.close();

  const manager = new BackgroundProcessManager(root, enabled);
  assert.deepEqual(await manager.list(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(linkedTarget, 'utf8')), { id: linkedId, status: 'exited' });
});

test('background processes persist identifiers and bounded output and enforce session ownership', async (t) => {
  const root = await createTempDirectory('xyst-process-');
  const manager = new BackgroundProcessManager(root, enabled);
  t.after(async () => {
    await stopAll(manager);
    await fs.rm(root, { recursive: true, force: true });
  });
  const processRecord = await manager.start({
    command: process.execPath,
    args: ['-e', "process.stdout.write('job-output')"],
    session_id: '8c2d8c80-840a-41ce-b121-78a5b8694af3',
  });
  assert.ok(['running', 'exited'].includes(processRecord.status));
  assert.ok(processRecord.pid > 0);
  await assert.rejects(manager.read(processRecord.id, { session_id: 'ec0a5846-7dd7-4112-a6a4-3b454658adad' }), /does not belong/);
  let observed;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    observed = await manager.read(processRecord.id);
    if (observed.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(observed.status, 'exited');
  assert.match(observed.stdout, /job-output/);
  assert.equal((await manager.list({ session_id: processRecord.session_id })).length, 1);
});

test('background process output is redacted before it reaches persistent records', async (t) => {
  const root = await createTempDirectory('xyst-process-');
  const manager = new BackgroundProcessManager(root, enabled);
  t.after(async () => {
    await stopAll(manager);
    await fs.rm(root, { recursive: true, force: true });
  });
  const processRecord = await manager.start({
    command: process.execPath,
    args: ['-e', "process.stdout.write('API_KEY=background-canary-secret')"],
  });
  let observed;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    observed = await manager.read(processRecord.id);
    if (observed.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const saved = await fs.readFile(path.join(root, '.agent', 'processes', `${processRecord.id}.json`), 'utf8');
  assert.match(observed.stdout, /API_KEY=\[REDACTED\]/);
  assert.doesNotMatch(saved, /background-canary-secret/);
});

test('unrestricted background processes use machine directories and inherit the full user environment', async (t) => {
  const root = await createTempDirectory('xyst-process-');
  const outside = await createTempDirectory('xyst-process-outside-');
  const key = 'XYST_UNRESTRICTED_CANARY';
  const previous = process.env[key];
  process.env[key] = 'unfiltered-user-value';
  const manager = new BackgroundProcessManager(root, { tools: { autonomy: 'unrestricted' }, budgets: { max_tool_output_bytes: 4096 } });
  t.after(async () => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    await stopAll(manager);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const childCode = `process.stdout.write(JSON.stringify({cwd:process.cwd(),value:process.env.${key}}))`;
  const processRecord = await manager.start({ command: process.execPath, args: ['-e', childCode], cwd: outside });
  let observed;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    observed = await manager.read(processRecord.id);
    if (observed.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(observed.status, 'exited');
  assert.deepEqual(JSON.parse(observed.stdout), { cwd: outside, value: 'unfiltered-user-value' });
});

test('unrestricted background processes can run without an automatic timeout and remain stoppable', async (t) => {
  const root = await createTempDirectory('xyst-process-unbounded-');
  const manager = new BackgroundProcessManager(root, { tools: { autonomy: 'unrestricted' } });
  t.after(async () => {
    await stopAll(manager);
    await fs.rm(root, { recursive: true, force: true });
  });
  const record = await manager.start({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    timeout_seconds: null,
  });
  assert.equal(record.timeout_seconds, null);
  assert.equal(record.status, 'running');
  const stopped = await manager.stop(record.id);
  assert.equal(stopped.stopped, true);
});

test('interactive background processes accept session-scoped follow-up input', async (t) => {
  const root = await createTempDirectory('xyst-process-interactive-');
  const manager = new BackgroundProcessManager(root, enabled);
  t.after(async () => {
    await stopAll(manager);
    await fs.rm(root, { recursive: true, force: true });
  });
  const childCode =
    "process.stdin.setEncoding('utf8');process.stdin.on('data',value=>{process.stdout.write('received:'+value);if(value.includes('\\n'))process.stdin.pause()})";
  const record = await manager.start({
    command: process.execPath,
    args: ['-e', childCode],
    interactive: true,
    session_id: '8c2d8c80-840a-41ce-b121-78a5b8694af3',
  });
  await assert.rejects(
    manager.writeInput(record.id, 'wrong session', { session_id: 'ec0a5846-7dd7-4112-a6a4-3b454658adad' }),
    /does not belong/,
  );
  const result = await manager.writeInput(record.id, 'continue\n', { session_id: record.session_id });
  assert.equal(result.bytes_written, Buffer.byteLength('continue\n'));
  let observed;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    observed = await manager.read(record.id, { session_id: record.session_id });
    if (observed.stdout.includes('received:continue')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.match(observed.stdout, /received:continue/);
  assert.equal(observed.interactive, true);
  await assert.rejects(manager.writeInput(record.id, 'x'.repeat(65_537), { session_id: record.session_id }), /65536 bytes/);
});

test('interactive input errors are handled without leaking child error details or crashing the manager', async (t) => {
  const root = await createTempDirectory('xyst-process-interactive-write-error-');
  const manager = new BackgroundProcessManager(root, enabled);
  t.after(async () => {
    await stopAll(manager);
    await fs.rm(root, { recursive: true, force: true });
  });
  const record = await manager.start({
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    interactive: true,
    session_id: '8c2d8c80-840a-41ce-b121-78a5b8694af3',
  });
  const stream = manager.children.get(record.id).stdin;
  const originalWrite = stream.write;
  const existingErrorListeners = stream.listenerCount('error');
  stream.write = function (_input, callback) {
    queueMicrotask(() => {
      const error = Object.assign(new Error('sensitive child input diagnostic'), { code: 'EPIPE' });
      this.emit('error', error);
      callback?.(error);
    });
    return true;
  };
  try {
    await assert.rejects(manager.writeInput(record.id, 'continue\n', { session_id: record.session_id }), (error) => {
      assert.equal(error.code, 'PROCESS_INPUT_FAILED');
      assert.equal(error.stdinErrorCode, 'EPIPE');
      assert.doesNotMatch(error.message, /sensitive child input diagnostic/);
      return true;
    });
    assert.equal(stream.listenerCount('error'), existingErrorListeners);
  } finally {
    stream.write = originalWrite;
  }
  assert.equal((await manager.stop(record.id)).stopped, true);
});

test('background process output is capped and stop terminates the managed process', async (t) => {
  const root = await createTempDirectory('xyst-process-');
  const manager = new BackgroundProcessManager(root, { ...enabled, budgets: { max_tool_output_bytes: 1024 } });
  t.after(async () => {
    await stopAll(manager);
    await fs.rm(root, { recursive: true, force: true });
  });
  const noisy = await manager.start({ command: process.execPath, args: ['-e', "process.stdout.write('x'.repeat(10000))"] });
  let noisyResult;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    noisyResult = await manager.read(noisy.id);
    if (noisyResult.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(noisyResult.status, 'exited');
  assert.ok(Buffer.byteLength(noisyResult.stdout) <= 512);
  assert.equal(noisyResult.output_truncated, true);

  const longRunning = await manager.start({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] });
  const stopped = await manager.stop(longRunning.id);
  assert.equal(stopped.stopped, true);
  let final;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    final = await manager.read(longRunning.id);
    if (final.status !== 'stopping' && final.status !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(final.status, 'exited');
  assert.equal((await manager.stop(longRunning.id)).stopped, false);
  await assert.rejects(
    manager.remove(longRunning.id).then(async () => manager.read(longRunning.id)),
    /not found/,
  );
});

test('background process manager does not signal records owned by another manager and refuses workspace escape', async (t) => {
  const root = await createTempDirectory('xyst-process-');
  const outside = await createTempDirectory('xyst-outside-');
  const manager = new BackgroundProcessManager(root, enabled);
  t.after(async () => {
    await stopAll(manager);
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const longRunning = await manager.start({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] });
  await assert.rejects(
    manager.start({ command: process.execPath, args: ['-e', ''], cwd: outside }),
    /escapes workspace|inside the workspace/,
  );
  const recordPath = path.join(root, '.agent', 'processes', `${longRunning.id}.json`);
  let persisted;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    persisted = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    if (persisted.manager_identity && persisted.process_identity) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(persisted.manager_identity);
  assert.ok(persisted.process_identity);
  persisted.manager_pid = 2_147_483_647;
  persisted.manager_identity = {
    platform: process.platform,
    pid: 2_147_483_647,
    boot_id: 'stale',
    start_ticks: '1',
    command_hash: 'stale',
  };
  await fs.writeFile(recordPath, JSON.stringify(persisted));
  const restarted = new BackgroundProcessManager(root, enabled);
  assert.equal((await restarted.read(longRunning.id)).status, 'recoverable');
  assert.equal((await restarted.stop(longRunning.id)).stopped, true);
  assert.equal((await restarted.read(longRunning.id)).status, 'exited');
});

test('Linux background process recovery stops a process group after its manager is force-killed', {
  skip: process.platform !== 'linux' ? 'Linux pidfd integration requires Linux' : false,
  timeout: 30_000,
}, async (t) => {
  const pidfdSupport = spawnSync('python3', ['-I', '-S', '-c', 'import os; fd=os.pidfd_open(os.getpid()); os.close(fd)'], {
    encoding: 'utf8',
    timeout: 3_000,
    windowsHide: true,
  });
  if (pidfdSupport.error || pidfdSupport.status !== 0) {
    const reason = 'Python 3.9+ or Linux 5.3+ pidfd support is unavailable on this host';
    if (process.env.XYST_REQUIRE_PIDFD_TEST === 'true') throw new Error(reason, { cause: pidfdSupport.error });
    return t.skip(reason);
  }

  const root = await createTempDirectory('xyst-manager-crash-recovery-');
  const moduleUrl = new URL('../src/platform/background-processes.mjs', import.meta.url).href;
  const workerCode = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { BackgroundProcessManager } from ${JSON.stringify(moduleUrl)};
    const root = ${JSON.stringify(root)};
    const manager = new BackgroundProcessManager(root, ${JSON.stringify(enabled)});
    const job = await manager.start({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
    const recordPath = path.join(root, '.agent', 'processes', job.id + '.json');
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
      if (record.manager_identity && record.process_identity) {
        process.stdout.write(JSON.stringify({ id: job.id, process_identity: record.process_identity }) + '\\n');
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    setInterval(() => {}, 1000);
  `;
  let worker = null;
  let workerOutput = '';
  let workerError = '';
  t.after(async () => {
    if (worker && worker.exitCode === null && worker.signalCode === null) {
      const closed = new Promise((resolve) => worker.once('close', resolve));
      worker.kill('SIGKILL');
      let closeTimer;
      await Promise.race([closed, new Promise((resolve) => (closeTimer = setTimeout(resolve, 2_000)))]);
      clearTimeout(closeTimer);
    }
    const processDirectory = path.join(root, '.agent', 'processes');
    for (const name of await fs.readdir(processDirectory).catch(() => [])) {
      const persisted = await fs
        .readFile(path.join(processDirectory, name), 'utf8')
        .then((contents) => JSON.parse(contents))
        .catch(() => null);
      if (!Number.isInteger(persisted?.pid)) continue;
      const identity = persisted.process_identity || (await captureProcessIdentity(persisted.pid));
      if (identity) await terminateVerifiedLinuxProcessGroup(identity, 'SIGKILL').catch(() => {});
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  worker = spawn(process.execPath, ['--input-type=module', '-e', workerCode], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout.setEncoding('utf8');
  worker.stderr.setEncoding('utf8');
  worker.stdout.on('data', (chunk) => (workerOutput += chunk));
  worker.stderr.on('data', (chunk) => (workerError += chunk));

  let started = null;
  for (let attempt = 0; attempt < 200 && !started; attempt += 1) {
    const line = workerOutput.split(/\r?\n/).find((value) => value.startsWith('{'));
    if (line) started = JSON.parse(line);
    else if (worker.exitCode !== null || worker.signalCode !== null) break;
    else await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(started, `the manager should persist process identities before announcing readiness${workerError ? `: ${workerError}` : ''}`);
  assert.equal(await verifyProcessIdentity(started.process_identity), 'match');

  const managerClosed = new Promise((resolve) => worker.once('close', resolve));
  worker.kill('SIGKILL');
  let closeTimer;
  const managerExited = await Promise.race([
    managerClosed.then(() => true),
    new Promise((resolve) => (closeTimer = setTimeout(() => resolve(false), 5_000))),
  ]);
  clearTimeout(closeTimer);
  assert.equal(managerExited, true, 'the worker manager should close after SIGKILL');

  const recovered = new BackgroundProcessManager(root, enabled);
  assert.equal((await recovered.read(started.id)).status, 'recoverable');
  assert.equal((await recovered.stop(started.id)).stopped, true);
  assert.equal((await recovered.read(started.id)).status, 'exited');
  let processStatus = 'match';
  for (let attempt = 0; attempt < 100 && processStatus === 'match'; attempt += 1) {
    processStatus = await verifyProcessIdentity(started.process_identity);
    if (processStatus === 'match') await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(['absent', 'mismatch'].includes(processStatus), `recovered process should be gone, found ${processStatus}`);
});

test('recovered Windows process termination captures nested descendants while the tree is still spawning', {
  skip: process.platform !== 'win32' ? 'Windows Job Object recovery integration requires Windows' : false,
  timeout: 60_000,
}, async (t) => {
  const root = await createTempDirectory('xyst-process-descendant-recovery-');
  const manager = new BackgroundProcessManager(root, enabled);
  const markerPath = path.join(root, 'descendant-heartbeat.log');
  const spawnMorePath = path.join(root, 'spawn-more-descendants');
  const descendantIdentities = [];
  t.after(async () => {
    await stopAll(manager);
    for (const identity of descendantIdentities) await terminateVerifiedWindowsProcess(identity).catch(() => {});
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const tickerCode = `const fs = require('node:fs'); const target = ${JSON.stringify(markerPath)}; let sequence = 0; setInterval(() => fs.appendFileSync(target, process.pid + ':' + (++sequence) + '\\n'), 20);`;
  const spawnerCode = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const source = ${JSON.stringify(tickerCode)}; const control = ${JSON.stringify(spawnMorePath)}; const launch = () => { const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: 'ignore' }); process.stdout.write(String(child.pid) + '\\n'); }; let initial = 0; const initialTimer = setInterval(() => { if (initial >= 2) { clearInterval(initialTimer); return; } launch(); initial += 1; }, 60); let extraStarted = false; setInterval(() => { if (extraStarted || !fs.existsSync(control)) return; extraStarted = true; let extra = 0; const extraTimer = setInterval(() => { if (extra >= 8) { clearInterval(extraTimer); return; } launch(); extra += 1; }, 35); }, 5); setInterval(() => {}, 1000);`;
  const rootCode = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(spawnerCode)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); process.stdout.write(String(child.pid) + '\\n'); child.stdout.on('data', (chunk) => process.stdout.write(chunk)); setInterval(() => {}, 1000);`;
  const running = await manager.start({ command: process.execPath, args: ['-e', rootCode] });
  const parsePids = (output) =>
    output
      .trim()
      .split(/\r?\n/)
      .map((value) => Number.parseInt(value, 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  let descendantPids = [];
  for (let attempt = 0; attempt < 100 && descendantPids.length < 3; attempt += 1) {
    const current = await manager.read(running.id);
    descendantPids = parsePids(current.stdout);
    if (descendantPids.length < 3) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(descendantPids.length >= 3, 'the process tree should report its spawner and nested children');
  for (const pid of descendantPids.slice(0, 3)) {
    let identity = null;
    for (let attempt = 0; attempt < 30 && !identity; attempt += 1) {
      identity = await captureProcessIdentity(pid);
      if (!identity) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(identity, `capture process identity for descendant ${pid}`);
    descendantIdentities.push(identity);
  }
  for (const identity of descendantIdentities) assert.equal(await verifyProcessIdentity(identity), 'match');
  let markerContents = '';
  for (let attempt = 0; attempt < 50 && !markerContents; attempt += 1) {
    markerContents = await fs.readFile(markerPath, 'utf8').catch(() => '');
    if (!markerContents) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(markerContents, 'nested processes should be alive and writing their heartbeat before recovery');

  const recordPath = path.join(root, '.agent', 'processes', `${running.id}.json`);
  let persisted;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    persisted = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    if (persisted.manager_identity && persisted.process_identity) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(persisted.manager_identity);
  assert.ok(persisted.process_identity);
  persisted.manager_pid = 2_147_483_647;
  persisted.manager_identity = {
    platform: 'win32',
    pid: 2_147_483_647,
    creation_time: '1',
    image_hash: '0'.repeat(64),
  };
  await fs.writeFile(recordPath, JSON.stringify(persisted));

  const restarted = new BackgroundProcessManager(root, enabled);
  assert.equal((await restarted.read(running.id)).status, 'recoverable');
  const pidsBeforeRecovery = new Set(parsePids((await manager.read(running.id)).stdout));
  await fs.writeFile(spawnMorePath, 'start bounded second wave');
  let stopFinished = false;
  const stopOperation = restarted.stop(running.id).then(
    (result) => {
      stopFinished = true;
      return result;
    },
    (error) => {
      stopFinished = true;
      throw error;
    },
  );
  let spawnedDuringRecovery = false;
  for (let attempt = 0; attempt < 200 && !stopFinished; attempt += 1) {
    const currentPids = parsePids((await manager.read(running.id)).stdout);
    if (currentPids.some((pid) => !pidsBeforeRecovery.has(pid))) {
      spawnedDuringRecovery = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const stopped = await stopOperation;
  if (!spawnedDuringRecovery) {
    const finalPids = parsePids((await manager.read(running.id)).stdout);
    spawnedDuringRecovery = finalPids.some((pid) => !pidsBeforeRecovery.has(pid));
  }
  assert.equal(spawnedDuringRecovery, true, 'nested processes should continue to start while recovery attaches the tree');
  assert.equal(stopped.stopped, true);
  for (const identity of descendantIdentities) {
    let descendantStatus = 'match';
    for (let attempt = 0; attempt < 50 && descendantStatus === 'match'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      descendantStatus = await verifyProcessIdentity(identity);
    }
    assert.ok(['absent', 'mismatch'].includes(descendantStatus), `descendant should be gone, found ${descendantStatus}`);
  }
  const markerAtStop = await fs.readFile(markerPath, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await fs.readFile(markerPath, 'utf8'), markerAtStop, 'no nested process should keep writing after Job termination');
});

test('recovered Windows process termination leaves WMI-created out-of-tree processes untouched', {
  skip: process.platform !== 'win32' ? 'Windows WMI recovery boundary integration requires Windows' : false,
  timeout: 60_000,
}, async (t) => {
  const root = await createTempDirectory('xyst-process-wmi-recovery-');
  const manager = new BackgroundProcessManager(root, enabled);
  const markerPath = path.join(root, 'wmi-heartbeat.log');
  const scriptPath = path.join(root, 'wmi-heartbeat.mjs');
  let externalPid = null;
  let externalIdentity = null;
  t.after(async () => {
    await stopAll(manager);
    try {
      externalIdentity ||= externalPid ? await captureProcessIdentity(externalPid) : null;
      if (externalPid) {
        assert.ok(externalIdentity, `capture a safe process identity to clean up WMI child ${externalPid}`);
        const outcome = await terminateVerifiedWindowsProcess(externalIdentity);
        assert.ok(['absent', 'terminated'].includes(outcome), `WMI child cleanup returned ${outcome}`);
        let status = 'match';
        for (let attempt = 0; attempt < 100 && status === 'match'; attempt += 1) {
          status = await verifyProcessIdentity(externalIdentity);
          if (status === 'match') await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.ok(['absent', 'mismatch'].includes(status), `WMI child remains ${status} after cleanup`);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  const tracked = await manager.start({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] });
  await fs.writeFile(
    scriptPath,
    `import fs from 'node:fs';\nconst target = ${JSON.stringify(markerPath)};\nsetInterval(() => fs.appendFileSync(target, process.pid + '\\n'), 20);\nsetTimeout(() => process.exit(0), 120000);\n`,
  );
  const nodeExe = process.execPath.replaceAll("'", "''");
  const scriptFile = scriptPath.replaceAll("'", "''");
  const powershellPath = path.join(
    process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const powershell = [
    "$ErrorActionPreference='Stop'",
    `$command = '"${nodeExe}" "${scriptFile}"'`,
    '$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $command }',
    'if ($created.ReturnValue -ne 0) { throw "WMI process creation failed with code $($created.ReturnValue)" }',
    '[Console]::Out.WriteLine("PID=$($created.ProcessId)")',
    'Start-Sleep -Milliseconds 100',
    '$child = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($created.ProcessId)"',
    "if ($null -eq $child) { throw 'WMI-created process disappeared before inspection' }",
    '[Console]::Out.WriteLine("PARENT=$($child.ParentProcessId)")',
  ].join('; ');
  const encodedCommand = Buffer.from(powershell, 'utf16le').toString('base64');
  const result = spawnSync(powershellPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  const diagnostic = `${result.stdout || ''}\n${result.stderr || ''}`;
  const pidMatch = /^PID=(\d+)\s*$/m.exec(result.stdout || '');
  if (pidMatch) externalPid = Number(pidMatch[1]);
  if (/Access to a CIM resource was not available to the client|Access is denied/i.test(diagnostic)) {
    assert.notEqual(
      process.env.XYST_REQUIRE_WMI_TEST,
      'true',
      `Windows CI requires the WMI out-of-tree recovery integration, but CIM access was denied: ${diagnostic}`,
    );
    t.skip('WMI process creation is unavailable to this local account; CI requires this integration');
    return;
  }
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, diagnostic);
  const parentMatch = /^PARENT=(\d+)\s*$/m.exec(result.stdout);
  assert.ok(externalPid, `expected WMI to report the child PID; output was ${result.stdout}`);
  assert.ok(parentMatch, `expected WMI to report the child parent PID; output was ${result.stdout}`);
  assert.notEqual(Number(parentMatch[1]), tracked.pid, 'WMI-created process must not be parented beneath the managed root');
  for (let attempt = 0; attempt < 50 && !externalIdentity; attempt += 1) {
    externalIdentity = await captureProcessIdentity(externalPid);
    if (!externalIdentity) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(externalIdentity, 'capture the WMI process identity before recovery');
  assert.equal(await verifyProcessIdentity(externalIdentity), 'match');

  const recordPath = path.join(root, '.agent', 'processes', `${tracked.id}.json`);
  let persisted;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    persisted = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    if (persisted.manager_identity && persisted.process_identity) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(persisted.manager_identity);
  assert.ok(persisted.process_identity);
  persisted.manager_pid = 2_147_483_647;
  persisted.manager_identity = {
    platform: 'win32',
    pid: 2_147_483_647,
    creation_time: '1',
    image_hash: '0'.repeat(64),
  };
  await fs.writeFile(recordPath, JSON.stringify(persisted));

  const restarted = new BackgroundProcessManager(root, enabled);
  assert.equal((await restarted.read(tracked.id)).status, 'recoverable');
  assert.equal((await restarted.stop(tracked.id)).stopped, true);
  assert.equal(
    await verifyProcessIdentity(externalIdentity),
    'match',
    'out-of-tree WMI process must not be signaled by managed-tree recovery',
  );
  const markerBefore = await fs.readFile(markerPath, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.notEqual(
    await fs.readFile(markerPath, 'utf8'),
    markerBefore,
    'WMI process remains alive until explicitly stopped by its verified identity',
  );
});

async function stopAll(manager) {
  for (const record of await manager.list().catch(() => [])) {
    if (['running', 'starting', 'stopping'].includes(record.status)) await manager.stop(record.id).catch(() => {});
  }
  await manager.settle();
}
