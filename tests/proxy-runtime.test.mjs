import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';

const [major, minor] = process.versions.node.split('.').map(Number);
const supportsFetchProxy = major >= 24 || (major === 22 && minor >= 21);

test('Node environment proxy reaches external hosts while Xyst loopback remains direct', { skip: !supportsFetchProxy }, async () => {
  let proxyRequests = 0;
  let proxyConnects = 0;
  let directRequests = 0;
  const proxy = createServer((request, response) => {
    proxyRequests += 1;
    assert.equal(request.url, 'http://xyst-proxy-check.invalid/external');
    response.end('through-proxy');
  });
  const local = createServer((_request, response) => {
    directRequests += 1;
    response.end('direct-loopback');
  });
  proxy.on('connect', (request, socket) => {
    proxyConnects += 1;
    assert.equal(request.url, 'xyst-proxy-check.invalid:80');
    socket.on('error', () => {});
    socket.once('data', () => {
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nthrough-proxy');
    });
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  try {
    proxy.listen(0, '127.0.0.1');
    local.listen(0, '127.0.0.1');
    await Promise.all([once(proxy, 'listening'), once(local, 'listening')]);
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
    const localUrl = `http://127.0.0.1:${local.address().port}/local`;
    const script = `console.error('local-start');
const b = await fetch(${JSON.stringify(localUrl)});
console.error('local-done');
console.error('external-start');
const a = await fetch('http://xyst-proxy-check.invalid/external');
console.error('external-done');
process.stdout.write(JSON.stringify([await a.text(), await b.text()]));
process.exit(0);`;
    const output = await runNode(script, {
      ...process.env,
      HTTP_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      NO_PROXY: 'localhost,127.0.0.1,::1,[::1]',
      no_proxy: 'localhost,127.0.0.1,::1,[::1]',
      NODE_USE_ENV_PROXY: '1',
    }).catch((error) => {
      throw new Error(`${error.message}; proxyRequests=${proxyRequests}; proxyConnects=${proxyConnects}; directRequests=${directRequests}`);
    });
    assert.deepEqual(JSON.parse(output), ['through-proxy', 'direct-loopback']);
    assert.equal(proxyRequests + proxyConnects, 1);
    assert.equal(directRequests, 1);
  } finally {
    await Promise.all([closeServer(proxy), closeServer(local)]);
  }
});

function runNode(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env,
      windowsHide: true,
      signal: AbortSignal.timeout(10_000),
    });
    let output = '';
    let errors = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (errors += chunk));
    child.once('error', (error) => reject(new Error(`${error.message}; output=${output}; stderr=${errors}`)));
    child.once('close', (code) => (code === 0 ? resolve(output) : reject(new Error(`Node proxy check exited ${code}: ${errors}`))));
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
