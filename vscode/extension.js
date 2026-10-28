// biome-ignore lint/suspicious/noRedundantUseStrict: Keep CommonJS extension behavior explicit.
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

const API_CLIENT_PATH = path.join(__dirname, 'dist', 'api-client.mjs');
const MAX_SESSION_EXPORT_BYTES = 50 * 1024 * 1024;

function activate(context, injectedVscode, dependencies = {}) {
  const vscode = injectedVscode || require('vscode');
  const spawnProcess = dependencies.spawn || spawn;
  let service = null;
  let panel = null;
  let panelReady = false;
  let pendingPanelMessages = [];
  let client = null;
  let activeRunId = null;
  let activeSessionId = null;
  let activeWorkspaceRoot = null;
  let runController = null;
  let serviceStart = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let disposed = false;
  let statusBar;
  let selectedModel = '';
  let modelProfiles = {};
  let sandboxMode = 'off';
  let autonomyMode = 'assisted';
  let usageSnapshot = null;
  let requestedMode = 'agent';
  let availableMcpServers = [];
  let availableWorktrees = [];
  let worktreesAvailable = false;
  let selectedWorktreeId = null;
  let activeSessionWorktreeId = null;
  let activeSessionWorktreeUnavailable = false;
  let worktreeCreatePending = false;
  const pendingFileChanges = new Map();
  const diffDocuments = new Map();
  const diffRegistration = vscode.workspace.registerTextDocumentContentProvider('xyst-diff', {
    provideTextDocumentContent: (uri) => diffDocuments.get(uri.toString()) ?? 'This Xyst AI Assistant diff preview is no longer available.',
  });
  context.subscriptions.push(diffRegistration, {
    dispose: () => {
      pendingFileChanges.clear();
      diffDocuments.clear();
    },
  });
  const clientFactory =
    dependencies.clientFactory ||
    (async ({ url, token }) => {
      const { ControlApiClient } = await import(pathToFileURL(API_CLIENT_PATH).href);
      return new ControlApiClient({ url, token });
    });

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'xyst.startChat';
  statusBar.text = '$(sparkle) Xyst AI Assistant: idle';
  statusBar.tooltip = 'Open Xyst AI Assistant Agent chat';
  statusBar.show();

  const startChat = vscode.commands.registerCommand('xyst.startChat', async () => {
    try {
      await ensurePanel();
      await refreshSessions();
      panel.reveal(vscode.ViewColumn.Beside);
    } catch (error) {
      reportError(vscode, error);
    }
  });
  const selectWorkspace = vscode.commands.registerCommand('xyst.selectWorkspace', async () => {
    try {
      const folders = vscode.workspace.workspaceFolders || [];
      if (folders.length < 2)
        return vscode.window.showInformationMessage('Open at least two workspace folders to switch Xyst AI Assistant projects.');
      if (activeRunId || worktreeCreatePending)
        throw new Error('Wait for the active Xyst AI Assistant action to finish before switching workspaces.');
      if (!panel) await ensurePanel();
      const items = folders.map((folder) => ({
        label: path.basename(folder.uri.fsPath) || folder.uri.fsPath,
        description: folder.uri.fsPath,
        workspaceRoot: folder.uri.fsPath,
      }));
      const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Choose the project Xyst AI Assistant should use' });
      if (!selected) return;
      const currentRoot = activeWorkspaceRoot || folders[0].uri.fsPath;
      const sameRoot = sameWorkspacePath(selected.workspaceRoot, currentRoot);
      if (sameRoot) return;
      const confirmed = await vscode.window.showWarningMessage(
        `Switch Xyst AI Assistant to '${selected.label}'? The current conversation stays in its original workspace.`,
        { modal: true },
        'Switch workspace',
      );
      if (confirmed !== 'Switch workspace') return;

      const previousRoot = currentRoot;
      await stopService();
      activeWorkspaceRoot = selected.workspaceRoot;
      activeSessionId = null;
      postToPanel({ type: 'session', session: null });
      try {
        await ensureService();
        await initializeWorkspacePanel();
        panel?.reveal(vscode.ViewColumn.Beside);
      } catch (error) {
        await stopService();
        activeWorkspaceRoot = previousRoot;
        try {
          await ensureService();
          await initializeWorkspacePanel();
        } catch (restoreError) {
          reportError(
            vscode,
            new Error(`${error.message} The previous workspace connection could not be restored: ${restoreError.message}`),
          );
          return;
        }
        throw error;
      }
    } catch (error) {
      reportError(vscode, error);
    }
  });
  const attachSelection = vscode.commands.registerCommand('xyst.attachSelection', async () => {
    if (!panel) {
      await vscode.commands.executeCommand('xyst.startChat');
      if (!panel) return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showInformationMessage('Open a text editor and select the context to attach.');
    const selection = editor.document.getText(editor.selection);
    if (!selection.trim()) return vscode.window.showInformationMessage('Select some text before attaching editor context.');
    const limit = getXystSetting(vscode, 'maxAttachedSelectionCharacters', 20_000);
    if (selection.length > limit)
      return vscode.window.showWarningMessage(
        `Selection is ${selection.length} characters; the configured limit is ${limit}. Narrow the selection and try again.`,
      );
    postToPanel({
      type: 'attachContext',
      label: `${path.basename(editor.document.fileName)} · ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`,
      text: selection,
    });
    panel.reveal(vscode.ViewColumn.Beside);
  });
  const attachActiveFile = vscode.commands.registerCommand('xyst.attachActiveFile', async () => {
    if (!panel) {
      await vscode.commands.executeCommand('xyst.startChat');
      if (!panel) return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) return vscode.window.showInformationMessage('Open a text editor before attaching its file.');
    const text = editor.document.getText();
    if (!text.trim()) return vscode.window.showInformationMessage('The active editor is empty; there is no file content to attach.');
    const limit = getXystSetting(vscode, 'maxAttachedSelectionCharacters', 20_000);
    if (text.length > limit)
      return vscode.window.showWarningMessage(
        `Active file is ${text.length} characters; the configured limit is ${limit}. Narrow the content or raise the limit and try again.`,
      );
    postToPanel({
      type: 'attachContext',
      label: `${path.basename(editor.document.fileName)} · full editor content`,
      text,
    });
    panel.reveal(vscode.ViewColumn.Beside);
  });
  const startReview = registerModeCommand('xyst.startReview', 'review');
  const startPlan = registerModeCommand('xyst.startPlan', 'plan');
  const cancelRun = vscode.commands.registerCommand('xyst.cancelRun', async () => {
    if (!activeRunId || !client) return vscode.window.showInformationMessage('There is no active Xyst AI Assistant run.');
    try {
      await client.cancelRun(activeRunId);
    } catch (error) {
      reportError(vscode, error);
    }
  });
  const openSettings = vscode.commands.registerCommand('xyst.openSettings', () =>
    vscode.commands.executeCommand('workbench.action.openSettings', 'xyst'),
  );
  const workspaceFolderListener = vscode.workspace.onDidChangeWorkspaceFolders?.(() => {
    if (!activeWorkspaceRoot) return;
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.some((folder) => sameWorkspacePath(folder.uri.fsPath, activeWorkspaceRoot))) return;
    if (activeRunId && client) void client.cancelRun(activeRunId).catch(() => {});
    void stopService();
    activeWorkspaceRoot = null;
    activeSessionId = null;
    activeSessionWorktreeId = null;
    activeSessionWorktreeUnavailable = false;
    availableWorktrees = [];
    worktreesAvailable = false;
    selectedWorktreeId = null;
    postToPanel({ type: 'session', session: null });
    postWorktreeState();
    postToPanel({
      type: 'connection',
      connected: false,
      message: 'The active Xyst AI Assistant folder was removed from this VS Code workspace.',
    });
    updateStatus('offline');
  });
  context.subscriptions.push(
    statusBar,
    startChat,
    selectWorkspace,
    attachSelection,
    attachActiveFile,
    startReview,
    startPlan,
    cancelRun,
    openSettings,
    {
      dispose,
    },
    ...(workspaceFolderListener ? [workspaceFolderListener] : []),
  );

  function registerModeCommand(command, mode) {
    return vscode.commands.registerCommand(command, async () => {
      try {
        requestedMode = mode;
        await ensurePanel();
        postToPanel({ type: 'setMode', mode });
        panel.reveal(vscode.ViewColumn.Beside);
      } catch (error) {
        reportError(vscode, error);
      }
    });
  }

  async function ensurePanel() {
    await ensureService();
    if (panel) return panel;
    panel = vscode.window.createWebviewPanel('xyst.chat', 'Xyst AI Assistant Agent', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    panelReady = false;
    pendingPanelMessages = [];
    panel.webview.html = await renderWebview(vscode, panel.webview, context.extensionUri);
    panel.webview.onDidReceiveMessage(
      (message) => {
        void handleMessage(message);
      },
      undefined,
      context.subscriptions,
    );
    panel.onDidDispose(
      () => {
        panel = null;
        panelReady = false;
        pendingPanelMessages = [];
      },
      undefined,
      context.subscriptions,
    );
    await initializeWorkspacePanel();
    return panel;
  }

  async function initializeWorkspacePanel() {
    if (!client || !panel) throw new Error('Xyst AI Assistant workspace service is not connected.');
    let activeRunState = null;
    if (activeRunId) {
      activeRunState = await client.getRun(activeRunId);
      if (!['running', 'paused'].includes(activeRunState.status)) activeRunState = null;
    }
    if (!activeRunState) {
      activeSessionId = null;
      activeSessionWorktreeId = null;
      activeSessionWorktreeUnavailable = false;
      selectedWorktreeId = null;
    }
    worktreeCreatePending = false;
    const settings = await client.getSettings();
    const mcpServers = await client.listMcpServers().catch(() => []);
    availableMcpServers = mcpServers;
    await refreshWorktrees();
    modelProfiles = settings.models || {};
    selectedModel = settings.default_model || '';
    sandboxMode = settings.sandbox?.mode || 'off';
    autonomyMode = settings.tools?.autonomy || 'assisted';
    await refreshUsageSnapshot();
    updateStatus('ready');
    postToPanel({
      type: 'initialize',
      settings: {
        default_model: settings.default_model,
        review_model: settings.review_model,
        plan_model: settings.plan_model,
        models: modelProfiles,
        mode: requestedMode,
        workspace: path.basename(activeWorkspaceRoot || (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath || ''),
      },
      mcpServers: mcpServers.map(({ name, connection_state }) => ({ name, connection_state })),
    });
    postWorktreeState();
    await refreshSessions();
    if (activeRunState) {
      if (activeRunState.session_id) await loadSession(activeRunState.session_id);
      postToPanel({ type: 'runRecovered', status: activeRunState.status });
      postToPanel({
        type: 'runBudgetState',
        budgets: activeRunState.budgets,
        initialBudgets: activeRunState.initial_budgets,
        enabled: activeRunState.budget_adjustments_enabled,
      });
      for (const approval of activeRunState.approval_requests || []) postToPanel({ type: 'approval', approval });
    }
  }

  async function ensureService({ reconnect = false } = {}) {
    if (client) return client;
    if (serviceStart) return serviceStart.promise;
    const folders = vscode.workspace.workspaceFolders || [];
    if (!folders.length) throw new Error('Open a workspace folder before starting Xyst AI Assistant.');
    if (vscode.workspace.isTrusted === false) throw new Error('Trust this VS Code workspace before starting the Xyst AI Assistant agent.');
    const workspaceRoot = activeWorkspaceRoot || folders[0].uri.fsPath;
    activeWorkspaceRoot = workspaceRoot;
    const cliPath = getXystSetting(vscode, 'cliPath', '').trim();
    const nodePath = getXystSetting(vscode, 'nodePath', 'node').trim() || 'node';
    if (!cliPath || !path.isAbsolute(cliPath))
      throw new Error('Set xyst.cliPath to the absolute path of src/cli.mjs in your Xyst AI Assistant checkout.');
    const info = await fs.stat(cliPath).catch(() => null);
    if (!info?.isFile()) throw new Error(`Xyst AI Assistant CLI was not found at ${cliPath}`);
    const child = spawnProcess(nodePath, [cliPath, 'serve', '--workspace', workspaceRoot, '--port', '0'], {
      cwd: workspaceRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    service = child;
    const start = { child, promise: null };
    serviceStart = start;
    child.stderr.on('data', (chunk) => {
      const diagnostic = chunk.toString('utf8').slice(0, 4000).trim();
      if (diagnostic) vscode.window.setStatusBarMessage(`Xyst AI Assistant service: ${diagnostic}`, 5000);
    });
    child.once('close', () => {
      if (service === child) {
        service = null;
        client = null;
        if (serviceStart === start) serviceStart = null;
        runController?.abort();
        activeRunId = null;
        updateStatus('offline');
        postToPanel({ type: 'connection', connected: false, message: 'Xyst AI Assistant service stopped.' });
        scheduleReconnect();
      }
    });
    child.once('error', (error) => vscode.window.showErrorMessage(`Could not start Xyst AI Assistant service: ${error.message}`));
    start.promise = (async () => {
      try {
        const bootstrap = await readBootstrap(child, 15_000);
        if (service !== child) throw new Error('The Xyst AI Assistant service changed while connecting.');
        const nextClient = await clientFactory(bootstrap);
        if (service !== child) throw new Error('The Xyst AI Assistant service changed while connecting.');
        const health = await nextClient.health();
        if (service !== child) throw new Error('The Xyst AI Assistant service changed while connecting.');
        if (health.api_version !== 1 || health.status !== 'ready')
          throw new Error('The local Xyst AI Assistant API reported an incompatible or unavailable service.');
        client = nextClient;
        if (!reconnect) reconnectAttempt = 0;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        updateStatus('ready');
        return nextClient;
      } catch (error) {
        child.kill();
        if (service === child) {
          service = null;
          client = null;
          updateStatus('offline');
        }
        if (serviceStart === start) serviceStart = null;
        throw error;
      }
    })();
    try {
      return await start.promise;
    } finally {
      if (serviceStart === start) serviceStart = null;
    }
  }

  async function stopService() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    runController?.abort();
    runController = null;
    client = null;
    const child = service;
    service = null;
    serviceStart = null;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
  }

  function dispose() {
    disposed = true;
    return stopService();
  }

  function scheduleReconnect() {
    const retryDelays = [500, 1_000, 2_000, 5_000, 10_000];
    if (!panel || disposed || reconnectTimer) return;
    if (
      !activeWorkspaceRoot ||
      !(vscode.workspace.workspaceFolders || []).some((folder) => sameWorkspacePath(folder.uri.fsPath, activeWorkspaceRoot))
    )
      return;
    if (reconnectAttempt >= retryDelays.length) {
      postToPanel({
        type: 'connection',
        connected: false,
        message: 'Xyst AI Assistant could not reconnect. Run Open Agent Chat to try again.',
      });
      return;
    }
    const delayMs = retryDelays[reconnectAttempt++];
    vscode.window.setStatusBarMessage(`Xyst AI Assistant service stopped; reconnecting in ${Math.ceil(delayMs / 1000)}s…`);
    postToPanel({ type: 'connection', connected: false, message: 'Xyst AI Assistant service stopped; reconnecting…' });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void reconnectWorkspace();
    }, delayMs);
  }

  async function reconnectWorkspace() {
    const previousSessionId = activeSessionId;
    const previousWorkspaceRoot = activeWorkspaceRoot;
    try {
      await ensureService({ reconnect: true });
      if (!sameWorkspacePath(activeWorkspaceRoot, previousWorkspaceRoot)) return;
      await initializeWorkspacePanel();
      if (previousSessionId) {
        try {
          await loadSession(previousSessionId);
        } catch {
          activeSessionId = null;
          activeSessionWorktreeId = null;
          activeSessionWorktreeUnavailable = false;
          postToPanel({ type: 'session', session: null });
          postWorktreeState();
        }
      }
      reconnectAttempt = 0;
      postToPanel({ type: 'connection', connected: true, message: 'Xyst AI Assistant reconnected to the active workspace.' });
    } catch {
      if (disposed || !sameWorkspacePath(activeWorkspaceRoot, previousWorkspaceRoot)) return;
      updateStatus('offline');
      scheduleReconnect();
    }
  }

  async function refreshSessions() {
    if (!panel || !client) return;
    postToPanel({ type: 'sessions', sessions: await client.listSessions() });
  }

  async function refreshWorktrees() {
    try {
      const result = await client.listWorktrees();
      const seen = new Set();
      availableWorktrees = (Array.isArray(result) ? result : []).filter((worktree) => {
        if (
          !worktree ||
          !isUuid(worktree.id) ||
          typeof worktree.path !== 'string' ||
          !path.isAbsolute(worktree.path) ||
          worktree.path.length > 32_000 ||
          seen.has(worktree.id)
        )
          return false;
        seen.add(worktree.id);
        return true;
      });
      worktreesAvailable = true;
    } catch {
      availableWorktrees = [];
      worktreesAvailable = false;
    }
    return worktreesAvailable;
  }

  function postWorktreeState() {
    postToPanel({
      type: 'worktrees',
      worktrees: availableWorktrees.map(({ id, branch }) => ({
        id,
        branch: typeof branch === 'string' ? branch.slice(0, 200) : null,
      })),
      available: worktreesAvailable,
      selectedId: selectedWorktreeId,
      selectedUnavailable: Boolean(selectedWorktreeId && !availableWorktrees.some((worktree) => worktree.id === selectedWorktreeId)),
      creationPending: worktreeCreatePending,
      locked: Boolean(activeSessionId && (activeSessionWorktreeId || activeSessionWorktreeUnavailable)),
      unavailable: activeSessionWorktreeUnavailable,
    });
  }

  function postToPanel(message) {
    if (!panel) return;
    if (!panelReady) {
      pendingPanelMessages.push(message);
      return;
    }
    void panel.webview.postMessage(message);
  }

  async function handleMessage(message) {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
    if (message.type === 'webviewReady') {
      if (!panelReady && panel) {
        panelReady = true;
        const queued = pendingPanelMessages;
        pendingPanelMessages = [];
        for (const queuedMessage of queued) void panel.webview.postMessage(queuedMessage);
      } else if (panel) {
        void initializeWorkspacePanel().catch((error) => reportError(vscode, error));
      }
      return;
    }
    try {
      if (message.type === 'worktreeChanged') {
        if (worktreeCreatePending) throw new Error('Wait for worktree creation to finish before changing the selection.');
        if (activeRunId) throw new Error('Wait for the active Xyst AI Assistant run to finish before changing worktrees.');
        if (activeSessionWorktreeUnavailable)
          throw new Error('This session’s managed worktree is unavailable. Start a new session or restore the worktree.');
        const nextId = message.worktreeId ?? null;
        if (nextId !== null && !isUuid(nextId)) throw new Error('Select a valid managed worktree.');
        if (activeSessionWorktreeId && nextId !== activeSessionWorktreeId)
          throw new Error('This session is bound to its original worktree. Start a new session to choose another.');
        if (nextId && !availableWorktrees.some((worktree) => worktree.id === nextId))
          throw new Error('That managed worktree is no longer available. Refresh the workspace and try again.');
        selectedWorktreeId = nextId;
        postWorktreeState();
        return;
      }
      if (message.type === 'createWorktree') {
        if (activeRunId) throw new Error('Wait for the active Xyst AI Assistant run to finish before creating a worktree.');
        if (worktreeCreatePending) throw new Error('A managed worktree is already being created.');
        if (activeSessionWorktreeId || activeSessionWorktreeUnavailable)
          throw new Error('Start a new session before choosing a different worktree.');
        if (!worktreesAvailable) throw new Error('Managed worktrees require this folder to be a Git repository.');
        const createClient = client;
        const createWorkspaceRoot = activeWorkspaceRoot;
        const createSessionId = activeSessionId;
        worktreeCreatePending = true;
        postWorktreeState();
        try {
          const branch = await vscode.window.showInputBox({
            prompt: 'Create a managed Xyst AI Assistant worktree for a new branch',
            placeHolder: 'feature/branch-name',
            validateInput: (value) => {
              const candidate = value.trim();
              if (!candidate || candidate.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(candidate))
                return 'Enter a valid Git branch name of at most 200 characters.';
              if (
                candidate.includes('..') ||
                candidate.includes('//') ||
                candidate.endsWith('/') ||
                candidate.endsWith('.') ||
                candidate.endsWith('.lock') ||
                candidate.includes('@{')
              )
                return 'Enter a valid Git branch name.';
              return undefined;
            },
          });
          if (branch === undefined) return;
          if (client !== createClient || !createWorkspaceRoot || !sameWorkspacePath(activeWorkspaceRoot, createWorkspaceRoot))
            throw new Error('The active workspace changed while choosing a branch. Retry the worktree creation.');
          if (activeRunId || activeSessionId !== createSessionId || activeSessionWorktreeId || activeSessionWorktreeUnavailable)
            throw new Error('The active session changed. Start a new session and retry the worktree creation.');
          const created = await createClient.createWorktree(branch.trim());
          if (client !== createClient || !sameWorkspacePath(activeWorkspaceRoot, createWorkspaceRoot))
            throw new Error('The active workspace changed while creating the worktree. Select it again before using it.');
          await refreshWorktrees();
          if (!worktreesAvailable || !availableWorktrees.some((worktree) => worktree.id === created.id))
            throw new Error('Xyst AI Assistant created the worktree, but it could not be listed. Refresh the workspace before using it.');
          selectedWorktreeId = created.id;
        } finally {
          worktreeCreatePending = false;
          postWorktreeState();
        }
        return;
      }
      if (message.type === 'send') return await runPrompt(message);
      if (message.type === 'modeChanged' && ['agent', 'review', 'plan'].includes(message.mode)) {
        requestedMode = message.mode;
        if (typeof message.model === 'string' && message.model) selectedModel = message.model;
        updateStatus('ready');
        return;
      }
      if (message.type === 'refreshSessions') return await refreshSessions();
      if (message.type === 'cancel' && activeRunId) return await client.cancelRun(activeRunId);
      if (message.type === 'pauseToggle' && activeRunId && typeof message.resume === 'boolean') {
        if (message.resume) await client.resumeRun(activeRunId);
        else await client.pauseRun(activeRunId);
        return;
      }
      if (message.type === 'runDirection' && activeRunId && typeof message.content === 'string') {
        const result = await client.addRunDirection(activeRunId, message.content);
        postToPanel({ type: 'directionQueued', pending: result.pending });
        return;
      }
      if (message.type === 'changeRunBudgets' && activeRunId && message.budgets && typeof message.budgets === 'object') {
        const result = await client.changeRunBudgets(activeRunId, message.budgets);
        postToPanel({ type: 'runBudgetQueued', budgets: result.budgets });
        return;
      }
      if (message.type === 'showApprovalDiff' && typeof message.approvalId === 'string') {
        const approval = pendingFileChanges.get(message.approvalId);
        if (!approval) throw new Error('This file diff is no longer available.');
        await openApprovalDiff(approval);
        return;
      }
      if (message.type === 'openReviewFinding') {
        const requestedPath = message.file;
        const folders = vscode.workspace.workspaceFolders || [];
        if (
          !folders.length ||
          typeof requestedPath !== 'string' ||
          !requestedPath.trim() ||
          requestedPath.length > 2_000 ||
          path.isAbsolute(requestedPath) ||
          path.posix.isAbsolute(requestedPath) ||
          /^[a-z]:[\\/]/i.test(requestedPath) ||
          requestedPath.startsWith('\\\\') ||
          requestedPath.split(/[\\/]/).includes('..')
        )
          throw new Error('The review finding does not identify a workspace-relative file.');
        if (message.line !== null && message.line !== undefined && (!Number.isSafeInteger(message.line) || message.line < 1))
          throw new Error('The review finding line number is invalid.');
        const workspaceRoot = await fs.realpath(activeWorkspaceRoot || folders[0].uri.fsPath);
        const requestedFile = path.resolve(workspaceRoot, requestedPath);
        const requestedRelative = path.relative(workspaceRoot, requestedFile);
        if (
          !requestedRelative ||
          requestedRelative === '..' ||
          requestedRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(requestedRelative)
        )
          throw new Error('The review finding file is outside the current workspace.');
        const target = await fs.realpath(requestedFile);
        const realRelative = path.relative(workspaceRoot, target);
        if (!realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative))
          throw new Error('The review finding file resolves outside the current workspace.');
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
        if (message.line === null || message.line === undefined) await vscode.window.showTextDocument(document, { preview: true });
        else {
          const line = Math.min(message.line - 1, Math.max(0, document.lineCount - 1));
          const selection = new vscode.Range(line, 0, line, 0);
          const editor = await vscode.window.showTextDocument(document, { preview: true, selection });
          editor.revealRange(selection, vscode.TextEditorRevealType.InCenter);
        }
        return;
      }
      if (message.type === 'loadSession' && isUuid(message.sessionId)) {
        if (activeRunId) throw new Error('Wait for the active run to finish before switching sessions.');
        return await loadSession(message.sessionId);
      }
      if (
        [
          'renameSession',
          'archiveSession',
          'deleteSession',
          'exportSession',
          'importSession',
          'manageSessionGoals',
          'updateSessionPlan',
          'clearSessionPlan',
        ].includes(message.type)
      ) {
        if (activeRunId) throw new Error('Wait for the active run to finish before managing sessions.');
        if (message.type === 'importSession') return await importSession();
        if (!isUuid(message.sessionId || activeSessionId)) throw new Error('Select a saved session first.');
        const sessionId = message.sessionId || activeSessionId;
        if (sessionId !== activeSessionId) throw new Error('Select this session in the session picker before managing it.');
        if (message.type === 'updateSessionPlan' || message.type === 'clearSessionPlan') {
          if (
            message.type === 'updateSessionPlan' &&
            (typeof message.plan !== 'string' || !message.plan.trim() || message.plan.length > 96_000)
          )
            throw new Error('The edited plan must contain 1 to 96000 characters.');
          if (message.type === 'clearSessionPlan') {
            const confirmed = await vscode.window.showWarningMessage(
              'Clear the saved plan from this Xyst AI Assistant session?',
              { modal: true },
              'Clear plan',
            );
            if (confirmed !== 'Clear plan') return;
          }
          await client.updateSessionPlan(sessionId, message.type === 'clearSessionPlan' ? null : message.plan);
          return await loadSession(sessionId);
        }
        if (message.type === 'manageSessionGoals') {
          const operationClient = client;
          const operationWorkspace = activeWorkspaceRoot;
          const session = await operationClient.getSession(sessionId);
          const goals = (await operationClient.listGoals()).filter(
            (goal) => goal && isUuid(goal.id) && typeof goal.title === 'string' && goal.title.trim(),
          );
          if (!goals.length) {
            vscode.window.showInformationMessage(
              'No project goals are available. Add one in the browser Goals panel or with the CLI first.',
            );
            return;
          }
          const selectedIds = new Set(Array.isArray(session.persistent_goal_ids) ? session.persistent_goal_ids : []);
          const choices = goals.map((goal) => ({
            id: goal.id,
            label: goal.title.replace(/[\r\n\t]/g, ' ').slice(0, 200),
            description: `${goal.status === 'completed' ? 'Completed' : 'Active'} · ${goal.id.slice(0, 8)}`,
            picked: selectedIds.has(goal.id),
          }));
          const selected = await vscode.window.showQuickPick(choices, {
            canPickMany: true,
            placeHolder: 'Select goals for this conversation; goal notes are untrusted context.',
          });
          if (selected === undefined) return;
          if (activeRunId || operationClient !== client || operationWorkspace !== activeWorkspaceRoot || sessionId !== activeSessionId)
            throw new Error('The workspace or session changed while choosing goals. Reopen the goal picker and try again.');
          await operationClient.setSessionGoals(
            sessionId,
            selected.map((choice) => choice.id),
          );
          if (operationClient !== client || operationWorkspace !== activeWorkspaceRoot || sessionId !== activeSessionId) return;
          return await loadSession(sessionId);
        }
        if (message.type === 'renameSession') {
          const session = await client.getSession(sessionId);
          const title = await vscode.window.showInputBox({
            prompt: 'Rename this Xyst AI Assistant session',
            value: session.title || '',
            validateInput: (value) =>
              !value.trim()
                ? 'Session titles cannot be empty.'
                : value.trim().length > 200
                  ? 'Session titles must be at most 200 characters.'
                  : undefined,
          });
          if (title === undefined) return;
          await client.renameSession(sessionId, title.trim());
          await refreshSessions();
          return await loadSession(sessionId);
        }
        if (message.type === 'archiveSession' || message.type === 'deleteSession') {
          const deleting = message.type === 'deleteSession';
          const action = deleting ? 'Delete' : 'Archive';
          const confirmed = await vscode.window.showWarningMessage(
            `${action} this Xyst AI Assistant session${deleting ? ' and its transcript archive' : ''}?`,
            { modal: true },
            action,
          );
          if (confirmed !== action) return;
          if (deleting) await client.deleteSession(sessionId);
          else await client.archiveSession(sessionId);
          activeSessionId = null;
          activeSessionWorktreeId = null;
          activeSessionWorktreeUnavailable = false;
          postToPanel({ type: 'session', session: null });
          postWorktreeState();
          return await refreshSessions();
        }
        const document = await client.exportSession(sessionId);
        const target = await vscode.window.showSaveDialog({
          saveLabel: 'Export Xyst AI Assistant session',
          defaultUri: vscode.Uri.file(
            path.join(
              activeWorkspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
              `xyst-session-${sessionId.slice(0, 8)}.json`,
            ),
          ),
          filters: { 'JSON files': ['json'] },
        });
        if (!target) return;
        const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
        if (bytes.byteLength > MAX_SESSION_EXPORT_BYTES) throw new Error('Session export exceeds the 50 MiB limit.');
        await vscode.workspace.fs.writeFile(target, bytes);
        vscode.window.showInformationMessage('Xyst AI Assistant session exported. Review it before sharing.');
        return;
      }
      if (message.type === 'newSession') {
        if (activeRunId) throw new Error('Wait for the active run to finish before starting a new session.');
        activeSessionId = null;
        activeSessionWorktreeId = null;
        activeSessionWorktreeUnavailable = false;
        postToPanel({ type: 'session', session: null });
        postWorktreeState();
        return;
      }
      if (message.type === 'answerApproval' && activeRunId && isUuid(message.approvalId) && typeof message.approved === 'boolean') {
        const acceptedHunks = message.acceptedHunks;
        if (
          acceptedHunks !== undefined &&
          (!Array.isArray(acceptedHunks) ||
            acceptedHunks.length < 1 ||
            acceptedHunks.length > 100 ||
            acceptedHunks.some((id) => typeof id !== 'string' || !/^hunk-[1-9][0-9]{0,2}$/.test(id)))
        )
          throw new Error('Selected file hunks are invalid.');
        await client.answerApproval(activeRunId, message.approvalId, message.approved, { ...(acceptedHunks ? { acceptedHunks } : {}) });
        pendingFileChanges.delete(message.approvalId);
        postToPanel({
          type: 'approvalAnswered',
          approvalId: message.approvalId,
          approved: message.approved,
          acceptedHunks: acceptedHunks || null,
        });
        return;
      }
    } catch (error) {
      postToPanel({
        type: message.type === 'answerApproval' ? 'approvalError' : 'error',
        approvalId: message.approvalId,
        message: error.message,
      });
      if (['worktreeChanged', 'createWorktree'].includes(message.type)) postWorktreeState();
      reportError(vscode, error);
    }
  }

  async function loadSession(sessionId) {
    const session = await client.getSession(sessionId);
    activeSessionId = session.id;
    const boundPath = typeof session.worktree_path === 'string' ? session.worktree_path : null;
    const boundWorktree = boundPath ? availableWorktrees.find((worktree) => sameWorkspacePath(worktree.path, boundPath)) : null;
    activeSessionWorktreeId = boundWorktree?.id || null;
    activeSessionWorktreeUnavailable = Boolean(boundPath && !boundWorktree);
    selectedWorktreeId = boundWorktree?.id || null;
    postToPanel({ type: 'session', session: safeSessionView(session) });
    postWorktreeState();
  }

  async function importSession() {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Import Xyst AI Assistant session',
      filters: { 'JSON files': ['json'] },
    });
    if (!files?.[0]) return;
    const document = await readSessionExportFile(files[0].fsPath);
    const confirmed = await vscode.window.showWarningMessage(
      'Import this session into the current workspace? Its conversation may be included in model context when you resume it.',
      { modal: true },
      'Import session',
    );
    if (confirmed !== 'Import session') return;
    const imported = await client.importSession(document);
    await refreshSessions();
    return await loadSession(imported.id);
  }

  async function runPrompt(message) {
    if (activeRunId) throw new Error('A Xyst AI Assistant run is already active. Cancel it before starting another.');
    if (worktreeCreatePending) throw new Error('Wait for worktree creation to finish before starting a run.');
    if (typeof message.prompt !== 'string' || !message.prompt.trim() || message.prompt.length > 100_000)
      throw new Error('Enter a prompt of 1 to 100000 characters.');
    if (
      typeof message.contextText === 'string' &&
      message.contextText.length > getXystSetting(vscode, 'maxAttachedSelectionCharacters', 20_000)
    )
      throw new Error('Attached editor context exceeds the configured limit.');
    const editorContext =
      typeof message.contextText === 'string' && message.contextText.trim()
        ? `\n\n[User-attached editor context: ${message.contextLabel || 'selection'}]\n${message.contextText}`
        : '';
    const prompt = `${message.prompt.trim()}${editorContext}`;
    const model = typeof message.model === 'string' && message.model ? message.model : undefined;
    const mode = ['agent', 'review', 'plan'].includes(message.mode) ? message.mode : 'agent';
    const selectedMcpServers = message.mcpServers;
    if (
      selectedMcpServers !== null &&
      (!Array.isArray(selectedMcpServers) ||
        selectedMcpServers.length > 16 ||
        selectedMcpServers.some((name) => typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) ||
        new Set(selectedMcpServers).size !== selectedMcpServers.length)
    )
      throw new Error('MCP server selection must contain at most 16 unique configured server names.');
    runController = new AbortController();
    try {
      await refreshWorktrees();
      postWorktreeState();
      if (activeSessionWorktreeUnavailable)
        throw new Error('This session’s managed worktree is unavailable. Start a new session or restore the worktree.');
      if (activeSessionWorktreeId && !availableWorktrees.some((worktree) => worktree.id === activeSessionWorktreeId)) {
        activeSessionWorktreeUnavailable = true;
        postWorktreeState();
        throw new Error('This session’s managed worktree is unavailable. Start a new session or restore the worktree.');
      }
      const requestedWorktreeId = selectedWorktreeId;
      if (Object.hasOwn(message, 'worktreeId') && (message.worktreeId ?? null) !== selectedWorktreeId)
        throw new Error('The selected worktree changed. Confirm the current selection and try again.');
      if (requestedWorktreeId !== null && !isUuid(requestedWorktreeId)) throw new Error('Select a valid managed worktree.');
      if (activeSessionWorktreeId && requestedWorktreeId && requestedWorktreeId !== activeSessionWorktreeId)
        throw new Error('This session is bound to its original worktree. Start a new session to choose another.');
      const worktreeId = activeSessionWorktreeId || requestedWorktreeId || null;
      if (worktreeId && !availableWorktrees.some((worktree) => worktree.id === worktreeId))
        throw new Error('That managed worktree is no longer available. Refresh the workspace and try again.');
      if (Array.isArray(selectedMcpServers) && availableMcpServers.length > 0) {
        const available = new Set(availableMcpServers.map((server) => server.name));
        if (selectedMcpServers.some((name) => !available.has(name)))
          throw new Error('MCP server selection contains a server that is no longer configured.');
      }
      const accepted = await client.startRun(
        {
          prompt,
          session_id: activeSessionId || undefined,
          model,
          mode,
          mcp_servers: selectedMcpServers,
          ...(worktreeId ? { worktree_id: worktreeId } : {}),
        },
        { signal: runController.signal },
      );
      if (worktreeId) {
        activeSessionWorktreeId = worktreeId;
        activeSessionWorktreeUnavailable = false;
        selectedWorktreeId = worktreeId;
      }
      activeRunId = accepted.run_id;
      postToPanel({ type: 'runStarted', prompt: message.prompt.trim(), sessionId: activeSessionId });
      selectedModel = model || selectedModel;
      updateStatus('running');
      for await (const event of client.events(activeRunId, { signal: runController.signal })) {
        const data = event.data;
        if (data.session_id) {
          activeSessionId = data.session_id;
          postWorktreeState();
        }
        if (event.type === 'assistant_delta') postToPanel({ type: 'assistantDelta', text: data.text });
        if (event.type === 'compaction_started' || event.type === 'compaction_finished' || event.type === 'compaction_failed')
          postToPanel({
            type: 'activity',
            activity: { type: event.type, tool: 'session', label: formatCompactionActivity(event) },
          });
        if (event.type === 'run_pause_requested') postToPanel({ type: 'pauseRequested' });
        if (event.type === 'run_paused') {
          updateStatus('paused');
          postToPanel({ type: 'runPaused' });
          try {
            const runState = await client.getRun(activeRunId);
            postToPanel({
              type: 'runBudgetState',
              budgets: runState.budgets,
              initialBudgets: runState.initial_budgets,
              enabled: runState.budget_adjustments_enabled,
            });
          } catch {
            postToPanel({ type: 'runBudgetState', enabled: false });
          }
        }
        if (event.type === 'run_resumed') {
          updateStatus('running');
          postToPanel({ type: 'runResumed' });
        }
        if (event.type === 'run_pause_cancelled') postToPanel({ type: 'pauseCancelled' });
        if (event.type === 'run_budgets_changed') postToPanel({ type: 'runBudgetsChanged', budgets: data.budgets });
        if (event.type === 'run_budget_change_failed') postToPanel({ type: 'runBudgetChangeFailed' });
        if (event.type === 'run_policy_changed') {
          const action = data.action === 'revoked' ? 'revoked' : 'added';
          const decision = typeof data.decision === 'string' ? ` ${data.decision}` : '';
          postToPanel({
            type: 'activity',
            activity: {
              type: 'run_policy_changed',
              tool: 'approval policy',
              label: `Approval policy ${action}:${decision} ${data.tool || 'tool'} (${data.scope || 'scope'}). Pending tools are rechecked before execution.`,
            },
          });
        }
        if (event.type === 'user_direction_added') postToPanel({ type: 'directionAdded', content: data.content });
        if (
          event.type === 'tool_proposed' ||
          event.type === 'tool_started' ||
          event.type === 'tool_finished' ||
          event.type === 'tool_denied' ||
          event.type === 'tool_failed'
        ) {
          postToPanel({
            type: 'activity',
            activity: { type: event.type, tool: data.tool, tool_call_id: data.tool_call_id, message: data.message },
          });
        }
        if (event.type === 'approval_required') {
          if (data.file_change?.selection_available && data.arguments && ['write_file', 'edit_file'].includes(data.tool))
            pendingFileChanges.set(data.approval_id, data);
          postToPanel({ type: 'approval', approval: data });
        }
        if (event.type === 'api_run_finished') {
          pendingFileChanges.clear();
          activeSessionId = data.session_id || activeSessionId;
          updateStatus('ready');
          postToPanel({ type: 'runFinished', status: data.status, sessionId: activeSessionId });
        }
        if (event.type === 'api_run_failed') {
          pendingFileChanges.clear();
          updateStatus('ready');
          postToPanel({ type: 'runFinished', status: 'failed', error: data.error?.message || 'Run failed.' });
        }
      }
      await refreshSessions();
    } finally {
      activeRunId = null;
      runController = null;
      await refreshUsageSnapshot();
      updateStatus(client ? 'ready' : 'offline');
    }
  }

  function updateStatus(state) {
    if (!statusBar) return;
    const name = String(selectedModel || '')
      .replace(/[\r\n]/g, '')
      .slice(0, 60);
    const profile = modelProfiles[selectedModel];
    const location = profile ? (profile.local ? 'local' : 'remote') : 'agent';
    const label =
      state === 'running' ? '$(sync~spin) running' : state === 'paused' ? '$(debug-pause) paused' : client ? 'ready' : 'offline';
    statusBar.text = `$(sparkle) Xyst AI Assistant · ${name || location} · ${label}`;
    const budget = formatBudgetSnapshot(usageSnapshot, autonomyMode);
    const workspace = path.basename(activeWorkspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '');
    statusBar.tooltip = `Xyst AI Assistant Agent · workspace: ${workspace || 'not selected'} · ${location} model${name ? `: ${name}` : ''} · automation: ${autonomyMode} · sandbox: ${sandboxMode} · ${budget} · ${state}`;
  }

  async function openApprovalDiff(approval) {
    const fileChange = approval.file_change;
    if (!fileChange?.selection_available || typeof fileChange.path !== 'string')
      throw new Error('A reviewable text diff is not available for this change.');
    const rootPath = activeWorkspaceRoot || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const root = rootPath ? vscode.Uri.file(rootPath) : null;
    if (!root) throw new Error('Open a workspace before viewing a file diff.');
    const normalized = fileChange.path.replace(/\\/g, '/');
    const target = path.isAbsolute(fileChange.path)
      ? vscode.Uri.file(fileChange.path)
      : vscode.Uri.joinPath(root, ...normalized.split('/'));
    let proposed;
    if (approval.tool === 'write_file') proposed = buildProposedContent(approval);
    else {
      const document = await vscode.workspace.openTextDocument(target);
      proposed = buildProposedContent(approval, document.getText());
    }
    const previewUri = vscode.Uri.parse(
      `xyst-diff:/${encodeURIComponent(approval.approval_id)}/proposed/${encodeURIComponent(path.basename(fileChange.path))}`,
    );
    diffDocuments.set(previewUri.toString(), proposed);
    const proposedDocument = await vscode.workspace.openTextDocument(previewUri);
    let currentDocument;
    try {
      currentDocument = await vscode.workspace.openTextDocument(target);
    } catch (error) {
      if (fileChange.operation !== 'create') throw error;
      const emptyUri = vscode.Uri.parse(
        `xyst-diff:/${encodeURIComponent(approval.approval_id)}/original/${encodeURIComponent(path.basename(fileChange.path))}`,
      );
      diffDocuments.set(emptyUri.toString(), '');
      currentDocument = await vscode.workspace.openTextDocument(emptyUri);
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      currentDocument.uri,
      proposedDocument.uri,
      `${path.basename(fileChange.path)} · Proposed change`,
      { preview: true },
    );
  }

  async function refreshUsageSnapshot() {
    if (!client) {
      usageSnapshot = null;
      return;
    }
    try {
      usageSnapshot = await client.getUsage({ signal: AbortSignal.timeout(2_000) });
    } catch {
      usageSnapshot = null;
    }
  }

  return { dispose };
}

async function renderWebview(vscode, webview, extensionUri) {
  const nonce = randomBytes(18).toString('base64');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.css'));
  const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'xyst-icon.png'));
  const htmlPath = path.join(__dirname, 'media', 'chat.html');
  const template = await fs.readFile(htmlPath, 'utf8');
  return template
    .replaceAll('__CSP_SOURCE__', webview.cspSource)
    .replaceAll('__NONCE__', nonce)
    .replace('__SCRIPT_URI__', scriptUri.toString())
    .replace('__STYLE_URI__', styleUri.toString())
    .replace('__ICON_URI__', iconUri.toString());
}

function sameWorkspacePath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === 'win32' ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

function getXystSetting(vscode, key, fallback) {
  return vscode.workspace.getConfiguration('xyst').get(key, fallback);
}

function readBootstrap(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error('Xyst AI Assistant service did not provide its startup record in time.')), timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('close', onClose);
      child.off('error', onError);
      error ? reject(error) : resolve(value);
    };
    const onClose = (code) => finish(new Error(`Xyst AI Assistant service exited before startup (code ${code ?? 'unknown'}).`));
    const onError = (error) => finish(new Error(`Xyst AI Assistant service could not start: ${error.message}`));
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 16_384) return finish(new Error('Xyst AI Assistant service startup record exceeded its size limit.'));
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      try {
        const record = JSON.parse(line);
        const origin = typeof record.url === 'string' ? new URL(record.url) : null;
        if (
          origin?.protocol !== 'http:' ||
          origin.hostname !== '127.0.0.1' ||
          origin.pathname !== '/' ||
          origin.username ||
          origin.password ||
          origin.search ||
          origin.hash ||
          typeof record.token !== 'string' ||
          !/^[A-Za-z0-9_-]{32,}$/.test(record.token) ||
          record.api_version !== 1
        )
          throw new Error('Invalid startup record');
        finish(null, { url: record.url, token: record.token });
      } catch {
        finish(new Error('Xyst AI Assistant service returned an invalid startup record.'));
      }
    };
    child.stdout.on('data', onData);
    child.once('close', onClose);
    child.once('error', onError);
  });
}

function safeSessionView(session) {
  return {
    id: session.id,
    title: session.title || 'Conversation',
    persistent_goal_ids: Array.isArray(session.persistent_goal_ids)
      ? [...new Set(session.persistent_goal_ids.filter(isUuid).slice(0, 500))]
      : [],
    ...(typeof session.model === 'string' && session.model.length <= 200 ? { model: session.model } : {}),
    ...(['agent', 'review', 'plan'].includes(session.mode) ? { mode: session.mode } : {}),
    mcp_servers: Array.isArray(session.mcp_servers) ? [...session.mcp_servers] : null,
    ...(typeof session.plan === 'string' ? { plan: session.plan.slice(0, 96_000) } : {}),
    ...(Array.isArray(session.review_findings) ? { review_findings: safeReviewFindings(session.review_findings) } : {}),
    messages: session.messages.map((message) => ({
      role: message.role,
      content: typeof message.content === 'string' ? message.content : message.content == null ? '' : JSON.stringify(message.content),
      ...(Array.isArray(message.tool_calls)
        ? {
            tool_calls: message.tool_calls.map((call) => ({
              name: call.function?.name || 'tool',
              arguments: call.function?.arguments || '',
            })),
          }
        : {}),
    })),
  };
}

function safeReviewFindings(findings) {
  return findings.slice(0, 100).flatMap((finding) => {
    if (
      !finding ||
      !['critical', 'high', 'medium', 'low'].includes(finding.severity) ||
      typeof finding.file !== 'string' ||
      finding.file.length > 2_000 ||
      !(finding.line === null || (Number.isSafeInteger(finding.line) && finding.line > 0)) ||
      typeof finding.description !== 'string' ||
      typeof finding.evidence !== 'string'
    )
      return [];
    return [
      {
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        description: finding.description.slice(0, 8_000),
        evidence: finding.evidence.slice(0, 8_000),
      },
    ];
  });
}

function buildProposedContent(approval, source) {
  if (approval.tool === 'write_file' && typeof approval.arguments?.content === 'string') return approval.arguments.content;
  if (
    approval.tool !== 'edit_file' ||
    typeof source !== 'string' ||
    typeof approval.arguments?.old_string !== 'string' ||
    typeof approval.arguments?.new_string !== 'string'
  )
    throw new Error('The proposed file contents are unavailable.');
  const oldText = approval.arguments.old_string;
  const first = source.indexOf(oldText);
  if (!oldText || first < 0 || source.indexOf(oldText, first + oldText.length) >= 0)
    throw new Error('The file changed since this diff was prepared. Re-run the request to review its current contents.');
  return source.slice(0, first) + approval.arguments.new_string + source.slice(first + oldText.length);
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function readSessionExportFile(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SESSION_EXPORT_BYTES)
      throw new Error('Session export must be a regular file no larger than 50 MiB.');
    const chunks = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_SESSION_EXPORT_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_SESSION_EXPORT_BYTES) throw new Error('Session export must be no larger than 50 MiB.');
      chunks.push(chunk.subarray(0, bytesRead));
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
      return JSON.parse(text);
    } catch {
      throw new Error('The selected file is not valid UTF-8 JSON. Choose a Xyst AI Assistant session export.');
    }
  } finally {
    await handle.close();
  }
}

function reportError(vscode, error) {
  void vscode.window.showErrorMessage(`Xyst AI Assistant: ${error.message}`);
}

function formatCompactionActivity(event) {
  const data = event?.data || {};
  if (event?.type === 'compaction_started') {
    const reason =
      {
        context: 'context limit',
        budget: 'budget limit',
        context_and_budget: 'context and budget limits',
      }[data.trigger_reason] || 'requested';
    return `Compaction started · ${reason}`;
  }
  if (event?.type === 'compaction_finished') {
    const archived = Number.isSafeInteger(data.archived_messages) && data.archived_messages >= 0 ? data.archived_messages : '?';
    const retained = Number.isSafeInteger(data.retained_messages) && data.retained_messages >= 0 ? data.retained_messages : '?';
    return `Compaction complete · archived ${archived} messages, kept ${retained} recent`;
  }
  const code = typeof data.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(data.code) ? data.code : 'COMPACTION_FAILED';
  return `Compaction failed · ${code}`;
}

function formatBudgetSnapshot(snapshot, autonomy = 'assisted') {
  if (autonomy === 'unrestricted') return 'configured token/cost caps ignored; provider limits apply';
  if (!snapshot) return 'budget usage unavailable';
  const parts = [];
  for (const [period, data] of [
    ['day', snapshot.daily],
    ['month', snapshot.monthly],
  ]) {
    if (!data) continue;
    for (const [name, limitKey, usedKey] of [
      ['input', `max_${period === 'day' ? 'daily' : 'monthly'}_input_tokens`, 'input_tokens'],
      ['output', `max_${period === 'day' ? 'daily' : 'monthly'}_output_tokens`, 'output_tokens'],
      ['cost', `max_${period === 'day' ? 'daily' : 'monthly'}_cost`, 'cost_usd'],
    ]) {
      const limit = snapshot.limits?.[limitKey];
      const used = data[usedKey];
      if (Number.isFinite(limit) && Number.isFinite(used))
        parts.push(`${period} ${name} ${name === 'cost' ? `$${used.toFixed(2)}/$${limit.toFixed(2)}` : `${used}/${limit}`}`);
    }
  }
  return parts.length ? `budget ${parts.join(', ')}` : 'no shared budget caps configured';
}

module.exports = {
  activate,
  buildProposedContent,
  formatBudgetSnapshot,
  getXystSetting,
  readBootstrap,
  readSessionExportFile,
  renderWebview,
  safeSessionView,
  isUuid,
};
