import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { terminateProcessTree } from '../src/platform/process.mjs';

export async function smokeBundledService({ node, cli, workspace, env, expectedAutonomy = null }) {
  const child = spawn(node, [cli, '--workspace', workspace, '--desktop-parent', 'serve', '--port', '0'], {
    cwd: workspace,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  let stderrBytes = 0;
  child.stderr.on('data', (chunk) => {
    const remaining = Math.max(0, 16 * 1024 - stderrBytes);
    if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
    stderrBytes += Math.min(chunk.length, remaining);
  });
  const watchdog = setTimeout(() => terminateProcessTree(child, 'force'), 60_000);
  try {
    const line = await readFirstLine(child.stdout, child, 30_000);
    const bootstrap = JSON.parse(line);
    const url = new URL(bootstrap.url);
    assert.equal(bootstrap.api_version, 1);
    assert.ok(typeof bootstrap.token === 'string' && bootstrap.token.length >= 32);
    assert.equal(url.protocol, 'http:');
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/$/);

    const ready = await fetch(new URL('/v1/health', url), {
      headers: { authorization: `Bearer ${bootstrap.token}` },
    });
    assert.equal(ready.status, 200, 'The packaged service did not become ready');
    const readyBody = await ready.json();
    assert.equal(readyBody.api_version, 1);
    const page = await fetch(new URL('/app', url));
    assert.equal(page.status, 200, 'The packaged service did not serve the browser UI');
    assert.match(page.headers.get('content-security-policy') || '', /default-src/);
    assert.ok((await page.text()).includes(bootstrap.token), 'The same-origin app shell is missing its session token');
    const settings = await fetch(new URL('/v1/settings', url), { headers: { authorization: `Bearer ${bootstrap.token}` } });
    assert.equal(settings.status, 200, 'The packaged service did not expose authenticated runtime settings');
    const settingsBody = await settings.json();
    assert.deepEqual(
      Object.keys(settingsBody.settings.models || {}),
      [],
      'A clean user profile should reach first-run setup with no model configured',
    );
    if (expectedAutonomy !== null)
      assert.equal(
        settingsBody.settings.tools?.autonomy,
        expectedAutonomy,
        'The packaged service did not load the retained autonomy setting',
      );
    const guiDirectory = new URL('../gui/', import.meta.url);
    const guiModules = (await fs.readdir(guiDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
      .map((entry) => entry.name)
      .sort();
    assert.ok(guiModules.includes('app.mjs'), 'The GUI module inventory must contain the entry point');
    for (const moduleName of guiModules) {
      const moduleResponse = await fetch(new URL(`/app/${moduleName}`, url), { redirect: 'error' });
      assert.equal(moduleResponse.status, 200, `The packaged service did not serve ${moduleName}`);
      assert.match(moduleResponse.headers.get('content-type') || '', /javascript/);
      assert.ok(
        (await moduleResponse.text()) === (await fs.readFile(new URL(moduleName, guiDirectory), 'utf8')),
        `The packaged GUI module differs from the build input: ${moduleName}`,
      );
    }
    const redactionModule = await fetch(new URL('/src/core/redaction.mjs', url));
    assert.equal(redactionModule.status, 200, 'The packaged service did not serve the shared redaction module');
    assert.match(await redactionModule.text(), /redactSecrets/);

    child.stdin.end('xyst-desktop-shutdown\n');
    const exitCode = await waitForChildExit(child, 15_000);
    assert.equal(exitCode, 0, `The packaged service exited unsuccessfully: ${Buffer.concat(stderr).toString('utf8')}`);
    return { ready: true, apiVersion: readyBody.api_version, uiServed: true, guiModulesVerified: guiModules.length, shutdown: true };
  } catch (error) {
    terminateProcessTree(child, 'force');
    await waitForChildExit(child, 5_000).catch(() => {});
    const detail = Buffer.concat(stderr).toString('utf8').trim();
    if (detail) error.message += `; service stderr: ${detail}`;
    throw error;
  } finally {
    clearTimeout(watchdog);
  }
}

function readFirstLine(stream, child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('Timed out waiting for packaged service bootstrap')), timeoutMs);
    const finish = (error, line) => {
      clearTimeout(timer);
      stream.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
      if (error) reject(error);
      else resolve(line);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 16 * 1024) return finish(new Error('Packaged service bootstrap exceeds its size limit'));
      const newline = buffer.indexOf('\n');
      if (newline >= 0) finish(null, buffer.slice(0, newline).trim());
    };
    const onError = (error) => finish(error);
    const onClose = (code, signal) => finish(new Error(`Packaged service exited before bootstrap (code=${code}, signal=${signal})`));
    stream.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Timed out waiting for packaged service shutdown')), timeoutMs);
    const finish = (error, code) => {
      clearTimeout(timer);
      child.off('close', onClose);
      if (error) reject(error);
      else resolve(code);
    };
    const onClose = (code) => finish(null, code);
    child.once('close', onClose);
  });
}
