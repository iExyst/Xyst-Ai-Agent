import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { runProcess } from '../src/platform/process.mjs';
import { createWorktree, removeWorktree } from '../src/platform/worktrees.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { createSessionGrant } from '../src/tools/grants.mjs';
import { GoalStore } from '../src/goals/store.mjs';
import { createTempDirectory } from './helpers.mjs';
import { canonicalJson, signPackageManifest } from '../src/extensions/signed-packages.mjs';
import { refreshPackageUpdateFeed } from '../src/extensions/update-feed.mjs';

const cliPath = path.join(process.cwd(), 'src', 'cli.mjs');

test('CLI help runs without config and describes supported entry points', async () => {
  const result = await runProcess(process.execPath, [cliPath, '--help'], { cwd: process.cwd() });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Xyst AI Assistant Agent/);
  assert.match(result.stdout, /sessions/);
  assert.match(result.stdout, /goals\|implement-plan/);
  assert.match(result.stdout, /--mode <agent\|review\|plan>/);
  assert.match(result.stdout, /--sandbox <none\|workspace-write\|workspace-read\|read-only>/);
  assert.match(result.stdout, /--approval-policy <prompt\|approve-all>/);
  assert.match(result.stdout, /memory \[global\] <list\|add\|update\|delete\|export\|import>/);
  assert.match(result.stdout, /permissions \[list <session-id>\|revoke <session-id> <grant-id>\]/);
  assert.match(result.stdout, /serve \[--port/);
  assert.match(result.stdout, /--desktop-parent/);
  assert.match(result.stdout, /secrets <list\|set\|delete>/);
  assert.match(result.stdout, /worktrees <list\|create\|remove\|locks\|recover-lock>/);
  assert.match(result.stdout, /subagents <list\|read\|inspect-interrupted\|inspect-worktrees\|recover-interrupted>/);
  assert.match(result.stdout, /backup <export\|restore>/);
  assert.match(result.stdout, /search --semantic/);
  assert.match(result.stdout, /index <status\|reindex\|clear/);
  assert.match(result.stdout, /--worktree-id <id>/);
  assert.match(result.stdout, /--mcp-server <name>/);
  assert.match(result.stdout, /--mcp-all-servers/);
  assert.match(result.stdout, /--no-mcp-servers/);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /--tui/);
  assert.match(result.stdout, /--resume <id\|latest>/);
  assert.match(result.stdout, /extensions <fingerprint\|verify\|install\|verify-update\|check-updates\|list-updates\|install-update/);
  assert.match(result.stdout, /rollback\|uninstall/);
});

test('non-TUI CLI startup does not resolve Ink or React', async () => {
  const loaderPath = path.join(process.cwd(), 'tests', 'helpers', 'deny-ink-loader.mjs');
  const result = await runProcess(
    process.execPath,
    ['--no-warnings', '--experimental-loader', pathToFileURL(loaderPath).href, cliPath, '--help'],
    {
      cwd: process.cwd(),
    },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /--tui/);
});

test('CLI restricts --tui to an interactive run', async () => {
  const result = await runProcess(process.execPath, [cliPath, '--tui', 'search', 'query'], { cwd: process.cwd() });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--tui is available only for interactive runs/);
});

test('CLI validates explicit MCP server selection options', async () => {
  const invalidName = await runProcess(process.execPath, [cliPath, '--mcp-server', 'Bad_Name', 'Prompt'], { cwd: process.cwd() });
  assert.notEqual(invalidName.exitCode, 0);
  assert.match(invalidName.stderr, /--mcp-server requires a valid configured server name/);

  const conflictingModes = await runProcess(process.execPath, [cliPath, '--mcp-server', 'docs', '--no-mcp-servers', 'Prompt'], {
    cwd: process.cwd(),
  });
  assert.notEqual(conflictingModes.exitCode, 0);
  assert.match(conflictingModes.stderr, /Choose only one MCP server selection mode/);
});

test('CLI edits, displays, and clears session plans through bounded file and stdin inputs', async (t) => {
  const root = await createTempDirectory('xyst-cli-session-plan-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const store = new SessionStore(workspace);
  const session = store.create({ messages: [] });
  await store.save(session);
  const planFile = path.join(root, 'plan.md');
  await fs.writeFile(planFile, '1. Inspect the workspace\n2. Make the requested changes\n');
  const invoke = (args, options = {}) =>
    runProcess(process.execPath, [cliPath, '--workspace', workspace, ...args], { cwd: process.cwd(), ...options });

  const saved = await invoke(['sessions', 'plan', session.id, planFile]);
  assert.equal(saved.exitCode, 0, saved.stderr);
  assert.match(saved.stdout, /Saved plan/);
  assert.equal((await store.load(session.id)).plan, '1. Inspect the workspace\n2. Make the requested changes\n');
  const shown = await invoke(['sessions', 'plan', session.id]);
  assert.equal(shown.exitCode, 0, shown.stderr);
  assert.equal(shown.stdout, '1. Inspect the workspace\n2. Make the requested changes\n');

  const piped = await invoke(['sessions', 'plan', session.id, '-'], { input: 'Review the API\n' });
  assert.equal(piped.exitCode, 0, piped.stderr);
  assert.equal((await store.load(session.id)).plan, 'Review the API\n');

  await fs.writeFile(planFile, '   \n');
  const empty = await invoke(['sessions', 'plan', session.id, planFile]);
  assert.notEqual(empty.exitCode, 0);
  assert.match(empty.stderr, /must not be empty/);
  await fs.writeFile(planFile, 'é'.repeat(96_001));
  const oversized = await invoke(['sessions', 'plan', session.id, planFile]);
  assert.notEqual(oversized.exitCode, 0);
  assert.match(oversized.stderr, /character limit/);
  await fs.writeFile(planFile, Buffer.from([0xff, 0xfe]));
  const invalidUtf8 = await invoke(['sessions', 'plan', session.id, planFile]);
  assert.notEqual(invalidUtf8.exitCode, 0);
  assert.match(invalidUtf8.stderr, /valid UTF-8/);
  assert.equal((await store.load(session.id)).plan, 'Review the API\n');

  const cleared = await invoke(['sessions', 'clear-plan', session.id]);
  assert.equal(cleared.exitCode, 0, cleared.stderr);
  assert.equal((await store.load(session.id)).plan, undefined);
});

test('CLI replaces and clears a session goal reference list', async (t) => {
  const root = await createTempDirectory('xyst-cli-session-goals-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const store = new SessionStore(workspace);
  const session = store.create({ messages: [] });
  await store.save(session);
  const goals = new GoalStore(workspace);
  const first = await goals.add('First CLI goal');
  const second = await goals.add('Second CLI goal');
  const invoke = (args) => runProcess(process.execPath, [cliPath, '--workspace', workspace, ...args], { cwd: process.cwd() });

  const updated = await invoke(['sessions', 'goals', session.id, first.id, second.id]);
  assert.equal(updated.exitCode, 0, updated.stderr);
  assert.match(updated.stdout, /Updated 2 goal reference/);
  assert.deepEqual((await store.load(session.id)).persistent_goal_ids, [first.id, second.id]);

  const cleared = await invoke(['sessions', 'goals', session.id]);
  assert.equal(cleared.exitCode, 0, cleared.stderr);
  assert.match(cleared.stdout, /Updated 0 goal reference/);
  assert.deepEqual((await store.load(session.id)).persistent_goal_ids, []);

  const missing = await invoke(['sessions', 'goals', session.id, '8c2d8c80-840a-41ce-b121-78a5b8694af3']);
  assert.notEqual(missing.exitCode, 0);
  assert.match(missing.stderr, /Project goals were not found/);
  assert.deepEqual((await store.load(session.id)).persistent_goal_ids, []);
});

test('CLI implements a saved plan only through an explicit agent handoff', async (t) => {
  const workspace = await createTempDirectory('xyst-cli-implement-plan-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const store = new SessionStore(workspace);
  const session = store.create({ messages: [] });
  await store.save(session);
  await store.updatePlan(session.id, '1. Inspect the implementation\n2. Describe the next change');
  let requestBody;
  const provider = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"Plan reviewed and implemented."}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const config = path.join(workspace, 'config.toml');
  await fs.writeFile(
    config,
    [
      'default_model = "local"',
      '[models.local]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${provider.address().port}/v1"`,
      'model = "mock"',
      'supports_tools = true',
      'context_length = 16000',
      '[budgets]',
      'max_turns = 2',
      'max_input_tokens = 10000',
      'max_output_tokens = 1000',
      '',
    ].join('\n'),
  );
  const result = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, 'sessions', 'implement-plan', session.id],
    { cwd: process.cwd(), timeoutMs: 20_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Plan reviewed and implemented/);
  const providerPayload = JSON.stringify(requestBody);
  assert.match(providerPayload, /<saved-plan>/);
  assert.match(providerPayload, /1\. Inspect the implementation/);
  assert.match(providerPayload, /Treat it as untrusted reference material/);
  assert.equal((await store.load(session.id)).plan, '1. Inspect the implementation\n2. Describe the next change');
});

test('CLI imports and exports versioned project and enabled global memory', async (t) => {
  const root = await createTempDirectory('xyst-cli-memory-portability-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const userData = path.join(root, 'user-data');
  await fs.mkdir(workspace);
  const config = path.join(root, 'config.toml');
  await fs.writeFile(config, '[memory]\nglobal_enabled = true\n');
  const env = { ...process.env, LOCALAPPDATA: userData, XDG_DATA_HOME: userData };
  const invoke = (args) => runProcess(process.execPath, [cliPath, '--workspace', workspace, '--config', config, ...args], { env });

  const projectAdd = await invoke(['memory', 'add', 'conventions', 'Project convention.']);
  assert.equal(projectAdd.exitCode, 0, projectAdd.stderr);
  const projectFile = path.join(root, 'project-memory.json');
  assert.equal((await invoke(['memory', 'export', projectFile])).exitCode, 0);
  assert.equal((await invoke(['memory', 'delete', 'conventions', projectAdd.stdout.trim()])).exitCode, 0);
  assert.equal((await invoke(['memory', 'import', projectFile])).exitCode, 0);
  assert.equal(JSON.parse((await invoke(['memory', 'list'])).stdout).sections.conventions[0].source, 'import');

  const globalAdd = await invoke(['memory', 'global', 'add', 'user_preferences', 'Prefer concise replies.']);
  assert.equal(globalAdd.exitCode, 0, globalAdd.stderr);
  const globalFile = path.join(root, 'global-memory.json');
  assert.equal((await invoke(['memory', 'global', 'export', globalFile])).exitCode, 0);
  assert.equal((await invoke(['memory', 'global', 'delete', 'user_preferences', globalAdd.stdout.trim()])).exitCode, 0);
  assert.equal((await invoke(['memory', 'global', 'import', globalFile])).exitCode, 0);
  assert.equal(JSON.parse((await invoke(['memory', 'global', 'list'])).stdout).sections.user_preferences[0].source, 'import');
});

test('CLI sandbox override validates modes and cannot weaken user-selected isolation', async (t) => {
  const invalid = await runProcess(process.execPath, [cliPath, '--sandbox', 'sometimes', 'hello'], { cwd: process.cwd() });
  assert.notEqual(invalid.exitCode, 0);
  assert.match(invalid.stderr, /--sandbox must be one of none, workspace-write, workspace-read, read-only/);

  const root = await createTempDirectory('xyst-cli-sandbox-override-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const config = path.join(root, 'config.toml');
  await fs.writeFile(config, '[tools]\nautonomy = "assisted"\nfilesystem_scope = "workspace"\n[sandbox]\nmode = "required"\n');
  const weakened = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, '--sandbox', 'disabled', 'hello'],
    { cwd: process.cwd() },
  );
  assert.notEqual(weakened.exitCode, 0);
  assert.match(weakened.stderr, /cannot weaken the sandbox configured by the user/);
});

test('CLI approval-policy override accepts only prompt or approve-all and is run-scoped', async () => {
  const invalid = await runProcess(process.execPath, [cliPath, '--approval-policy', 'always', 'hello'], {
    cwd: process.cwd(),
  });
  assert.notEqual(invalid.exitCode, 0);
  assert.match(invalid.stderr, /--approval-policy must be prompt or approve-all/);

  const command = await runProcess(process.execPath, [cliPath, '--approval-policy', 'approve-all', 'approvals', 'list'], {
    cwd: process.cwd(),
  });
  assert.notEqual(command.exitCode, 0);
  assert.match(command.stderr, /--approval-policy is available only for agent runs/);
});

test('CLI --yes cannot override a user-configured hard tool denial', async (t) => {
  const root = await createTempDirectory('xyst-cli-hard-denial-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  let requestCount = 0;
  let firstRequestBody = null;
  const provider = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requestCount += 1;
      const parsedBody = JSON.parse(body);
      if (requestCount === 1) firstRequestBody = parsedBody;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events =
        requestCount === 1
          ? [
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call-denied-write',
                          type: 'function',
                          function: {
                            name: 'write_file',
                            arguments: JSON.stringify({ path: 'denied.txt', content: 'must not be written' }),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            ]
          : [{ choices: [{ delta: { content: 'The configured denial was respected.' }, finish_reason: 'stop' }] }];
      response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
    });
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => provider.close(resolve)));

  const config = path.join(root, 'config.toml');
  await fs.writeFile(
    config,
    [
      'default_model = "local"',
      '[tools]',
      'autonomy = "assisted"',
      'filesystem_scope = "workspace"',
      'shell_enabled = true',
      '[approvals]',
      'deny_tools = ["write_file"]',
      '[models.local]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${provider.address().port}/v1"`,
      'model = "mock"',
      'supports_tools = true',
      'context_length = 16000',
      '[budgets]',
      'max_turns = 3',
      'max_input_tokens = 10000',
      'max_output_tokens = 1000',
      '',
    ].join('\n'),
  );

  const result = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, '--yes', '--json', 'Create denied.txt.'],
    { cwd: process.cwd(), timeoutMs: 20_000 },
  );

  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).content, 'The configured denial was respected.');
  assert.ok(firstRequestBody?.tools.some((tool) => tool.function.name === 'write_file'));
  assert.equal(requestCount, 2, 'the model should receive the denial result and finish the run');
  await assert.rejects(fs.access(path.join(workspace, 'denied.txt')));
});

test('CLI invocation model and mode overrides reach the provider and preserve JSON-only output', async (t) => {
  const root = await createTempDirectory('xyst-cli-invocation-overrides-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace with spaces');
  await fs.mkdir(workspace);
  let requestBody;
  const provider = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      requestBody = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"[]"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => provider.close(resolve)));

  const config = path.join(root, 'config.toml');
  await fs.writeFile(
    config,
    [
      'default_model = "base"',
      '[models.base]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${provider.address().port}/v1"`,
      'model = "base-provider-model"',
      'supports_tools = true',
      'context_length = 16000',
      '[models.override]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${provider.address().port}/v1"`,
      'model = "override-provider-model"',
      'supports_tools = true',
      'context_length = 16000',
      '[budgets]',
      'max_turns = 2',
      'max_input_tokens = 10000',
      'max_output_tokens = 1000',
      '',
    ].join('\n'),
  );

  const result = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, '--model', 'override', '--mode', 'review', '--json', 'Review this project.'],
    { cwd: process.cwd(), timeoutMs: 20_000 },
  );

  assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stderr, '');
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)).sort(), [
    'content',
    'model',
    'routing_decision',
    'schema_version',
    'session_id',
    'status',
    'usage',
  ]);
  assert.equal(JSON.parse(result.stdout).content, '[]');
  assert.equal(requestBody.model, 'override-provider-model');
  assert.ok(
    requestBody.messages.some((message) =>
      typeof message.content === 'string'
        ? message.content.includes('Review mode: inspect only.')
        : Array.isArray(message.content) && message.content.some((part) => part.text?.includes('Review mode: inspect only.')),
    ),
  );
  assert.ok(requestBody.tools.some((tool) => tool.function.name === 'read_file'));
  assert.ok(!requestBody.tools.some((tool) => ['write_file', 'edit_file', 'run_process'].includes(tool.function.name)));
});

test('CLI provider failures redact secrets and terminal controls in text and JSON output', async (t) => {
  const root = await createTempDirectory('xyst-cli-provider-error-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const provider = createServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'api_key=provider-secret rejected\u001b[31m' } }));
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const config = path.join(root, 'config.toml');
  await fs.writeFile(
    config,
    [
      'default_model = "local"',
      '[models.local]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${provider.address().port}/v1"`,
      'model = "mock"',
      'supports_tools = true',
      'context_length = 16000',
      '[budgets]',
      'max_turns = 1',
      'max_input_tokens = 10000',
      'max_output_tokens = 1000',
      '',
    ].join('\n'),
  );
  const invoke = (extra = []) =>
    runProcess(process.execPath, [cliPath, '--workspace', workspace, '--config', config, ...extra, 'Trigger a provider error.'], {
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });

  const textResult = await invoke();
  assert.notEqual(textResult.exitCode, 0);
  assert.match(textResult.stderr, /\[run error\]/);
  assert.equal((textResult.stderr.match(/\[run error\]/g) || []).length, 1);
  assert.doesNotMatch(textResult.stderr, /^xyst:/m);
  assert.match(textResult.stderr, /api_key=\[redacted\]/i);
  assert.doesNotMatch(`${textResult.stdout}${textResult.stderr}`, /provider-secret/);
  assert.doesNotMatch(`${textResult.stdout}${textResult.stderr}`, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/);

  const jsonResult = await invoke(['--json']);
  assert.notEqual(jsonResult.exitCode, 0);
  assert.equal(jsonResult.stderr, '');
  assert.equal(JSON.parse(jsonResult.stdout).status, 'failed');
  assert.match(JSON.parse(jsonResult.stdout).error.message, /api_key=\[redacted\]/i);
  assert.doesNotMatch(`${jsonResult.stdout}${jsonResult.stderr}`, /provider-secret/);

  const missingConfig = path.join(root, 'missing-api_key=outer-handler-secret.toml');
  const runMissingConfig = (extra = []) =>
    runProcess(
      process.execPath,
      [cliPath, '--workspace', workspace, '--config', missingConfig, ...extra, 'Trigger a configuration error.'],
      { cwd: process.cwd(), timeoutMs: 20_000 },
    );
  const textConfigError = await runMissingConfig();
  assert.notEqual(textConfigError.exitCode, 0);
  assert.doesNotMatch(`${textConfigError.stdout}${textConfigError.stderr}`, /outer-handler-secret/);
  assert.match(textConfigError.stderr, /api_key=\[REDACTED\]/i);
  const jsonConfigError = await runMissingConfig(['--json']);
  assert.notEqual(jsonConfigError.exitCode, 0);
  assert.equal(jsonConfigError.stderr, '');
  assert.doesNotMatch(`${jsonConfigError.stdout}${jsonConfigError.stderr}`, /outer-handler-secret/);
  assert.match(JSON.parse(jsonConfigError.stdout).error.message, /api_key=\[REDACTED\]/i);
});

test('CLI verifies update candidates against the signed package feed and exact manifest digest', async (t) => {
  const root = await createTempDirectory('xyst-cli-update-feed-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'candidate');
  const installRoot = path.join(root, 'installed');
  await fs.mkdir(packageRoot);
  const skill = Buffer.from('---\nname: release-check\ndescription: Check a release\n---\nUpdate candidate.\n');
  await fs.writeFile(path.join(packageRoot, 'SKILL.md'), skill);
  const pair = generateKeyPairSync('ed25519');
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = signPackageManifest({
    packageId: 'release-check',
    packageType: 'skill',
    version: '2.0.0',
    keyId: 'publisher',
    privateKey: pair.privateKey,
    files: [{ path: 'SKILL.md', size: skill.byteLength, sha256: createHash('sha256').update(skill).digest('hex') }],
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  await fs.writeFile(path.join(packageRoot, 'manifest.json'), manifestBytes);
  const config = path.join(root, 'config.toml');
  const feedUrl = 'https://updates.example.test/packages.json';
  await fs.writeFile(
    config,
    `[extensions]\ninstall_directory = ${JSON.stringify(installRoot)}\nupdate_feed_url = ${JSON.stringify(feedUrl)}\nupdate_key_id = "publisher"\n[extensions.trusted_keys]\npublisher = ${JSON.stringify(publicPem)}\n`,
  );
  const installedSource = path.join(root, 'installed-v1');
  await fs.mkdir(installedSource);
  const installedSkill = Buffer.from('---\nname: release-check\ndescription: Check a release\n---\nInstalled version.\n');
  await fs.writeFile(path.join(installedSource, 'SKILL.md'), installedSkill);
  const installedManifest = signPackageManifest({
    packageId: 'release-check',
    packageType: 'skill',
    version: '1.0.0',
    keyId: 'publisher',
    privateKey: pair.privateKey,
    files: [{ path: 'SKILL.md', size: installedSkill.byteLength, sha256: createHash('sha256').update(installedSkill).digest('hex') }],
  });
  await fs.writeFile(path.join(installedSource, 'manifest.json'), JSON.stringify(installedManifest));
  for (const args of [
    ['install', installedSource],
    ['enable', 'skill', 'release-check', '1.0.0'],
  ]) {
    const result = await runProcess(process.execPath, [cliPath, '--workspace', root, '--config', config, 'extensions', ...args], {
      cwd: process.cwd(),
    });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  const feedStatement = {
    schema_version: 1,
    sequence: 1,
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    key_id: 'publisher',
    packages: [
      {
        package_type: 'skill',
        package_id: 'release-check',
        version: '2.0.0',
        manifest_sha256: createHash('sha256').update(manifestBytes).digest('hex'),
        package_url: 'https://packages.example.test/release-check-2.0.0',
      },
    ],
  };
  const signedFeed = {
    ...feedStatement,
    signature: sign(null, Buffer.from(canonicalJson(feedStatement)), pair.privateKey).toString('base64'),
  };
  await refreshPackageUpdateFeed({
    installRoot,
    url: feedUrl,
    keyId: 'publisher',
    trustedKeys: { publisher: publicPem },
    fetchImpl: async () => new Response(JSON.stringify(signedFeed)),
  });
  const verified = await runProcess(
    process.execPath,
    [cliPath, '--workspace', root, '--config', config, 'extensions', 'verify-update', packageRoot],
    {
      cwd: process.cwd(),
    },
  );
  assert.equal(verified.exitCode, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).authenticated_update, true);
  const offlineUpdates = await runProcess(
    process.execPath,
    [cliPath, '--workspace', root, '--config', config, 'extensions', 'list-updates'],
    { cwd: process.cwd() },
  );
  assert.equal(offlineUpdates.exitCode, 0, offlineUpdates.stderr);
  assert.equal(JSON.parse(offlineUpdates.stdout).updates[0].current_version, '1.0.0');

  const changedStatement = {
    ...feedStatement,
    sequence: 2,
    packages: [{ ...feedStatement.packages[0], manifest_sha256: '0'.repeat(64) }],
  };
  const changedFeed = {
    ...changedStatement,
    signature: sign(null, Buffer.from(canonicalJson(changedStatement)), pair.privateKey).toString('base64'),
  };
  await refreshPackageUpdateFeed({
    installRoot,
    url: feedUrl,
    keyId: 'publisher',
    trustedKeys: { publisher: publicPem },
    fetchImpl: async () => new Response(JSON.stringify(changedFeed)),
  });
  const mismatch = await runProcess(
    process.execPath,
    [cliPath, '--workspace', root, '--config', config, 'extensions', 'verify-update', packageRoot],
    {
      cwd: process.cwd(),
    },
  );
  assert.equal(mismatch.exitCode, 1);
  assert.match(mismatch.stderr, /manifest digest does not match authenticated update metadata/);
});

test('CLI verifies and stages a signed package only under configured publisher trust', async (t) => {
  const root = await createTempDirectory('xyst-cli-signed-package-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package');
  await fs.mkdir(packageRoot);
  const skill = Buffer.from('---\nname: release-check\ndescription: Check a release\n---\nInspect its files.\n');
  await fs.writeFile(path.join(packageRoot, 'SKILL.md'), skill);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = signPackageManifest({
    packageId: 'release-check',
    packageType: 'skill',
    version: '1.0.0',
    keyId: 'publisher',
    privateKey,
    files: [{ path: 'SKILL.md', size: skill.byteLength, sha256: createHash('sha256').update(skill).digest('hex') }],
  });
  await fs.writeFile(path.join(packageRoot, 'manifest.json'), JSON.stringify(manifest));
  const config = path.join(root, 'config.toml');
  await fs.writeFile(config, `[extensions.trusted_keys]\npublisher = ${JSON.stringify(publicPem)}\n`);
  const run = (action, target = packageRoot) =>
    runProcess(process.execPath, [cliPath, '--workspace', root, '--config', config, 'extensions', action, target], { cwd: process.cwd() });
  const manage = (...args) =>
    runProcess(process.execPath, [cliPath, '--workspace', root, '--config', config, 'extensions', ...args], { cwd: process.cwd() });
  const verified = await run('verify');
  assert.equal(verified.exitCode, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).valid, true);
  assert.equal(JSON.parse(verified.stdout).capability_schema, null);
  assert.deepEqual(JSON.parse(verified.stdout).declared_capabilities, []);
  const installed = await run('install');
  assert.equal(installed.exitCode, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).enabled, false);
  assert.equal(await fs.readFile(path.join(root, 'extensions/skill/release-check/1.0.0/SKILL.md'), 'utf8'), skill.toString());

  const versionTwo = Buffer.from('---\nname: release-check\ndescription: Check a release\n---\nUse the updated release procedure.\n');
  const versionTwoRoot = path.join(root, 'package-v2');
  await fs.mkdir(versionTwoRoot);
  await fs.writeFile(path.join(versionTwoRoot, 'SKILL.md'), versionTwo);
  const versionTwoManifest = signPackageManifest({
    packageId: 'release-check',
    packageType: 'skill',
    version: '2.0.0',
    keyId: 'publisher',
    privateKey,
    files: [{ path: 'SKILL.md', size: versionTwo.byteLength, sha256: createHash('sha256').update(versionTwo).digest('hex') }],
  });
  await fs.writeFile(path.join(versionTwoRoot, 'manifest.json'), JSON.stringify(versionTwoManifest));
  const installedTwo = await run('install', versionTwoRoot);
  assert.equal(installedTwo.exitCode, 0, installedTwo.stderr);
  const activatedOne = await manage('enable', 'skill', 'release-check', '1.0.0');
  assert.equal(activatedOne.exitCode, 0, activatedOne.stderr);
  const activatedTwo = await manage('enable', 'skill', 'release-check', '2.0.0');
  assert.equal(JSON.parse(activatedTwo.stdout).active_version, '2.0.0');
  const rolledBack = await manage('rollback', 'skill', 'release-check');
  assert.equal(JSON.parse(rolledBack.stdout).active_version, '1.0.0');
  const listed = await manage('list');
  assert.equal(JSON.parse(listed.stdout).packages[0].active_version, '1.0.0');
  const activeUninstall = await manage('uninstall', 'skill', 'release-check');
  assert.notEqual(activeUninstall.exitCode, 0);
  assert.match(activeUninstall.stderr, /Disable the package before uninstalling it/);
  await fs.writeFile(
    config,
    `[extensions]\nrevocation_url = "https://revocations.example.invalid/feed.json"\nrevocation_key_id = "publisher"\n[extensions.trusted_keys]\npublisher = ${JSON.stringify(publicPem)}\n`,
  );
  const disableSkill = await manage('disable', 'skill', 'release-check');
  assert.equal(disableSkill.exitCode, 0, disableSkill.stderr);
  const uninstallSkill = await manage('uninstall', 'skill', 'release-check');
  assert.equal(uninstallSkill.exitCode, 0, uninstallSkill.stderr);
  assert.deepEqual(JSON.parse(uninstallSkill.stdout), {
    changed: true,
    package_type: 'skill',
    package_id: 'release-check',
  });
  await assert.rejects(fs.stat(path.join(root, 'extensions/skill/release-check')), { code: 'ENOENT' });
  assert.deepEqual(JSON.parse((await manage('list')).stdout).packages, []);
  await fs.writeFile(config, `[extensions.trusted_keys]\npublisher = ${JSON.stringify(publicPem)}\n`);

  const mcpRoot = path.join(root, 'mcp-package');
  await fs.mkdir(mcpRoot);
  const server = Buffer.from('export {};\n');
  await fs.writeFile(path.join(mcpRoot, 'server.mjs'), server);
  const capabilities = [
    { name: 'network.connect', scope: 'https://releases.example.invalid', reason: 'Read release metadata' },
    { name: 'process.execute', scope: 'configured', reason: 'Run the configured MCP server entry point' },
  ];
  const mcpManifest = signPackageManifest({
    packageId: 'release-check-server',
    packageType: 'mcp',
    version: '1.0.0',
    keyId: 'publisher',
    privateKey,
    capabilities,
    entryPoint: 'server.mjs',
    files: [{ path: 'server.mjs', size: server.byteLength, sha256: createHash('sha256').update(server).digest('hex') }],
  });
  await fs.writeFile(path.join(mcpRoot, 'manifest.json'), JSON.stringify(mcpManifest));
  const verifiedMcp = await run('verify', mcpRoot);
  assert.equal(verifiedMcp.exitCode, 0, verifiedMcp.stderr);
  assert.equal(JSON.parse(verifiedMcp.stdout).entry_point, 'server.mjs');
  assert.deepEqual(JSON.parse(verifiedMcp.stdout).declared_capabilities, capabilities);
  assert.equal(JSON.parse(verifiedMcp.stdout).capability_schema, 1);
  const installedMcp = await run('install', mcpRoot);
  assert.equal(installedMcp.exitCode, 0, installedMcp.stderr);
  assert.deepEqual(JSON.parse(installedMcp.stdout).declared_capabilities, capabilities);
  assert.equal(JSON.parse(installedMcp.stdout).entry_point, 'server.mjs');
  assert.equal(JSON.parse(installedMcp.stdout).enabled, false, 'capability declarations do not activate or grant the package');
  const activatedMcp = await manage('enable', 'mcp', 'release-check-server', '1.0.0');
  assert.equal(activatedMcp.exitCode, 0, activatedMcp.stderr);
  assert.equal(JSON.parse(activatedMcp.stdout).active_version, '1.0.0');
  const disabledMcp = await manage('disable', 'mcp', 'release-check-server');
  assert.equal(disabledMcp.exitCode, 0, disabledMcp.stderr);
  assert.equal(JSON.parse(disabledMcp.stdout).active_version, null);
  await fs.writeFile(
    config,
    `[extensions.trusted_keys]\npublisher = ${JSON.stringify(publicPem)}\n[mcp]\nenabled = true\n[mcp.servers.signed_example]\nenabled = true\npackage_id = "release-check-server"\n`,
  );
  const configuredUninstall = await manage('uninstall', 'mcp', 'release-check-server');
  assert.notEqual(configuredUninstall.exitCode, 0);
  assert.match(configuredUninstall.stderr, /Remove MCP server configuration referencing package/);
  await fs.writeFile(config, `[extensions.trusted_keys]\npublisher = ${JSON.stringify(publicPem)}\n`);
  const uninstallMcp = await manage('uninstall', 'mcp', 'release-check-server');
  assert.equal(uninstallMcp.exitCode, 0, uninstallMcp.stderr);
  await assert.rejects(fs.stat(path.join(root, 'extensions/mcp/release-check-server')), { code: 'ENOENT' });
});

test('CLI exports a portable project bundle and restores it into a clean workspace', async (t) => {
  const source = await createTempDirectory('xyst-cli-backup-source-');
  const target = await createTempDirectory('xyst-cli-backup-target-');
  const backupFile = path.join(source, 'backup.json');
  const config = path.join(source, 'config.toml');
  t.after(() => Promise.all([fs.rm(source, { recursive: true, force: true }), fs.rm(target, { recursive: true, force: true })]));
  await fs.writeFile(config, '[models.local]\nprovider = "openai-compatible"\nbase_url = "http://127.0.0.1:1234/v1"\nmodel = "offline"\n');
  await new GoalStore(source).add('Survive a workspace move');
  const exportResult = await runProcess(
    process.execPath,
    [cliPath, '--workspace', source, '--config', config, 'backup', 'export', backupFile],
    {
      cwd: process.cwd(),
    },
  );
  assert.equal(exportResult.exitCode, 0, exportResult.stderr);
  assert.equal(JSON.parse(exportResult.stdout).goals, 1);
  const restoreResult = await runProcess(
    process.execPath,
    [cliPath, '--workspace', target, '--config', config, 'backup', 'restore', backupFile],
    {
      cwd: process.cwd(),
    },
  );
  assert.equal(restoreResult.exitCode, 0, restoreResult.stderr);
  assert.equal(JSON.parse(restoreResult.stdout).restored, true);
  assert.equal((await new GoalStore(target).list())[0].title, 'Survive a workspace move');
});

test('CLI manages semantic index exclusions without contacting the embedding service', async (t) => {
  const workspace = await createTempDirectory('xyst-cli-index-exclude-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const config = path.join(workspace, 'config.toml');
  await fs.writeFile(config, '[retrieval.semantic]\nenabled = true\nbase_url = "http://127.0.0.1:1234/v1"\nmodel = "mock-embed"\n');
  const run = (args) =>
    runProcess(process.execPath, [cliPath, '--workspace', workspace, '--config', config, 'index', ...args], { cwd: process.cwd() });
  const added = await run(['exclude', 'add', 'secrets/**']);
  assert.equal(added.exitCode, 0, added.stderr);
  assert.deepEqual(JSON.parse(added.stdout).patterns, ['secrets/**']);
  const listed = await run(['exclude', 'list']);
  assert.deepEqual(JSON.parse(listed.stdout), ['secrets/**']);
  const removed = await run(['exclude', 'remove', 'secrets/**']);
  assert.equal(JSON.parse(removed.stdout).removed, true);
});

test('CLI --resume latest selects the most recently updated saved session', async (t) => {
  const workspace = await createTempDirectory('xyst-cli-resume-latest-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const store = new SessionStore(workspace);
  const older = store.create({ messages: [{ role: 'user', content: 'OLDER_TRANSCRIPT_MARKER' }] });
  await store.save(older);
  const latest = store.create({ messages: [{ role: 'user', content: 'LATEST_TRANSCRIPT_MARKER' }] });
  await store.save(latest);
  let providerBody;
  const provider = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      providerBody = JSON.parse(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: {"choices":[{"delta":{"content":"Resumed."}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const config = path.join(workspace, 'config.toml');
  await fs.writeFile(
    config,
    [
      'default_model = "local"',
      '[models.local]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${provider.address().port}/v1"`,
      'model = "mock"',
      'supports_tools = true',
      'context_length = 16000',
      '[budgets]',
      'max_turns = 2',
      'max_input_tokens = 10000',
      'max_output_tokens = 1000',
      '',
    ].join('\n'),
  );
  const result = await runProcess(
    process.execPath,
    [cliPath, '--json', '--resume', 'latest', '--workspace', workspace, '--config', config, 'Continue this conversation.'],
    { cwd: process.cwd(), timeoutMs: 20_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.session_id, latest.id);
  assert.ok(providerBody.messages.some((message) => message.content === 'LATEST_TRANSCRIPT_MARKER'));
  assert.ok(!providerBody.messages.some((message) => message.content === 'OLDER_TRANSCRIPT_MARKER'));
  assert.match((await store.load(latest.id)).messages.at(-1).content, /Resumed\./);
});

test('CLI --resume latest gives a clear error when no session exists', async (t) => {
  const workspace = await createTempDirectory('xyst-cli-resume-empty-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const result = await runProcess(process.execPath, [cliPath, '--resume', 'latest', '--workspace', workspace, 'prompt'], {
    cwd: process.cwd(),
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /No saved sessions are available to resume/);
});

test('one-shot CLI JSON output is versioned and keeps all decoration off stdout and stderr', async (t) => {
  const workspace = await createTempDirectory('xyst-cli-json-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"Structured answer."}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const config = path.join(workspace, 'config.toml');
  await fs.writeFile(
    config,
    [
      'default_model = "local"',
      '[models.local]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${provider.address().port}/v1"`,
      'model = "mock"',
      'supports_tools = true',
      'context_length = 16000',
      '[budgets]',
      'max_turns = 2',
      'max_input_tokens = 10000',
      'max_output_tokens = 1000',
      '',
    ].join('\n'),
  );
  const result = await runProcess(process.execPath, [cliPath, '--json', '--workspace', workspace, '--config', config, 'Say hello.'], {
    cwd: process.cwd(),
    timeoutMs: 20_000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.status, 'complete');
  assert.equal(payload.model, 'local');
  assert.equal(payload.content, 'Structured answer.');
  assert.match(payload.session_id, /^[0-9a-f-]{36}$/i);
  assert.ok(payload.routing_decision && typeof payload.routing_decision === 'object');
  assert.ok(payload.usage && typeof payload.usage === 'object');
});

test('CLI refuses secret values in command-line arguments', async () => {
  const result = await runProcess(process.execPath, [cliPath, 'secrets', 'set', 'provider', 'do-not-accept-this'], { cwd: process.cwd() });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /secret values are never accepted as command-line arguments/);
  assert.doesNotMatch(result.stderr, /do-not-accept-this/);
});

test('CLI rejects invalid control API ports before loading configuration', async () => {
  const result = await runProcess(process.execPath, [cliPath, '--port', '70000', 'serve'], { cwd: process.cwd() });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--port must be an integer/);
});

test('desktop parent control protocol starts the local API and shuts it down cleanly', async (t) => {
  const workspace = await createTempDirectory('xyst-desktop-parent-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const child = spawn(process.execPath, [cliPath, '--workspace', workspace, '--desktop-parent', 'serve', '--port', '0'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const bootstrap = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`service did not start: ${stderr}`)), 10_000);
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(JSON.parse(output.slice(0, newline)));
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`service exited ${code}: ${stderr}`));
      }
    });
  });
  assert.equal(bootstrap.api_version, 1);
  assert.match(bootstrap.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(bootstrap.token.length >= 32);
  const appResponse = await fetch(`${bootstrap.url}/app`);
  assert.equal(appResponse.status, 200);
  assert.match(appResponse.headers.get('content-security-policy'), /default-src 'none'/);
  assert.ok((await appResponse.text()).includes(bootstrap.token));
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  child.stdin.end('xyst-desktop-shutdown\n');
  assert.equal(await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))]), 0, stderr);
});

test('desktop parent protocol flag is restricted to the service command', async () => {
  const result = await runProcess(process.execPath, [cliPath, '--desktop-parent', 'models'], { cwd: process.cwd() });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /--desktop-parent is available only with the serve command/);
});

test('one-shot CLI exits unsuccessfully when the agent stops at a token budget', async (t) => {
  const workspace = await createTempDirectory('xyst-cli-budget-stop-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      [
        'data: {"choices":[{"delta":{"content":"partial response"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1001}}',
        'data: [DONE]',
        '',
      ].join('\n\n'),
    );
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const config = path.join(workspace, 'config.toml');
  await fs.writeFile(
    config,
    [
      'default_model = "local"',
      '[models.local]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${provider.address().port}/v1"`,
      'model = "mock"',
      'supports_tools = true',
      'context_length = 16000',
      '[tools]',
      'autonomy = "assisted"',
      '[budgets]',
      'max_turns = 2',
      'max_input_tokens = 10000',
      'max_output_tokens = 1000',
      '',
    ].join('\n'),
  );

  const result = await runProcess(process.execPath, [cliPath, '--json', '--workspace', workspace, '--config', config, 'Say hello.'], {
    cwd: process.cwd(),
    timeoutMs: 20_000,
  });
  assert.notEqual(result.exitCode, 0, result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, 'budget_exceeded');
  assert.match(payload.content, /Provider-reported usage exceeded the configured token budget/);
  const sessions = await new SessionStore(workspace).list();
  assert.equal(sessions.length, 1);
  assert.equal((await new SessionStore(workspace).load(sessions[0].id)).status, 'budget_exceeded');
});

test('CLI project management commands run without a configured model provider', async (t) => {
  const workspace = await createTempDirectory('xyst-cli-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const config = path.join(workspace, 'config.toml');
  await fs.writeFile(config, 'workspace = "."\n');
  const goals = await runProcess(process.execPath, [cliPath, '--workspace', workspace, '--config', config, 'goals', 'list'], {
    cwd: process.cwd(),
  });
  const sessions = await runProcess(process.execPath, [cliPath, '--workspace', workspace, '--config', config, 'sessions', 'list'], {
    cwd: process.cwd(),
  });
  await assert.rejects(fs.access(path.join(workspace, '.agent', 'processes')), { code: 'ENOENT' });
  const processes = await runProcess(process.execPath, [cliPath, '--workspace', workspace, '--config', config, 'processes', 'list'], {
    cwd: process.cwd(),
  });
  const usage = await runProcess(process.execPath, [cliPath, '--workspace', workspace, '--config', config, 'usage', 'status'], {
    cwd: process.cwd(),
  });
  const index = await runProcess(process.execPath, [cliPath, '--workspace', workspace, '--config', config, 'index', 'status'], {
    cwd: process.cwd(),
  });
  assert.equal(goals.exitCode, 0);
  assert.equal(sessions.exitCode, 0);
  assert.equal(JSON.parse(goals.stdout).length, 0);
  assert.equal(JSON.parse(sessions.stdout).length, 0);
  assert.equal(processes.exitCode, 0);
  assert.equal(JSON.parse(processes.stdout).length, 0);
  assert.equal(usage.exitCode, 0, usage.stderr);
  assert.ok(Array.isArray(JSON.parse(usage.stdout).attribution.days));
  assert.notEqual(index.exitCode, 0);
  assert.match(index.stderr, /Semantic retrieval is disabled/);

  const store = new SessionStore(workspace);
  const session = store.create();
  session.permission_grants.push(createSessionGrant('write_file', { path: 'legacy.txt', content: 'approved' }, 60_000));
  const permissionSession = store.create();
  const permissionGrant = createSessionGrant('write_file', { path: 'file.txt', content: 'approved' }, 60_000);
  permissionSession.permission_grants.push(permissionGrant);
  await store.save(session);
  await store.save(permissionSession);
  const permissionStatus = await runProcess(process.execPath, [cliPath, '--workspace', workspace, '--config', config, 'permissions'], {
    cwd: process.cwd(),
  });
  const permissionList = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, 'permissions', 'list', permissionSession.id],
    { cwd: process.cwd() },
  );
  assert.equal(permissionStatus.exitCode, 0, permissionStatus.stderr);
  assert.deepEqual(JSON.parse(permissionStatus.stdout), {
    autonomy: 'unrestricted',
    filesystem_scope: 'machine',
    process_execution: true,
    sandbox: 'none',
    session_id: null,
    grants: [],
  });
  assert.equal(JSON.parse(permissionList.stdout).grants[0].id, permissionGrant.id);
  const revokedGrant = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, 'permissions', 'revoke', permissionSession.id, permissionGrant.id],
    { cwd: process.cwd() },
  );
  assert.equal(revokedGrant.exitCode, 0, revokedGrant.stderr);
  assert.equal(JSON.parse(revokedGrant.stdout).revoked, true);
  assert.deepEqual(await store.listPermissionGrants(permissionSession.id), []);
  const auditText = await fs.readFile(path.join(workspace, '.agent', 'audit', 'tool-events.jsonl'), 'utf8');
  assert.match(auditText, /"outcome":"revocation_requested"/);
  assert.match(auditText, /"outcome":"succeeded"/);
  const exportPath = path.join(workspace, 'portable-session.json');
  const exported = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, 'sessions', 'export', session.id, exportPath],
    { cwd: process.cwd() },
  );
  assert.equal(exported.exitCode, 0, exported.stderr);
  const exportDocument = JSON.parse(await fs.readFile(exportPath, 'utf8'));
  assert.equal(exportDocument.format, 'xyst-session');
  assert.deepEqual(exportDocument.session.permission_grants, []);
  const importedResult = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, 'sessions', 'import', exportPath],
    { cwd: process.cwd() },
  );
  assert.equal(importedResult.exitCode, 0, importedResult.stderr);
  const importedId = importedResult.stdout.match(/([0-9a-f-]{36})/i)?.[1];
  assert.ok(importedId);
  assert.notEqual(importedId, session.id);
  assert.equal((await store.load(importedId)).permission_grants.length, 0);
  const listedGrants = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, 'sessions', 'grants', session.id],
    { cwd: process.cwd() },
  );
  assert.equal(listedGrants.exitCode, 0);
  const grants = JSON.parse(listedGrants.stdout);
  assert.equal(grants.length, 1);
  const revoked = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, 'sessions', 'revoke-grant', session.id, grants[0].id],
    { cwd: process.cwd() },
  );
  assert.equal(revoked.exitCode, 0);
  assert.match(revoked.stdout, /Grant revoked/);

  const ruleAdded = await runProcess(
    process.execPath,
    [
      cliPath,
      '--workspace',
      workspace,
      '--config',
      config,
      'approvals',
      'add',
      'write_file',
      'path_glob',
      'allow',
      '60000',
      'generated/**',
    ],
    { cwd: process.cwd() },
  );
  assert.equal(ruleAdded.exitCode, 0);
  const rule = JSON.parse(ruleAdded.stdout);
  const ruleList = await runProcess(process.execPath, [cliPath, '--workspace', workspace, '--config', config, 'approvals', 'list'], {
    cwd: process.cwd(),
  });
  assert.equal(JSON.parse(ruleList.stdout)[0].id, rule.id);
  const ruleRevoked = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, 'approvals', 'revoke', rule.id],
    { cwd: process.cwd() },
  );
  assert.equal(ruleRevoked.exitCode, 0);
  assert.match(ruleRevoked.stdout, /Rule revoked/);
});

test('CLI runs in a selected worktree, stores the session in the project root, and releases its lease', async (t) => {
  const base = await createTempDirectory('xyst-cli-worktree-');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'project');
  await fs.mkdir(workspace);
  const git = async (...args) => {
    const result = await runProcess('git', args, { cwd: workspace, timeoutMs: 15_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(' ')} exited ${result.exitCode}`);
  };
  await git('init', '-q');
  await git('config', 'user.name', 'Xyst AI Assistant Tests');
  await git('config', 'user.email', 'xyst-test@example.invalid');
  await fs.writeFile(path.join(workspace, 'README.md'), 'project root\n');
  await git('add', 'README.md');
  await git('commit', '-q', '-m', 'initial');
  const worktree = await createWorktree(workspace, 'agent/cli-test');

  const provider = createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"choices":[{"delta":{"content":"CLI worktree response"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const { port } = provider.address();
  const config = path.join(base, 'config.toml');
  await fs.writeFile(
    config,
    [
      'default_model = "local"',
      '[models.local]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'model = "mock"',
      'supports_tools = true',
      'context_length = 16000',
      '[budgets]',
      'max_turns = 3',
      'max_input_tokens = 10000',
      'max_output_tokens = 1000',
      'max_tool_output_bytes = 2000',
      '',
    ].join('\n'),
  );

  const result = await runProcess(
    process.execPath,
    [cliPath, '--workspace', workspace, '--config', config, '--worktree-id', worktree.id, 'Say hello.'],
    { cwd: process.cwd(), timeoutMs: 20_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /CLI worktree response/);
  const sessions = await new SessionStore(workspace).list();
  assert.equal(sessions.length, 1);
  assert.equal((await new SessionStore(workspace).load(sessions[0].id)).worktree_path, worktree.path);
  assert.equal((await removeWorktree(workspace, worktree.id)).removed, true);
});
