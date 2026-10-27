import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import {
  captureProcessIdentity,
  parseLinuxStartTicks,
  terminateVerifiedLinuxProcessGroup,
  terminateVerifiedWindowsProcess,
  verifyProcessIdentity,
} from '../src/platform/process-identity.mjs';
import { createTempDirectory } from './helpers.mjs';

test('Linux recovered termination rejects invalid identities and signals on other platforms', async () => {
  assert.equal(await terminateVerifiedLinuxProcessGroup(null), 'unavailable');
  assert.equal(await terminateVerifiedLinuxProcessGroup({ platform: process.platform, pid: 42 }), 'unavailable');
});

test('Windows process recovery rejects relative and network SystemRoot values', async () => {
  const identity = {
    platform: 'win32',
    pid: 42,
    creation_time: '12345',
    image_hash: 'a'.repeat(64),
  };
  assert.equal(await terminateVerifiedWindowsProcess(identity, { windowsSystemRoot: 'Windows' }), 'unavailable');
  assert.equal(await terminateVerifiedWindowsProcess(identity, { windowsSystemRoot: '\\\\server\\share\\Windows' }), 'unavailable');
  assert.equal(
    await verifyProcessIdentity(identity, { platform: 'win32', windowsSystemRoot: '\\\\server\\share\\Windows' }),
    'unavailable',
  );
});

test('Linux process stat parser handles right parentheses inside the command name', () => {
  const fields = Array(20).fill('0');
  fields[0] = 'S';
  fields[2] = '123';
  fields[19] = '987654';
  assert.equal(parseLinuxStartTicks(`123 (worker ) name)) ${fields.join(' ')}`), '987654');
  assert.throws(() => parseLinuxStartTicks('not a proc stat'), /delimiter/);
});

test('Linux process identity distinguishes a live process, a changed PID identity, and an absent PID', async (t) => {
  const procRoot = await createTempDirectory('xyst-proc-');
  t.after(() => fs.rm(procRoot, { recursive: true, force: true }));
  const pid = 42;
  const processDirectory = path.join(procRoot, String(pid));
  await fs.mkdir(processDirectory);
  await fs.mkdir(path.join(procRoot, 'sys', 'kernel', 'random'), { recursive: true });
  const fields = Array(20).fill('0');
  fields[0] = 'S';
  fields[2] = String(pid);
  fields[19] = '345';
  const statFile = path.join(processDirectory, 'stat');
  const commandFile = path.join(processDirectory, 'cmdline');
  await fs.writeFile(statFile, `${pid} (example worker)) ${fields.join(' ')}`);
  await fs.writeFile(commandFile, Buffer.from('/usr/bin/node\0worker.mjs\0'));
  await fs.writeFile(path.join(procRoot, 'sys', 'kernel', 'random', 'boot_id'), 'boot-alpha\n');
  const identity = await captureProcessIdentity(pid, { platform: 'linux', procRoot });
  assert.ok(identity);
  assert.equal(await verifyProcessIdentity(identity, { platform: 'linux', procRoot }), 'match');
  fields[0] = 'Z';
  await fs.writeFile(statFile, `${pid} (example worker)) ${fields.join(' ')}`);
  await fs.writeFile(commandFile, Buffer.alloc(0));
  assert.equal(
    await verifyProcessIdentity(identity, { platform: 'linux', procRoot }),
    'match',
    'the original process-group leader may exit before its descendants',
  );
  fields[0] = 'S';
  await fs.writeFile(statFile, `${pid} (example worker)) ${fields.join(' ')}`);
  await fs.writeFile(commandFile, Buffer.from('/usr/bin/python\0worker.py\0'));
  assert.equal(await verifyProcessIdentity(identity, { platform: 'linux', procRoot }), 'mismatch');
  await fs.rm(processDirectory, { recursive: true });
  assert.equal(await verifyProcessIdentity(identity, { platform: 'linux', procRoot }), 'absent');
});

test('Linux recovered process-group termination pins and rechecks the leader through pidfd', {
  skip: process.platform !== 'linux' ? 'Linux pidfd integration requires Linux' : false,
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
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {}
    }
  });
  await once(child, 'spawn');
  const identity = await captureProcessIdentity(child.pid);
  assert.ok(identity, 'capture the detached process identity');
  const mismatch = await terminateVerifiedLinuxProcessGroup({ ...identity, command_hash: '0'.repeat(64) }, 'SIGTERM');
  assert.equal(mismatch, 'mismatch');
  assert.equal(await verifyProcessIdentity(identity), 'match');
  const closed = once(child, 'close');
  assert.equal(await terminateVerifiedLinuxProcessGroup(identity, 'SIGTERM'), 'terminated');
  await closed;
  assert.equal(await verifyProcessIdentity(identity), 'absent');
});

test('Linux recovery refuses to signal an unpinned process group after its leader was reaped', {
  skip: process.platform !== 'linux' ? 'Linux pidfd integration requires Linux' : false,
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

  const root = await createTempDirectory('xyst-pidfd-reaped-leader-');
  const marker = path.join(root, 'descendant-received-signal');
  let rootPid = null;
  t.after(async () => {
    if (rootPid) {
      try {
        process.kill(-rootPid, 'SIGKILL');
      } catch {}
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  const descendantCode = `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'stopped');process.exit(0)});setInterval(()=>{},1000);`;
  const leaderCode = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'});child.unref();process.stdout.write(String(child.pid));setTimeout(()=>process.exit(0),300);`;
  const leader = spawn(process.execPath, ['-e', leaderCode], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  leader.stdout.setEncoding('utf8');
  leader.stdout.on('data', (chunk) => (stdout += chunk));
  await once(leader, 'spawn');
  rootPid = leader.pid;
  const leaderClosed = once(leader, 'close');

  let leaderIdentity = null;
  for (let attempt = 0; attempt < 30 && !leaderIdentity; attempt += 1) {
    leaderIdentity = await captureProcessIdentity(leader.pid);
    if (!leaderIdentity) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(leaderIdentity, 'capture the detached group leader before it exits');

  await leaderClosed;
  const descendantPid = Number.parseInt(stdout.trim(), 10);
  assert.ok(descendantPid > 0, 'the leader should report its surviving process-group member');

  let descendantIdentity = null;
  for (let attempt = 0; attempt < 30 && !descendantIdentity; attempt += 1) {
    descendantIdentity = await captureProcessIdentity(descendantPid);
    if (!descendantIdentity) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(descendantIdentity, 'the descendant should remain alive after its group leader exits');
  assert.equal(
    await verifyProcessIdentity(leaderIdentity),
    'unavailable',
    'a live group with a reaped leader must not be treated as absent',
  );

  assert.equal(await terminateVerifiedLinuxProcessGroup(leaderIdentity, 'SIGTERM'), 'unavailable');
  assert.equal(await verifyProcessIdentity(descendantIdentity), 'match', 'recovery must not guess at an unpinned group ID');

  process.kill(-leader.pid, 'SIGTERM');
  let signaled = false;
  for (let attempt = 0; attempt < 100 && !signaled; attempt += 1) {
    signaled = (await fs.readFile(marker, 'utf8').catch(() => '')) === 'stopped';
    if (!signaled) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(signaled, true, 'the test cleanup signal should reach the surviving group member');
});

test('Windows termination requires a matching process identity and terminates through the verified handle', {
  skip: process.platform !== 'win32' ? 'Verified Windows process termination integration requires Windows' : false,
}, async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {}
    }
  });
  await once(child, 'spawn');
  let identity = null;
  for (let attempt = 0; attempt < 20 && !identity; attempt += 1) {
    identity = await captureProcessIdentity(child.pid);
    if (!identity) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(identity, 'capture the spawned process identity');
  assert.equal(await terminateVerifiedWindowsProcess({ ...identity, image_hash: '0'.repeat(64) }), 'mismatch');
  assert.equal(await verifyProcessIdentity(identity), 'match');
  const systemRoot = process.env.SystemRoot;
  try {
    delete process.env.SystemRoot;
    assert.equal(await verifyProcessIdentity(identity), 'match', 'identity verification should fall back to WINDIR');
  } finally {
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  }
  assert.equal(await terminateVerifiedWindowsProcess(identity), 'terminated');
  let finalIdentityStatus = 'match';
  for (let attempt = 0; attempt < 30 && finalIdentityStatus === 'match'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    finalIdentityStatus = await verifyProcessIdentity(identity);
  }
  assert.ok(
    ['absent', 'mismatch'].includes(finalIdentityStatus),
    `terminated PID should be absent or reused by another process, found ${finalIdentityStatus}`,
  );
});
