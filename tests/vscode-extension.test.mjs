import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { ControlApiClient } from '../src/api/client.mjs';
import { LocalControlServer } from '../src/api/server.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { createSessionGrant } from '../src/tools/grants.mjs';
import { loadConfig } from '../src/config/load.mjs';
import { runProcess } from '../src/platform/process.mjs';
import { createTempDirectory } from './helpers.mjs';

const require = createRequire(import.meta.url);
const {
  activate,
  buildProposedContent,
  formatBudgetSnapshot,
  getXystSetting,
  readBootstrap,
  readSessionExportFile,
  renderWebview,
  safeSessionView,
  isUuid,
} = require('../vscode/extension.js');

test('VS Code session lifecycle controls use the authenticated shared session store', async (t) => {
  const workspace = await createTempDirectory('xyst-vscode-api-sessions-');
  const token = 'xyst-vscode-integration-token-0123456789';
  const config = {
    default_model: 'local',
    models: {
      local: {
        provider: 'openai-compatible',
        base_url: 'http://127.0.0.1:1234/v1',
        model: 'test',
        local: true,
        supports_tools: true,
        context_length: 16000,
      },
    },
    budgets: { max_turns: 3, max_input_tokens: 10000, max_output_tokens: 1000, max_tool_output_bytes: 2000 },
  };
  const server = new LocalControlServer({ config, workspaceRoot: workspace, token });
  const { url } = await server.start();
  t.after(() => server.close());
  const store = new SessionStore(workspace);
  const original = store.create({ title: 'Imported conversation', messages: [{ role: 'user', content: 'PORTABLE_TRANSCRIPT_MARKER' }] });
  original.review_findings = [
    { severity: 'high', file: 'finding.txt', line: 2, description: 'Inspect this line.', evidence: 'Observed in review.' },
    { severity: 'invalid', file: '../outside.txt', line: 1, description: 'Ignore.', evidence: 'Invalid schema.' },
  ];
  await store.save(original);
  await fs.writeFile(path.join(workspace, 'finding.txt'), 'first\nsecond\nthird\n');
  const importPath = path.join(workspace, 'session-import.json');
  await fs.writeFile(importPath, JSON.stringify(await store.exportSession(original.id)));
  const exportPath = path.join(workspace, 'session-export.json');
  const posted = [];
  const errors = [];
  let quickPickSelection = [];
  let quickPickOptions = null;
  let receiveMessage;
  let openedFile;
  let openedSelection;
  let revealedRange;
  const commands = new Map();
  const savedUri = { fsPath: exportPath, toString: () => `file://${exportPath}` };
  const sourceUri = { fsPath: importPath, toString: () => `file://${importPath}` };
  const webview = {
    cspSource: 'vscode-webview://trusted',
    asWebviewUri: (uri) => ({ toString: () => `webview:${uri.toString()}` }),
    postMessage: async (message) => posted.push(message),
    onDidReceiveMessage: (handler) => {
      receiveMessage = handler;
      return { dispose() {} };
    },
  };
  const panel = { webview, reveal() {}, onDidDispose() {} };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ViewColumn: { Beside: 2 },
    Uri: {
      file: (filePath) => ({ fsPath: filePath, toString: () => `file://${filePath}` }),
      joinPath: (base, ...parts) => ({ toString: () => `${base}/${parts.join('/')}` }),
    },
    commands: {
      registerCommand: (name, callback) => {
        commands.set(name, callback);
        return { dispose() {} };
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      isTrusted: true,
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (key, fallback = '') => (key === 'cliPath' ? path.resolve('src/cli.mjs') : fallback) }),
      fs: { writeFile: (uri, bytes) => fs.writeFile(uri.fsPath, bytes) },
      openTextDocument: async (uri) => {
        openedFile = uri.fsPath;
        return { lineCount: 3 };
      },
    },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createWebviewPanel: () => panel,
      showInformationMessage: async () => {},
      showErrorMessage: async (message) => errors.push(message),
      showQuickPick: async (items, options) => {
        quickPickOptions = { items, options };
        return items.filter((item) => quickPickSelection.includes(item.id));
      },
      setStatusBarMessage() {},
      showInputBox: async () => 'Renamed conversation',
      showWarningMessage: async (...args) => args.at(-1),
      showSaveDialog: async () => savedUri,
      showOpenDialog: async () => [sourceUri],
      showTextDocument: async (_document, options) => {
        openedSelection = options.selection;
        return {
          revealRange: (range) => {
            revealedRange = range;
          },
        };
      },
    },
    Range: class Range {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    TextEditorRevealType: { InCenter: 'center' },
  };
  const child = fakeServiceChild({ url, token });
  const context = { subscriptions: [], extensionUri: 'extension://xyst' };
  const extension = activate(context, vscode, {
    spawn: () => {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ url, token, api_version: 1 })}\n`)));
      return child;
    },
    clientFactory: ({ url: apiUrl, token: apiToken }) => new ControlApiClient({ url: apiUrl, token: apiToken }),
  });
  t.after(() => extension.dispose());
  await commands.get('xyst.startChat')();
  assert.deepEqual(errors, []);
  assert.equal(typeof receiveMessage, 'function');
  receiveMessage({ type: 'webviewReady' });
  await waitUntil(() => posted.some((message) => message.type === 'sessions'));

  vscode.window.activeTextEditor = {
    document: {
      fileName: path.join(workspace, 'unsaved-example.mjs'),
      getText: (range) => (range ? 'selected code' : 'unsaved full editor contents'),
    },
    selection: { start: { line: 0 }, end: { line: 0 } },
  };
  await commands.get('xyst.attachActiveFile')();
  const attachedFile = posted.filter((message) => message.type === 'attachContext').at(-1);
  assert.equal(attachedFile.label, 'unsaved-example.mjs · full editor content');
  assert.equal(attachedFile.text, 'unsaved full editor contents');

  receiveMessage({ type: 'importSession' });
  await waitUntil(() => posted.filter((message) => message.type === 'session').length > 0);
  const importedView = posted.filter((message) => message.type === 'session').at(-1).session;
  assert.notEqual(importedView.id, original.id);
  assert.equal(importedView.messages[0].content, 'PORTABLE_TRANSCRIPT_MARKER');
  assert.deepEqual(importedView.review_findings, [
    { severity: 'high', file: 'finding.txt', line: 2, description: 'Inspect this line.', evidence: 'Observed in review.' },
  ]);
  const vscodeGoal = await server.goalStore.add('Keep a VS Code session goal', 'Visible in the picker as untrusted context.');
  quickPickSelection = [vscodeGoal.id];
  receiveMessage({ type: 'manageSessionGoals', sessionId: importedView.id });
  await waitUntil(() =>
    posted.some(
      (message) =>
        message.type === 'session' &&
        message.session?.id === importedView.id &&
        message.session.persistent_goal_ids?.includes(vscodeGoal.id),
    ),
  );
  assert.equal(quickPickOptions.options.canPickMany, true);
  assert.match(quickPickOptions.options.placeHolder, /untrusted context/);
  assert.equal(quickPickOptions.items[0].picked, false);
  assert.deepEqual((await store.load(importedView.id)).persistent_goal_ids, [vscodeGoal.id]);
  const postedBeforeGoalClear = posted.length;
  quickPickSelection = [];
  receiveMessage({ type: 'manageSessionGoals', sessionId: importedView.id });
  await waitUntil(() =>
    posted
      .slice(postedBeforeGoalClear)
      .some(
        (message) =>
          message.type === 'session' && message.session?.id === importedView.id && message.session.persistent_goal_ids?.length === 0,
      ),
  );
  assert.equal(quickPickOptions.items[0].picked, true);
  assert.deepEqual((await store.load(importedView.id)).persistent_goal_ids, []);
  receiveMessage({ type: 'openReviewFinding', file: 'finding.txt', line: 2 });
  await waitUntil(() => Boolean(revealedRange));
  assert.equal(openedFile, path.join(workspace, 'finding.txt'));
  assert.equal(openedSelection.start.line, 1);
  assert.equal(revealedRange.start.line, 1);

  receiveMessage({ type: 'renameSession', sessionId: importedView.id });
  await waitUntil(() =>
    posted.some(
      (message) =>
        message.type === 'session' && message.session?.id === importedView.id && message.session.title === 'Renamed conversation',
    ),
  );
  assert.equal((await store.load(importedView.id)).title, 'Renamed conversation');
  receiveMessage({ type: 'updateSessionPlan', sessionId: importedView.id, plan: '1. Inspect files\n2. Implement changes' });
  await waitUntil(() =>
    posted.some(
      (message) =>
        message.type === 'session' &&
        message.session?.id === importedView.id &&
        message.session.plan === '1. Inspect files\n2. Implement changes',
    ),
  );
  assert.equal((await store.load(importedView.id)).plan, '1. Inspect files\n2. Implement changes');
  const postedBeforeClear = posted.length;
  receiveMessage({ type: 'clearSessionPlan', sessionId: importedView.id });
  await waitUntil(() =>
    posted
      .slice(postedBeforeClear)
      .some((message) => message.type === 'session' && message.session?.id === importedView.id && !message.session.plan),
  );
  assert.equal((await store.load(importedView.id)).plan, undefined);
  receiveMessage({ type: 'exportSession', sessionId: importedView.id });
  await waitUntil(async () => errors.length > 0 || (await fs.stat(exportPath).catch(() => ({ size: 0 }))).size > 0);
  assert.deepEqual(errors, []);
  const exported = JSON.parse(await fs.readFile(exportPath, 'utf8'));
  assert.equal(exported.session.id, importedView.id);
  assert.equal(exported.session.title, 'Renamed conversation');

  receiveMessage({ type: 'openReviewFinding', file: '../outside.txt', line: 1 });
  await waitUntil(() => errors.length > 0);
  assert.match(errors[0], /workspace-relative file/);

  const postedBeforeDelete = posted.length;
  receiveMessage({ type: 'deleteSession', sessionId: importedView.id });
  await waitUntil(() =>
    posted
      .slice(postedBeforeDelete)
      .some((message) => message.type === 'sessions' && !message.sessions.some((item) => item.id === importedView.id)),
  );
  await assert.rejects(store.load(importedView.id), { code: 'ENOENT' });
  assert.ok(posted.some((message) => message.type === 'sessions' && !message.sessions.some((item) => item.id === importedView.id)));
  await extension.dispose();
  await server.close();
});

test('a VS Code session resumes in the CLI and returns to the same VS Code transcript', async (t) => {
  const workspace = await createTempDirectory('xyst-vscode-cross-surface-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  if (!(await initializeGitRepository(workspace, t))) return;
  const hasMessageText = (messages, role, text) =>
    messages.some(
      (message) =>
        message.role === role &&
        (typeof message.content === 'string'
          ? message.content.includes(text)
          : Array.isArray(message.content) && message.content.some((part) => part.type === 'text' && part.text?.includes(text))),
    );
  const token = 'xyst-vscode-cross-surface-token-0123456789';
  const providerRequests = [];
  const provider = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      providerRequests.push(JSON.parse(body));
      const answer = ['VS Code planning answer.', 'CLI plan continuation answer.', 'CLI Agent override answer.'][
        providerRequests.length - 1
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        provider.close(resolve);
        provider.closeAllConnections?.();
      }),
  );

  const configPath = path.join(workspace, 'config.toml');
  await fs.writeFile(
    configPath,
    [
      'default_model = "local"',
      '[models.local]',
      'provider = "openai-compatible"',
      `base_url = "http://127.0.0.1:${provider.address().port}/v1"`,
      'model = "cross-surface-test"',
      'context_length = 16000',
      '[tools]',
      'autonomy = "assisted"',
      '',
    ].join('\n'),
  );
  const config = await loadConfig({ configPath, projectPath: workspace, env: {} });
  const server = new LocalControlServer({
    config,
    workspaceRoot: workspace,
    userDataDirectory: path.join(workspace, '.xyst-user-data'),
    token,
  });
  const { url } = await server.start();
  t.after(() => server.close());
  let worktree;

  const posted = [];
  const errors = [];
  let receiveMessage;
  const commands = new Map();
  const panel = {
    webview: {
      cspSource: 'vscode-webview://trusted',
      asWebviewUri: (uri) => ({ toString: () => `webview:${uri.toString()}` }),
      postMessage: async (message) => posted.push(message),
      onDidReceiveMessage: (handler) => {
        receiveMessage = handler;
        return { dispose() {} };
      },
    },
    reveal() {},
    onDidDispose() {},
  };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ViewColumn: { Beside: 2 },
    Uri: {
      joinPath: (base, ...parts) => ({ toString: () => `${base}/${parts.join('/')}` }),
    },
    commands: {
      registerCommand: (name, callback) => {
        commands.set(name, callback);
        return { dispose() {} };
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      isTrusted: true,
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (key, fallback = '') => (key === 'cliPath' ? path.resolve('src/cli.mjs') : fallback) }),
    },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createWebviewPanel: () => panel,
      showInputBox: async (options) => {
        assert.equal(options.validateInput('feature/vscode-session'), undefined);
        assert.ok(options.validateInput('../outside'));
        return 'feature/vscode-session';
      },
      showQuickPick: async (items, options) => {
        assert.equal(options.canPickMany, true);
        return items;
      },
      showErrorMessage: async (message) => errors.push(message),
      setStatusBarMessage() {},
    },
  };
  const child = fakeServiceChild();
  const extension = activate({ subscriptions: [], extensionUri: 'extension://xyst' }, vscode, {
    spawn: () => {
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ url, token, api_version: 1 })}\n`)));
      return child;
    },
    clientFactory: ({ url: apiUrl, token: apiToken }) => new ControlApiClient({ url: apiUrl, token: apiToken }),
  });
  t.after(() => extension.dispose());

  await commands.get('xyst.startChat')();
  assert.deepEqual(errors, []);
  assert.equal(typeof receiveMessage, 'function');
  receiveMessage({ type: 'webviewReady' });
  await waitUntil(() => posted.some((message) => message.type === 'sessions' && message.sessions.length === 0));
  receiveMessage({ type: 'createWorktree' });
  await waitUntil(() =>
    posted.some((message) => message.type === 'worktrees' && message.worktrees.some((item) => item.branch === 'feature/vscode-session')),
  );
  worktree = (await new ControlApiClient({ url, token }).listWorktrees()).find((item) => item.branch === 'feature/vscode-session');
  assert.ok(worktree);
  await waitUntil(() =>
    posted.some(
      (message) => message.type === 'worktrees' && message.available && message.worktrees.some((item) => item.id === worktree.id),
    ),
  );
  const worktreeSummary = posted.filter((message) => message.type === 'worktrees').at(-1).worktrees[0];
  assert.deepEqual(worktreeSummary, { id: worktree.id, branch: 'feature/vscode-session' });
  receiveMessage({ type: 'worktreeChanged', worktreeId: worktree.id });
  await waitUntil(() => posted.some((message) => message.type === 'worktrees' && message.selectedId === worktree.id));
  receiveMessage({ type: 'send', prompt: 'Start in VS Code.', mode: 'plan', mcpServers: [], worktreeId: worktree.id });
  await waitUntil(() => posted.some((message) => message.type === 'runFinished' && message.sessionId));
  await waitUntil(() => posted.some((message) => message.type === 'sessions' && message.sessions.length === 1));

  const finish = posted.filter((message) => message.type === 'runFinished').at(-1);
  assert.equal(finish.status, 'complete');
  const sessionId = finish.sessionId;
  const firstSession = await server.sessionStore.load(sessionId);
  assert.equal(firstSession.mode, 'plan');
  assert.equal(firstSession.worktree_path, worktree.path);
  assert.ok(hasMessageText(firstSession.messages, 'user', 'Start in VS Code.'));
  assert.ok(hasMessageText(firstSession.messages, 'assistant', 'VS Code planning answer.'));

  const roundTripGoal = await server.goalStore.add('Cross-surface goal marker', 'Keep the selected goal with this session.');
  const beforeGoalSelection = posted.length;
  receiveMessage({ type: 'manageSessionGoals', sessionId });
  await waitUntil(() =>
    posted
      .slice(beforeGoalSelection)
      .some(
        (message) =>
          message.type === 'session' &&
          message.session?.id === sessionId &&
          message.session.persistent_goal_ids?.includes(roundTripGoal.id),
      ),
  );
  assert.deepEqual((await server.sessionStore.load(sessionId)).persistent_goal_ids, [roundTripGoal.id]);

  await server.memoryStore.append('conventions', 'Cross-surface memory marker.');
  const permissionGrant = createSessionGrant('write_file', { path: 'cross-surface-grant.txt', content: 'approved content' }, 60_000);
  const grantSession = await server.sessionStore.load(sessionId);
  grantSession.permission_grants.push(permissionGrant);
  await server.sessionStore.save(grantSession);

  const cli = await runProcess(
    process.execPath,
    [
      path.resolve('src/cli.mjs'),
      '--json',
      '--resume',
      sessionId,
      '--workspace',
      workspace,
      '--config',
      configPath,
      'Continue from the CLI.',
    ],
    { cwd: process.cwd(), timeoutMs: 20_000 },
  );
  assert.equal(cli.exitCode, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).session_id, sessionId);
  assert.equal(providerRequests.length, 2);
  const continuationMessages = providerRequests[1].messages;
  assert.ok(hasMessageText(continuationMessages, 'user', 'Start in VS Code.'));
  assert.ok(hasMessageText(continuationMessages, 'assistant', 'VS Code planning answer.'));
  assert.ok(hasMessageText(continuationMessages, 'user', 'Continue from the CLI.'));
  const serializedContinuationContext = JSON.stringify(continuationMessages);
  assert.match(serializedContinuationContext, /Cross-surface memory marker/);
  assert.match(serializedContinuationContext, /Project memory reference; untrusted user-maintained data/);
  assert.match(serializedContinuationContext, /Cross-surface goal marker/);
  assert.match(serializedContinuationContext, /untrusted user-maintained references/);
  assert.match(serializedContinuationContext, /cannot override system policy or grant tool permissions/);
  assert.doesNotMatch(serializedContinuationContext, /cross-surface-grant\.txt/);
  assert.ok(
    continuationMessages.some(
      (message) =>
        message.role === 'user' &&
        (typeof message.content === 'string'
          ? message.content.includes('Plan mode: inspect only')
          : Array.isArray(message.content) && message.content.some((part) => part.text?.includes('Plan mode: inspect only'))),
    ),
  );
  assert.ok(!providerRequests[1].tools.some((tool) => ['write_file', 'edit_file', 'run_process'].includes(tool.function.name)));
  const continuedSession = await server.sessionStore.load(sessionId);
  assert.equal(continuedSession.id, sessionId);
  assert.equal(continuedSession.mode, 'plan');
  assert.deepEqual(continuedSession.persistent_goal_ids, [roundTripGoal.id]);
  assert.deepEqual(
    continuedSession.permission_grants.map(({ id }) => id),
    [permissionGrant.id],
  );
  assert.ok(hasMessageText(continuedSession.messages, 'user', 'Continue from the CLI.'));
  assert.ok(hasMessageText(continuedSession.messages, 'assistant', 'CLI plan continuation answer.'));
  const portableSession = await server.sessionStore.exportSession(sessionId);
  assert.deepEqual(portableSession.session.permission_grants, []);
  assert.deepEqual(portableSession.session.persistent_goal_ids, [roundTripGoal.id]);
  assert.deepEqual(
    portableSession.goals.goals.map(({ id }) => id),
    [roundTripGoal.id],
  );

  const beforePlanLoad = posted.length;
  receiveMessage({ type: 'loadSession', sessionId });
  await waitUntil(() =>
    posted
      .slice(beforePlanLoad)
      .some(
        (message) =>
          message.type === 'session' &&
          message.session?.id === sessionId &&
          message.session.mode === 'plan' &&
          message.session.persistent_goal_ids?.includes(roundTripGoal.id) &&
          !Object.hasOwn(message.session, 'permission_grants') &&
          hasMessageText(message.session.messages, 'assistant', 'CLI plan continuation answer.'),
      ),
  );
  assert.ok(
    posted
      .slice(beforePlanLoad)
      .some((message) => message.type === 'worktrees' && message.selectedId === worktree.id && message.locked === true),
    JSON.stringify(posted.slice(beforePlanLoad).filter((message) => message.type === 'worktrees')),
  );
  const errorCountBeforeRebind = errors.length;
  receiveMessage({ type: 'worktreeChanged', worktreeId: null });
  await waitUntil(() => errors.length > errorCountBeforeRebind);
  assert.match(errors.at(-1), /bound to its original worktree/i);
  assert.ok(posted.at(-1).type === 'worktrees' && posted.at(-1).selectedId === worktree.id && posted.at(-1).locked);
  errors.length = errorCountBeforeRebind;

  const cliOverride = await runProcess(
    process.execPath,
    [
      path.resolve('src/cli.mjs'),
      '--json',
      '--mode',
      'agent',
      '--resume',
      sessionId,
      '--workspace',
      workspace,
      '--config',
      configPath,
      'Switch to Agent explicitly.',
    ],
    { cwd: process.cwd(), timeoutMs: 20_000 },
  );
  assert.equal(cliOverride.exitCode, 0, cliOverride.stderr);
  assert.equal(JSON.parse(cliOverride.stdout).session_id, sessionId);
  assert.equal(providerRequests.length, 3);
  assert.ok(providerRequests[2].tools.some((tool) => tool.function.name === 'write_file'));
  const overriddenSession = await server.sessionStore.load(sessionId);
  assert.equal(overriddenSession.mode, 'agent');
  assert.ok(hasMessageText(overriddenSession.messages, 'user', 'Switch to Agent explicitly.'));
  assert.ok(hasMessageText(overriddenSession.messages, 'assistant', 'CLI Agent override answer.'));

  const beforeLoad = posted.length;
  receiveMessage({ type: 'loadSession', sessionId });
  await waitUntil(() =>
    posted
      .slice(beforeLoad)
      .some(
        (message) =>
          message.type === 'session' &&
          message.session?.id === sessionId &&
          message.session.mode === 'agent' &&
          hasMessageText(message.session.messages, 'assistant', 'CLI Agent override answer.'),
      ),
  );
  assert.deepEqual(errors, []);
});

test('VS Code session import reads one bounded file handle and requires valid UTF-8 JSON', async (t) => {
  const directory = await createTempDirectory('xyst-vscode-session-import-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = `${directory}/session.json`;
  await fs.writeFile(file, '{"format":"xyst-session"}');
  assert.deepEqual(await readSessionExportFile(file), { format: 'xyst-session' });

  await fs.writeFile(file, Buffer.from([0xff, 0xfe]));
  await assert.rejects(readSessionExportFile(file), /valid UTF-8 JSON/);
  await fs.writeFile(file, '{');
  await assert.rejects(readSessionExportFile(file), /valid UTF-8 JSON/);

  await fs.truncate(file, 50 * 1024 * 1024 + 1);
  await assert.rejects(readSessionExportFile(file), /no larger than 50 MiB/);
  await assert.rejects(readSessionExportFile(directory), /regular file/);
});

test('VS Code bootstrap parser validates the local API startup record', async () => {
  const child = fakeChild();
  const pending = readBootstrap(child, 1000);
  child.stdout.emit('data', Buffer.from(`{"url":"http://127.0.0.1:1234","token":"${'a'.repeat(43)}","api_version":1}\n`));
  assert.deepEqual(await pending, { url: 'http://127.0.0.1:1234', token: 'a'.repeat(43) });
});

test('VS Code bootstrap parser rejects invalid startup data and oversized records', async () => {
  const invalid = fakeChild();
  const invalidPending = readBootstrap(invalid, 1000);
  invalid.stdout.emit('data', Buffer.from('{"url":"https://example.com","token":"secret","api_version":1}\n'));
  await assert.rejects(invalidPending, /invalid startup record/i);
  const incompatible = fakeChild();
  const incompatiblePending = readBootstrap(incompatible, 1000);
  incompatible.stdout.emit('data', Buffer.from(`{"url":"http://127.0.0.1:1234","token":"${'a'.repeat(43)}","api_version":2}\n`));
  await assert.rejects(incompatiblePending, /invalid startup record/i);
  const oversized = fakeChild();
  const oversizedPending = readBootstrap(oversized, 1000);
  oversized.stdout.emit('data', Buffer.from('x'.repeat(16_385)));
  await assert.rejects(oversizedPending, /size limit/i);
});

test('VS Code refuses an incompatible API health version and stops the local service', async (t) => {
  const workspace = await createTempDirectory('xyst-vscode-api-version-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const commands = new Map();
  const errors = [];
  const child = fakeServiceChild();
  let panelCreated = false;
  const statusBar = { show() {}, dispose() {}, text: '', tooltip: '' };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    commands: {
      registerCommand: (name, callback) => {
        commands.set(name, callback);
        return { dispose() {} };
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      isTrusted: true,
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (key, fallback = '') => (key === 'cliPath' ? path.resolve('src/cli.mjs') : fallback) }),
    },
    window: {
      createStatusBarItem: () => statusBar,
      createWebviewPanel: () => {
        panelCreated = true;
        throw new Error('An incompatible API must not create a chat panel');
      },
      showErrorMessage: async (message) => errors.push(message),
      setStatusBarMessage() {},
    },
  };
  const extension = activate({ subscriptions: [], extensionUri: 'extension://xyst' }, vscode, {
    spawn: () => {
      queueMicrotask(() =>
        child.stdout.emit('data', Buffer.from(`{"url":"http://127.0.0.1:43210","token":"${'b'.repeat(43)}","api_version":1}\n`)),
      );
      return child;
    },
    clientFactory: ({ url, token }) => ({
      health: async () => {
        assert.equal(url, 'http://127.0.0.1:43210');
        assert.equal(token, 'b'.repeat(43));
        return { api_version: 2, status: 'ready' };
      },
    }),
  });
  t.after(() => extension.dispose());

  await commands.get('xyst.startChat')();

  assert.equal(panelCreated, false);
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /incompatible or unavailable service/);
  assert.doesNotMatch(errors[0], /b{43}/);
  assert.match(statusBar.text, /offline/);
});

test('VS Code forwards paused-run budget edits and reports safe-checkpoint activation', async (t) => {
  const workspace = await createTempDirectory('xyst-vscode-run-budgets-');
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const commands = new Map();
  const posted = [];
  const child = fakeServiceChild();
  const runId = '4a13ca7e-85ee-4a85-9952-3e6f7a92c101';
  const sessionId = 'e2a26b61-d261-41e8-aa10-565c05eadb91';
  const currentBudgets = { max_turns: 1, max_output_tokens: 1000 };
  const initialBudgets = { ...currentBudgets };
  let currentRunStatus = 'running';
  let receiveMessage;
  let nextRunEvent;
  const resumeRunEvents = new Promise((resolve) => {
    nextRunEvent = resolve;
  });
  const budgetRequests = [];
  const statusBar = { show() {}, dispose() {}, text: '', tooltip: '' };
  const panel = {
    webview: {
      cspSource: 'vscode-webview://trusted',
      asWebviewUri: (uri) => ({ toString: () => `webview:${uri.toString()}` }),
      postMessage: async (message) => posted.push(message),
      onDidReceiveMessage: (handler) => {
        receiveMessage = handler;
        return { dispose() {} };
      },
    },
    reveal() {},
    onDidDispose() {},
  };
  const client = {
    health: async () => ({ api_version: 1, status: 'ready' }),
    getSettings: async () => ({ default_model: 'local', models: { local: { local: true } } }),
    listMcpServers: async () => [],
    getUsage: async () => ({}),
    listSessions: async () => [],
    getSession: async (id) => ({ id, messages: [{ role: 'user', content: 'Continue the task' }] }),
    startRun: async () => ({ run_id: runId }),
    getRun: async () => ({
      status: currentRunStatus,
      session_id: sessionId,
      model: 'run-model',
      budgets: { ...currentBudgets },
      initial_budgets: { ...initialBudgets },
      budget_adjustments_enabled: true,
      approval_requests: [{ approval_id: 'f42c8f33-3b89-4c3b-b21c-1be25a918509', tool: 'write_file', arguments: { path: 'a.txt' } }],
    }),
    changeRunBudgets: async (id, budgets) => {
      budgetRequests.push({ id, budgets });
      Object.assign(currentBudgets, budgets);
      nextRunEvent();
      return { budgets: { ...currentBudgets } };
    },
    followRunEvents: async function* (id) {
      assert.equal(id, runId);
      yield {
        type: 'model_fallback',
        data: {
          session_id: sessionId,
          from_model: 'local',
          to_model: 'remote',
          cause: 'CONNECTION_FAILED',
          reason: 'configured fallback 1 after local',
        },
      };
      yield { type: 'compaction_started', data: { session_id: sessionId, trigger_reason: 'context' } };
      yield {
        type: 'compaction_finished',
        data: { session_id: sessionId, archived_messages: 6, retained_messages: 4, duration_ms: 10 },
      };
      yield { type: 'compaction_started', data: { session_id: sessionId, trigger_reason: 'budget' } };
      yield { type: 'compaction_failed', data: { session_id: sessionId, code: 'REQUEST_TIMEOUT' } };
      currentRunStatus = 'paused';
      yield { type: 'run_paused', data: { session_id: sessionId } };
      await resumeRunEvents;
      currentRunStatus = 'running';
      yield { type: 'run_budgets_changed', data: { session_id: sessionId, budgets: { ...currentBudgets } } };
      yield {
        type: 'run_policy_changed',
        data: {
          policy: 'approval_rules',
          action: 'added',
          rule_id: '963e4d7c-b4ea-46ca-a196-93b0f825a420',
          tool: 'write_file',
          scope: 'tool',
          decision: 'deny',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      };
      yield { type: 'api_run_finished', data: { status: 'complete', session_id: sessionId } };
    },
  };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ViewColumn: { Beside: 2 },
    Uri: {
      joinPath: (base, ...parts) => ({ toString: () => `${base}/${parts.join('/')}` }),
    },
    commands: {
      registerCommand: (name, callback) => {
        commands.set(name, callback);
        return { dispose() {} };
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workspace } }],
      isTrusted: true,
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (key, fallback = '') => (key === 'cliPath' ? path.resolve('src/cli.mjs') : fallback) }),
    },
    window: {
      createStatusBarItem: () => statusBar,
      createWebviewPanel: () => panel,
      showErrorMessage: async (message) => assert.fail(message),
      setStatusBarMessage() {},
    },
  };
  const extension = activate({ subscriptions: [], extensionUri: 'extension://xyst' }, vscode, {
    spawn: () => {
      queueMicrotask(() =>
        child.stdout.emit('data', Buffer.from(`{"url":"http://127.0.0.1:43211","token":"${'c'.repeat(43)}","api_version":1}\n`)),
      );
      return child;
    },
    clientFactory: () => client,
  });
  t.after(() => extension.dispose());

  await commands.get('xyst.startChat')();
  receiveMessage({ type: 'webviewReady' });
  await waitUntil(() => posted.some((message) => message.type === 'initialize'));
  receiveMessage({ type: 'send', prompt: 'Continue the task', mode: 'agent', mcpServers: null });
  await waitUntil(() => posted.some((message) => message.type === 'runBudgetState' && message.enabled));
  await waitUntil(() => posted.some((message) => message.type === 'runPaused'));
  receiveMessage({ type: 'webviewReady' });
  await waitUntil(() => posted.some((message) => message.type === 'runRecovered' && message.status === 'paused'));
  assert.match(statusBar.text, /run-model.*paused/);
  assert.ok(posted.some((message) => message.type === 'session' && message.session?.id === sessionId));
  assert.ok(
    posted.some((message) => message.type === 'approval' && message.approval?.approval_id === 'f42c8f33-3b89-4c3b-b21c-1be25a918509'),
  );
  receiveMessage({ type: 'changeRunBudgets', budgets: { max_turns: 2 } });
  await waitUntil(() => posted.some((message) => message.type === 'runBudgetQueued'));
  await waitUntil(() => posted.some((message) => message.type === 'runBudgetsChanged'));
  await waitUntil(() => posted.some((message) => message.type === 'runFinished'));

  assert.deepEqual(budgetRequests, [{ id: runId, budgets: { max_turns: 2 } }]);
  assert.ok(posted.some((message) => message.type === 'runBudgetState' && message.budgets.max_turns === 1));
  assert.ok(posted.some((message) => message.type === 'runBudgetsChanged' && message.budgets.max_turns === 2));
  assert.ok(
    posted.some(
      (message) =>
        message.type === 'activity' &&
        message.activity.label === 'Approval policy added: deny write_file (tool). Pending tools are rechecked before execution.',
    ),
  );
  assert.ok(posted.some((message) => message.type === 'activity' && message.activity.label === 'Compaction started · context limit'));
  assert.ok(
    posted.some(
      (message) => message.type === 'activity' && message.activity.label === 'Compaction complete · archived 6 messages, kept 4 recent',
    ),
  );
  assert.ok(posted.some((message) => message.type === 'activity' && message.activity.label === 'Compaction failed · REQUEST_TIMEOUT'));
  assert.ok(
    posted.some(
      (message) =>
        message.type === 'activity' &&
        message.activity.label === 'Model fallback · local → remote · provider connection failed · configured fallback 1 after local',
    ),
  );
  assert.deepEqual(currentBudgets, { max_turns: 2, max_output_tokens: 1000 });
});

test('VS Code session view exposes only display-safe conversation fields', () => {
  const session = safeSessionView({
    id: 'id',
    title: 'Example',
    persistent_goal_ids: [],
    model: 'plan-model',
    mode: 'plan',
    mcp_servers: ['docs'],
    plan: '1. Inspect the workspace',
    review_findings: [
      { severity: 'high', file: 'src/example.mjs', line: 4, description: 'Check this branch.', evidence: 'The branch is unreachable.' },
      { severity: 'invalid', file: '../secret', line: -1, description: 'Discard.', evidence: 'Bad finding.' },
    ],
    secret: 'omit',
    messages: [
      { role: 'user', content: 'hello', private_metadata: 'omit' },
      { role: 'assistant', content: null, tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"x"}' }, internal: 'omit' }] },
    ],
  });
  assert.deepEqual(session, {
    id: 'id',
    title: 'Example',
    persistent_goal_ids: [],
    model: 'plan-model',
    mode: 'plan',
    mcp_servers: ['docs'],
    plan: '1. Inspect the workspace',
    review_findings: [
      { severity: 'high', file: 'src/example.mjs', line: 4, description: 'Check this branch.', evidence: 'The branch is unreachable.' },
    ],
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: '', tool_calls: [{ name: 'read_file', arguments: '{"path":"x"}' }] },
    ],
  });
});

test('VS Code client validates UUIDs before requesting sessions or approvals', () => {
  assert.equal(isUuid('123e4567-e89b-42d3-a456-426614174000'), true);
  assert.equal(isUuid('../../settings'), false);
  assert.equal(isUuid(null), false);
});

test('VS Code side-by-side diff uses proposed write/edit content and refuses stale edit bases', () => {
  assert.equal(buildProposedContent({ tool: 'write_file', arguments: { content: 'new file' } }), 'new file');
  assert.equal(
    buildProposedContent({ tool: 'edit_file', arguments: { old_string: 'old', new_string: 'new' } }, 'before old after'),
    'before new after',
  );
  assert.throws(
    () => buildProposedContent({ tool: 'edit_file', arguments: { old_string: 'missing', new_string: 'new' } }, 'already changed'),
    /changed since this diff/i,
  );
  assert.throws(
    () => buildProposedContent({ tool: 'edit_file', arguments: { old_string: 'same', new_string: 'new' } }, 'same and same'),
    /changed since this diff/i,
  );
});

test('VS Code activation registers the documented command-palette actions and status item', async () => {
  const commands = new Map();
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    commands: {
      registerCommand: (name, callback) => {
        commands.set(name, callback);
        return { dispose() {} };
      },
    },
    workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }) },
    window: { createStatusBarItem: () => ({ show() {}, dispose() {} }) },
  };
  const context = { subscriptions: [], extensionUri: 'extension://xyst' };
  const extension = activate(context, vscode);
  for (const name of [
    'xyst.startChat',
    'xyst.selectWorkspace',
    'xyst.attachSelection',
    'xyst.attachActiveFile',
    'xyst.startReview',
    'xyst.startPlan',
    'xyst.cancelRun',
    'xyst.openSettings',
  ])
    assert.ok(commands.has(name));
  assert.ok(context.subscriptions.length >= 7);
  await extension.dispose();
});

test('VS Code workspace switching reconnects the shared service to the selected folder', async (t) => {
  const firstWorkspace = await createTempDirectory('xyst-vscode-first-workspace-');
  const secondWorkspace = await createTempDirectory('xyst-vscode-second-workspace-');
  t.after(() => fs.rm(firstWorkspace, { recursive: true, force: true }));
  t.after(() => fs.rm(secondWorkspace, { recursive: true, force: true }));
  const config = {
    default_model: 'local',
    models: {
      local: {
        provider: 'openai-compatible',
        base_url: 'http://127.0.0.1:1234/v1',
        model: 'test',
        local: true,
        supports_tools: true,
        context_length: 16000,
      },
    },
  };
  const firstServer = new LocalControlServer({ config, workspaceRoot: firstWorkspace });
  const secondServer = new LocalControlServer({ config, workspaceRoot: secondWorkspace });
  const firstConnection = await firstServer.start();
  const secondConnection = await secondServer.start();
  t.after(() => firstServer.close());
  t.after(() => secondServer.close());
  const firstStore = new SessionStore(firstWorkspace);
  const firstSession = firstStore.create({ title: 'First workspace only' });
  await firstStore.save(firstSession);
  const secondStore = new SessionStore(secondWorkspace);
  const secondSession = secondStore.create({ title: 'Second workspace only' });
  await secondStore.save(secondSession);
  const commands = new Map();
  const savedWorkspaceState = new Map();
  const workspaceState = {
    get: (key) => savedWorkspaceState.get(key),
    update: async (key, value) => {
      if (value === undefined) savedWorkspaceState.delete(key);
      else savedWorkspaceState.set(key, value);
    },
  };
  const spawnedRoots = [];
  const spawnedChildren = [];
  const posted = [];
  let selectedWorkspaceIndex = 1;
  let deferNextClientFactory = false;
  let releaseDeferredClient;
  let deferredHealthCalls = 0;
  let receiveMessage;
  let foldersChanged;
  const panel = {
    webview: {
      cspSource: 'vscode-webview://trusted',
      asWebviewUri: (uri) => ({ toString: () => `webview:${uri.toString()}` }),
      postMessage: async (message) => posted.push(message),
      onDidReceiveMessage: (handler) => {
        receiveMessage = handler;
        return { dispose() {} };
      },
    },
    reveal() {},
    onDidDispose() {},
  };
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    ViewColumn: { Beside: 2 },
    Uri: {
      file: (filePath) => ({ fsPath: filePath, toString: () => `file://${filePath}` }),
      joinPath: (base, ...parts) => ({ toString: () => `${base}/${parts.join('/')}` }),
    },
    commands: {
      registerCommand: (name, callback) => {
        commands.set(name, callback);
        return { dispose() {} };
      },
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: firstWorkspace } }, { uri: { fsPath: secondWorkspace } }],
      isTrusted: true,
      onDidChangeWorkspaceFolders: (handler) => {
        foldersChanged = handler;
        return { dispose() {} };
      },
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (key, fallback = '') => (key === 'cliPath' ? path.resolve('src/cli.mjs') : fallback) }),
    },
    window: {
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      createWebviewPanel: () => panel,
      showQuickPick: async (items) => items[selectedWorkspaceIndex],
      showWarningMessage: async (...args) => args.at(-1),
      showInformationMessage: async () => {},
      showErrorMessage: async (message) => assert.fail(message),
      setStatusBarMessage() {},
    },
  };
  const extension = activate({ subscriptions: [], extensionUri: 'extension://xyst', workspaceState }, vscode, {
    spawn: (_node, args) => {
      const root = args[args.indexOf('--workspace') + 1];
      spawnedRoots.push(root);
      const child = fakeServiceChild();
      spawnedChildren.push(child);
      const connection = root === firstWorkspace ? firstConnection : secondConnection;
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(connection)}\n`)));
      return child;
    },
    clientFactory: ({ url, token }) => {
      const client = new ControlApiClient({ url, token });
      if (!deferNextClientFactory) return client;
      deferNextClientFactory = false;
      client.health = async () => {
        deferredHealthCalls += 1;
        return { api_version: 1, status: 'ready' };
      };
      return new Promise((resolve) => {
        releaseDeferredClient = () => resolve(client);
      });
    },
  });
  t.after(() => extension.dispose());

  await commands.get('xyst.startChat')();
  receiveMessage({ type: 'webviewReady' });
  await waitUntil(() => posted.some((message) => message.type === 'initialize'));
  await waitUntil(() =>
    posted.some((message) => message.type === 'sessions' && message.sessions.some((session) => session.id === firstSession.id)),
  );
  await commands.get('xyst.selectWorkspace')();
  await waitUntil(() => posted.filter((message) => message.type === 'initialize').length === 2);
  await waitUntil(() =>
    posted.some((message) => message.type === 'sessions' && message.sessions.some((session) => session.id === secondSession.id)),
  );

  assert.deepEqual(spawnedRoots, [firstWorkspace, secondWorkspace]);
  assert.equal(posted.filter((message) => message.type === 'initialize').at(-1).settings.workspace, path.basename(secondWorkspace));
  const currentSessionList = posted.filter((message) => message.type === 'sessions').at(-1).sessions;
  assert.deepEqual(
    currentSessionList.map((session) => session.id),
    [secondSession.id],
  );
  receiveMessage({ type: 'loadSession', sessionId: secondSession.id });
  await waitUntil(() => posted.some((message) => message.type === 'session' && message.session?.id === secondSession.id));
  spawnedChildren.at(-1).emit('close', 1, null);
  await waitUntil(() => posted.filter((message) => message.type === 'initialize').length === 3);
  await waitUntil(() => posted.some((message) => message.type === 'connection' && message.connected === true));
  assert.equal(spawnedRoots.at(-1), secondWorkspace);
  assert.ok(posted.some((message) => message.type === 'session' && message.session?.id === secondSession.id));
  assert.ok(posted.filter((message) => message.type === 'session').some((message) => message.session === null));

  deferNextClientFactory = true;
  spawnedChildren.at(-1).emit('close', 1, null);
  await waitUntil(() => typeof releaseDeferredClient === 'function');
  assert.deepEqual(spawnedRoots, [firstWorkspace, secondWorkspace, secondWorkspace, secondWorkspace]);
  selectedWorkspaceIndex = 0;
  await commands.get('xyst.selectWorkspace')();
  assert.deepEqual(spawnedRoots, [firstWorkspace, secondWorkspace, secondWorkspace, secondWorkspace, firstWorkspace]);
  await waitUntil(() => posted.filter((message) => message.type === 'initialize').length === 4);
  await waitUntil(() =>
    posted.some((message) => message.type === 'sessions' && message.sessions.some((session) => session.id === firstSession.id)),
  );
  releaseDeferredClient();
  await new Promise((resolve) => setTimeout(resolve, 25));
  receiveMessage({ type: 'loadSession', sessionId: firstSession.id });
  await waitUntil(() => posted.some((message) => message.type === 'session' && message.session?.id === firstSession.id));
  assert.equal(deferredHealthCalls, 0, 'a stale reconnect must not publish its client after a workspace switch');
  assert.deepEqual(spawnedRoots, [firstWorkspace, secondWorkspace, secondWorkspace, secondWorkspace, firstWorkspace]);

  selectedWorkspaceIndex = 1;
  await commands.get('xyst.selectWorkspace')();
  await waitUntil(() => posted.filter((message) => message.type === 'initialize').length === 5);
  await waitUntil(() =>
    posted.some((message) => message.type === 'sessions' && message.sessions.some((session) => session.id === secondSession.id)),
  );
  const sessionMessageCountBeforeReloadSelection = posted.filter((message) => message.type === 'session').length;
  receiveMessage({ type: 'loadSession', sessionId: secondSession.id });
  await waitUntil(
    () =>
      posted.filter((message) => message.type === 'session').length > sessionMessageCountBeforeReloadSelection &&
      posted.filter((message) => message.type === 'session').at(-1)?.session?.id === secondSession.id,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(savedWorkspaceState.get('xyst.activeWorkspaceRoot'), secondWorkspace);
  assert.equal(savedWorkspaceState.get('xyst.activeSessionId'), secondSession.id);

  await extension.dispose();
  commands.clear();
  const previousInitializeCount = posted.filter((message) => message.type === 'initialize').length;
  const restartedExtension = activate({ subscriptions: [], extensionUri: 'extension://xyst', workspaceState }, vscode, {
    spawn: (_node, args) => {
      const root = args[args.indexOf('--workspace') + 1];
      spawnedRoots.push(root);
      const child = fakeServiceChild();
      spawnedChildren.push(child);
      const connection = root === firstWorkspace ? firstConnection : secondConnection;
      queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(connection)}\n`)));
      return child;
    },
    clientFactory: ({ url, token }) => new ControlApiClient({ url, token }),
  });
  t.after(() => restartedExtension.dispose());
  const sessionMessageCountBeforeRestart = posted.filter((message) => message.type === 'session').length;
  await commands.get('xyst.startChat')();
  receiveMessage({ type: 'webviewReady' });
  await waitUntil(() => posted.filter((message) => message.type === 'initialize').length > previousInitializeCount);
  await waitUntil(
    () =>
      posted.filter((message) => message.type === 'session').length > sessionMessageCountBeforeRestart &&
      posted.filter((message) => message.type === 'session').at(-1)?.session?.id === secondSession.id,
  );
  assert.equal(spawnedRoots.at(-1), secondWorkspace, 'extension-host activation should restore the selected workspace');

  selectedWorkspaceIndex = 0;
  const initializeCountBeforeSwitchBack = posted.filter((message) => message.type === 'initialize').length;
  await commands.get('xyst.selectWorkspace')();
  await waitUntil(() => posted.filter((message) => message.type === 'initialize').length > initializeCountBeforeSwitchBack);
  assert.equal(spawnedRoots.at(-1), firstWorkspace);

  vscode.workspace.workspaceFolders = [{ uri: { fsPath: secondWorkspace } }];
  foldersChanged();
  assert.ok(posted.some((message) => message.type === 'connection' && message.connected === false));
  assert.equal(spawnedChildren.at(-1).signalCode, 'SIGTERM');
});

test('VS Code status tooltip formats only configured aggregate budget usage', () => {
  assert.equal(formatBudgetSnapshot(null), 'budget usage unavailable');
  assert.equal(
    formatBudgetSnapshot({
      limits: { max_daily_input_tokens: 1000, max_monthly_cost: 5 },
      daily: { input_tokens: 250 },
      monthly: { cost_usd: 1.235 },
    }),
    'budget day input 250/1000, month cost $1.24/$5.00',
  );
  assert.equal(
    formatBudgetSnapshot({ limits: { max_daily_input_tokens: 1000 }, daily: { input_tokens: 250 } }, 'unrestricted'),
    'configured token/cost caps ignored; provider limits apply',
  );
});

test('VS Code chat selects review and plan defaults unless the user overrides the model', async () => {
  const elements = new Map();
  const messages = [];
  const listeners = {};
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement(['model', 'worktree-picker', 'session-picker'].includes(id) ? 'select' : 'div'));
      return elements.get(id);
    },
    createElement(tag) {
      return fakeElement(tag);
    },
  };
  const window = {
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
  };
  const source = await fs.readFile(new URL('../vscode/media/chat.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document,
    window,
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    String,
    JSON,
  });
  listeners.message({
    data: {
      type: 'initialize',
      settings: {
        default_model: 'agent-model',
        review_model: 'review-model',
        plan_model: 'plan-model',
        models: { 'agent-model': { model: 'a' }, 'review-model': { model: 'r' }, 'plan-model': { model: 'p' }, custom: { model: 'c' } },
      },
      mcpServers: [
        { name: 'docs', connection_state: 'connected' },
        { name: 'calendar', connection_state: 'disabled' },
      ],
    },
  });
  const worktreeId = '123e4567-e89b-42d3-a456-426614174001';
  listeners.message({
    data: {
      type: 'worktrees',
      available: true,
      selectedId: null,
      locked: false,
      unavailable: false,
      worktrees: [{ id: worktreeId, branch: 'feature/chat-ui' }],
    },
  });
  assert.equal(elements.get('worktree-picker').options[1].value, worktreeId);
  assert.equal(elements.get('worktree-picker').options[1].textContent, 'feature/chat-ui');
  listeners.message({
    data: {
      type: 'worktrees',
      available: true,
      creationPending: true,
      selectedId: null,
      locked: false,
      worktrees: [{ id: worktreeId, branch: 'feature/chat-ui' }],
    },
  });
  assert.equal(elements.get('worktree-picker').disabled, true);
  assert.equal(elements.get('create-worktree').disabled, true);
  assert.equal(elements.get('send').disabled, true);
  listeners.message({
    data: {
      type: 'worktrees',
      available: true,
      creationPending: false,
      selectedId: null,
      locked: false,
      worktrees: [{ id: worktreeId, branch: 'feature/chat-ui' }],
    },
  });
  elements.get('worktree-picker').value = worktreeId;
  elements.get('worktree-picker').listeners.change();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'worktreeChanged', worktreeId });
  assert.equal(elements.get('model').value, 'agent-model');
  listeners.message({ data: { type: 'setMode', mode: 'review' } });
  assert.equal(elements.get('model').value, 'review-model');
  listeners.message({ data: { type: 'setMode', mode: 'plan' } });
  assert.equal(elements.get('model').value, 'plan-model');
  elements.get('model').value = 'custom';
  elements.get('model').listeners.change();
  listeners.message({ data: { type: 'setMode', mode: 'agent' } });
  assert.equal(elements.get('model').value, 'custom');
  assert.ok(messages.some((message) => message.type === 'modeChanged' && message.model === 'custom'));
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  listeners.message({
    data: { type: 'session', session: { id: sessionId, title: 'Shared session', mcp_servers: ['docs'], messages: [] } },
  });
  listeners.message({
    data: {
      type: 'session',
      session: {
        id: sessionId,
        title: 'Shared session',
        mode: 'review',
        model: 'review-model',
        mcp_servers: ['docs'],
        persistent_goal_ids: ['123e4567-e89b-42d3-a456-426614174001'],
        messages: [],
      },
    },
  });
  assert.equal(elements.get('mode').value, 'review');
  assert.equal(elements.get('model').value, 'review-model');
  assert.equal(elements.get('mcp-selection').hidden, false);
  assert.equal(elements.get('mcp-selection-summary').textContent, 'MCP servers · 1 selected');
  assert.equal(elements.get('mcp-selection-options').children[0].children[0].checked, true);
  assert.equal(elements.get('mcp-selection-options').children[1].children[0].checked, false);
  assert.equal(elements.get('manage-goals').hidden, false);
  assert.equal(elements.get('manage-goals').textContent, 'Goals (1)');
  const prompt = document.getElementById('prompt');
  prompt.value = 'Use the selected MCP server.';
  elements.get('composer').listeners.submit({ preventDefault() {} });
  const resumedSend = messages.find((message) => message.type === 'send');
  assert.deepEqual(JSON.parse(JSON.stringify(resumedSend.mcpServers)), ['docs']);
  assert.equal(resumedSend.worktreeId, worktreeId);
  assert.equal(resumedSend.mode, 'review');
  assert.equal(resumedSend.model, 'review-model');
  elements.get('create-worktree').listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'createWorktree' });
  listeners.message({
    data: {
      type: 'worktrees',
      available: true,
      selectedId: worktreeId,
      locked: true,
      worktrees: [{ id: worktreeId, branch: 'feature/chat-ui' }],
    },
  });
  assert.equal(elements.get('worktree-picker').disabled, true);
  assert.equal(elements.get('create-worktree').disabled, true);
  for (const [button, type] of [
    ['manage-goals', 'manageSessionGoals'],
    ['rename-session', 'renameSession'],
    ['archive-session', 'archiveSession'],
    ['delete-session', 'deleteSession'],
    ['export-session', 'exportSession'],
  ]) {
    assert.equal(elements.get(button).hidden, false);
    elements.get(button).listeners.click();
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type, sessionId });
  }
  elements.get('import-session').listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'importSession' });
  elements.get('new-session').listeners.click();
  assert.equal(elements.get('mcp-selection-summary').textContent, 'MCP servers · all configured');
});

test('VS Code saved plans can be reordered, edited, saved, cleared, and explicitly implemented', async () => {
  const elements = new Map();
  const messages = [];
  const listeners = {};
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement('div'));
      return elements.get(id);
    },
    createElement(tag) {
      return fakeElement(tag);
    },
  };
  const composer = document.getElementById('composer');
  composer.requestSubmit = () => composer.listeners.submit({ preventDefault() {} });
  const window = {
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
  };
  const source = await fs.readFile(new URL('../vscode/media/chat.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document,
    window,
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    String,
    JSON,
  });
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  listeners.message({
    data: { type: 'session', session: { id: sessionId, title: 'Plan', plan: '1. Inspect\n2. Implement', messages: [] } },
  });
  const timeline = elements.get('timeline');
  let fields = timeline.querySelectorAll('.plan-step-text');
  assert.deepEqual(
    fields.map((field) => field.value),
    ['Inspect', 'Implement'],
  );
  timeline.querySelector('button[aria-label="Move down plan step 1"]').listeners.click();
  fields = timeline.querySelectorAll('.plan-step-text');
  assert.deepEqual(
    fields.map((field) => field.value),
    ['Implement', 'Inspect'],
  );
  fields[0].value = 'Implement thoroughly';
  fields[0].listeners.input();
  const save = timeline.children.at(-1).children.find((child) => child.textContent === 'Save plan');
  save.listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: 'updateSessionPlan',
    sessionId,
    plan: '1. Implement thoroughly\n2. Inspect',
  });
  const clear = timeline.children.at(-1).children.find((child) => child.textContent === 'Clear plan');
  clear.listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), { type: 'clearSessionPlan', sessionId });
  listeners.message({ data: { type: 'session', session: { id: sessionId, title: 'Plan', plan: '1. Inspect', messages: [] } } });
  timeline.children
    .at(-1)
    .children.find((child) => child.textContent === 'Implement this plan')
    .listeners.click();
  assert.equal(JSON.parse(JSON.stringify(messages.at(-1))).type, 'send');
  assert.match(messages.at(-1).prompt, /<saved-plan>\n1\. Inspect\n<\/saved-plan>/);
  assert.equal(messages.at(-1).mode, 'agent');
});

test('VS Code renders review findings, opens the cited location, and drafts read-only follow-up', async () => {
  const elements = new Map();
  const messages = [];
  const listeners = {};
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement('div'));
      return elements.get(id);
    },
    createElement(tag) {
      return fakeElement(tag);
    },
  };
  const window = {
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
  };
  const source = await fs.readFile(new URL('../vscode/media/chat.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document,
    window,
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    String,
    JSON,
  });
  const sessionId = '123e4567-e89b-42d3-a456-426614174000';
  listeners.message({
    data: {
      type: 'session',
      session: {
        id: sessionId,
        messages: [],
        review_findings: [
          {
            severity: 'high',
            file: 'src/worker.mjs',
            line: 12,
            description: 'A branch is unreachable.',
            evidence: 'The predicate cannot be true.',
          },
          { severity: 'invalid', file: '../outside', line: 1, description: 'Must not render.', evidence: 'Bad.' },
        ],
      },
    },
  });
  const opens = elements.get('timeline').querySelectorAll('[data-finding-action="open"]');
  const asks = elements.get('timeline').querySelectorAll('[data-finding-action="ask"]');
  assert.equal(opens.length, 1);
  assert.equal(asks.length, 1);
  opens[0].listeners.click();
  assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {
    type: 'openReviewFinding',
    file: 'src/worker.mjs',
    line: 12,
  });
  asks[0].listeners.click();
  assert.match(elements.get('prompt').value, /A branch is unreachable/);
  assert.match(elements.get('prompt').value, /The predicate cannot be true/);
  assert.ok(messages.some((message) => message.type === 'modeChanged' && message.mode === 'review'));
});

test('VS Code approval UI submits only the checked diff hunks', async () => {
  const elements = new Map();
  const messages = [];
  const listeners = {};
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement('div'));
      return elements.get(id);
    },
    createElement(tag) {
      return fakeElement(tag);
    },
  };
  const window = {
    addEventListener(type, handler) {
      listeners[type] = handler;
    },
  };
  const source = await fs.readFile(new URL('../vscode/media/chat.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {
    document,
    window,
    acquireVsCodeApi: () => ({ postMessage: (message) => messages.push(message) }),
    String,
    JSON,
  });
  listeners.message({
    data: {
      type: 'approval',
      approval: {
        approval_id: 'approval-1',
        tool: 'write_file',
        summary: 'Update two separate sections',
        file_change: {
          selection_available: true,
          hunks: [
            { id: 'hunk-1', old_start: 2, old_count: 1, diff: '--- a/file\n+++ b/file\n@@ -2,1 +2,1 @@\n-old\n+new' },
            { id: 'hunk-2', old_start: 12, old_count: 1, diff: '--- a/file\n+++ b/file\n@@ -12,1 +12,1 @@\n-old2\n+new2' },
          ],
        },
      },
    },
  });
  const card = elements.get('approval-region').children[0];
  const inputs = card.querySelectorAll('[data-hunk-id]');
  assert.equal(inputs.length, 2);
  inputs[1].checked = false;
  inputs[1].listeners.change();
  card.querySelector('[data-approval-action="approve"]').listeners.click();
  assert.equal(
    JSON.stringify(messages.at(-1)),
    JSON.stringify({ type: 'answerApproval', approvalId: 'approval-1', approved: true, acceptedHunks: ['hunk-1'] }),
  );
  card.children.find((child) => child.textContent === 'Open side-by-side diff').listeners.click();
  assert.equal(JSON.stringify(messages.at(-1)), JSON.stringify({ type: 'showApprovalDiff', approvalId: 'approval-1' }));
  const extension = await fs.readFile(new URL('../vscode/extension.js', import.meta.url), 'utf8');
  assert.match(extension, /registerTextDocumentContentProvider\('xyst-diff'/);
  assert.match(extension, /executeCommand\(\s*'vscode\.diff'/);
  assert.match(extension, /pendingFileChanges\.set\(data\.approval_id, data\)/);
});

test('VS Code webview renderer uses injected VS Code URIs and a nonce-only network-disabled policy', async () => {
  const vscode = { Uri: { joinPath: (base, ...parts) => ({ toString: () => `${base}/${parts.join('/')}` }) } };
  const webview = {
    cspSource: 'vscode-webview://trusted',
    asWebviewUri: (uri) => ({ toString: () => `webview:${uri.toString()}` }),
  };
  const html = await renderWebview(vscode, webview, 'extension://xyst');
  assert.match(html, /script-src 'nonce-[A-Za-z0-9+/]+=*' vscode-webview:\/\/trusted/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /webview:extension:\/\/xyst\/media\/chat\.js/);
  assert.match(html, /webview:extension:\/\/xyst\/media\/xyst-icon\.png/);
  assert.match(html, /img-src vscode-webview:\/\/trusted data:/);
  assert.match(html, /id="pause-run"/);
  assert.match(html, /id="send-direction"/);
  assert.match(html, /id="run-budget-controls"/);
  assert.match(html, /id="apply-run-budgets"/);
  for (const id of ['manage-goals', 'rename-session', 'archive-session', 'delete-session', 'export-session', 'import-session'])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.doesNotMatch(html, /__[A-Z_]+__/);
  const chat = await fs.readFile(new URL('../vscode/media/chat.js', import.meta.url), 'utf8');
  assert.match(chat, /pauseToggle/);
  assert.match(chat, /runDirection/);
  assert.match(chat, /runPaused/);
  assert.match(chat, /directionAdded/);
  assert.match(chat, /changeRunBudgets/);
  assert.match(chat, /runBudgetState/);
  for (const type of ['manageSessionGoals', 'renameSession', 'archiveSession', 'deleteSession', 'exportSession', 'importSession'])
    assert.match(chat, new RegExp(type));
  const extension = await fs.readFile(new URL('../vscode/extension.js', import.meta.url), 'utf8');
  assert.match(extension, /user_direction_added/);
  assert.match(extension, /run_budgets_changed/);
  assert.match(extension, /event\.type === 'run_policy_changed'/);
  for (const type of ['manageSessionGoals', 'renameSession', 'archiveSession', 'deleteSession', 'exportSession', 'importSession'])
    assert.match(extension, new RegExp(type));
  assert.match(extension, /Import this session into the current workspace/);
});

test('VS Code settings read values from the Xyst namespace', () => {
  const makeConfiguration = (values) => ({
    get: (key, fallback) => values[key] ?? fallback,
  });
  const vscode = {
    workspace: { getConfiguration: (section) => makeConfiguration(section === 'xyst' ? { cliPath: 'C:/new/cli.mjs' } : {}) },
  };
  assert.equal(getXystSetting(vscode, 'cliPath', ''), 'C:/new/cli.mjs');
  assert.equal(getXystSetting(vscode, 'missing', 'fallback'), 'fallback');
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  return child;
}

function fakeServiceChild() {
  const child = fakeChild();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = 'SIGTERM';
  };
  return child;
}

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Timed out waiting for the VS Code session operation to complete.');
}

function fakeElement(tag) {
  return {
    tag,
    children: [],
    listeners: {},
    options: [],
    dataset: {},
    value: '',
    hidden: false,
    disabled: false,
    append(...items) {
      this.children.push(...items);
      if (this.tag === 'select') this.options = this.children;
    },
    replaceChildren(...items) {
      this.children = items;
      if (this.tag === 'select') this.options = items;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    focus() {},
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    querySelectorAll(selector) {
      const found = [];
      const matches = (element) => {
        if (selector.startsWith('.')) return element.className?.split(' ').includes(selector.slice(1));
        if (selector === '[data-plan-control]') return element.dataset?.planControl !== undefined;
        const findingAction = selector.match(/^\[data-finding-action="([^"]+)"\]$/);
        if (findingAction) return element.dataset?.findingAction === findingAction[1];
        const aria = selector.match(/^button\[aria-label="([^"]+)"\]$/);
        if (aria) return element.tag === 'button' && element.attributes?.['aria-label'] === aria[1];
        if (selector === '[data-hunk-id]') return element.dataset?.hunkId !== undefined;
        if (selector === '[data-hunk-id]:checked') return element.dataset?.hunkId !== undefined && element.checked;
        const action = selector.match(/^\[data-hunk-action="([^"]+)"\]$/);
        if (action) return element.dataset?.hunkAction === action[1];
        const approval = selector.match(/^\[data-approval-action="([^"]+)"\]$/);
        if (approval) return element.dataset?.approvalAction === approval[1];
        return false;
      };
      const visit = (element) => {
        for (const child of element.children || []) {
          if (matches(child)) found.push(child);
          visit(child);
        }
      };
      visit(this);
      return found;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
  };
}

async function initializeGitRepository(workspace, t) {
  const git = async (args) => runProcess('git', args, { cwd: workspace, timeoutMs: 15_000 });
  let initialized;
  try {
    initialized = await git(['init', '--quiet']);
  } catch (error) {
    if (error.code === 'ENOENT') {
      t.skip('Git executable is unavailable');
      return false;
    }
    throw error;
  }
  assert.equal(initialized.exitCode, 0, initialized.stderr);
  for (const [key, value] of [
    ['user.name', 'Xyst AI Assistant VS Code Test'],
    ['user.email', 'xyst-vscode@example.invalid'],
  ]) {
    const configured = await git(['config', key, value]);
    assert.equal(configured.exitCode, 0, configured.stderr);
  }
  await fs.writeFile(path.join(workspace, '.gitignore'), '/.agent/\n');
  await fs.writeFile(path.join(workspace, 'README.md'), 'VS Code worktree integration\n');
  const added = await git(['add', '.gitignore', 'README.md']);
  assert.equal(added.exitCode, 0, added.stderr);
  const committed = await git(['commit', '--quiet', '-m', 'initial']);
  assert.equal(committed.exitCode, 0, committed.stderr);
  return true;
}
