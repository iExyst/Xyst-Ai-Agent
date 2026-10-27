import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendConversationMessage,
  conversationMessages,
  editPromptValue,
  moveVerticalPromptCursor,
  promptDisplayParts,
} from '../src/cli/ink-prompt.mjs';
import { SessionStore } from '../src/session/store.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function quoteShellArgument(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test('Ink prompt history keeps only the latest visible user and assistant messages', () => {
  const messages = [
    { role: 'system', content: 'hidden instruction' },
    { role: 'user', content: 'first request' },
    { role: 'assistant', content: 'first response' },
    { role: 'tool', content: 'hidden tool output' },
    { role: 'user', content: 'latest\u001b[31m request\u001b[0m\nwith spacing' },
  ];

  assert.deepEqual(
    conversationMessages({ messages }, 2).map(({ id: _id, ...message }) => message),
    [
      { role: 'assistant', text: 'first response' },
      { role: 'user', text: 'latest request\nwith spacing' },
    ],
  );
});

test('Ink prompt history bounds message count and text length', () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({ role: 'user', content: `${index}: ${'x'.repeat(12_001)}` }));
  const visible = conversationMessages({ messages }, 3);
  assert.equal(visible.length, 3);
  assert.equal(visible[0].text.startsWith('2: '), true);
  assert.equal(visible[0].text.length, 12_000);
  assert.deepEqual(conversationMessages({ messages }, 0), []);
});

test('Ink live history keeps the newest 200 messages after repeated prompt and response updates', () => {
  let history = [];
  for (let index = 0; index < 205; index += 1) {
    history = appendConversationMessage(history, { id: `message-${index}`, text: `${index}` });
  }

  assert.equal(history.length, 200);
  assert.equal(history[0].id, 'message-5');
  assert.equal(history.at(-1).id, 'message-204');
  assert.equal(conversationMessages({ messages: history.map(({ text }) => ({ role: 'user', content: text })) }, 500).length, 200);
});

test('Ink prompt history redacts a private key clipped by the display limit', () => {
  const content = `-----BEGIN PRIVATE KEY-----\n${'secret'.repeat(2_500)}`;
  const [message] = conversationMessages({ messages: [{ role: 'assistant', content }] });
  assert.match(message.text, /\[REDACTED PRIVATE KEY\]/);
  assert.doesNotMatch(message.text, /secret/);
});

test('Ink prompt history rejects invalid limits', () => {
  assert.throws(() => conversationMessages(null, -1), /non-negative integer/);
  assert.throws(() => conversationMessages(null, 1.5), /non-negative integer/);
});

test('Ink prompt editing moves and deletes whole Unicode graphemes', () => {
  let prompt = { input: 'A👩‍💻B', cursor: 'A👩‍💻B'.length };
  prompt = editPromptValue(prompt.input, prompt.cursor, 'left', { leftArrow: true });
  prompt = editPromptValue(prompt.input, prompt.cursor, 'left', { leftArrow: true });
  assert.equal(prompt.cursor, 1);
  prompt = editPromptValue(prompt.input, prompt.cursor, 'delete', { delete: true });
  assert.deepEqual(prompt, { input: 'AB', cursor: 1 });
  prompt = editPromptValue(prompt.input, prompt.cursor, '!', {});
  assert.deepEqual(prompt, { input: 'A!B', cursor: 2 });
  prompt = editPromptValue(prompt.input, prompt.cursor, 'backspace', { backspace: true });
  assert.deepEqual(prompt, { input: 'AB', cursor: 1 });
});

test('Ink prompt editing supports line home/end and line deletion controls', () => {
  const input = 'first\nsecond';
  let prompt = editPromptValue(input, input.length, 'home', { home: true });
  assert.deepEqual(prompt, { input, cursor: 6 });
  prompt = editPromptValue(prompt.input, prompt.cursor, 'end', { end: true });
  assert.deepEqual(prompt, { input, cursor: input.length });
  prompt = editPromptValue(prompt.input, prompt.cursor, 'home', { home: true });
  prompt = editPromptValue(prompt.input, prompt.cursor + 2, '\u000b');
  assert.deepEqual(prompt, { input: 'first\nse', cursor: 8 });
  prompt = editPromptValue(prompt.input, prompt.cursor, '\u0015');
  assert.deepEqual(prompt, { input: 'first\n', cursor: 6 });
  prompt = editPromptValue(prompt.input, prompt.cursor, '\r\n', {});
  assert.deepEqual(prompt, { input: 'first\n\n', cursor: 7 });
  assert.deepEqual(editPromptValue('ab', 1, '\u001b[A'), { input: 'ab', cursor: 1 });
});

test('Ink prompt Ctrl+J inserts a newline at the cursor', () => {
  assert.deepEqual(editPromptValue('firstsecond', 5, '\n'), { input: 'first\nsecond', cursor: 6 });
  assert.deepEqual(editPromptValue('firstsecond', 5, 'j', { ctrl: true }), { input: 'first\nsecond', cursor: 6 });
});

test('Ink prompt cursor rendering redacts secrets before dividing text around the cursor', () => {
  const secret = `sk-${'A'.repeat(24)}`;
  const input = `prefix ${secret} suffix`;
  const cursor = input.indexOf(secret) + 10;
  const rendered = promptDisplayParts(input, cursor);
  const display = `${rendered.before}${rendered.current}${rendered.after}`;
  assert.match(display, /\[REDACTED TOKEN\]/);
  assert.doesNotMatch(display, new RegExp(secret));
});

test('Ink prompt moves vertically by grapheme column and preserves the preferred column across short lines', () => {
  const input = '123456\nxy\nabcdef';
  let movement = moveVerticalPromptCursor(input, input.length, -1);
  assert.deepEqual(movement, { cursor: 9, column: 6 });
  movement = moveVerticalPromptCursor(input, movement.cursor, -1, movement.column);
  assert.deepEqual(movement, { cursor: 6, column: 6 });
  movement = moveVerticalPromptCursor(input, movement.cursor, 1, movement.column);
  assert.deepEqual(movement, { cursor: 9, column: 6 });
  movement = moveVerticalPromptCursor(input, movement.cursor, 1, movement.column);
  assert.deepEqual(movement, { cursor: input.length, column: 6 });
  assert.equal(moveVerticalPromptCursor(input, 0, -1), null);
  assert.throws(() => moveVerticalPromptCursor(input, 0, 0), /direction must be -1 or 1/);
});

test('Ink CLI streams, routes approval, cancels, resumes the same session, and exits on /exit', {
  skip: process.platform !== 'linux' ? 'Interactive pseudo-terminal coverage currently requires Linux.' : false,
  timeout: 60_000,
}, async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xyst-tui-pty-'));
  const configPath = path.join(workspace, 'config.toml');
  const ptyDevicePath = path.join(workspace, 'pty-device.txt');
  const requestBodies = [];
  const marker = 'XYST_TUI_STREAM_OK';
  const finalMarker = 'XYST_TUI_APPROVAL_DENIED_OK';
  const partialMarker = 'XYST_TUI_CANCEL_PARTIAL';
  const resumedMarker = 'XYST_TUI_RESUMED_OK';
  const deniedPath = 'should-not-be-written.txt';
  let cancelledResponseClosed = false;
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }

    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    if (requestBodies.length === 1) {
      const toolCall = {
        index: 0,
        id: 'call_tui_approval',
        type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: deniedPath, content: 'must stay absent' }) },
      };
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: marker, tool_calls: [toolCall] } }] })}\n\n`);
      await pause(30);
      response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    } else if (requestBodies.length === 2) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: finalMarker } }] })}\n\n`);
      await pause(30);
      response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } else if (requestBodies.length === 3) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: partialMarker } }] })}\n\n`);
      await new Promise((resolve) => {
        response.once('close', () => {
          cancelledResponseClosed = true;
          resolve();
        });
      });
    } else {
      assert.equal(requestBodies.length, 4, 'the resumed CLI should make exactly one additional provider call');
      response.end(
        `data: ${JSON.stringify({ choices: [{ delta: { content: resumedMarker } }] })}\n\n` +
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const closeServer = async () => {
    if (!server.listening) return;
    const closed = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await closed;
  };
  t.after(async () => {
    await closeServer();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  await fs.writeFile(
    configPath,
    [
      'default_model = "local"',
      '[models.local]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'model = "mock"',
      'supports_tools = true',
      'context_length = 16000',
      '[tools]',
      'autonomy = "assisted"',
      'filesystem_scope = "workspace"',
      '',
    ].join('\n'),
  );

  const command = [
    `cd ${quoteShellArgument(repositoryRoot)}`,
    '&&',
    `tty > ${quoteShellArgument(ptyDevicePath)}`,
    '&&',
    // `script` starts with a 0×0 viewport when the parent test runner has piped stdio.
    'stty cols 100 rows 30',
    '&&',
    quoteShellArgument(process.execPath),
    quoteShellArgument(path.join(repositoryRoot, 'src', 'cli.mjs')),
    '--tui',
    '--workspace',
    quoteShellArgument(workspace),
    '--config',
    quoteShellArgument(configPath),
  ].join(' ');
  const child = spawn('script', ['-qefc', command, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([exitPromise, pause(1_000)]);
  });

  const waitForOutput = async (expected, count = 1) => {
    const deadline = Date.now() + 20_000;
    while (output.split(expected).length - 1 < count) {
      if (child.exitCode !== null) throw new Error(`TUI exited before ${JSON.stringify(expected)}: ${output}`);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${JSON.stringify(expected)}: ${output}`);
      await pause(20);
    }
  };

  await waitForOutput('Ask Xyst');
  await waitForOutput('100×30');
  await pause(100);
  child.stdin.write('A👩‍💻B');
  await pause(100);
  child.stdin.write('\u001b[D\u001b[D\u001b[3~');
  await pause(50);
  child.stdin.write('\u001b[H');
  child.stdin.write('Start ');
  await pause(50);
  child.stdin.write('\u001b[F');
  await pause(50);
  child.stdin.write('\u000a');
  await pause(50);
  child.stdin.write('Keep this on a second line.');
  await pause(50);
  child.stdin.write('\u001b[A');
  await pause(50);
  child.stdin.write('!');
  await pause(50);
  child.stdin.write('\u001b[B');
  await pause(50);
  child.stdin.write('?');
  await pause(100);
  child.stdin.write('\r');
  await waitForOutput(marker);
  assert.deepEqual(requestBodies[0]?.messages.find((message) => message.role === 'user')?.content, [
    { type: 'text', text: 'Start AB!\nKeep this? on a second line.' },
  ]);
  await waitForOutput('Type y/s/p/c or n, then Enter');
  assert.equal(requestBodies[0]?.stream, true);
  child.stdin.write('n');
  await pause(100);
  child.stdin.write('\r');
  await waitForOutput(finalMarker);
  await waitForOutput('Ask Xyst', 2);
  assert.equal(requestBodies.length, 2);
  await assert.rejects(fs.access(path.join(workspace, deniedPath)));
  child.stdin.write('Continue with a request I will cancel.');
  await pause(100);
  child.stdin.write('\r');
  await waitForOutput(partialMarker);
  child.stdin.write('\u0003');
  await waitForOutput('Ask Xyst', 3);
  const sessions = new SessionStore(workspace);
  const [sessionSummary] = await sessions.list();
  const cancelledSession = await sessions.load(sessionSummary.id);
  assert.equal(cancelledSession.status, 'cancelled');
  assert.equal(cancelledSession.messages.at(-1)?.content.includes(partialMarker), true);
  await withTimeout(
    new Promise((resolve) => {
      const checkClosed = () => {
        if (cancelledResponseClosed) resolve();
        else setTimeout(checkClosed, 10);
      };
      checkClosed();
    }),
    2_000,
    'Provider stream stayed open after TUI cancellation',
  );
  assert.equal(requestBodies.length, 3);
  const ptyDevice = (await fs.readFile(ptyDevicePath, 'utf8')).trim();
  assert.match(ptyDevice, /^\/dev\/pts\/\d+$/);
  execFileSync('stty', ['-F', ptyDevice, 'cols', '60', 'rows', '20']);
  await waitForOutput('60×20');
  execFileSync('stty', ['-F', ptyDevice, 'cols', '100', 'rows', '30']);
  await waitForOutput('100×30', 2);
  child.stdin.write('/exit');
  await pause(100);
  child.stdin.write('\r');
  const result = await withTimeout(exitPromise, 5_000, `TUI did not exit after /exit: ${output}`);
  assert.deepEqual(result, { code: 0, signal: null });
  assert.match(output, new RegExp(marker));
  assert.match(output, new RegExp(finalMarker));
  assert.match(output, new RegExp(partialMarker));

  const resumedCommand = [
    `cd ${quoteShellArgument(repositoryRoot)}`,
    '&&',
    'stty cols 100 rows 30',
    '&&',
    quoteShellArgument(process.execPath),
    quoteShellArgument(path.join(repositoryRoot, 'src', 'cli.mjs')),
    '--tui',
    '--resume',
    quoteShellArgument(sessionSummary.id),
    '--workspace',
    quoteShellArgument(workspace),
    '--config',
    quoteShellArgument(configPath),
  ].join(' ');
  const resumedChild = spawn('script', ['-qefc', resumedCommand, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let resumedOutput = '';
  resumedChild.stdout.on('data', (chunk) => (resumedOutput += chunk.toString()));
  resumedChild.stderr.on('data', (chunk) => (resumedOutput += chunk.toString()));
  const resumedExitPromise = new Promise((resolve, reject) => {
    resumedChild.once('error', reject);
    resumedChild.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (resumedChild.exitCode !== null || resumedChild.signalCode !== null) return;
    resumedChild.kill('SIGTERM');
    await Promise.race([resumedExitPromise, pause(1_000)]);
  });
  const waitForResumedOutput = async (expected, count = 1) => {
    const deadline = Date.now() + 20_000;
    while (resumedOutput.split(expected).length - 1 < count) {
      if (resumedChild.exitCode !== null) throw new Error(`Resumed TUI exited before ${JSON.stringify(expected)}: ${resumedOutput}`);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${JSON.stringify(expected)}: ${resumedOutput}`);
      await pause(20);
    }
  };
  await waitForResumedOutput('Ask Xyst');
  resumedChild.stdin.write('Continue the cancelled task in this same session.');
  await pause(100);
  resumedChild.stdin.write('\r');
  await waitForResumedOutput(resumedMarker);
  await waitForResumedOutput('Ask Xyst', 2);
  assert.equal(requestBodies.length, 4);
  assert.equal(
    requestBodies[3]?.messages.some(
      (message) => message.role === 'user' && JSON.stringify(message.content).includes('Continue the cancelled task'),
    ),
    true,
  );
  assert.equal(
    requestBodies[3]?.messages.some((message) => message.role === 'assistant' && message.content.includes(partialMarker)),
    true,
  );
  const resumedSession = await sessions.load(sessionSummary.id);
  assert.equal(resumedSession.id, cancelledSession.id, 'resuming must preserve the saved session identity');
  assert.equal(resumedSession.status, 'complete');
  assert.equal(resumedSession.messages.at(-1)?.content.includes(resumedMarker), true);
  resumedChild.stdin.write('/exit');
  await pause(100);
  resumedChild.stdin.write('\r');
  assert.deepEqual(await withTimeout(resumedExitPromise, 5_000, `Resumed TUI did not exit after /exit: ${resumedOutput}`), {
    code: 0,
    signal: null,
  });
  assert.match(resumedOutput, new RegExp(resumedMarker));
});

test('Windows ConPTY reports live terminal resizes to the Ink prompt', {
  skip: process.platform !== 'win32' ? 'Windows-only ConPTY coverage.' : false,
  timeout: 30_000,
}, async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'xyst-tui-conpty-'));
  const configPath = path.join(workspace, 'config.toml');
  const harness = path.join(repositoryRoot, 'tests', 'windows-conpty', 'target', 'debug', 'xyst-windows-conpty-test.exe');
  try {
    await fs.access(harness);
  } catch {
    if (process.env.XYST_REQUIRE_WINDOWS_CONPTY_TEST === 'true') {
      assert.fail('Required Windows ConPTY helper was not built by CI.');
    }
    t.skip('Build tests/windows-conpty before running Windows interactive terminal coverage.');
    return;
  }
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(
    configPath,
    [
      'default_model = "local"',
      '[models.local]',
      'provider = "openai-compatible"',
      'base_url = "http://127.0.0.1:1/v1"',
      'model = "mock"',
      'supports_tools = false',
      '[tools]',
      'autonomy = "assisted"',
      'filesystem_scope = "workspace"',
      '',
    ].join('\n'),
  );

  const child = spawn(
    harness,
    [process.execPath, path.join(repositoryRoot, 'src', 'cli.mjs'), '--tui', '--workspace', workspace, '--config', configPath],
    { cwd: repositoryRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk.toString()));
  child.stderr.on('data', (chunk) => (output += chunk.toString()));
  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const sendInput = (value) => child.stdin.write(`I ${Buffer.from(value).toString('hex')}\n`);
  const waitForOutput = async (expected) => {
    const deadline = Date.now() + 10_000;
    while (!output.includes(expected)) {
      if (child.exitCode !== null) throw new Error(`ConPTY TUI exited before ${JSON.stringify(expected)}: ${output}`);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${JSON.stringify(expected)}: ${output}`);
      await pause(20);
    }
  };
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.write('Q\n');
    await Promise.race([exitPromise, pause(1_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });

  try {
    await waitForOutput('Ask Xyst');
  } catch (error) {
    if (process.env.XYST_REQUIRE_WINDOWS_CONPTY_TEST !== 'true' && output.includes('ConPTY child exited with NTSTATUS 0xC0000142')) {
      t.skip('The local Windows process sandbox rejects ConPTY child initialization; the required CI job runs outside this sandbox.');
      return;
    }
    throw error;
  }
  await waitForOutput('100×30');
  child.stdin.write('R 60 20\n');
  await waitForOutput('60×20');
  child.stdin.write('R 100 30\n');
  await waitForOutput('100×30');
  sendInput('/exit\r');
  assert.deepEqual(await withTimeout(exitPromise, 5_000, `ConPTY TUI did not exit: ${output}`), { code: 0, signal: null });
});
