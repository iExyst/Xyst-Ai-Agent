import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runProcess, resolveWindowsPowerShellPath } from '../src/platform/process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'src', 'cli.mjs');
const node = process.execPath;
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'xyst-cli-shells-'));
const workspace = path.join(scratch, 'workspace with spaces');
const config = path.join(scratch, 'settings with spaces.toml');
const markerPath = path.join(workspace, 'shell marker.txt');
const markerContent = 'cross-shell-automation-ok';
const prompt = 'Write the cross-shell marker file.';
let requestCount = 0;
const provider = createServer((request, response) => {
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4 * 1024 * 1024) request.destroy();
  });
  request.on('end', () => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.method, 'POST');
      const payload = JSON.parse(body);
      assert.equal(payload.model, 'shell-smoke');
      assert.ok(payload.tools.some((tool) => tool.function.name === 'write_file'));
      requestCount += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      const events =
        requestCount % 2 === 1
          ? [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: `shell-write-${requestCount}`,
                          type: 'function',
                          function: {
                            name: 'write_file',
                            arguments: JSON.stringify({ path: 'shell marker.txt', content: markerContent }),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            ]
          : [{ choices: [{ delta: { content: 'Cross-shell workflow completed.' }, finish_reason: 'stop' }] }];
      response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
    } catch (error) {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(error.message);
    }
  });
});

try {
  await fs.mkdir(workspace);
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  const address = provider.address();
  assert.ok(address && typeof address === 'object' && address.port > 0, 'mock provider must bind an ephemeral loopback port');
  await fs.writeFile(
    config,
    [
      'default_model = "shell-smoke"',
      '[tools]',
      'autonomy = "unrestricted"',
      '[models.shell-smoke]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${address.port}/v1"`,
      'model = "shell-smoke"',
      'supports_tools = true',
      'context_length = 16000',
      '[budgets]',
      'max_turns = 3',
      'max_input_tokens = 10000',
      'max_output_tokens = 1000',
      '',
    ].join('\n'),
  );

  if (process.platform === 'win32') {
    const powershell = resolveWindowsPowerShellPath();
    assert.ok(powershell, 'Windows PowerShell must resolve beneath SystemRoot or WINDIR');
    const quotePowerShell = (value) => `'${value.replaceAll("'", "''")}'`;
    await verify('Windows PowerShell', powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `& ${quotePowerShell(node)} ${quotePowerShell(cli)} --workspace ${quotePowerShell(workspace)} --config ${quotePowerShell(config)} --json ${quotePowerShell(prompt)}; exit $LASTEXITCODE`,
    ]);

    const commandScript = path.join(scratch, 'invoke-xyst.cmd');
    const systemRoot = process.env.SystemRoot || process.env.WINDIR;
    assert.ok(systemRoot, 'Windows cmd.exe requires SystemRoot or WINDIR');
    const commandProcessor = path.join(systemRoot, 'System32', 'cmd.exe');
    const quoteCmdValue = (value) => value.replaceAll('%', '%%').replaceAll('"', '""');
    await fs.writeFile(
      commandScript,
      [
        '@echo off',
        `set "XYST_NODE=${quoteCmdValue(node)}"`,
        `set "XYST_CLI=${quoteCmdValue(cli)}"`,
        `set "XYST_WORKSPACE=${quoteCmdValue(workspace)}"`,
        `set "XYST_CONFIG=${quoteCmdValue(config)}"`,
        `set "XYST_PROMPT=${quoteCmdValue(prompt)}"`,
        '"%XYST_NODE%" "%XYST_CLI%" --workspace "%XYST_WORKSPACE%" --config "%XYST_CONFIG%" --json "%XYST_PROMPT%"',
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n'),
      { encoding: 'utf8' },
    );
    await verify('cmd.exe', commandProcessor, ['/d', '/c', commandScript]);
  } else {
    await verify('Bash', 'bash', [
      '-c',
      'exec "$@"',
      'xyst-cli-shell-smoke',
      node,
      cli,
      '--workspace',
      workspace,
      '--config',
      config,
      '--json',
      prompt,
    ]);
  }
} finally {
  await new Promise((resolve) => {
    if (!provider.listening) return resolve();
    provider.close(resolve);
  });
  await fs.rm(scratch, { recursive: true, force: true });
}

async function verify(name, command, args) {
  await fs.rm(markerPath, { force: true });
  const previousRequestCount = requestCount;
  const result = await runProcess(command, args, { cwd: root, timeoutMs: 45_000, maxOutputBytes: 1_000_000 });
  assert.equal(result.exitCode, 0, `${name} failed: ${result.stderr}`);
  assert.equal(result.stderr, '', `${name} wrote unexpected stderr output`);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, `${name} must preserve JSON-only stdout`);
  const output = JSON.parse(lines[0]);
  assert.equal(output.status, 'complete', `${name} must complete the agent run`);
  assert.equal(output.content, 'Cross-shell workflow completed.');
  assert.equal(requestCount - previousRequestCount, 2, `${name} must complete one streamed tool call and one final response`);
  assert.equal(await fs.readFile(markerPath, 'utf8'), markerContent, `${name} must complete the approved file-tool workflow`);
  process.stdout.write(`${name}: real CLI tool workflow passed\n`);
}
