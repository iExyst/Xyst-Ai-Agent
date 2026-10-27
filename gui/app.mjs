import { ControlApiClient, ControlApiError } from './api-client.mjs';
import {
  formatRunFailure,
  formatCompactionActivity,
  formatMemoryProvenance,
  formatUntrustedContentSignal,
  formatToolDetail,
  parseStoredToolArguments,
  parseStoredToolObservation,
} from './timeline.mjs';
import { budgetRemainingRows, routingSummary } from './run-inspector.mjs';
import {
  MAX_PLAN_IMPLEMENTATION_CHARACTERS,
  MAX_PLAN_PREVIEW_CHARACTERS,
  MAX_PLAN_STEPS,
  planStepsFromText,
  planTextFromSteps,
  planImplementationPrompt,
  reviewFindingsForDisplay,
} from './review-plan.mjs';
import { mountWorkspacePanel } from './workspace-panel.mjs';
import { localProfileFromDiscovery, markDiscoveredModelLoaded, postLoadModelChoice } from './onboarding.mjs';
import { isInterruptedSession } from './session-status.mjs';
import { resolveWebSearchProvider } from './web-search-settings.mjs';
import { modelCapabilitiesDataStatus, modelCapabilitiesStatus, modelPricingDataStatus, modelPricingStatus } from './model-pricing.mjs';
import { withStartupTimeout } from './startup.mjs';
import { DEFAULT_UI_SHORTCUTS, matchesUiShortcut } from '../src/core/keybindings.mjs';

const token = document.querySelector('meta[name="xyst-token"]')?.content;
const client = new ControlApiClient({ url: location.origin, token });
const AUTO_MODEL_OPTION = '__xyst_auto__';
const elements = Object.fromEntries(
  [
    'app-frame',
    'toggle-sidebar',
    'connection-indicator',
    'workspace-status',
    'session-list',
    'refresh-sessions',
    'new-session',
    'conversation-title',
    'session-actions',
    'recap-session',
    'recap-dialog',
    'recap-content',
    'close-recap',
    'rename-session',
    'export-session',
    'fork-session',
    'archive-session',
    'delete-session',
    'import-session',
    'import-session-file',
    'attach-images',
    'image-files',
    'attached-images',
    'mcp-selection',
    'mcp-selection-summary',
    'mcp-selection-options',
    'memory-button',
    'goals-button',
    'skills-button',
    'mcp-button',
    'extensions-button',
    'processes-button',
    'workspace-button',
    'settings-title',
    'timeline',
    'welcome',
    'prompt-form',
    'prompt-input',
    'run-mode',
    'send-button',
    'run-inspector',
    'run-inspector-content',
    'stop-run',
    'pause-run',
    'change-run-model',
    'run-budget-controls',
    'run-budget-fields',
    'apply-run-budgets',
    'run-budget-status',
    'send-direction',
    'model-picker',
    'approval-region',
    'status-banner',
    'search-form',
    'workspace-search',
    'sidebar-search-results',
    'semantic-search-toggle',
    'settings-button',
    'primary-tabs',
    'mode-workspace',
    'settings-view',
    'active-mode-label',
    'discover-models-button',
    'settings-discover-models',
    'local-model-results',
    'configured-models-list',
    'advanced-settings-button',
    'settings-dialog',
    'settings-content',
    'close-settings',
    'toast',
    'process-dialog',
    'process-content',
    'refresh-processes',
    'close-processes',
    'workspace-dialog',
    'workspace-content',
    'refresh-workspace',
    'close-workspace',
  ].map((id) => [id.replaceAll('-', '_'), document.getElementById(id)]),
);

const workspacePanel = mountWorkspacePanel({
  client,
  dialog: elements.workspace_dialog,
  content: elements.workspace_content,
  refreshButton: elements.refresh_workspace,
  closeButton: elements.close_workspace,
  onError: showToast,
});

let activeSessionId = null;
let activeRunId = null;
let runController = null;
let activeRunPaused = false;
let activeRunPauseRequested = false;
let activeRunModel = null;
let activeRunMode = 'agent';
let activeRunHasImages = false;
let activeRunAutomaticModelSelection = false;
let runModelChangePending = false;
let runBudgetChangePending = false;
let activeRunInitialBudgets = {};
let activeRunBudgets = {};
let activeRunBudgetAdjustmentsEnabled = false;
let toastTimer = null;
let sessionsById = new Map();
let modelProfiles = {};
let localModelChoices = [];
let localDiscoveryServers = [];
let selectedPrimaryTab = 'agent';
let localDiscoveryCompleted = false;
let attachedImageFiles = [];
let mcpServerCatalog = [];
let mcpServerSelection = null;
let runtimeSettings = {};
let appUpdateCheckedThisSession = false;
let currentRoutingDecision = null;
let usageSnapshot = null;
const MAX_IMAGE_FILES = 4;
const MAX_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024;
const RUN_BUDGET_FIELDS = [
  { key: 'max_turns', label: 'Model turns', integer: true },
  { key: 'max_input_tokens', label: 'Run input tokens', integer: true },
  { key: 'max_output_tokens', label: 'Run output tokens', integer: true },
  { key: 'max_tool_output_bytes', label: 'Tool output bytes', integer: true },
  { key: 'max_session_input_tokens', label: 'Session input tokens', integer: true },
  { key: 'max_session_output_tokens', label: 'Session output tokens', integer: true },
  { key: 'recovery_summary_input_tokens', label: 'Recovery input tokens', integer: true, zero: true },
  { key: 'final_response_reserve_tokens', label: 'Final response reserve', integer: true },
  { key: 'max_session_cost', label: 'Session cost (USD)', integer: false },
  { key: 'max_daily_input_tokens', label: 'Daily input tokens', integer: true },
  { key: 'max_daily_output_tokens', label: 'Daily output tokens', integer: true },
  { key: 'max_monthly_input_tokens', label: 'Monthly input tokens', integer: true },
  { key: 'max_monthly_output_tokens', label: 'Monthly output tokens', integer: true },
  { key: 'max_daily_cost', label: 'Daily cost (USD)', integer: false },
  { key: 'max_monthly_cost', label: 'Monthly cost (USD)', integer: false },
];

function setConnected(connected) {
  document.documentElement.dataset.xystStartupReported = 'true';
  elements.connection_indicator.className = `connection-dot${connected ? ' ready' : ' error'}`;
  elements.connection_indicator.title = connected ? 'Connected to local runtime' : 'Runtime unavailable';
  elements.connection_indicator.setAttribute('aria-label', elements.connection_indicator.title);
  elements.workspace_status.textContent = connected ? 'Local · connected' : 'Local · unavailable';
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 3600);
}

function selectPrimaryTab(tab) {
  const validModes = ['agent', 'plan', 'review'];
  const mode = validModes.includes(tab) ? tab : null;
  selectedPrimaryTab = mode || 'settings';
  for (const button of elements.primary_tabs.querySelectorAll('[role="tab"]')) {
    const selected = button.dataset.mode === selectedPrimaryTab || (!button.dataset.mode && selectedPrimaryTab === 'settings');
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  elements.mode_workspace.hidden = !mode;
  elements.settings_view.hidden = Boolean(mode);
  if (mode) {
    elements.run_mode.value = mode;
    elements.active_mode_label.textContent =
      mode === 'plan' ? 'Plan mode · read only' : mode === 'review' ? 'Review mode · read only' : 'Agent mode';
    elements.mode_workspace.setAttribute('aria-labelledby', `tab-${mode}`);
  } else {
    void renderSettingsOverview();
  }
}

function renderConfiguredModelProfiles() {
  const entries = Object.entries(modelProfiles);
  elements.configured_models_list.replaceChildren();
  if (!entries.length) {
    elements.configured_models_list.append(
      node('p', 'muted-copy', 'No profiles are configured yet. Find a local model below or add a provider in All runtime settings.'),
    );
    return;
  }
  for (const [name, profile] of entries) {
    const row = node('div', 'configured-model-row');
    const info = node('div', 'configured-model-info');
    const isDefault = runtimeSettings.default_model === name;
    info.append(
      node('strong', '', name),
      node('span', '', `${profile.model || 'Model ID not set'} · ${profile.provider || 'provider'}${profile.local ? ' · local' : ''}`),
    );
    const action = node('button', isDefault ? 'model-default-badge' : 'model-select-button', isDefault ? 'Default' : 'Use model');
    action.type = 'button';
    action.disabled = isDefault;
    action.addEventListener('click', async () => {
      try {
        const result = await client.updateSettings({ default_model: name });
        runtimeSettings = result.settings;
        const option = [...elements.model_picker.options].find((item) => item.value === name);
        if (option && elements.model_picker.value !== AUTO_MODEL_OPTION) elements.model_picker.value = name;
        renderConfiguredModelProfiles();
        showToast(`${name} is now the default model.`);
      } catch (error) {
        showError(error);
      }
    });
    row.append(info, action);
    elements.configured_models_list.append(row);
  }
}

function renderLocalModelDiscovery(result) {
  localDiscoveryServers = Array.isArray(result.servers) ? result.servers : [];
  localModelChoices = localDiscoveryServers.flatMap((server) =>
    server.models.filter((model) => typeof model === 'string' && model.trim() && model.length <= 200).map((model) => ({ server, model })),
  );
  const list = elements.local_model_results;
  list.replaceChildren();
  if (!localModelChoices.length) {
    list.append(
      node(
        'p',
        'muted-copy',
        'No local models found. Start the LM Studio server or another local OpenAI-compatible server, then try again.',
      ),
    );
  } else {
    for (const [index, choice] of localModelChoices.entries()) {
      const row = node('div', 'local-model-row');
      const details = node('div', 'local-model-info');
      const existing = findDiscoveredProfile(choice.server, choice.model);
      const exists = Boolean(existing);
      const contextLength = choice.server.model_context_lengths?.[choice.model];
      const modelState = choice.server.model_states?.[choice.model];
      const capabilities = choice.server.model_capabilities?.[choice.model];
      const needsLoad = modelState === 'not_loaded';
      const hasValidContextLength = Number.isSafeInteger(contextLength) && contextLength > 0 && contextLength <= 10_000_000;
      const contextNeedsSync = exists && hasValidContextLength && existing[1].context_length !== contextLength;
      const modelStateLabel = modelState === 'loaded' ? 'Loaded in LM Studio' : needsLoad ? 'Installed · not loaded' : '';
      const capabilityLabels = [
        capabilities?.supports_tools === true ? 'tool use' : capabilities?.supports_tools === false ? 'not tool-tuned' : null,
        capabilities?.supports_vision === true ? 'vision' : capabilities?.supports_vision === false ? 'text only' : null,
      ].filter(Boolean);
      const modelDetails = [
        choice.server.name,
        new URL(choice.server.base_url).host,
        modelStateLabel,
        hasValidContextLength ? `${contextLength.toLocaleString()} context` : null,
        ...capabilityLabels,
        exists ? 'already configured' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      details.append(node('strong', '', choice.model), node('span', '', modelDetails));
      const button = node(
        'button',
        exists && !contextNeedsSync && !needsLoad ? 'model-default-badge' : 'model-select-button',
        needsLoad ? (exists ? 'Load model' : 'Load & use') : contextNeedsSync ? 'Sync context' : exists ? 'Added' : 'Add model',
      );
      button.type = 'button';
      button.disabled = exists && !contextNeedsSync && !needsLoad;
      if (contextNeedsSync)
        button.setAttribute('aria-label', `Set ${choice.model} context length to ${contextLength.toLocaleString()} tokens`);
      button.addEventListener(
        'click',
        () =>
          void (contextNeedsSync
            ? syncDiscoveredProfileContext(index)
            : needsLoad
              ? loadAndConnectDiscoveredModel(index, button)
              : connectDiscoveredModel(index)),
      );
      row.append(details, button);
      list.append(row);
    }
  }
  appendLocalModelPickerOptions();
}

function appendLocalModelPickerOptions() {
  elements.model_picker.querySelector('optgroup[data-local-discovery]')?.remove();
  if (!localModelChoices.length) return;
  const group = node('optgroup', '', 'Local server models · choose to add');
  group.dataset.localDiscovery = 'true';
  for (const [index, choice] of localModelChoices.entries()) {
    const option = node('option', '', `${choice.model} · ${choice.server.name}`);
    option.value = `local-discovery:${index}`;
    group.append(option);
  }
  elements.model_picker.append(group);
}

async function refreshLocalModels({ quiet = false, preservePreviousOnEmpty = false } = {}) {
  const buttons = [elements.discover_models_button, elements.settings_discover_models];
  for (const button of buttons) {
    button.disabled = true;
    button.dataset.loading = 'true';
  }
  if (!quiet) elements.local_model_results.replaceChildren(node('p', 'muted-copy', 'Checking LM Studio and other local model servers…'));
  try {
    const result = await client.discoverLocalModels();
    localDiscoveryCompleted = true;
    if (preservePreviousOnEmpty && !result.servers?.length && localDiscoveryServers.length) {
      renderLocalModelDiscovery({ servers: localDiscoveryServers });
      return;
    }
    renderLocalModelDiscovery(result);
    if (!quiet)
      showToast(
        localModelChoices.length
          ? `Found ${localModelChoices.length} local model${localModelChoices.length === 1 ? '' : 's'}.`
          : 'No local models found.',
      );
  } catch (error) {
    if (preservePreviousOnEmpty && localDiscoveryServers.length) renderLocalModelDiscovery({ servers: localDiscoveryServers });
    if (!quiet) {
      elements.local_model_results.replaceChildren(node('p', 'run-error', `Local model discovery failed: ${error.message}`));
      showToast(`Local model discovery failed: ${error.message}`);
    }
  } finally {
    for (const button of buttons) {
      button.disabled = false;
      delete button.dataset.loading;
    }
  }
}

async function connectDiscoveredModel(indexOrChoice) {
  const choice = typeof indexOrChoice === 'number' ? localModelChoices[indexOrChoice] : indexOrChoice;
  if (!choice) return;
  try {
    const existing = findDiscoveredProfile(choice.server, choice.model);
    const { name, profile } = existing
      ? { name: existing[0], profile: existing[1] }
      : localProfileFromDiscovery(choice.server, choice.model, modelProfiles);
    const result = await client.updateSettings({ ...(existing ? {} : { models: { [name]: profile } }), default_model: name });
    runtimeSettings = result.settings;
    modelProfiles = runtimeSettings.models || { ...modelProfiles, [name]: profile };
    await initialize();
    ensureModelPickerOption(name);
    elements.model_picker.value = name;
    renderConfiguredModelProfiles();
    renderLocalModelDiscovery({ servers: localDiscoveryServers });
    showToast(`Connected ${choice.model} from ${choice.server.name}.`);
  } catch (error) {
    showError(error);
  }
}

async function loadAndConnectDiscoveredModel(index, button = null) {
  const choice = localModelChoices[index];
  if (!choice) return;
  const alreadyConfigured = Boolean(findDiscoveredProfile(choice.server, choice.model));
  if (button) {
    button.disabled = true;
    button.textContent = 'Loading…';
    button.setAttribute('aria-busy', 'true');
  }
  try {
    const loadResult = await client.loadLocalModel(choice.model);
    markDiscoveredModelLoaded(choice, loadResult);
    await refreshLocalModels({ quiet: true, preservePreviousOnEmpty: true });
    const connectedChoice = postLoadModelChoice(choice, localModelChoices, alreadyConfigured);
    if (!connectedChoice) {
      showToast(`Loaded ${choice.model} in ${choice.server.name}.`);
      return;
    }
    await connectDiscoveredModel(connectedChoice);
  } catch (error) {
    showError(error);
    await refreshLocalModels({ quiet: true }).catch(() => {});
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }
}

async function syncDiscoveredProfileContext(index) {
  const choice = localModelChoices[index];
  if (!choice) return;
  const existing = findDiscoveredProfile(choice.server, choice.model);
  const contextLength = choice.server.model_context_lengths?.[choice.model];
  if (!existing || !Number.isSafeInteger(contextLength) || contextLength < 1 || contextLength > 10_000_000) return;
  try {
    const [name] = existing;
    const result = await client.updateSettings({ models: { [name]: { context_length: contextLength } } });
    runtimeSettings = result.settings;
    modelProfiles = runtimeSettings.models || modelProfiles;
    renderConfiguredModelProfiles();
    renderLocalModelDiscovery({ servers: localDiscoveryServers });
    showToast(`Updated ${name} to the active ${contextLength.toLocaleString()}-token LM Studio context.`);
  } catch (error) {
    showError(error);
  }
}

function findDiscoveredProfile(server, modelId) {
  return Object.entries(modelProfiles).find(([, profile]) => {
    try {
      return new URL(profile.base_url).toString().replace(/\/$/, '') === server.base_url && profile.model === modelId;
    } catch {
      return false;
    }
  });
}

async function renderSettingsOverview() {
  if (!runtimeSettings || !elements.settings_view) return;
  renderConfiguredModelProfiles();
}

function ensureModelPickerOption(profile) {
  if (typeof profile !== 'string' || !profile || [...elements.model_picker.options].some((option) => option.value === profile)) return;
  const configuredModel = modelProfiles[profile]?.model || 'configured';
  const option = node('option', '', `${profile} · ${configuredModel}`);
  option.value = profile;
  elements.model_picker.append(option);
}

function renderRunModelControl() {
  const visible = Boolean(activeRunId && activeRunPaused);
  elements.change_run_model.hidden = !visible;
  elements.change_run_model.disabled =
    !visible ||
    runModelChangePending ||
    !elements.model_picker.value ||
    elements.model_picker.value === AUTO_MODEL_OPTION ||
    elements.model_picker.value === activeRunModel;
  elements.change_run_model.title = runModelChangePending
    ? 'A model change is queued and will apply when the run resumes.'
    : 'Apply the selected model at the next safe model-turn boundary.';
}

function renderRunBudgetFields() {
  elements.run_budget_fields.replaceChildren();
  for (const field of RUN_BUDGET_FIELDS) {
    const label = node('label', 'run-budget-field', field.label);
    const input = node('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.min = field.zero ? '0' : '1';
    input.max = '1000000000';
    input.step = field.integer ? '1' : 'any';
    input.dataset.budgetField = field.key;
    input.setAttribute('aria-label', field.label);
    if (Object.hasOwn(activeRunBudgets, field.key)) input.value = String(activeRunBudgets[field.key]);
    label.append(input);
    elements.run_budget_fields.append(label);
  }
}

function renderRunBudgetControl() {
  const visible = Boolean(activeRunId && activeRunPaused && activeRunBudgetAdjustmentsEnabled);
  elements.run_budget_controls.hidden = !visible;
  if (!visible) return;
  const disabled = runBudgetChangePending;
  for (const input of elements.run_budget_fields.querySelectorAll('input')) input.disabled = disabled;
  elements.apply_run_budgets.disabled = disabled;
  elements.apply_run_budgets.textContent = disabled ? 'Budget change queued' : 'Apply budget changes';
}

async function refreshRunBudgetControl() {
  if (!activeRunId) return;
  try {
    const state = await client.getRun(activeRunId);
    activeRunInitialBudgets = state.initial_budgets || {};
    activeRunBudgets = state.budgets || {};
    activeRunBudgetAdjustmentsEnabled = state.budget_adjustments_enabled === true;
    renderRunBudgetFields();
    renderRunBudgetControl();
  } catch (error) {
    showToast(`Could not load active-run budgets: ${error.message}`);
  }
}

async function applyRunBudgetChanges() {
  if (!activeRunId || !activeRunPaused || runBudgetChangePending) return;
  const changes = {};
  for (const field of RUN_BUDGET_FIELDS) {
    const input = elements.run_budget_fields.querySelector(`[data-budget-field="${field.key}"]`);
    const raw = input?.value.trim() || '';
    const current = activeRunBudgets[field.key];
    const initial = activeRunInitialBudgets[field.key];
    if (!raw) {
      if (!Object.is(current, initial) && (current !== undefined || initial !== undefined)) changes[field.key] = null;
      continue;
    }
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      (field.integer && !Number.isSafeInteger(value)) ||
      value < (field.zero ? 0 : 1) ||
      value > 1_000_000_000
    ) {
      input?.focus();
      showToast(`${field.label} must be a valid${field.integer ? ' integer' : ''} budget value.`);
      return;
    }
    if (!Object.is(value, current)) changes[field.key] = value;
  }
  if (!Object.keys(changes).length) {
    showToast('No budget changes to apply.');
    return;
  }
  elements.run_budget_status.textContent = '';
  try {
    const result = await client.changeRunBudgets(activeRunId, changes);
    runBudgetChangePending = true;
    elements.run_budget_status.textContent = 'Queued; resume the run to apply.';
    renderRunBudgetControl();
    showToast(`Budget changes queued for ${Object.keys(changes).length} setting(s).`);
    if (result.budgets) activeRunBudgets = result.budgets;
  } catch (error) {
    showToast(error.message);
  }
}

function showError(error) {
  const message =
    error instanceof ControlApiError || error?.name === 'TimeoutError'
      ? error.message
      : 'The local runtime could not complete that request.';
  elements.status_banner.textContent = message;
  elements.status_banner.hidden = false;
  setConnected(false);
}

function clearError() {
  elements.status_banner.hidden = true;
}

function applyUiPreferences(preferences = runtimeSettings.ui) {
  const collapsed = preferences?.sidebar_collapsed === true;
  const theme = ['dark', 'light'].includes(preferences?.theme) ? preferences.theme : 'system';
  elements.app_frame.classList.toggle('sidebar-collapsed', collapsed);
  document.documentElement.dataset.theme = theme;
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.querySelector('meta[name="theme-color"]').content =
    theme === 'dark' || (theme === 'system' && systemDark) ? '#070b1b' : '#f2f6ff';
  elements.toggle_sidebar.title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
  elements.toggle_sidebar.setAttribute('aria-label', elements.toggle_sidebar.title);
  elements.toggle_sidebar.setAttribute('aria-expanded', String(!collapsed));
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!['dark', 'light'].includes(runtimeSettings.ui?.theme)) applyUiPreferences(runtimeSettings.ui);
});

async function toggleSidebar() {
  const collapsed = !elements.app_frame.classList.contains('sidebar-collapsed');
  elements.toggle_sidebar.disabled = true;
  try {
    const result = await client.updateSettings({ ui: { sidebar_collapsed: collapsed } });
    runtimeSettings = result.settings;
    applyUiPreferences(runtimeSettings.ui);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.toggle_sidebar.disabled = false;
  }
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function resetTimeline() {
  elements.timeline.replaceChildren(elements.welcome);
  elements.welcome.hidden = false;
  elements.approval_region.replaceChildren();
}

function addMessage(role, content = '') {
  elements.welcome.hidden = true;
  const message = node('article', `message ${role}`);
  message.dataset.role = role;
  const meta = node('div', 'message-meta', role === 'user' ? 'YOU' : 'XYST');
  const body = node('div', 'message-body', content);
  message.append(meta, body);
  elements.timeline.append(message);
  message.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return body;
}

function appendActivity(text, status = 'working') {
  const activity = node('div', 'tool-activity', text);
  activity.dataset.status = status;
  elements.timeline.append(activity);
  activity.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  return activity;
}

function appendToolDetail(tool, args, { status = 'proposed', result } = {}) {
  const detail = node('details', 'tool-detail');
  detail.dataset.status = status;
  const summary = node('summary', '', `${tool} · ${status}`);
  const body = node('pre', 'tool-detail-body', formatToolDetail(result === undefined ? args : result));
  detail.append(summary, body);
  elements.timeline.append(detail);
  return detail;
}

function renderStoredToolMessage(message) {
  const observation = parseStoredToolObservation(message.content);
  if (observation) {
    appendToolDetail(
      observation.name,
      { tool_call_id: observation.tool_call_id, trust: observation.trust },
      { status: 'result', result: observation.content },
    );
    return;
  }
  appendToolDetail('Tool result', {}, { status: 'result', result: message.content });
}

function renderSessions(sessions) {
  sessionsById = new Map(sessions.map((session) => [session.id, session]));
  elements.session_list.replaceChildren();
  if (!sessions.length) {
    elements.session_list.append(node('p', 'empty-sessions', 'Your conversations will appear here.'));
    return;
  }
  for (const session of sessions) {
    const title = session.title || 'New conversation';
    const item = node('div', `session-item${session.id === activeSessionId ? ' active' : ''}`);
    item.dataset.sessionId = session.id;
    const openButton = node('button', 'session-open-button');
    openButton.type = 'button';
    const model = session.model || 'Automatic model';
    const running = Boolean(
      session.run_active === true || (session.run_active === undefined && session.id === activeSessionId && runController),
    );
    const interrupted = isInterruptedSession(session, { running });
    const status = running
      ? 'Running'
      : interrupted
        ? 'Interrupted'
        : session.status === 'archived'
          ? 'Archived'
          : session.status === 'failed'
            ? 'Failed'
            : 'Ready';
    const mode = session.mode && session.mode !== 'agent' ? ` · ${session.mode}` : '';
    const worktree = session.has_worktree ? ' · Worktree' : '';
    openButton.title = `${title} · ${status} · ${model}${mode}${worktree} · ${session.message_count} messages`;
    openButton.setAttribute('aria-label', `Open conversation ${title}`);
    const icon = node('span', 'session-icon', running ? '◌' : session.status === 'failed' || interrupted ? '!' : '◦');
    icon.setAttribute('aria-hidden', 'true');
    const copy = node('span', 'session-copy');
    copy.append(node('span', 'session-title', title));
    copy.append(node('span', 'session-detail', `${status} · ${model}${mode}${worktree}`));
    openButton.append(icon, copy);
    openButton.addEventListener('click', () => {
      if (runController) showToast('Wait for the current run to finish before switching conversations.');
      else void openSession(session.id);
    });
    const deleteButton = node('button', 'session-delete-button', '×');
    deleteButton.type = 'button';
    deleteButton.setAttribute('aria-label', `Delete conversation ${title}`);
    deleteButton.title = runController ? 'Stop the active run before deleting this conversation.' : `Delete “${title}”`;
    deleteButton.disabled = Boolean(runController);
    deleteButton.addEventListener('click', () => {
      if (deleteButton.disabled) return;
      if (!window.confirm(`Delete “${title}” and its saved transcript? This cannot be undone.`)) return;
      void (async () => {
        try {
          await client.deleteSession(session.id);
          if (session.id === activeSessionId) {
            activeSessionId = null;
            elements.session_actions.hidden = true;
            elements.conversation_title.textContent = 'New conversation';
            resetTimeline();
          }
          await refreshSessions();
          showToast(`Deleted “${title}”.`);
        } catch (error) {
          showError(error);
        }
      })();
    });
    item.append(openButton, deleteButton);
    elements.session_list.append(item);
  }
}

function renderRunInspector() {
  const content = elements.run_inspector_content;
  if (!content) return;
  const decision = routingSummary(currentRoutingDecision, modelProfiles);
  const fragment = document.createDocumentFragment();
  if (decision) {
    const selected = node('div', 'inspector-selected');
    selected.append(node('strong', '', `${decision.profile} · ${decision.locality}`));
    if (decision.model || decision.provider)
      selected.append(node('span', '', [decision.model, decision.provider].filter(Boolean).join(' · ')));
    fragment.append(selected, node('p', 'inspector-reason', decision.reason));
    const factors = decision.factors;
    const required = [
      `Context ≥ ${Number(factors.required_context_tokens || 0).toLocaleString()} tokens`,
      factors.required_tools ? 'Tool calling required' : '',
      factors.required_vision ? 'Vision required' : '',
      factors.prefer_local === true ? 'Prefers local' : '',
      factors.strategy ? `Strategy: ${factors.strategy}` : '',
      factors.pricing_data_status ? `Price data: ${factors.pricing_data_status}` : '',
    ].filter(Boolean);
    if (required.length) fragment.append(node('p', 'inspector-factors', required.join(' · ')));
    if (decision.alternatives.length) {
      const list = node('ul', 'inspector-alternatives');
      for (const item of decision.alternatives)
        list.append(
          node(
            'li',
            item.eligible ? '' : 'ineligible',
            `${item.name}${item.reason ? ` · ${item.reason}` : item.eligible ? ' · eligible' : ' · unavailable'}`,
          ),
        );
      const group = node('details', 'inspector-alternative-list');
      group.append(node('summary', '', `Alternatives (${decision.alternatives.length})`), list);
      fragment.append(group);
    }
  } else fragment.append(node('p', 'muted-copy', 'Routing details appear when a run starts.'));

  const budgets = budgetRemainingRows(runtimeSettings, usageSnapshot);
  const budgetGroup = node('div', 'inspector-budgets');
  budgetGroup.append(node('h3', '', 'Remaining shared budget'));
  if (runtimeSettings.tools?.autonomy === 'unrestricted')
    budgetGroup.append(
      node(
        'p',
        'muted-copy',
        'Configured token and cost caps do not limit unrestricted runs. Provider context, output, and billing limits still apply.',
      ),
    );
  else if (!usageSnapshot) budgetGroup.append(node('p', 'muted-copy', 'Usage is unavailable; remaining budget cannot be calculated.'));
  else if (!budgets.length) budgetGroup.append(node('p', 'muted-copy', 'No daily or monthly token/cost caps are configured.'));
  else
    for (const row of budgets) {
      const value =
        row.unit === 'USD'
          ? `$${row.remaining.toFixed(row.decimals)} of $${row.limit.toFixed(row.decimals)} remaining${row.used ? ` · $${row.used.toFixed(row.decimals)} used or reserved` : ''}`
          : `${Math.floor(row.remaining).toLocaleString()} of ${Math.floor(row.limit).toLocaleString()} remaining${row.used ? ` · ${Math.floor(row.used).toLocaleString()} used or reserved` : ''}`;
      budgetGroup.append(node('div', 'inspector-budget-row', `${row.period} · ${row.label} · ${value}`));
    }
  fragment.append(budgetGroup);
  content.replaceChildren(fragment);
}

async function refreshSessions(options) {
  const sessions = await client.listSessions(options);
  renderSessions(sessions);
}

function renderMcpRunSelection() {
  const selection = Array.isArray(mcpServerSelection) ? new Set(mcpServerSelection) : null;
  elements.mcp_selection.hidden = mcpServerCatalog.length === 0;
  elements.mcp_selection_summary.textContent =
    selection === null
      ? 'MCP tools · all configured servers'
      : selection.size === 0
        ? 'MCP tools · none selected'
        : `MCP tools · ${selection.size} selected`;
  const options = mcpServerCatalog.map((server) => {
    const label = node('label', 'mcp-selection-option');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selection === null || selection.has(server.name);
    checkbox.disabled = Boolean(runController) || activeRunId !== null;
    checkbox.setAttribute('aria-label', `Use MCP server ${server.name} (${server.connection_state})`);
    checkbox.addEventListener('change', () => {
      const next = selection || new Set(mcpServerCatalog.map((item) => item.name));
      if (checkbox.checked) next.add(server.name);
      else next.delete(server.name);
      mcpServerSelection = [...next].sort();
      renderMcpRunSelection();
    });
    label.append(checkbox, node('span', '', `${server.name} · ${server.connection_state}`));
    return label;
  });
  elements.mcp_selection_options.replaceChildren(
    ...options,
    ...(mcpServerSelection === null
      ? []
      : [
          (() => {
            const reset = node('button', 'text-button', 'Use all configured servers');
            reset.type = 'button';
            reset.disabled = Boolean(runController) || activeRunId !== null;
            reset.addEventListener('click', () => {
              mcpServerSelection = null;
              renderMcpRunSelection();
            });
            return reset;
          })(),
        ]),
  );
}

async function openSession(id) {
  clearError();
  try {
    const session = await client.getSession(id);
    activeSessionId = session.id;
    const configuredMcpServers = new Set(mcpServerCatalog.map((server) => server.name));
    mcpServerSelection = Array.isArray(session.mcp_servers) ? session.mcp_servers.filter((name) => configuredMcpServers.has(name)) : null;
    renderMcpRunSelection();
    currentRoutingDecision = session.routing_decision || null;
    renderRunInspector();
    elements.session_actions.hidden = false;
    for (const button of elements.session_actions.querySelectorAll('button')) button.disabled = Boolean(activeRunId);
    elements.conversation_title.textContent = session.title || 'Conversation';
    elements.run_mode.value = ['agent', 'plan', 'review'].includes(session.mode) ? session.mode : 'agent';
    selectPrimaryTab(elements.run_mode.value);
    elements.timeline.replaceChildren();
    elements.approval_region.replaceChildren();
    elements.welcome.hidden = true;
    for (const message of session.messages || []) {
      if (message.role === 'tool') {
        renderStoredToolMessage(message);
        continue;
      }
      if (!['user', 'assistant'].includes(message.role)) continue;
      if (message.content) {
        const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content, null, 2);
        const attachmentNote = message.image_attachments?.length
          ? `\n[${message.image_attachments.length} image(s) attached; image data is not stored in this transcript]`
          : '';
        addMessage(message.role, `${content}${attachmentNote}`);
      }
      for (const call of message.tool_calls || []) {
        const name = call.function?.name || 'Tool';
        appendToolDetail(name, parseStoredToolArguments(call), { status: 'proposed' });
      }
    }
    if (session.status === 'failed' && session.failure) {
      appendActivity(formatRunFailure(session.failure), 'error');
    }
    if (isInterruptedSession(session, { running: session.run_active === true }))
      appendActivity('This conversation has an unfinished turn and is not currently running. Send a message to continue.', 'error');
    renderSavedPlan(session.plan, session.id);
    renderSavedFindings(session.review_findings, session.worktree_path || null);
    renderSessions([...sessionsById.values()]);
    elements.timeline.scrollTop = elements.timeline.scrollHeight;
  } catch (error) {
    showError(error);
  }
}

function renderSavedPlan(plan, sessionId) {
  if (typeof plan !== 'string' || !plan.trim()) return;
  const card = node('section', 'saved-plan-card');
  card.append(node('h2', '', 'Saved implementation plan'));
  const editor = node('div', 'plan-step-editor');
  let steps;
  try {
    steps = planStepsFromText(plan);
  } catch (error) {
    card.append(node('p', 'muted-copy', error.message));
    elements.timeline.append(card);
    return card;
  }
  const save = node('button', 'text-button', 'Save plan');
  save.type = 'button';
  save.disabled = true;
  const add = node('button', 'text-button', 'Add step');
  add.type = 'button';
  const clear = node('button', 'text-button', 'Clear plan');
  clear.type = 'button';
  clear.disabled = Boolean(activeRunId);
  const markDirty = () => {
    save.disabled = Boolean(activeRunId);
    implement.disabled = true;
  };
  const renderSteps = () => {
    editor.replaceChildren();
    steps.forEach((step, index) => {
      const row = node('div', 'plan-step-row');
      const field = node('textarea', 'plan-step-text');
      field.value = step;
      field.rows = Math.max(2, Math.min(8, step.split('\n').length + 1));
      field.setAttribute('aria-label', `Plan step ${index + 1}`);
      field.addEventListener('input', () => {
        steps[index] = field.value;
        markDirty();
      });
      row.append(field);
      const controls = node('div', 'plan-step-controls');
      const moveUp = node('button', 'text-button', 'Move up');
      moveUp.type = 'button';
      moveUp.disabled = index === 0 || Boolean(activeRunId);
      moveUp.setAttribute('aria-label', `Move plan step ${index + 1} up`);
      moveUp.addEventListener('click', () => {
        [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]];
        markDirty();
        renderSteps();
      });
      const moveDown = node('button', 'text-button', 'Move down');
      moveDown.type = 'button';
      moveDown.disabled = index === steps.length - 1 || Boolean(activeRunId);
      moveDown.setAttribute('aria-label', `Move plan step ${index + 1} down`);
      moveDown.addEventListener('click', () => {
        [steps[index], steps[index + 1]] = [steps[index + 1], steps[index]];
        markDirty();
        renderSteps();
      });
      const remove = node('button', 'text-button', 'Remove');
      remove.type = 'button';
      remove.disabled = Boolean(activeRunId);
      remove.setAttribute('aria-label', `Remove plan step ${index + 1}`);
      remove.addEventListener('click', () => {
        steps.splice(index, 1);
        markDirty();
        renderSteps();
      });
      controls.append(moveUp, moveDown, remove);
      row.append(controls);
      editor.append(row);
    });
  };
  const implement = node('button', 'send-button', 'Implement this plan');
  implement.type = 'button';
  implement.disabled = plan.length > MAX_PLAN_IMPLEMENTATION_CHARACTERS || Boolean(activeRunId);
  add.disabled = steps.length >= MAX_PLAN_STEPS || Boolean(activeRunId);
  add.addEventListener('click', () => {
    if (steps.length >= MAX_PLAN_STEPS) return;
    steps.push('');
    markDirty();
    renderSteps();
  });
  renderSteps();
  save.addEventListener('click', async () => {
    try {
      const updated = planTextFromSteps(steps);
      await client.updateSessionPlan(sessionId, updated);
      card.replaceWith(renderSavedPlan(updated, sessionId));
      showToast('Plan saved. Choose Implement when you are ready to start work.');
    } catch (error) {
      showError(error);
    }
  });
  clear.addEventListener('click', async () => {
    if (!window.confirm('Clear the saved plan from this session?')) return;
    try {
      await client.updateSessionPlan(sessionId, null);
      card.remove();
      showToast('Saved plan cleared.');
    } catch (error) {
      showError(error);
    }
  });
  card.append(editor, add, save, clear);
  if (plan.length > MAX_PLAN_PREVIEW_CHARACTERS)
    card.append(node('p', 'muted-copy', `Plan exceeds the ${MAX_PLAN_PREVIEW_CHARACTERS.toLocaleString()} character preview threshold.`));
  if (implement.disabled)
    card.append(
      node(
        'p',
        'muted-copy',
        `This plan exceeds the ${MAX_PLAN_IMPLEMENTATION_CHARACTERS.toLocaleString()} character implementation limit. You can still review and copy it.`,
      ),
    );
  implement.addEventListener('click', () => {
    try {
      elements.run_mode.value = 'agent';
      void submitPrompt(planImplementationPrompt(plan));
    } catch (error) {
      showToast(error.message);
    }
  });
  card.append(
    implement,
    node(
      'p',
      'muted-copy',
      'Starting implementation creates a new Agent-mode turn in this conversation. File and process actions still use the configured approval policy.',
    ),
  );
  elements.timeline.append(card);
}

function renderSavedFindings(findings, worktreePath = null) {
  const safeFindings = reviewFindingsForDisplay(findings);
  if (!safeFindings.length) return;
  const section = node('section', 'saved-findings');
  section.append(node('h2', '', `Review findings · ${safeFindings.length}`));
  const list = node('ol', 'finding-list');
  for (const [index, finding] of safeFindings.entries()) {
    const item = node('li', `finding finding-${finding.severity}`);
    const heading = node('div', 'finding-heading');
    heading.append(
      node('strong', '', finding.severity.toUpperCase()),
      node('code', '', `${finding.file}${finding.line === null ? '' : `:${finding.line}`}`),
    );
    item.append(heading, node('p', '', finding.description), node('details', 'finding-evidence'));
    const evidence = item.querySelector('details');
    evidence.append(node('summary', '', 'Evidence'), node('pre', '', finding.evidence));
    const open = node('button', 'text-button', 'Open finding location');
    open.type = 'button';
    open.addEventListener('click', () => {
      void workspacePanel.openFileAt(finding.file, finding.line, worktreePath).catch(showToast);
    });
    const ask = node('button', 'text-button', 'Ask about this finding');
    ask.type = 'button';
    ask.addEventListener('click', () => {
      elements.prompt_input.value = `Investigate this review finding and explain whether it is valid. Do not change files unless I request implementation.\n\nFinding ${index + 1} (${finding.severity}) at ${finding.file}${finding.line === null ? '' : `:${finding.line}`}\n${finding.description}\n\nEvidence:\n${finding.evidence}`;
      elements.prompt_input.focus();
      elements.prompt_input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    item.append(open, ask);
    list.append(item);
  }
  section.append(list);
  elements.timeline.append(section);
}

function createApproval(event) {
  const data = event.data;
  const card = node('article', 'approval-card');
  card.dataset.approvalId = data.approval_id;
  const heading = node('div', 'approval-title');
  heading.append(node('span', '', '!'), document.createTextNode('Review this action'));
  const summary = node('p', 'approval-summary', data.summary || `Xyst AI Assistant wants to run ${data.tool}.`);
  const change = data.file_change;
  const details = node(
    'pre',
    'approval-details',
    change
      ? JSON.stringify(
          { tool: data.tool, path: change.path, operation: change.operation, old_bytes: change.old_bytes, new_bytes: change.new_bytes },
          null,
          2,
        )
      : JSON.stringify({ tool: data.tool, arguments: data.arguments }, null, 2),
  );
  const preview =
    change?.selection_available && change.hunks?.length ? renderFileHunkSelection(change) : change ? renderFileChangeDiff(change) : null;
  const actions = node('div', 'approval-actions');
  const grantOptions = data.grant_options?.scopes || ['once'];
  const choices = [
    ['once', 'Approve once', 'approve-once'],
    ['session_exact_action', 'Allow this action in session', ''],
  ];
  if (grantOptions.includes('exact_path_1h')) choices.push(['exact_path_1h', 'Allow this path for 1 hour', '']);
  if (grantOptions.includes('exact_command_1h')) choices.push(['exact_command_1h', 'Allow this command for 1 hour', '']);
  for (const [scope, label, className] of choices) {
    if (scope !== 'once' && !grantOptions.includes(scope)) continue;
    const button = node('button', className, label);
    button.type = 'button';
    button.dataset.grantScope = scope;
    button.addEventListener('click', () => void answerApproval(data.approval_id, true, scope, card));
    actions.append(button);
  }
  const deny = node('button', 'deny-action', 'Deny');
  deny.type = 'button';
  deny.addEventListener('click', () => void answerApproval(data.approval_id, false, 'once', card));
  actions.append(deny);
  const expiry = node('div', 'approval-expiry', `Expires in ${Math.ceil((data.expires_in_ms || 300000) / 60000)} min · ${data.tool}`);
  card.append(heading, summary, details);
  if (preview) card.append(preview);
  card.append(actions, expiry);
  if (change?.selection_available && change.hunks?.length) {
    card.dataset.hunkSelection = 'true';
    const updateSelection = () => {
      const checkboxes = [...card.querySelectorAll('[data-hunk-id]')];
      const selected = checkboxes.filter((item) => item.checked).length;
      const partial = selected > 0 && selected < checkboxes.length;
      const summary = card.querySelector('.hunk-selection-summary');
      summary.textContent = `${selected} of ${checkboxes.length} hunks selected${partial ? ' · partial selections apply only once' : ''}`;
      for (const button of actions.querySelectorAll('[data-grant-scope]')) {
        const scope = button.dataset.grantScope;
        button.disabled = selected === 0 || (partial && scope !== 'once');
      }
      const approve = actions.querySelector('[data-grant-scope="once"]');
      if (approve) approve.textContent = selected === checkboxes.length ? 'Approve all hunks' : 'Apply selected hunks';
      const selectAll = card.querySelector('[data-hunk-action="all"]');
      const selectNone = card.querySelector('[data-hunk-action="none"]');
      if (selectAll) selectAll.disabled = selected === checkboxes.length;
      if (selectNone) selectNone.disabled = selected === 0;
    };
    for (const input of card.querySelectorAll('[data-hunk-id]')) input.addEventListener('change', updateSelection);
    for (const action of card.querySelectorAll('[data-hunk-action]'))
      action.addEventListener('click', () => {
        const checked = action.dataset.hunkAction === 'all';
        for (const input of card.querySelectorAll('[data-hunk-id]')) input.checked = checked;
        updateSelection();
      });
    updateSelection();
  }
  elements.approval_region.append(card);
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderFileChangeDiff(change) {
  const preview = node('pre', 'file-change-diff');
  preview.setAttribute('aria-label', 'Proposed file change diff');
  if (!change.diff) {
    preview.textContent = `Diff unavailable: ${change.unavailable_reason || 'the file could not be rendered as UTF-8 text'}`;
    return preview;
  }
  appendHighlightedDiff(preview, change.diff);
  return preview;
}

function appendHighlightedDiff(preview, diff) {
  const lines = diff.split('\n');
  lines.forEach((line, index) => {
    const kind = line.startsWith('+')
      ? 'diff-added'
      : line.startsWith('-')
        ? 'diff-removed'
        : line.startsWith('@@')
          ? 'diff-hunk'
          : line.startsWith('\\ No newline')
            ? 'diff-note'
            : '';
    preview.append(node('span', kind, line));
    if (index < lines.length - 1) preview.append(document.createTextNode('\n'));
  });
}

function renderFileHunkSelection(change) {
  const review = node('section', 'file-hunk-review');
  review.append(node('div', 'hunk-review-heading', 'Choose which hunks to apply'));
  const selectionActions = node('div', 'hunk-selection-actions');
  for (const [action, label] of [
    ['all', 'Select all'],
    ['none', 'Select none'],
  ]) {
    const button = node('button', '', label);
    button.type = 'button';
    button.dataset.hunkAction = action;
    selectionActions.append(button);
  }
  selectionActions.append(node('span', 'hunk-selection-summary', ''));
  review.append(selectionActions);
  for (const hunk of change.hunks) {
    const item = node('section', 'file-hunk');
    const label = node('label', 'file-hunk-label');
    const checkbox = node('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.hunkId = hunk.id;
    const originalRange = hunk.old_count
      ? `lines ${hunk.old_start}–${hunk.old_start + hunk.old_count - 1}`
      : `insertion before line ${hunk.old_start + 1}`;
    checkbox.setAttribute('aria-label', `Include hunk ${hunk.id.slice(5)}, ${originalRange}`);
    label.append(checkbox, node('span', '', `Hunk ${hunk.id.slice(5)} · ${originalRange}`));
    item.append(label);
    const diff = node('pre', 'file-change-diff file-hunk-diff');
    diff.setAttribute('aria-label', `Diff for hunk ${hunk.id.slice(5)}`);
    appendHighlightedDiff(diff, hunk.diff);
    item.append(diff);
    review.append(item);
  }
  return review;
}

async function answerApproval(approvalId, approved, grantScope, card) {
  if (!activeRunId) return;
  for (const button of card.querySelectorAll('button')) button.disabled = true;
  try {
    await client.answerApproval(activeRunId, approvalId, approved, {
      grantScope,
      ...(approved && grantScope === 'session_exact_action' ? { grantDurationMs: 60 * 60 * 1000 } : {}),
      ...(approved && card.dataset.hunkSelection === 'true'
        ? { acceptedHunks: [...card.querySelectorAll('[data-hunk-id]:checked')].map((input) => input.dataset.hunkId) }
        : {}),
    });
    card.replaceChildren(node('div', 'approval-expiry', approved ? 'Approval submitted.' : 'Action denied.'));
  } catch (error) {
    for (const button of card.querySelectorAll('button')) button.disabled = false;
    showError(error);
  }
}

async function submitPrompt(prompt) {
  if (activeRunId || !prompt.trim()) return;
  if (
    attachedImageFiles.length &&
    elements.model_picker.value !== AUTO_MODEL_OPTION &&
    modelProfiles[elements.model_picker.value]?.supports_vision !== true
  ) {
    showToast('Choose a model profile marked Vision before attaching images.');
    return;
  }
  clearError();
  elements.prompt_input.value = '';
  resizeComposer();
  addMessage('user', `${prompt.trim()}${attachedImageFiles.length ? `\n[${attachedImageFiles.length} image(s) attached]` : ''}`);
  let responseBody = addMessage('assistant');
  const activityRows = new Map();
  const modelLoadRows = new Map();
  let compactionActivity = null;
  elements.send_button.disabled = true;
  elements.stop_run.hidden = false;
  for (const button of elements.session_actions.querySelectorAll('button')) button.disabled = true;
  runController = new AbortController();
  renderMcpRunSelection();
  try {
    const request = { prompt: prompt.trim(), mode: elements.run_mode.value };
    request.mcp_servers = mcpServerSelection;
    if (attachedImageFiles.length) request.images = await Promise.all(attachedImageFiles.map(encodeImageFile));
    if (activeSessionId) request.session_id = activeSessionId;
    const automaticModelSelection = elements.model_picker.value === AUTO_MODEL_OPTION;
    if (elements.model_picker.value && !automaticModelSelection) request.model = elements.model_picker.value;
    activeRunModel = request.model || null;
    activeRunAutomaticModelSelection = automaticModelSelection;
    activeRunMode = request.mode;
    activeRunHasImages = Array.isArray(request.images) && request.images.length > 0;
    runModelChangePending = false;
    runBudgetChangePending = false;
    activeRunInitialBudgets = {};
    activeRunBudgets = {};
    activeRunBudgetAdjustmentsEnabled = false;
    const accepted = await client.startRun(request, { signal: runController.signal });
    attachedImageFiles = [];
    renderAttachedImages();
    activeRunId = accepted.run_id;
    renderRunModelControl();
    renderMcpRunSelection();
    activeRunPaused = false;
    activeRunPauseRequested = false;
    currentRoutingDecision = null;
    usageSnapshot = await client.getUsage().catch(() => null);
    renderRunInspector();
    elements.pause_run.hidden = false;
    elements.pause_run.disabled = false;
    elements.pause_run.textContent = 'Pause run';
    elements.send_direction.hidden = false;
    for await (const event of client.followRunEvents(activeRunId, { signal: runController.signal })) {
      const data = event.data;
      if (data.session_id) activeSessionId = data.session_id;
      if (event.type === 'run_started' && data.routing_decision) {
        activeRunModel = data.model || data.routing_decision.model || activeRunModel;
        ensureModelPickerOption(activeRunModel);
        if (!activeRunAutomaticModelSelection) elements.model_picker.value = activeRunModel || elements.model_picker.value;
        renderRunModelControl();
        currentRoutingDecision = data.routing_decision;
        void client
          .getUsage()
          .then((usage) => {
            usageSnapshot = usage;
            renderRunInspector();
          })
          .catch(() => renderRunInspector());
        renderRunInspector();
      }
      if (event.type === 'assistant_delta' && typeof data.text === 'string') responseBody.textContent += data.text;
      if (event.type === 'model_load_started') {
        const activity = appendActivity(`Loading local model · ${data.model}`, 'working');
        modelLoadRows.set(data.model, activity);
      }
      if (event.type === 'model_load_finished' || event.type === 'model_load_failed' || event.type === 'model_load_skipped') {
        const activity = modelLoadRows.get(data.model);
        if (activity) {
          activity.textContent =
            event.type === 'model_load_finished'
              ? `Local model ready · ${data.model}`
              : event.type === 'model_load_skipped'
                ? `Model auto-load unavailable · trying ${data.model}`
                : `Model load failed · ${data.model}`;
          activity.dataset.status = event.type === 'model_load_failed' ? 'failed' : 'complete';
          modelLoadRows.delete(data.model);
        }
      }
      if (event.type === 'compaction_started') compactionActivity = appendActivity(formatCompactionActivity(event), 'working');
      if (event.type === 'compaction_finished' || event.type === 'compaction_failed') {
        const activity = compactionActivity || appendActivity('', 'working');
        activity.textContent = formatCompactionActivity(event);
        activity.dataset.status = event.type === 'compaction_finished' ? 'complete' : 'failed';
        compactionActivity = null;
      }
      if (event.type === 'untrusted_content_signal') {
        const message = formatUntrustedContentSignal({ type: event.type, ...data });
        if (message) appendActivity(message, 'warning');
      }
      if (event.type === 'tool_started' || event.type === 'tool_proposed') {
        const activity = appendActivity(`${event.type === 'tool_proposed' ? 'Proposed' : 'Running'} · ${data.tool}`, event.type);
        if (data.tool_call_id) activityRows.set(data.tool_call_id, activity);
        if (event.type === 'tool_proposed') {
          const detail = appendToolDetail(data.tool, data.arguments || {}, { status: data.permission?.decision || 'proposed' });
          if (data.tool_call_id) activityRows.set(`${data.tool_call_id}:detail`, detail);
        }
      }
      if (event.type === 'tool_finished') {
        const row = activityRows.get(data.tool_call_id);
        if (row) {
          row.textContent = `Finished · ${data.tool}`;
          row.dataset.status = 'complete';
        }
        const detail = activityRows.get(`${data.tool_call_id}:detail`);
        if (detail) {
          detail.dataset.status = 'complete';
          detail.querySelector('summary').textContent =
            `${data.tool} · completed${data.applied_hunks ? ` · applied ${data.applied_hunks.join(', ')}` : ''}`;
        }
      }
      if (event.type === 'tool_denied' || event.type === 'tool_failed') {
        const row = activityRows.get(data.tool_call_id);
        if (row) {
          row.textContent = `${event.type === 'tool_denied' ? 'Denied' : 'Failed'} · ${data.tool}`;
          row.dataset.status = event.type;
        }
        const detail = activityRows.get(`${data.tool_call_id}:detail`);
        if (detail) {
          detail.dataset.status = event.type;
          detail.querySelector('summary').textContent = `${data.tool} · ${event.type === 'tool_denied' ? 'denied' : 'failed'}`;
          if (data.message)
            detail.querySelector('pre').textContent = formatToolDetail({
              arguments: detail.querySelector('pre').textContent,
              error: data.message,
            });
        }
      }
      if (event.type === 'run_paused') {
        activeRunPaused = true;
        activeRunPauseRequested = false;
        elements.pause_run.disabled = false;
        elements.pause_run.textContent = 'Resume run';
        renderRunModelControl();
        void refreshRunBudgetControl();
      }
      if (event.type === 'run_pause_requested') {
        activeRunPauseRequested = true;
        elements.pause_run.disabled = false;
        elements.pause_run.textContent = 'Cancel pause';
      }
      if (event.type === 'run_resumed' || event.type === 'run_pause_cancelled') {
        activeRunPaused = false;
        activeRunPauseRequested = false;
        elements.pause_run.disabled = false;
        elements.pause_run.textContent = 'Pause run';
        renderRunModelControl();
        renderRunBudgetControl();
      }
      if (event.type === 'run_model_changed') {
        activeRunModel = data.to_model;
        runModelChangePending = false;
        ensureModelPickerOption(activeRunModel);
        elements.model_picker.value = activeRunModel;
        renderRunModelControl();
        showToast(`Run switched to ${activeRunModel}.`);
      }
      if (event.type === 'run_model_change_failed') {
        runModelChangePending = false;
        ensureModelPickerOption(activeRunModel);
        elements.model_picker.value = activeRunAutomaticModelSelection ? AUTO_MODEL_OPTION : activeRunModel || '';
        renderRunModelControl();
        showToast('The model change could not be applied. The run kept its previous model.');
      }
      if (event.type === 'run_budgets_changed') {
        activeRunBudgets = data.budgets || {};
        runBudgetChangePending = false;
        elements.run_budget_status.textContent = 'Budget changes are active for this run.';
        renderRunBudgetFields();
        renderRunBudgetControl();
        showToast('Active-run budgets updated.');
      }
      if (event.type === 'run_budget_change_failed') {
        runBudgetChangePending = false;
        elements.run_budget_status.textContent = 'Budget changes could not be applied; the previous limits remain active.';
        renderRunBudgetControl();
        showToast('The budget change could not be applied; previous limits remain active.');
      }
      if (event.type === 'user_direction_added' && typeof data.content === 'string') {
        if (!responseBody.textContent) responseBody.closest('.message')?.remove();
        addMessage('user', `Direction during run: ${data.content}`);
        responseBody = addMessage('assistant');
      }
      if (event.type === 'run_direction_queued') showToast('Direction queued for the next safe checkpoint.');
      if (event.type === 'run_policy_changed') {
        const action = data.action === 'revoked' ? 'revoked' : 'added';
        const decision = typeof data.decision === 'string' ? ` ${data.decision}` : '';
        appendActivity(
          `Approval policy ${action}:${decision} ${data.tool || 'tool'} (${data.scope || 'scope'}). Pending tools are rechecked before execution.`,
          'complete',
        );
      }
      if (event.type === 'run_runtime_policy_queued') {
        appendActivity(`Runtime policy update queued. Autonomy will switch to ${data.autonomy} when this paused run resumes.`, 'complete');
      }
      if (event.type === 'run_runtime_policy_changed') {
        appendActivity(`Runtime policy is active for this run: ${data.autonomy} autonomy and the updated sandbox settings.`, 'complete');
      }
      if (event.type === 'run_runtime_policy_change_failed') {
        appendActivity('Runtime policy update could not be applied; the previous run policy remains active.', 'error');
      }
      if (event.type === 'approval_required') createApproval(event);
      if (event.type === 'context_trimmed' && data.dropped_tool_calls > 0)
        appendActivity(
          `Reduced earlier tool history to fit the model context window (${data.dropped_tool_calls} tool call(s) omitted from model context). The full transcript remains saved.`,
          'complete',
        );
      if (event.type === 'context_trimmed' && Array.isArray(data.dropped_tools) && data.dropped_tools.length)
        appendActivity(
          `Temporarily hid optional tool schemas to fit the model context: ${data.dropped_tools.join(', ')}. They remain enabled for the next run.`,
          'complete',
        );
      if (event.type === 'api_run_failed') {
        responseBody.classList.add('run-error');
        appendActivity(formatRunFailure(data.error), 'error');
      }
      if (event.type === 'api_run_finished') {
        void client
          .getUsage()
          .then((usage) => {
            usageSnapshot = usage;
            renderRunInspector();
          })
          .catch(() => {});
        activeSessionId = data.session_id || activeSessionId;
        elements.conversation_title.textContent = sessionsById.get(activeSessionId)?.title || 'Conversation';
        if (!responseBody.textContent && data.status !== 'complete') responseBody.textContent = `Run ${data.status}.`;
        await refreshSessions();
      }
    }
    if (activeSessionId) await openSession(activeSessionId);
    setConnected(true);
  } catch (error) {
    if (error.name !== 'AbortError') showError(error);
  } finally {
    activeRunId = null;
    runController = null;
    activeRunModel = null;
    activeRunMode = 'agent';
    activeRunHasImages = false;
    runModelChangePending = false;
    runBudgetChangePending = false;
    activeRunInitialBudgets = {};
    activeRunBudgets = {};
    activeRunBudgetAdjustmentsEnabled = false;
    elements.run_budget_fields.replaceChildren();
    elements.run_budget_status.textContent = '';
    renderMcpRunSelection();
    activeRunPaused = false;
    activeRunPauseRequested = false;
    elements.send_button.disabled = false;
    elements.stop_run.hidden = true;
    elements.pause_run.hidden = true;
    elements.pause_run.disabled = false;
    elements.pause_run.textContent = 'Pause run';
    renderRunModelControl();
    renderRunBudgetControl();
    elements.send_direction.hidden = true;
    for (const button of elements.session_actions.querySelectorAll('button')) button.disabled = false;
    if (!elements.status_banner.hidden) setConnected(false);
    else setConnected(true);
    elements.prompt_input.focus();
  }
}

function renderAttachedImages() {
  const panel = elements.attached_images;
  panel.replaceChildren();
  panel.hidden = attachedImageFiles.length === 0;
  for (const [index, file] of attachedImageFiles.entries()) {
    const chip = node('span', 'attached-image');
    chip.append(node('span', 'attached-image-name', file.name));
    const remove = node('button', 'attached-image-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Remove image ${file.name}`);
    remove.addEventListener('click', () => {
      attachedImageFiles.splice(index, 1);
      renderAttachedImages();
    });
    chip.append(remove);
    panel.append(chip);
  }
}

async function encodeImageFile(file) {
  const mimeType = ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ? file.type : '';
  if (!mimeType) throw new Error(`Unsupported image type: ${file.name}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { mime_type: mimeType, data: btoa(binary) };
}

function addImageFiles(files) {
  const incoming = [...files];
  const next = [...attachedImageFiles, ...incoming];
  if (next.length > MAX_IMAGE_FILES || next.some((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
    showToast(`Choose up to ${MAX_IMAGE_FILES} PNG, JPEG, or WebP images.`);
    elements.image_files.value = '';
    return;
  }
  if (next.some((file) => file.size > 10 * 1024 * 1024) || next.reduce((total, file) => total + file.size, 0) > MAX_IMAGE_TOTAL_BYTES) {
    showToast('Images must be 10 MiB or smaller each and 16 MiB total before preprocessing.');
    elements.image_files.value = '';
    return;
  }
  attachedImageFiles = next;
  renderAttachedImages();
  elements.image_files.value = '';
}

async function stopRun() {
  if (!activeRunId) return;
  elements.stop_run.disabled = true;
  try {
    await client.cancelRun(activeRunId);
    showToast('Run cancellation requested.');
  } catch (error) {
    showError(error);
  } finally {
    elements.stop_run.disabled = false;
  }
}

async function toggleRunPause() {
  if (!activeRunId || !runController) return;
  const isResuming = activeRunPaused || activeRunPauseRequested;
  elements.pause_run.disabled = true;
  try {
    if (isResuming) await client.resumeRun(activeRunId);
    else await client.pauseRun(activeRunId);
    showToast(isResuming ? 'Resume requested.' : 'Pause requested; the current operation will finish first.');
  } catch (error) {
    showToast(error.message);
    elements.pause_run.disabled = false;
  }
}

async function applyRunModelChange() {
  if (!activeRunId || !activeRunPaused || runModelChangePending) return;
  const model = elements.model_picker.value;
  if (!model || model === AUTO_MODEL_OPTION || model === activeRunModel) return;
  const profile = modelProfiles[model];
  if (!profile) {
    showToast('Choose a configured model profile.');
    return;
  }
  if (activeRunMode !== 'agent' && profile.supports_tools === false) {
    showToast('Review and Plan require a model profile with tool support.');
    return;
  }
  if (activeRunHasImages && profile.supports_vision !== true) {
    showToast('This run has image input; choose a profile configured for vision.');
    return;
  }
  elements.change_run_model.disabled = true;
  try {
    await client.changeRunModel(activeRunId, model);
    runModelChangePending = true;
    renderRunModelControl();
    showToast(`Model change to ${model} is queued. Resume the run to apply it.`);
  } catch (error) {
    showToast(error.message);
  } finally {
    renderRunModelControl();
  }
}

async function sendRunDirection() {
  const content = elements.prompt_input.value.trim();
  if (!activeRunId || !content) return;
  elements.send_direction.disabled = true;
  try {
    await client.addRunDirection(activeRunId, content);
    elements.prompt_input.value = '';
    resizeComposer();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.send_direction.disabled = false;
    elements.prompt_input.focus();
  }
}

async function manageSession(action) {
  if (!activeSessionId || runController) return;
  const id = activeSessionId;
  try {
    if (action === 'rename') {
      const current = sessionsById.get(id)?.title || '';
      const title = window.prompt('Conversation name (up to 80 characters)', current);
      if (title === null) return;
      const normalized = title.replace(/\s+/g, ' ').trim();
      if (!normalized || normalized.length > 80) {
        showToast('Use a name between 1 and 80 characters.');
        return;
      }
      await client.renameSession(id, normalized);
      await refreshSessions();
      elements.conversation_title.textContent = normalized;
      showToast('Conversation renamed.');
      return;
    }
    if (action === 'fork') {
      const fork = await client.forkSession(id);
      await refreshSessions();
      await openSession(fork.id);
      showToast('Conversation forked.');
      return;
    }
    if (action === 'export') {
      const sessionExport = await client.exportSession(id);
      const blob = new Blob([`${JSON.stringify(sessionExport, null, 2)}\n`], { type: 'application/json' });
      const downloadUrl = URL.createObjectURL(blob);
      const link = node('a');
      link.href = downloadUrl;
      link.download = `xyst-session-${id}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
      showToast('Session export downloaded. Review it before sharing.');
      return;
    }
    if (action === 'archive') {
      await client.archiveSession(id);
      activeSessionId = null;
      elements.session_actions.hidden = true;
      elements.conversation_title.textContent = 'New conversation';
      resetTimeline();
      await refreshSessions();
      showToast('Conversation archived.');
      return;
    }
    if (action === 'delete') {
      if (!window.confirm('Delete this conversation and its saved transcript? This cannot be undone.')) return;
      await client.deleteSession(id);
      activeSessionId = null;
      elements.session_actions.hidden = true;
      elements.conversation_title.textContent = 'New conversation';
      resetTimeline();
      await refreshSessions();
      showToast('Conversation deleted.');
    }
  } catch (error) {
    showError(error);
  }
}

async function showSessionRecap() {
  if (!activeSessionId || runController) return;
  elements.recap_content.textContent = 'Preparing recap…';
  elements.recap_dialog.showModal();
  try {
    elements.recap_content.textContent = await client.recapSession(activeSessionId);
  } catch (error) {
    elements.recap_content.textContent = `Could not load recap: ${error.message}`;
  }
}

async function importSessionFile(file) {
  if (!file) return;
  if (runController) {
    showToast('Wait for the current run to finish before importing.');
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    showToast('Session exports must be no larger than 50 MiB.');
    return;
  }
  try {
    const document = JSON.parse(await file.text());
    const session = await client.importSession(document);
    await refreshSessions();
    await openSession(session.id);
    showToast('Session imported as a new conversation.');
  } catch (error) {
    if (error instanceof ControlApiError) showError(error);
    else showToast('Choose a valid Xyst AI Assistant session JSON export.');
  } finally {
    elements.import_session_file.value = '';
  }
}

function resizeComposer() {
  elements.prompt_input.style.height = 'auto';
  elements.prompt_input.style.height = `${Math.min(elements.prompt_input.scrollHeight, 180)}px`;
}

async function searchWorkspace(query) {
  if (!query.trim()) return;
  clearError();
  const panel = elements.sidebar_search_results;
  panel.hidden = false;
  panel.replaceChildren(node('strong', '', 'Searching workspace…'));
  try {
    const semantic = elements.semantic_search_toggle.checked;
    let result;
    if (semantic) {
      const settings = await client.getSettings();
      if (!settings.retrieval?.semantic?.enabled) throw new Error('Semantic retrieval is disabled in runtime settings.');
      const destination = settings.retrieval.semantic.allow_remote
        ? 'the configured remote HTTPS embedding service'
        : 'the configured local embedding service';
      if (!window.confirm(`Semantic search sends redacted workspace excerpts and your query to ${destination}. Continue?`)) {
        panel.replaceChildren(node('strong', '', 'Semantic search cancelled'));
        return;
      }
      result = await client.searchSemantic(query.trim(), { maxResults: 8, approved: true });
    } else result = await client.searchWorkspace(query.trim(), { maxResults: 8 });
    panel.replaceChildren(
      node(
        'strong',
        '',
        `${result.matches.length} ${semantic ? 'semantic ' : ''}matches${semantic ? ` · ${result.chunks_indexed} chunks` : ` · ${result.files_scanned} files scanned`}${result.truncated ? ' · scan capped' : ''}`,
      ),
    );
    if (!result.matches.length)
      panel.append(node('p', 'empty-sessions', semantic ? 'No related passages found.' : 'No matching lines found.'));
    for (const match of result.matches) {
      const hit = node('div', 'search-hit');
      const location = match.line ? `${match.path}:${match.line}` : `${match.path}:${match.start_line}-${match.end_line}`;
      hit.append(node('code', '', location), document.createTextNode(` ${match.text}`));
      panel.append(hit);
    }
  } catch (error) {
    panel.replaceChildren(node('strong', '', 'Search failed'), node('p', 'empty-sessions', error.message));
  }
}

function settingRow(label, value) {
  const row = node('div', 'setting-row');
  row.append(node('span', '', label), node('span', '', String(value ?? 'Not configured')));
  return row;
}

function createSettingsEditor(settings) {
  const form = node('form', 'runtime-settings-form');
  const modelLabel = node('label', '', 'Default model profile');
  const model = node('select', 'data-input');
  model.name = 'default_model';
  for (const [profile, definition] of Object.entries(settings.models || {})) {
    const option = node('option', '', `${profile} · ${definition.model || definition.provider || 'model'}`);
    option.value = profile;
    option.selected = profile === settings.default_model;
    model.append(option);
  }
  if (!model.options.length) model.append(node('option', '', 'No profiles configured'));
  model.addEventListener('change', () => {
    model.dataset.dirty = 'true';
  });
  modelLabel.append(model);

  const roleModels = {};
  for (const [key, labelText] of [
    ['review_model', 'Review model profile'],
    ['plan_model', 'Plan model profile'],
  ]) {
    const label = node('label', '', labelText);
    const select = node('select', 'data-input');
    select.name = key;
    const fallback = node('option', '', 'Use default model profile');
    fallback.value = '';
    select.append(fallback);
    for (const [profile, definition] of Object.entries(settings.models || {})) {
      const option = node('option', '', `${profile} · ${definition.model || definition.provider || 'model'}`);
      option.value = profile;
      option.selected = profile === settings[key];
      select.append(option);
    }
    select.value = settings[key] || '';
    select.addEventListener('change', () => {
      select.dataset.dirty = 'true';
    });
    label.append(select);
    roleModels[key] = select;
    form.append(label);
  }

  const routingEnabledLabel = node('label', 'settings-checkbox');
  const routingEnabled = node('input');
  routingEnabled.type = 'checkbox';
  routingEnabled.name = 'routing.enabled';
  routingEnabled.checked = settings.routing?.enabled !== false;
  routingEnabled.addEventListener('change', () => {
    routingEnabled.dataset.dirty = 'true';
  });
  routingEnabledLabel.append(routingEnabled, document.createTextNode('Enable automatic model routing'));

  const routingLabel = node('label', '', 'Routing strategy');
  const routing = node('select', 'data-input');
  routing.name = 'routing.selection';
  for (const strategy of ['balanced', 'quality', 'cost', 'speed']) {
    const option = node('option', '', strategy[0].toUpperCase() + strategy.slice(1));
    option.value = strategy;
    option.selected = strategy === (settings.routing?.selection || 'balanced');
    routing.append(option);
  }
  routing.addEventListener('change', () => {
    routing.dataset.dirty = 'true';
  });
  routingLabel.append(routing);

  const localLabel = node('label', 'settings-checkbox');
  const local = node('input');
  local.type = 'checkbox';
  local.name = 'routing.prefer_local';
  local.checked = settings.routing?.prefer_local !== false;
  local.addEventListener('change', () => {
    local.dataset.dirty = 'true';
  });
  localLabel.append(local, document.createTextNode('Prefer capable local models'));

  const orchestrationSection = node('fieldset', 'settings-budget-editor settings-autonomy-editor');
  orchestrationSection.append(node('legend', '', 'Agent orchestration'));
  const subagentsLabel = node('label', 'settings-checkbox');
  const subagentsEnabled = node('input');
  subagentsEnabled.type = 'checkbox';
  subagentsEnabled.name = 'subagents.enabled';
  subagentsEnabled.checked = settings.subagents?.enabled === true;
  const subagentsConcurrency = node('select', 'data-picker');
  subagentsConcurrency.name = 'subagents.max_concurrent';
  for (let count = 1; count <= 8; count += 1) {
    const option = node('option', '', `${count} concurrent agent${count === 1 ? '' : 's'}`);
    option.value = String(count);
    subagentsConcurrency.append(option);
  }
  subagentsConcurrency.value = String(settings.subagents?.max_concurrent || 2);
  subagentsConcurrency.disabled = !subagentsEnabled.checked;
  subagentsLabel.append(subagentsEnabled, document.createTextNode('Enable child agents for independent work'));
  const subagentsConcurrencyLabel = node('label', 'budget-setting');
  subagentsConcurrencyLabel.append(node('span', '', 'Maximum concurrent agents'), subagentsConcurrency);
  subagentsEnabled.addEventListener('change', () => {
    subagentsEnabled.dataset.dirty = 'true';
    subagentsConcurrency.disabled = !subagentsEnabled.checked;
  });
  subagentsConcurrency.addEventListener('change', () => {
    subagentsConcurrency.dataset.dirty = 'true';
  });
  orchestrationSection.append(
    subagentsLabel,
    subagentsConcurrencyLabel,
    node(
      'p',
      'muted-copy',
      'Child agents work in isolated Git worktrees. Enable this to make delegation available; Xyst uses it when you ask or when parallel work will help.',
    ),
  );

  const providersSection = node('fieldset', 'settings-budget-editor settings-provider-editor');
  providersSection.append(node('legend', '', 'Provider profiles'));
  const addProfile = node('div', 'provider-profile-editor provider-profile-create');
  addProfile.append(node('strong', '', 'Add a model profile'));
  const newProfileName = node('input', 'data-input');
  newProfileName.placeholder = 'Profile name';
  newProfileName.setAttribute('aria-label', 'New model profile name');
  const newProfileUrl = node('input', 'data-input');
  newProfileUrl.type = 'url';
  newProfileUrl.placeholder = 'http://127.0.0.1:1234/v1';
  newProfileUrl.setAttribute('aria-label', 'New profile API base URL');
  const newProfileModel = node('input', 'data-input');
  newProfileModel.placeholder = 'Model ID';
  newProfileModel.setAttribute('aria-label', 'New profile model ID');
  const localProfileLabel = node('label', 'settings-checkbox');
  const localProfile = node('input');
  localProfile.type = 'checkbox';
  localProfile.checked = true;
  localProfileLabel.append(localProfile, document.createTextNode('Local model server'));
  const createProfile = node('button', 'send-button', 'Add profile');
  createProfile.type = 'button';
  createProfile.addEventListener('click', async () => {
    const name = newProfileName.value.trim();
    const baseUrl = newProfileUrl.value.trim();
    const modelId = newProfileModel.value.trim();
    createProfile.disabled = true;
    try {
      const result = await client.updateSettings({
        models: {
          [name]: {
            provider: 'openai-compatible',
            base_url: baseUrl,
            model: modelId,
            local: localProfile.checked,
            supports_tools: true,
          },
        },
      });
      runtimeSettings = result.settings;
      modelProfiles = runtimeSettings.models || modelProfiles;
      showToast(`Model profile ${name} added. Set a credential if this endpoint requires one.`);
      await openSettings();
      void initialize();
    } catch (error) {
      showToast(`Could not add model profile: ${error.message}`);
    } finally {
      createProfile.disabled = false;
    }
  });
  addProfile.append(newProfileName, newProfileUrl, newProfileModel, localProfileLabel, createProfile);
  providersSection.append(addProfile);
  providersSection.append(
    node(
      'p',
      'muted-copy',
      'Prices are your estimates and can be edited at any time. Record when you checked the source; prices older than 90 days are marked stale. Cached-input pricing applies only when the provider reports cached tokens. Removing a profile leaves its OS-vault credential intact; a credential may be shared with another configuration.',
    ),
  );
  for (const [profileName, definition] of Object.entries(settings.models || {})) {
    const profile = node('fieldset', 'provider-profile-editor');
    profile.append(node('legend', '', profileName));
    const fields = {};
    for (const [key, labelText, value] of [
      ['base_url', 'API base URL', definition.base_url || ''],
      ['model', 'Model ID', definition.model || ''],
    ]) {
      const label = node('label', 'budget-setting');
      label.append(node('span', '', labelText));
      const input = node('input', 'data-input');
      input.type = 'text';
      input.autocomplete = 'off';
      input.value = value;
      input.addEventListener('change', () => {
        input.dataset.dirty = 'true';
      });
      label.append(input);
      profile.append(label);
      fields[key] = input;
    }
    const contextLabel = node('label', 'budget-setting');
    contextLabel.append(node('span', '', 'Context length · tokens'));
    const contextInput = node('input', 'data-input');
    contextInput.type = 'number';
    contextInput.min = '1';
    contextInput.max = '10000000';
    contextInput.step = '1';
    contextInput.value = definition.context_length ?? '';
    contextInput.placeholder = 'Not configured';
    contextInput.setAttribute('aria-label', `${profileName} context length in tokens`);
    contextInput.addEventListener('change', () => {
      contextInput.dataset.dirty = 'true';
    });
    contextLabel.append(contextInput);
    profile.append(contextLabel);
    fields.context_length = contextInput;
    const reasoningLabel = node('label', 'budget-setting');
    reasoningLabel.append(node('span', '', 'Reasoning effort'));
    const reasoningSelect = node('select', 'data-input');
    for (const [value, text] of [
      ['', 'Provider default'],
      ['none', 'Off · fastest response'],
      ['minimal', 'Minimal'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High'],
      ['xhigh', 'Extra high'],
    ]) {
      const option = node('option', '', text);
      option.value = value;
      reasoningSelect.append(option);
    }
    reasoningSelect.value = definition.reasoning_effort ?? '';
    reasoningSelect.setAttribute('aria-label', `${profileName} reasoning effort`);
    reasoningSelect.addEventListener('change', () => {
      reasoningSelect.dataset.dirty = 'true';
    });
    reasoningLabel.append(reasoningSelect);
    profile.append(reasoningLabel);
    fields.reasoning_effort = reasoningSelect;
    for (const [key, labelText] of [
      ['local', 'Prefer as a local model'],
      ['supports_tools', 'Supports tool calls'],
      ['supports_vision', 'Supports image input'],
      ['prompt_cache_enabled', 'Provider supports prompt cache controls'],
    ]) {
      const label = node('label', 'budget-setting');
      label.append(node('span', '', labelText));
      const select = node('select', 'data-input');
      for (const [value, text] of [
        ['', 'Use configured/default value'],
        ['true', 'Yes'],
        ['false', 'No'],
      ]) {
        const option = node('option', '', text);
        option.value = value;
        select.append(option);
      }
      select.value = typeof definition[key] === 'boolean' ? String(definition[key]) : '';
      select.setAttribute('aria-label', `${profileName} ${labelText}`);
      select.addEventListener('change', () => {
        select.dataset.dirty = 'true';
      });
      label.append(select);
      profile.append(label);
      fields[key] = select;
    }
    for (const [key, labelText, min, max] of [
      ['coding_strength', 'Coding strength · 1–10', 1, 10],
      ['tool_calling_quality', 'Tool-call reliability · 1–10', 1, 10],
      ['speed_score', 'Speed score · 1–10', 1, 10],
      ['priority', 'Routing priority · 0–1000 (lower first)', 0, 1000],
      ['retry_attempts', 'Same-provider retries · 0–2 (default 1)', 0, 2],
    ]) {
      const label = node('label', 'budget-setting');
      label.append(node('span', '', labelText));
      const input = node('input', 'data-input');
      input.type = 'number';
      input.min = String(min);
      input.max = String(max);
      input.step = '1';
      input.value = definition[key] ?? '';
      input.placeholder = 'Not configured';
      input.setAttribute('aria-label', `${profileName} ${labelText}`);
      input.addEventListener('change', () => {
        input.dataset.dirty = 'true';
      });
      label.append(input);
      profile.append(label);
      fields[key] = input;
    }
    for (const [key, labelText] of [
      ['input_cost_per_million', 'Input price · USD per 1M tokens'],
      ['cached_input_cost_per_million', 'Cached input price · USD per 1M tokens'],
      ['output_cost_per_million', 'Output price · USD per 1M tokens'],
    ]) {
      const label = node('label', 'budget-setting');
      label.append(node('span', '', labelText));
      const input = node('input', 'data-input');
      input.type = 'number';
      input.min = '0';
      input.step = 'any';
      input.value = definition[key] ?? '';
      input.placeholder = 'Not configured';
      input.setAttribute('aria-label', `${profileName} ${labelText}`);
      input.addEventListener('change', () => {
        input.dataset.dirty = 'true';
      });
      label.append(input);
      profile.append(label);
      fields[key] = input;
    }
    const promptCacheKeyLabel = node('label', 'budget-setting');
    promptCacheKeyLabel.append(node('span', '', 'Prompt cache key · non-sensitive identifier'));
    const promptCacheKeyInput = node('input', 'data-input');
    promptCacheKeyInput.type = 'text';
    promptCacheKeyInput.maxLength = 64;
    promptCacheKeyInput.value = definition.prompt_cache_key ?? '';
    promptCacheKeyInput.placeholder = 'Optional, e.g. xyst-main';
    promptCacheKeyInput.setAttribute('aria-label', `${profileName} prompt cache key`);
    promptCacheKeyInput.addEventListener('change', () => {
      promptCacheKeyInput.dataset.dirty = 'true';
    });
    promptCacheKeyLabel.append(promptCacheKeyInput);
    profile.append(promptCacheKeyLabel);
    fields.prompt_cache_key = promptCacheKeyInput;
    const promptCacheRetentionLabel = node('label', 'budget-setting');
    promptCacheRetentionLabel.append(node('span', '', 'Prompt cache retention'));
    const promptCacheRetentionSelect = node('select', 'data-input');
    for (const [value, text] of [
      ['', 'Provider default'],
      ['24h', '24 hours'],
    ]) {
      const option = node('option', '', text);
      option.value = value;
      promptCacheRetentionSelect.append(option);
    }
    promptCacheRetentionSelect.value = definition.prompt_cache_retention ?? '';
    promptCacheRetentionSelect.setAttribute('aria-label', `${profileName} prompt cache retention`);
    promptCacheRetentionSelect.addEventListener('change', () => {
      promptCacheRetentionSelect.dataset.dirty = 'true';
    });
    promptCacheRetentionLabel.append(promptCacheRetentionSelect);
    profile.append(promptCacheRetentionLabel);
    fields.prompt_cache_retention = promptCacheRetentionSelect;
    for (const [key, labelText, type] of [
      ['pricing_updated_at', 'Prices last checked (UTC)', 'date'],
      ['pricing_source', 'Pricing source or note', 'text'],
    ]) {
      const label = node('label', 'budget-setting');
      label.append(node('span', '', labelText));
      const input = node('input', 'data-input');
      input.type = type;
      input.value = definition[key] ?? '';
      if (key === 'pricing_source') {
        input.maxLength = 256;
        input.placeholder = 'Provider pricing page or source note';
      }
      input.setAttribute('aria-label', `${profileName} ${labelText}`);
      input.addEventListener('change', () => {
        input.dataset.dirty = 'true';
      });
      label.append(input);
      profile.append(label);
      fields[key] = input;
    }
    const pricingStatus = modelPricingDataStatus(definition);
    const pricingNote = node('p', `muted-copy pricing-status pricing-status-${pricingStatus}`, modelPricingStatus(definition));
    pricingNote.setAttribute('aria-live', 'polite');
    profile.append(pricingNote);
    for (const [key, labelText, type] of [
      ['capabilities_updated_at', 'Capabilities last checked (UTC)', 'date'],
      ['capabilities_source', 'Capability source or note', 'text'],
    ]) {
      const label = node('label', 'budget-setting');
      label.append(node('span', '', labelText));
      const input = node('input', 'data-input');
      input.type = type;
      input.value = definition[key] ?? '';
      if (key === 'capabilities_source') {
        input.maxLength = 256;
        input.placeholder = 'Model card, provider docs, or source note';
      }
      input.setAttribute('aria-label', `${profileName} ${labelText}`);
      input.addEventListener('change', () => {
        input.dataset.dirty = 'true';
      });
      label.append(input);
      profile.append(label);
      fields[key] = input;
    }
    const capabilityStatus = modelCapabilitiesDataStatus(definition);
    const capabilityNote = node('p', `muted-copy pricing-status pricing-status-${capabilityStatus}`, modelCapabilitiesStatus(definition));
    capabilityNote.setAttribute('aria-live', 'polite');
    profile.append(capabilityNote);
    const keyLabel = node('label', 'budget-setting');
    keyLabel.append(node('span', '', 'Credential storage name'));
    const keyInput = node('input', 'data-input');
    keyInput.type = 'text';
    keyInput.autocomplete = 'off';
    keyInput.value = definition.api_key_secret || '';
    keyInput.placeholder = `Auto-generated if you save a credential`;
    keyInput.addEventListener('change', () => {
      keyInput.dataset.dirty = 'true';
    });
    keyLabel.append(keyInput);
    profile.append(keyLabel);
    const credentialLabel = node('label', 'budget-setting');
    credentialLabel.append(node('span', '', 'Optional model API credential'));
    const credentialInput = node('input', 'data-input');
    credentialInput.type = 'password';
    credentialInput.autocomplete = 'new-password';
    credentialInput.placeholder = definition.credential_configured
      ? 'Credential configured · enter to replace'
      : definition.local
        ? 'Usually not needed for local servers'
        : 'Only needed if this provider requires one';
    credentialLabel.append(credentialInput);
    profile.append(credentialLabel);
    const credentialNote = node(
      'p',
      'muted-copy',
      definition.local
        ? 'This credential is only for the model connection, not web search. Local servers such as LM Studio normally work without a key; add one only if you enabled server authentication.'
        : 'This credential is only for the model connection, not web search. It is needed only when the selected model provider requires authentication.',
    );
    profile.append(credentialNote);
    const actions = node('div', 'provider-profile-actions');
    const saveProfile = node('button', 'send-button', 'Save profile');
    saveProfile.type = 'button';
    saveProfile.addEventListener('click', async () => {
      const patch = {};
      for (const key of ['base_url', 'model']) if (fields[key].dataset.dirty === 'true') patch[key] = fields[key].value.trim();
      if (fields.context_length.dataset.dirty === 'true') {
        const rawValue = fields.context_length.value.trim();
        const contextLength = Number(rawValue);
        if (rawValue && (!Number.isSafeInteger(contextLength) || contextLength < 1 || contextLength > 10_000_000)) {
          showToast('Context length must be a positive integer of at most 10000000 tokens.');
          return;
        }
        patch.context_length = rawValue ? contextLength : null;
      }
      for (const key of ['local', 'supports_tools', 'supports_vision']) {
        if (fields[key].dataset.dirty !== 'true') continue;
        patch[key] = fields[key].value === '' ? null : fields[key].value === 'true';
      }
      if (fields.prompt_cache_enabled.dataset.dirty === 'true')
        patch.prompt_cache_enabled = fields.prompt_cache_enabled.value === '' ? null : fields.prompt_cache_enabled.value === 'true';
      if (fields.prompt_cache_key.dataset.dirty === 'true') {
        const value = fields.prompt_cache_key.value.trim();
        if (value && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(value)) {
          showToast(
            'Prompt cache key must be a non-sensitive identifier with at most 64 letters, numbers, dots, colons, dashes, or underscores.',
          );
          return;
        }
        patch.prompt_cache_key = value || null;
      }
      if (fields.prompt_cache_retention.dataset.dirty === 'true')
        patch.prompt_cache_retention = fields.prompt_cache_retention.value || null;
      if (fields.reasoning_effort.dataset.dirty === 'true') patch.reasoning_effort = fields.reasoning_effort.value || null;
      for (const [key, min, max] of [
        ['coding_strength', 1, 10],
        ['tool_calling_quality', 1, 10],
        ['speed_score', 1, 10],
        ['priority', 0, 1000],
      ]) {
        if (fields[key].dataset.dirty !== 'true') continue;
        const rawValue = fields[key].value.trim();
        const score = Number(rawValue);
        if (rawValue && (!Number.isSafeInteger(score) || score < min || score > max)) {
          showToast(`${key.replaceAll('_', ' ')} must be an integer from ${min} to ${max}.`);
          return;
        }
        patch[key] = rawValue ? score : null;
      }
      for (const key of ['input_cost_per_million', 'cached_input_cost_per_million', 'output_cost_per_million']) {
        if (fields[key].dataset.dirty !== 'true') continue;
        const rawValue = fields[key].value.trim();
        const price = Number(rawValue);
        if (rawValue && (!Number.isFinite(price) || price < 0)) {
          showToast(`${key.replaceAll('_', ' ')} must be a finite non-negative number.`);
          return;
        }
        patch[key] = rawValue ? price : null;
      }
      for (const key of ['pricing_updated_at', 'pricing_source'])
        if (fields[key].dataset.dirty === 'true') patch[key] = fields[key].value.trim() || null;
      for (const key of ['capabilities_updated_at', 'capabilities_source'])
        if (fields[key].dataset.dirty === 'true') patch[key] = fields[key].value.trim() || null;
      if (keyInput.dataset.dirty === 'true') patch.api_key_secret = keyInput.value.trim() || null;
      if (credentialInput.value) {
        patch.api_key_secret = keyInput.value.trim();
        patch.api_key_env = null;
      }
      if (!Object.keys(patch).length) {
        showToast('Change a profile field or enter a credential first.');
        return;
      }
      saveProfile.disabled = true;
      try {
        if (credentialInput.value) {
          const credentialName = keyInput.value.trim() || `xyst.model.${profileName}`;
          await client.storeCredential(credentialName, credentialInput.value);
          patch.api_key_secret = credentialName;
          patch.api_key_env = null;
        }
        const result = await client.updateSettings({ models: { [profileName]: patch } });
        runtimeSettings = result.settings;
        modelProfiles = runtimeSettings.models || modelProfiles;
        if (credentialInput.value) credentialInput.value = '';
        showToast(`${profileName} saved. Changes apply to new model requests.`);
        await openSettings();
      } catch (error) {
        showToast(`Could not save ${profileName}: ${error.message}`);
      } finally {
        saveProfile.disabled = false;
      }
    });
    const removeProfile = node('button', 'text-button danger-text', 'Remove profile');
    removeProfile.type = 'button';
    removeProfile.addEventListener('click', async () => {
      if (
        !window.confirm(
          `Remove model profile “${profileName}”? Profiles selected as default, fallback, review, or plan models must be switched first.`,
        )
      )
        return;
      removeProfile.disabled = true;
      try {
        const result = await client.updateSettings({ models: { [profileName]: null } });
        runtimeSettings = result.settings;
        modelProfiles = runtimeSettings.models || {};
        showToast(`Model profile ${profileName} removed.`);
        await openSettings();
        void initialize();
      } catch (error) {
        showToast(`Could not remove ${profileName}: ${error.message}`);
      } finally {
        removeProfile.disabled = false;
      }
    });
    const credentialState = node(
      'span',
      'muted-copy',
      definition.credential_configured ? 'A credential reference is configured.' : 'This profile has no credential reference.',
    );
    actions.append(saveProfile, removeProfile, credentialState);
    profile.append(actions);
    providersSection.append(profile);
  }

  const connectionsSection = node('fieldset', 'settings-budget-editor settings-autonomy-editor');
  connectionsSection.append(node('legend', '', 'Model connections'));
  const connectionButton = node('button', 'send-button', 'Test model connections');
  connectionButton.type = 'button';
  const connectionResults = node('div', 'connection-test-results');
  connectionResults.setAttribute('aria-live', 'polite');
  connectionButton.addEventListener('click', async () => {
    connectionButton.disabled = true;
    connectionResults.replaceChildren(node('p', 'muted-copy', 'Checking configured providers…'));
    try {
      const results = await client.listModels();
      const rows = results.map((result) => {
        const row = node('div', `connection-test-row${result.error ? ' failed' : ' ready'}`);
        const summary = result.error
          ? `${result.profile}: ${result.error}`
          : `${result.profile}: connected · ${result.models.length} model${result.models.length === 1 ? '' : 's'} available`;
        row.append(node('strong', '', summary));
        if (!result.error && result.models.length) {
          const ids = node('span', 'connection-test-models', result.models.slice(0, 12).join(', '));
          row.append(ids);
        }
        return row;
      });
      if (!rows.length) rows.push(node('p', 'muted-copy', 'No model profiles are configured.'));
      connectionResults.replaceChildren(...rows);
    } catch (error) {
      connectionResults.replaceChildren(node('p', 'muted-copy', `Connection check failed: ${error.message}`));
    } finally {
      connectionButton.disabled = false;
    }
  });
  connectionsSection.append(connectionButton, connectionResults);

  const approvalsSection = node('fieldset', 'settings-budget-editor settings-approval-editor');
  approvalsSection.append(node('legend', '', 'Temporary approval rules'));
  approvalsSection.append(
    node(
      'p',
      'muted-copy',
      'In Assisted mode, rules are workspace-scoped, audited, and expire automatically. Allow rules apply only to the selected tool and pattern. Unrestricted mode bypasses Xyst AI Assistant approval rules; OS permissions and sandbox limits still apply.',
    ),
  );
  const ruleForm = node('div', 'approval-rule-form');
  ruleForm.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') event.preventDefault();
  });
  const ruleTool = node('select', 'data-picker');
  ruleTool.setAttribute('aria-label', 'Approval rule tool');
  const ruleTools = [
    'read_file',
    'list_dir',
    'search_files',
    'semantic_search',
    'web_search',
    'delegate_task',
    'list_skills',
    'load_skill',
    'write_file',
    'edit_file',
    'run_process',
    'run_shell_script',
    'computer_control',
    'start_background_process',
    'send_background_input',
    'list_background_processes',
    'read_background_process',
    'stop_background_process',
  ];
  for (const value of ruleTools) {
    const option = node('option', '', value);
    option.value = value;
    ruleTool.append(option);
  }
  const ruleScope = node('select', 'data-picker');
  ruleScope.setAttribute('aria-label', 'Approval rule scope');
  for (const [value, label] of [
    ['tool', 'Entire tool'],
    ['path_glob', 'Workspace path glob'],
    ['command_glob', 'Command glob'],
  ]) {
    const option = node('option', '', label);
    option.value = value;
    ruleScope.append(option);
  }
  const rulePattern = node('input', 'data-input');
  rulePattern.placeholder = 'Example: generated/**/*.ts';
  rulePattern.setAttribute('aria-label', 'Approval rule pattern');
  const ruleDecision = node('select', 'data-picker');
  ruleDecision.setAttribute('aria-label', 'Approval rule decision');
  for (const value of ['allow', 'deny']) {
    const option = node('option', '', value === 'allow' ? 'Allow matching actions' : 'Deny matching actions');
    option.value = value;
    ruleDecision.append(option);
  }
  const ruleDuration = node('select', 'data-picker');
  ruleDuration.setAttribute('aria-label', 'Approval rule duration');
  for (const [value, label] of [
    [3_600_000, '1 hour'],
    [86_400_000, '1 day'],
    [604_800_000, '7 days'],
    [2_592_000_000, '30 days'],
  ]) {
    const option = node('option', '', label);
    option.value = String(value);
    ruleDuration.append(option);
  }
  const updateRuleScope = () => {
    if (ruleScope.value === 'path_glob' && !['write_file', 'edit_file'].includes(ruleTool.value)) ruleTool.value = 'write_file';
    if (ruleScope.value === 'command_glob' && ruleTool.value !== 'run_process') ruleTool.value = 'run_process';
    rulePattern.hidden = ruleScope.value === 'tool';
    rulePattern.required = ruleScope.value !== 'tool';
    rulePattern.placeholder =
      ruleScope.value === 'path_glob' ? 'Workspace-relative glob, e.g. generated/**/*.ts' : 'Command glob, e.g. git status*';
  };
  ruleScope.addEventListener('change', updateRuleScope);
  ruleTool.addEventListener('change', () => {
    if (ruleScope.value === 'path_glob' && !['write_file', 'edit_file'].includes(ruleTool.value)) ruleScope.value = 'tool';
    if (ruleScope.value === 'command_glob' && ruleTool.value !== 'run_process') ruleScope.value = 'tool';
    updateRuleScope();
  });
  const createRule = node('button', 'send-button', 'Add rule');
  createRule.type = 'button';
  createRule.addEventListener('click', async () => {
    updateRuleScope();
    if (ruleScope.value !== 'tool' && !rulePattern.value.trim()) {
      rulePattern.focus();
      return;
    }
    if (ruleDecision.value === 'allow') {
      const target = ruleScope.value === 'tool' ? ruleTool.value : `${ruleTool.value} matching ${rulePattern.value.trim()}`;
      if (!window.confirm(`Allow ${target} without asking in Assisted mode for the selected duration?`)) return;
    }
    createRule.disabled = true;
    try {
      await client.createApprovalRule({
        tool: ruleTool.value,
        scope: ruleScope.value,
        ...(ruleScope.value === 'tool' ? {} : { pattern: rulePattern.value.trim() }),
        decision: ruleDecision.value,
        duration_ms: Number(ruleDuration.value),
      });
      rulePattern.value = '';
      showToast('Temporary approval rule added and audited.');
      await refreshApprovalRules();
    } catch (error) {
      showToast(`Could not add approval rule: ${error.message}`);
    } finally {
      createRule.disabled = false;
    }
  });
  ruleForm.append(ruleTool, ruleScope, rulePattern, ruleDecision, ruleDuration, createRule);
  const ruleList = node('div', 'approval-rule-list');
  const refreshApprovalRules = async () => {
    ruleList.replaceChildren(node('p', 'muted-copy', 'Loading approval rules…'));
    try {
      const rules = await client.listApprovalRules();
      const rows = rules.map((rule) => {
        const row = node('div', `approval-rule-row${rule.status === 'expired' ? ' expired' : ''}`);
        const details = rule.scope === 'tool' ? rule.tool : `${rule.tool} · ${rule.pattern}`;
        const text = `${rule.decision.toUpperCase()} · ${details} · ${rule.status} · expires ${new Date(rule.expires_at).toLocaleString()}`;
        row.append(node('span', '', text));
        const revoke = node('button', 'text-button danger-text', 'Revoke');
        revoke.type = 'button';
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          try {
            await client.revokeApprovalRule(rule.id);
            await refreshApprovalRules();
          } catch (error) {
            showToast(`Could not revoke rule: ${error.message}`);
            revoke.disabled = false;
          }
        });
        row.append(revoke);
        return row;
      });
      if (!rows.length) rows.push(node('p', 'muted-copy', 'No temporary approval rules.'));
      ruleList.replaceChildren(...rows);
    } catch (error) {
      ruleList.replaceChildren(node('p', 'muted-copy', `Could not load approval rules: ${error.message}`));
    }
  };
  updateRuleScope();
  void refreshApprovalRules();
  approvalsSection.append(ruleForm, ruleList);

  const sandboxSection = node('fieldset', 'settings-budget-editor settings-autonomy-editor');
  sandboxSection.append(node('legend', '', 'Process sandbox'));
  const sandboxLabel = node('label', 'budget-setting');
  sandboxLabel.append(node('span', '', 'Sandbox policy'));
  const sandboxMode = node('select', 'data-picker');
  for (const [value, label] of [
    ['none', 'None · use account permissions'],
    ['workspace-write', 'Workspace write · isolate process with workspace access'],
    ['workspace-read', 'Workspace read · isolate process with read-only workspace'],
    ['read-only', 'Read-only · expose only non-mutating tools'],
  ]) {
    const option = node('option', '', label);
    option.value = value;
    if (
      ['workspace-write', 'workspace-read'].includes(value) &&
      (!settings.sandbox?.available || settings.tools?.autonomy === 'unrestricted' || settings.tools?.filesystem_scope === 'machine')
    )
      option.disabled = true;
    sandboxMode.append(option);
  }
  sandboxMode.value = settings.sandbox?.mode || 'none';
  sandboxLabel.append(sandboxMode);
  const sandboxToolOverrides = node('div', 'budget-setting');
  sandboxToolOverrides.append(node('span', '', 'Process-tool overrides'));
  const sandboxToolSelectors = {};
  for (const [toolName, label] of [
    ['run_process', 'Run process'],
    ['run_shell_script', 'Run shell script'],
    ['start_background_process', 'Start background process'],
  ]) {
    const overrideLabel = node('label', 'budget-setting');
    overrideLabel.append(node('span', '', label));
    const overrideSelect = node('select', 'data-picker');
    for (const [value, title] of [
      ['inherit', 'Follow global policy'],
      ['workspace-write', 'Workspace write'],
      ['workspace-read', 'Workspace read-only'],
      ['read-only', 'Disable this process tool'],
    ]) {
      const option = node('option', '', title);
      option.value = value;
      if (
        ['workspace-write', 'workspace-read'].includes(value) &&
        (!settings.sandbox?.available || settings.tools?.autonomy === 'unrestricted' || settings.tools?.filesystem_scope === 'machine')
      )
        option.disabled = true;
      overrideSelect.append(option);
    }
    overrideSelect.value = settings.sandbox?.tools?.[toolName] || 'inherit';
    overrideSelect.disabled = sandboxMode.value === 'read-only';
    overrideSelect.addEventListener('change', () => {
      if (overrideSelect.value !== 'inherit' && overrideSelect.value !== 'read-only') {
        const rank = { none: 0, 'workspace-write': 1, 'workspace-read': 2, 'read-only': 3 };
        if (rank[overrideSelect.value] < rank[sandboxMode.value]) overrideSelect.value = 'inherit';
      }
    });
    sandboxToolSelectors[toolName] = overrideSelect;
    overrideLabel.append(overrideSelect);
    sandboxToolOverrides.append(overrideLabel);
  }
  sandboxMode.addEventListener('change', () => {
    for (const select of Object.values(sandboxToolSelectors)) select.disabled = sandboxMode.value === 'read-only';
  });
  const sandboxSave = node('button', 'send-button', 'Save sandbox setting');
  sandboxSave.type = 'button';
  sandboxSave.addEventListener('click', async () => {
    if (
      ['workspace-write', 'workspace-read'].includes(sandboxMode.value) &&
      !['workspace-write', 'workspace-read'].includes(settings.sandbox?.mode) &&
      !window.confirm(
        'Require OS process isolation with workspace file access? Process calls will fail instead of running unsandboxed when the isolation backend is unavailable. File-tool access remains governed separately.',
      )
    )
      return;
    sandboxSave.disabled = true;
    try {
      const tools = {};
      for (const [toolName, select] of Object.entries(sandboxToolSelectors)) {
        const value = select.value === 'inherit' ? null : select.value;
        const previous = settings.sandbox?.tools?.[toolName] || null;
        if (value !== previous) tools[toolName] = value;
      }
      const sandboxPatch = { mode: sandboxMode.value };
      if (Object.keys(tools).length) sandboxPatch.tools = tools;
      const result = await client.updateSettings({ sandbox: sandboxPatch });
      runtimeSettings = result.settings;
      showToast(`Sandbox mode set to ${sandboxMode.value}.`);
      await openSettings();
    } catch (error) {
      showToast(`Could not change sandbox mode: ${error.message}`);
    } finally {
      sandboxSave.disabled = false;
    }
  });
  const sandboxMessage = !settings.sandbox?.available
    ? settings.sandbox?.reason === 'unsupported_platform'
      ? 'Workspace process isolation is unavailable on this platform.'
      : settings.sandbox?.reason === 'windows_appcontainer_helper_unavailable'
        ? 'The packaged Windows AppContainer helper is unavailable. Workspace isolation cannot be selected.'
        : 'A trusted system Bubblewrap executable is unavailable. Workspace isolation cannot be selected.'
    : settings.tools?.autonomy === 'unrestricted' || settings.tools?.filesystem_scope === 'machine'
      ? 'Switch to Assisted mode and workspace filesystem access before selecting workspace process isolation.'
      : 'Workspace process modes fail closed if OS isolation cannot start. Read-only mode limits the tools available during agent runs.';
  sandboxSection.append(
    sandboxLabel,
    sandboxToolOverrides,
    sandboxSave,
    node(
      'p',
      'muted-copy',
      `${sandboxMessage} Pause every active run before changing autonomy or sandbox settings; changes apply when the runs resume.`,
    ),
  );

  const autonomySection = node('fieldset', 'settings-budget-editor settings-autonomy-editor');
  autonomySection.append(node('legend', '', 'Automation access'));
  const autonomyLabel = node('label', 'budget-setting');
  autonomyLabel.append(node('span', '', 'Tool approval mode'));
  const autonomy = node('select', 'data-picker');
  autonomy.name = 'tools.autonomy';
  for (const [value, label] of [
    ['assisted', 'Assisted · ask before changes'],
    ['unrestricted', 'Unrestricted · no Xyst AI Assistant approvals or usage caps'],
  ]) {
    const option = node('option', '', label);
    option.value = value;
    if (value === 'unrestricted' && ['workspace-write', 'workspace-read'].includes(settings.sandbox?.mode)) option.disabled = true;
    autonomy.append(option);
  }
  autonomy.value = settings.tools?.autonomy === 'unrestricted' ? 'unrestricted' : 'assisted';
  autonomy.addEventListener('change', () => {
    autonomy.dataset.dirty = 'true';
  });
  autonomyLabel.append(autonomy);
  autonomySection.append(
    autonomyLabel,
    node(
      'p',
      'muted-copy',
      ['workspace-write', 'workspace-read'].includes(settings.sandbox?.mode)
        ? 'Unrestricted mode is unavailable while workspace process isolation is active.'
        : 'Unrestricted mode removes Xyst AI Assistant approval prompts and configured token/cost caps, enables machine-wide file and process access, and includes unredacted data. The OS account, model context/output limits, and explicit cancellation still apply. Pause every active run before changing autonomy; the change takes effect when the runs resume.',
    ),
  );

  const layoutSection = node('fieldset', 'settings-budget-editor settings-autonomy-editor');
  layoutSection.append(node('legend', '', 'Interface layout'));
  const collapsedLabel = node('label', 'settings-checkbox');
  const collapsed = node('input');
  collapsed.type = 'checkbox';
  collapsed.name = 'ui.sidebar_collapsed';
  collapsed.checked = settings.ui?.sidebar_collapsed === true;
  collapsed.addEventListener('change', () => {
    collapsed.dataset.dirty = 'true';
  });
  collapsedLabel.append(collapsed, document.createTextNode('Start with the sidebar collapsed'));
  layoutSection.append(
    collapsedLabel,
    node('p', 'muted-copy', 'Saved to your user settings; the sidebar preference applies now and on the next launch.'),
  );
  const shortcutsLabel = node('label', 'settings-checkbox');
  const shortcuts = node('input');
  shortcuts.type = 'checkbox';
  shortcuts.name = 'ui.shortcuts_enabled';
  shortcuts.checked = settings.ui?.shortcuts_enabled !== false;
  shortcuts.addEventListener('change', () => {
    shortcuts.dataset.dirty = 'true';
  });
  shortcutsLabel.append(shortcuts, document.createTextNode('Enable app navigation shortcuts'));
  layoutSection.append(shortcutsLabel);
  const shortcutInputs = {};
  for (const [action, labelText] of [
    ['toggle_sidebar', 'Toggle sidebar'],
    ['new_session', 'Start new session'],
    ['focus_search', 'Focus workspace search'],
  ]) {
    const label = node('label', 'budget-setting');
    label.append(node('span', '', `${labelText} shortcut`));
    const input = node('input', 'data-input');
    input.type = 'text';
    input.maxLength = 16;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = settings.ui?.shortcuts?.[action] ?? DEFAULT_UI_SHORTCUTS[action];
    input.setAttribute('aria-label', `${labelText} shortcut`);
    input.addEventListener('change', () => {
      input.value = input.value.trim();
      input.dataset.dirty = 'true';
    });
    label.append(input);
    shortcutInputs[action] = input;
    layoutSection.append(label);
  }
  layoutSection.append(
    node(
      'p',
      'muted-copy',
      'Use Ctrl+letter, Alt+letter, optionally with Shift, or /. Clear a binding to restore its default. Shortcuts are inactive while editing text.',
    ),
  );

  const themeSection = node('fieldset', 'settings-budget-editor settings-autonomy-editor');
  themeSection.append(node('legend', '', 'Appearance'));
  const themeLabel = node('label', 'budget-setting');
  themeLabel.append(node('span', '', 'Color theme'));
  const theme = node('select', 'data-picker');
  theme.name = 'ui.theme';
  for (const [value, label] of [
    ['system', 'Use system setting'],
    ['dark', 'Dark'],
    ['light', 'Light'],
  ]) {
    const option = node('option', '', label);
    option.value = value;
    theme.append(option);
  }
  theme.value = settings.ui?.theme || 'system';
  theme.addEventListener('change', () => {
    theme.dataset.dirty = 'true';
  });
  themeLabel.append(theme);
  themeSection.append(themeLabel, node('p', 'muted-copy', 'Saved to your settings and applied immediately.'));

  const dataDirectorySection = node('fieldset', 'settings-budget-editor settings-autonomy-editor');
  dataDirectorySection.append(node('legend', '', 'User data location'));
  const dataDirectoryLabel = node('label', 'budget-setting');
  dataDirectoryLabel.append(node('span', '', 'Data directory'));
  const dataDirectory = node('input', 'data-input');
  dataDirectory.type = 'text';
  dataDirectory.autocomplete = 'off';
  dataDirectory.spellcheck = false;
  dataDirectory.maxLength = 4096;
  dataDirectory.value = settings.app_data?.directory || '';
  dataDirectory.setAttribute('aria-label', 'Xyst AI Assistant user data directory');
  dataDirectory.addEventListener('input', () => (dataDirectory.dataset.dirty = 'true'));
  dataDirectoryLabel.append(dataDirectory);
  const defaultDataDirectory = node('button', 'text-button', 'Use default location');
  defaultDataDirectory.type = 'button';
  defaultDataDirectory.addEventListener('click', () => {
    dataDirectory.value = '';
    dataDirectory.dataset.dirty = 'true';
  });
  dataDirectorySection.append(
    dataDirectoryLabel,
    defaultDataDirectory,
    node(
      'p',
      'muted-copy',
      'Use an absolute path. This currently stores cross-project global memory. Existing files stay in the old location and are not moved automatically.',
    ),
  );

  const memorySection = node('fieldset', 'settings-budget-editor settings-autonomy-editor');
  memorySection.append(node('legend', '', 'Memory'));
  const globalMemoryLabel = node('label', 'settings-checkbox');
  const globalMemory = node('input');
  globalMemory.type = 'checkbox';
  globalMemory.name = 'memory.global_enabled';
  globalMemory.checked = settings.memory?.global_enabled === true;
  globalMemory.addEventListener('change', () => (globalMemory.dataset.dirty = 'true'));
  globalMemoryLabel.append(globalMemory, document.createTextNode('Use global user memory across projects'));
  memorySection.append(
    globalMemoryLabel,
    node(
      'p',
      'muted-copy',
      'When enabled, saved global notes may be sent as bounded, untrusted context to your selected model. You can review and edit them from Memory.',
    ),
  );

  const webSearchSection = node('fieldset', 'settings-budget-editor settings-autonomy-editor');
  webSearchSection.append(node('legend', '', 'Live web search'));
  const webSearchEnabledLabel = node('label', 'settings-checkbox');
  const webSearchEnabled = node('input');
  webSearchEnabled.type = 'checkbox';
  webSearchEnabled.checked = settings.web_search?.enabled === true;
  webSearchEnabled.addEventListener('change', () => (webSearchEnabled.dataset.dirty = 'true'));
  webSearchEnabledLabel.append(webSearchEnabled, document.createTextNode('Enable automatic live lookups'));
  const webSearchProviderLabel = node('label', 'budget-setting');
  webSearchProviderLabel.append(node('span', '', 'Search source'));
  const webSearchProvider = node('select', 'data-picker');
  for (const [value, label] of [
    ['automatic', 'Automatic · live news + references, no API key'],
    ['wikipedia', 'Wikipedia · free, no API key'],
    ['brave', 'Brave Search · broader web, optional API key'],
  ]) {
    const option = node('option', '', label);
    option.value = value;
    webSearchProvider.append(option);
  }
  webSearchProvider.value = resolveWebSearchProvider(undefined, settings.web_search?.provider);
  webSearchProviderLabel.append(webSearchProvider);
  const webSearchCredentialKeyLabel = node('label', 'budget-setting');
  webSearchCredentialKeyLabel.append(node('span', '', 'Credential vault key'));
  const webSearchCredentialKey = node('input', 'data-input');
  webSearchCredentialKey.autocomplete = 'off';
  webSearchCredentialKey.maxLength = 128;
  webSearchCredentialKey.value = 'brave.search';
  webSearchCredentialKeyLabel.append(webSearchCredentialKey);
  const webSearchCredentialLabel = node('label', 'budget-setting');
  webSearchCredentialLabel.append(node('span', '', 'Optional Brave Search API key'));
  const webSearchCredential = node('input', 'data-input');
  webSearchCredential.type = 'password';
  webSearchCredential.autocomplete = 'new-password';
  webSearchCredential.maxLength = 4096;
  webSearchCredential.placeholder = settings.web_search?.credential_configured
    ? 'Saved in the OS credential vault'
    : 'Optional: enter a key to use Brave Search';
  webSearchCredentialLabel.append(webSearchCredential);
  const webSearchState = node(
    'p',
    'muted-copy',
    settings.web_search?.credential_configured
      ? 'A Brave credential reference is configured. Enter a new key only to replace it. If the key is unavailable or rejected, Xyst switches to keyless search automatically.'
      : 'No Brave key is configured. Automatic live news and reference lookups work without one; add a Brave key only for broader web coverage.',
  );
  const updateWebSearchProviderFields = () => {
    const needsCredential = webSearchProvider.value === 'brave';
    webSearchCredentialKeyLabel.hidden = !needsCredential;
    webSearchCredentialLabel.hidden = !needsCredential;
    webSearchState.hidden = !needsCredential;
    webSearchEnabledLabel.lastChild.textContent = needsCredential
      ? 'Enable live lookups; use Brave when its key is available'
      : 'Enable automatic keyless news and reference lookups';
  };
  webSearchProvider.addEventListener('change', () => {
    webSearchProvider.dataset.dirty = 'true';
    updateWebSearchProviderFields();
  });
  updateWebSearchProviderFields();
  webSearchSection.append(
    webSearchEnabledLabel,
    webSearchProviderLabel,
    webSearchCredentialKeyLabel,
    webSearchCredentialLabel,
    webSearchState,
    node(
      'p',
      'muted-copy',
      'The agent automatically searches when a request needs current information. Automatic search uses public sources without an account or API key. If Brave is selected but its key is missing or rejected, Xyst switches to keyless search; results remain untrusted input.',
    ),
  );

  const appUpdatesSection = node('fieldset', 'settings-budget-editor settings-autonomy-editor');
  appUpdatesSection.append(node('legend', '', 'Application updates'));
  const appUpdateModeLabel = node('label', 'budget-setting');
  appUpdateModeLabel.append(node('span', '', 'Update checks'));
  const appUpdateMode = node('select', 'data-picker');
  appUpdateMode.name = 'app_updates.mode';
  for (const [value, label] of [
    ['disabled', 'Never check'],
    ['manual', 'Only when I check'],
    ['notify', 'Check when Xyst AI Assistant starts and notify me'],
  ]) {
    const option = node('option', '', label);
    option.value = value;
    appUpdateMode.append(option);
  }
  appUpdateMode.value = settings.app_updates?.mode || 'disabled';
  appUpdateMode.addEventListener('change', () => (appUpdateMode.dataset.dirty = 'true'));
  appUpdateModeLabel.append(appUpdateMode);
  const appUpdateChannelLabel = node('label', 'budget-setting');
  appUpdateChannelLabel.append(node('span', '', 'Release channel'));
  const appUpdateChannel = node('select', 'data-picker');
  appUpdateChannel.name = 'app_updates.channel';
  for (const [value, label] of [
    ['stable', 'Stable'],
    ['preview', 'Preview'],
  ]) {
    const option = node('option', '', label);
    option.value = value;
    appUpdateChannel.append(option);
  }
  appUpdateChannel.value = settings.app_updates?.channel || 'stable';
  appUpdateChannel.addEventListener('change', () => (appUpdateChannel.dataset.dirty = 'true'));
  appUpdateChannelLabel.append(appUpdateChannel);
  const appUpdateFeedLabel = node('label', 'budget-setting');
  appUpdateFeedLabel.append(node('span', '', 'Signed release feed URL'));
  const appUpdateFeed = node('input', 'data-input');
  appUpdateFeed.type = 'url';
  appUpdateFeed.autocomplete = 'off';
  appUpdateFeed.maxLength = 2048;
  appUpdateFeed.value = settings.app_updates?.feed_url || '';
  appUpdateFeed.placeholder = 'https://updates.example.com/xyst/releases.json';
  appUpdateFeed.addEventListener('input', () => (appUpdateFeed.dataset.dirty = 'true'));
  appUpdateFeedLabel.append(appUpdateFeed);
  const appUpdateKeyIdLabel = node('label', 'budget-setting');
  appUpdateKeyIdLabel.append(node('span', '', 'Trusted signing key ID'));
  const appUpdateKeyId = node('input', 'data-input');
  appUpdateKeyId.autocomplete = 'off';
  appUpdateKeyId.maxLength = 128;
  appUpdateKeyId.value = settings.app_updates?.key_id || '';
  appUpdateKeyId.placeholder = 'key received through a trusted channel';
  appUpdateKeyId.addEventListener('input', () => (appUpdateKeyId.dataset.dirty = 'true'));
  appUpdateKeyIdLabel.append(appUpdateKeyId);
  const appUpdateKeyLabel = node('label', 'budget-setting');
  appUpdateKeyLabel.append(node('span', '', 'Trusted Ed25519 public key'));
  const appUpdateKey = node('textarea', 'data-input');
  appUpdateKey.rows = 4;
  appUpdateKey.maxLength = 8192;
  appUpdateKey.autocomplete = 'off';
  appUpdateKey.spellcheck = false;
  appUpdateKey.placeholder = 'Paste the release signing public key. Leave blank to keep the saved key.';
  appUpdateKey.addEventListener('input', () => (appUpdateKey.dataset.dirty = 'true'));
  appUpdateKeyLabel.append(appUpdateKey);
  const appUpdateFingerprint = node(
    'p',
    'muted-copy',
    settings.app_updates?.key_fingerprint
      ? `Saved signer fingerprint: ${settings.app_updates.key_fingerprint}. Compare this value with a trusted Xyst AI Assistant release source.`
      : 'No release signer is configured. Obtain its public key and fingerprint from a trusted Xyst AI Assistant release source.',
  );
  const appUpdateCheck = node('button', 'text-button', 'Check for updates now');
  appUpdateCheck.type = 'button';
  appUpdateCheck.disabled = !settings.app_updates?.feed_configured || appUpdateMode.value === 'disabled';
  const appUpdateResult = node('div', 'app-update-result');
  appUpdateResult.setAttribute('aria-live', 'polite');
  appUpdateCheck.addEventListener('click', async () => {
    appUpdateCheck.disabled = true;
    appUpdateResult.replaceChildren(node('p', 'muted-copy', 'Checking the signed release feed…'));
    try {
      const result = await client.checkApplicationUpdates();
      renderApplicationUpdateResult(appUpdateResult, result, client);
    } catch (error) {
      appUpdateResult.replaceChildren(node('p', 'muted-copy', `Update check failed: ${error.message}`));
    } finally {
      appUpdateCheck.disabled = !runtimeSettings.app_updates?.feed_configured || runtimeSettings.app_updates?.mode === 'disabled';
    }
  });
  appUpdatesSection.append(
    appUpdateModeLabel,
    appUpdateChannelLabel,
    appUpdateFeedLabel,
    appUpdateKeyIdLabel,
    appUpdateKeyLabel,
    appUpdateFingerprint,
    appUpdateCheck,
    appUpdateResult,
    node(
      'p',
      'muted-copy',
      'Update checks require a trusted Ed25519 release feed. Xyst AI Assistant downloads only after you choose, verifies the complete installer against the signed SHA-256 and size, and never installs it automatically.',
    ),
  );

  const budgetSection = node('fieldset', 'settings-budget-editor');
  budgetSection.append(node('legend', '', 'Assisted-mode budget caps · blank removes the cap'));
  budgetSection.append(
    node(
      'p',
      'muted-copy',
      'These caps are enforced in Assisted mode. Unrestricted runs ignore configured token and cost caps; the selected provider still applies its own context, output, and billing limits.',
    ),
  );
  const budgetNames = [
    ['max_turns', 'Maximum model turns', 'Default: 8 turns'],
    ['max_input_tokens', 'Per run input tokens'],
    ['max_output_tokens', 'Per run output tokens'],
    ['max_tool_output_bytes', 'Maximum tool output bytes'],
    ['max_session_input_tokens', 'Session input tokens'],
    ['max_session_output_tokens', 'Session output tokens'],
    ['recovery_summary_input_tokens', 'Recovery summary input reserve', 'Default: 1024 tokens'],
    ['final_response_reserve_tokens', 'Final response reserve', 'Default: up to 512 tokens'],
    ['max_session_cost', 'Session estimated cost (USD)'],
    ['max_daily_input_tokens', 'Daily input tokens'],
    ['max_daily_output_tokens', 'Daily output tokens'],
    ['max_monthly_input_tokens', 'Monthly input tokens'],
    ['max_monthly_output_tokens', 'Monthly output tokens'],
    ['max_daily_cost', 'Daily estimated cost (USD)'],
    ['max_monthly_cost', 'Monthly estimated cost (USD)'],
  ];
  for (const [key, label, placeholder] of budgetNames) {
    const wrapper = node('label', 'budget-setting');
    wrapper.append(node('span', '', label));
    const input = node('input', 'data-input');
    input.name = `budgets.${key}`;
    input.type = 'number';
    input.min = key.endsWith('_cost') || key === 'recovery_summary_input_tokens' ? '0' : '1';
    input.step = key.endsWith('_cost') ? '0.0001' : '1';
    input.value = settings.budgets?.[key] ?? '';
    input.placeholder = placeholder || 'No cap';
    input.addEventListener('change', () => {
      input.dataset.dirty = 'true';
    });
    wrapper.append(input);
    budgetSection.append(wrapper);
  }
  const save = node('button', 'send-button', 'Save settings');
  save.type = 'submit';
  const note = node(
    'p',
    'muted-copy',
    'Changes apply to new runs and are saved in a separate user settings file. Clearing a field removes its override. Credential values are not editable here.',
  );
  form.append(
    modelLabel,
    routingEnabledLabel,
    routingLabel,
    localLabel,
    orchestrationSection,
    providersSection,
    connectionsSection,
    approvalsSection,
    sandboxSection,
    autonomySection,
    layoutSection,
    themeSection,
    dataDirectorySection,
    memorySection,
    webSearchSection,
    appUpdatesSection,
    budgetSection,
    save,
    note,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const patch = {};
      if (model.dataset.dirty === 'true' && model.value) patch.default_model = model.value;
      for (const key of ['review_model', 'plan_model']) {
        if (roleModels[key].dataset.dirty === 'true') patch[key] = roleModels[key].value || null;
      }
      const routingPatch = {};
      if (routingEnabled.dataset.dirty === 'true') routingPatch.enabled = routingEnabled.checked;
      if (routing.dataset.dirty === 'true') routingPatch.selection = routing.value;
      if (local.dataset.dirty === 'true') routingPatch.prefer_local = local.checked;
      if (Object.keys(routingPatch).length) patch.routing = routingPatch;
      const subagentsPatch = {};
      if (subagentsEnabled.dataset.dirty === 'true') subagentsPatch.enabled = subagentsEnabled.checked;
      if (subagentsConcurrency.dataset.dirty === 'true') subagentsPatch.max_concurrent = Number(subagentsConcurrency.value);
      if (Object.keys(subagentsPatch).length) patch.subagents = subagentsPatch;
      if (autonomy.dataset.dirty === 'true') {
        if (
          autonomy.value === 'unrestricted' &&
          settings.tools?.autonomy !== 'unrestricted' &&
          !window.confirm(
            'Enable unrestricted autonomy? Xyst AI Assistant will not ask before file or process actions, can access credential files and paths across this machine, and will ignore configured token and cost caps. Tool content may include secrets and is sent to the selected model. The OS account and model context/output limits still apply.',
          )
        ) {
          save.disabled = false;
          return;
        }
        patch.tools = { autonomy: autonomy.value };
      }
      if (collapsed.dataset.dirty === 'true') patch.ui = { sidebar_collapsed: collapsed.checked };
      if (theme.dataset.dirty === 'true') patch.ui = { ...(patch.ui || {}), theme: theme.value };
      if (shortcuts.dataset.dirty === 'true') patch.ui = { ...(patch.ui || {}), shortcuts_enabled: shortcuts.checked };
      const shortcutPatch = {};
      for (const [action, input] of Object.entries(shortcutInputs)) {
        if (input.dataset.dirty === 'true') shortcutPatch[action] = input.value || null;
      }
      if (Object.keys(shortcutPatch).length) patch.ui = { ...(patch.ui || {}), shortcuts: shortcutPatch };
      if (globalMemory.dataset.dirty === 'true') {
        if (
          globalMemory.checked &&
          settings.memory?.global_enabled !== true &&
          !window.confirm(
            'Enable global user memory? Its saved notes may be included as untrusted context in model requests across projects.',
          )
        ) {
          save.disabled = false;
          return;
        }
        patch.memory = { global_enabled: globalMemory.checked };
      }
      if (dataDirectory.dataset.dirty === 'true') patch.app_data = { directory: dataDirectory.value.trim() || null };
      const webSearchPatch = {};
      if (webSearchEnabled.dataset.dirty === 'true') webSearchPatch.enabled = webSearchEnabled.checked;
      if (webSearchProvider.dataset.dirty === 'true') webSearchPatch.provider = webSearchProvider.value;
      if (webSearchCredential.value) {
        const credentialKey = webSearchCredentialKey.value.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(credentialKey)) throw new Error('Enter a valid credential vault key.');
        await client.storeCredential(credentialKey, webSearchCredential.value);
        webSearchPatch.api_key_secret = credentialKey;
        webSearchPatch.api_key_env = null;
      }
      const nextWebSearchProvider = resolveWebSearchProvider(webSearchPatch.provider, settings.web_search?.provider);
      if (Object.keys(webSearchPatch).length) {
        webSearchPatch.provider = nextWebSearchProvider;
        patch.web_search = webSearchPatch;
      }
      const appUpdatePatch = {};
      if (appUpdateMode.dataset.dirty === 'true') appUpdatePatch.mode = appUpdateMode.value;
      if (appUpdateChannel.dataset.dirty === 'true') appUpdatePatch.channel = appUpdateChannel.value;
      if (appUpdateFeed.dataset.dirty === 'true') appUpdatePatch.feed_url = appUpdateFeed.value.trim() || null;
      if (appUpdateKeyId.dataset.dirty === 'true') appUpdatePatch.key_id = appUpdateKeyId.value.trim() || null;
      if (appUpdateKey.dataset.dirty === 'true') appUpdatePatch.public_key = appUpdateKey.value.trim() || null;
      if (Object.keys(appUpdatePatch).length) {
        const changedTrustRoot = appUpdatePatch.key_id || appUpdatePatch.public_key;
        if (
          changedTrustRoot &&
          !window.confirm(
            `Trust application updates signed by key '${appUpdatePatch.key_id || settings.app_updates?.key_id || 'new key'}'? Verify the key with a trusted Xyst AI Assistant release source. The saved fingerprint will be shown in Runtime settings. No update will be installed automatically.`,
          )
        ) {
          save.disabled = false;
          return;
        }
        patch.app_updates = appUpdatePatch;
      }
      const budgets = {};
      for (const [key] of budgetNames) {
        const input = form.elements.namedItem(`budgets.${key}`);
        if (input.dataset.dirty !== 'true') continue;
        budgets[key] = input.value === '' ? null : Number(input.value);
      }
      if (Object.keys(budgets).length) patch.budgets = budgets;
      if (!Object.keys(patch).length) {
        save.disabled = false;
        showToast('Change at least one setting before saving.');
        return;
      }
      const result = await client.updateSettings(patch);
      runtimeSettings = result.settings;
      appUpdateCheck.disabled = !runtimeSettings.app_updates?.feed_configured || runtimeSettings.app_updates?.mode === 'disabled';
      applyUiPreferences(runtimeSettings.ui);
      modelProfiles = runtimeSettings.models || modelProfiles;
      if (runtimeSettings.default_model) {
        let option = [...elements.model_picker.options].find((item) => item.value === runtimeSettings.default_model);
        if (!option) {
          option = node(
            'option',
            '',
            `${runtimeSettings.default_model} · ${modelProfiles[runtimeSettings.default_model]?.model || 'configured'}`,
          );
          option.value = runtimeSettings.default_model;
          elements.model_picker.append(option);
        }
        elements.model_picker.value = runtimeSettings.default_model;
      }
      const globalMemoryMigration = result.data_migration?.global_memory;
      const dataDirectoryMessage = globalMemoryMigration
        ? globalMemoryMigration.copied > 0
          ? `Copied ${globalMemoryMigration.copied} global memory ${globalMemoryMigration.copied === 1 ? 'item' : 'items'} to the new data directory. The original remains as a backup.`
          : globalMemoryMigration.already_present > 0
            ? 'Global memory is already present in the new data directory. The original remains as a backup.'
            : 'No global memory items needed copying. The original directory remains unchanged.'
        : 'New runs will use the updated data directory.';
      showToast(
        patch.app_data ? `Settings saved. ${dataDirectoryMessage}` : 'Settings saved. New runs will use the updated configuration.',
      );
      renderRunInspector();
      await openSettings();
    } catch (error) {
      showError(error);
      save.disabled = false;
    }
  });
  return form;
}

function renderApplicationUpdateResult(target, result, client) {
  if (!result.update_available || !result.release) {
    target.replaceChildren(
      node(
        'p',
        'muted-copy',
        `Xyst AI Assistant ${result.current_version} is current on the ${result.channel} channel (checked ${new Date(result.checked_at).toLocaleString()}).`,
      ),
    );
    return;
  }
  const release = result.release;
  const heading = node('p', '', `Xyst AI Assistant ${release.version} is available for ${release.platform} ${release.arch}.`);
  const prepare = node('button', 'text-button', 'Download and verify update');
  prepare.type = 'button';
  const downloadStatus = node('p', 'muted-copy');
  prepare.addEventListener('click', async () => {
    prepare.disabled = true;
    downloadStatus.textContent = 'Downloading and verifying the signed release…';
    try {
      const staged = await client.downloadApplicationUpdate(release.version, result.sequence);
      const link = node('a', 'text-button', `Download verified file: ${staged.filename}`);
      link.href = staged.download_path;
      link.download = staged.filename;
      downloadStatus.textContent = `Verified ${staged.size_bytes.toLocaleString()} bytes against the signed SHA-256. The one-time download link expires ${new Date(staged.expires_at).toLocaleTimeString()}. Xyst AI Assistant will not install it.`;
      if (target.contains(checksumLabel)) target.insertBefore(link, checksumLabel);
    } catch (error) {
      downloadStatus.textContent = `Could not prepare a verified download: ${error.message}`;
      prepare.disabled = false;
    }
  });
  const details = node(
    'p',
    'muted-copy',
    `${release.notes}\nPublished ${new Date(release.published_at).toLocaleDateString()}. File size ${release.size_bytes.toLocaleString()} bytes.`,
  );
  const checksumLabel = node('p', 'muted-copy', 'Signed SHA-256:');
  const checksum = node('code', 'app-update-checksum', release.sha256);
  target.replaceChildren(heading, details, prepare, downloadStatus, checksumLabel, checksum);
}

function createUsageBreakdown(usage) {
  const section = node('section', 'settings-section');
  section.append(
    node('h3', '', 'Usage detail · last 45 days'),
    node(
      'p',
      'muted-copy',
      'Provider-reported and estimated token counts are labeled separately. Cached input is a subset of input tokens when the provider reports it. Dollar estimates use configured prices; reported cached tokens use the cached-input rate when configured, otherwise the regular input rate. Unknown prices are not treated as zero.',
    ),
  );
  const attribution = usage?.attribution;
  if (!attribution) {
    section.append(node('p', 'muted-copy', 'Usage detail is unavailable.'));
    return section;
  }
  const daily = attribution.daily || {};
  section.append(
    settingRow(
      'Today · token basis',
      `Provider-reported ${daily.input_tokens_by_source?.provider_reported || 0} in / ${daily.output_tokens_by_source?.provider_reported || 0} out · estimated ${daily.input_tokens_by_source?.estimated || 0} in / ${daily.output_tokens_by_source?.estimated || 0} out`,
    ),
    settingRow('Today · unknown priced calls', String(daily.unknown_cost_calls || 0)),
  );
  const monthly = attribution.monthly || {};
  if (daily.cache_usage_calls || monthly.cache_usage_calls)
    section.append(
      settingRow(
        'Cached input tokens',
        `Today ${(daily.cached_input_tokens || 0).toLocaleString()} cached tokens · ${daily.cache_hit_calls || 0} hits / ${daily.cache_miss_calls || 0} misses · month ${(monthly.cached_input_tokens || 0).toLocaleString()} cached tokens · ${monthly.cache_hit_calls || 0} hits / ${monthly.cache_miss_calls || 0} misses`,
      ),
    );
  const appendRanked = (title, entries, formatLabel, emptyLabel = 'No usage recorded today.') => {
    const group = node('div', 'usage-breakdown-group');
    group.append(node('h4', '', title));
    const ranked = Object.entries(entries || {})
      .sort((left, right) => right[1].input_tokens + right[1].output_tokens - left[1].input_tokens - left[1].output_tokens)
      .slice(0, 5);
    if (!ranked.length) group.append(node('p', 'muted-copy', emptyLabel));
    for (const [label, metrics] of ranked)
      group.append(
        settingRow(
          formatLabel(label),
          `${(metrics.input_tokens || 0).toLocaleString()} in / ${(metrics.output_tokens || 0).toLocaleString()} out · estimated $${(metrics.estimated_cost_usd || 0).toFixed(4)}`,
        ),
      );
    section.append(group);
  };
  appendRanked('Top models today', daily.by_model, (label) => label);
  appendRanked('Top sessions today', daily.by_session, (label) => `Session ${label.slice(0, 8)}`);
  appendRanked('Top models this month', attribution.monthly?.by_model, (label) => label, 'No usage recorded this month.');
  appendRanked(
    'Top sessions this month',
    attribution.monthly?.by_session,
    (label) => `Session ${label.slice(0, 8)}`,
    'No usage recorded this month.',
  );
  const history = node('div', 'usage-breakdown-group');
  history.append(node('h4', '', 'Daily totals'));
  const days = (attribution.days || []).slice(-7).reverse();
  if (!days.length) history.append(node('p', 'muted-copy', 'No usage recorded in the retained period.'));
  for (const day of days)
    history.append(
      settingRow(
        day.date,
        `${(day.input_tokens || 0).toLocaleString()} in / ${(day.output_tokens || 0).toLocaleString()} out${day.cache_usage_calls ? ` · ${(day.cached_input_tokens || 0).toLocaleString()} cached` : ''} · estimated $${(day.estimated_cost_usd || 0).toFixed(4)}`,
      ),
    );
  if (days.some((day) => !day.attribution_available))
    history.append(node('p', 'muted-copy', 'Some older daily totals predate detailed attribution and are shown as aggregates only.'));
  if (attribution.truncated)
    history.append(
      node('p', 'muted-copy', 'Some high-volume session/model detail was grouped under “other”; daily totals remain complete.'),
    );
  section.append(history);
  return section;
}

async function openSettings() {
  elements.settings_title.textContent = 'Runtime settings';
  if (!elements.settings_dialog.open) elements.settings_dialog.showModal();
  elements.settings_content.replaceChildren(node('p', 'muted-copy', 'Loading current settings…'));
  try {
    const [settings, usage, sandboxCapability] = await Promise.all([
      client.getSettings(),
      client.getUsage().catch(() => null),
      client.getSandboxCapability().catch(() => ({ available: false, reason: 'capability_check_failed' })),
    ]);
    settings.sandbox = { ...settings.sandbox, ...sandboxCapability };
    runtimeSettings = settings;
    applyUiPreferences(settings.ui);
    usageSnapshot = usage;
    const defaultModel = settings.default_model || 'Automatic';
    const sandbox = settings.sandbox?.mode || 'none';
    const usageValue = (period, metric) =>
      usage
        ? metric === 'cost_usd'
          ? `$${(usage[period]?.[metric] || 0).toFixed(4)}`
          : (usage[period]?.[metric] || 0).toLocaleString()
        : 'Unavailable';
    elements.settings_content.replaceChildren(
      settingRow('Default model', defaultModel),
      settingRow('Fallback strategy', settings.routing?.selection || 'balanced'),
      settingRow('Prefer local models', settings.routing?.prefer_local === false ? 'No' : 'Yes'),
      settingRow('Sandbox policy', sandbox),
      settingRow(
        'Automation mode',
        settings.tools?.autonomy === 'unrestricted' ? 'Unrestricted · no app-level tool approvals' : 'Assisted',
      ),
      settingRow(
        'Filesystem access',
        settings.tools?.autonomy === 'unrestricted' || settings.tools?.filesystem_scope === 'machine'
          ? 'Machine-wide absolute paths'
          : 'Selected workspace only',
      ),
      settingRow(
        'Shell execution',
        settings.tools?.autonomy === 'unrestricted' || settings.tools?.shell_enabled
          ? settings.tools?.autonomy === 'unrestricted'
            ? 'Enabled · no app approval'
            : 'Enabled · approval required'
          : 'Disabled',
      ),
      settingRow(
        'Web search',
        settings.web_search?.enabled
          ? `${settings.web_search.provider === 'brave' ? (settings.web_search.credential_configured ? 'Brave · live results, automatic keyless fallback' : 'Automatic keyless live results') : settings.web_search.provider === 'automatic' ? 'Automatic · live news + references' : 'Wikipedia · live references'}${settings.tools?.autonomy === 'unrestricted' ? '' : ' · approval required'}`
          : 'Disabled',
      ),
      settingRow(
        'Semantic retrieval',
        settings.retrieval?.semantic?.enabled
          ? `${settings.retrieval.semantic.model || 'embedding model'} · ${settings.retrieval.semantic.allow_remote ? `remote HTTPS${settings.retrieval.semantic.credential_configured ? '' : ' · credential missing'}` : 'local endpoint'} · approval required`
          : 'Disabled',
      ),
      settingRow(
        'Automatic retrieval context',
        settings.retrieval?.auto_context ? `Enabled · up to ${settings.retrieval.auto_context_max_results || 4} results` : 'Disabled',
      ),
      settingRow(
        'Subagents',
        settings.subagents?.enabled ? `${settings.subagents.max_concurrent || 2} concurrent · isolated worktrees` : 'Disabled',
      ),
      settingRow(
        'Input budget',
        settings.budgets?.max_input_tokens ? `${settings.budgets.max_input_tokens.toLocaleString()} tokens` : 'Default',
      ),
      settingRow(
        'Output budget',
        settings.budgets?.max_output_tokens ? `${settings.budgets.max_output_tokens.toLocaleString()} tokens` : 'Default',
      ),
      settingRow(
        'Session input ceiling',
        settings.budgets?.max_session_input_tokens
          ? `${settings.budgets.max_session_input_tokens.toLocaleString()} tokens`
          : 'No cumulative cap',
      ),
      settingRow(
        'Session output ceiling',
        settings.budgets?.max_session_output_tokens
          ? `${settings.budgets.max_session_output_tokens.toLocaleString()} tokens`
          : 'No cumulative cap',
      ),
      settingRow(
        'Session cost ceiling',
        settings.budgets?.max_session_cost !== undefined
          ? `$${settings.budgets.max_session_cost.toFixed(4)} estimated`
          : 'No cumulative cap',
      ),
      settingRow(
        'Automatic compaction',
        settings.compaction?.enabled
          ? `Enabled · ${(settings.compaction.trigger_ratio ?? 0.8) * 100}% context · ${(settings.compaction.budget_trigger_ratio ?? 0.8) * 100}% budget · keeps ${settings.compaction.keep_recent_turns ?? 2} recent turns`
          : 'Disabled',
      ),
      settingRow(
        'Today · input',
        `${usageValue('daily', 'input_tokens')} / ${settings.budgets?.max_daily_input_tokens?.toLocaleString() || 'no cap'} tokens`,
      ),
      settingRow(
        'Today · output',
        `${usageValue('daily', 'output_tokens')} / ${settings.budgets?.max_daily_output_tokens?.toLocaleString() || 'no cap'} tokens`,
      ),
      settingRow(
        'Today · estimated cost',
        `${usageValue('daily', 'cost_usd')} / ${settings.budgets?.max_daily_cost !== undefined ? `$${settings.budgets.max_daily_cost.toFixed(4)}` : 'no cap'}`,
      ),
      settingRow(
        'This month · input',
        `${usageValue('monthly', 'input_tokens')} / ${settings.budgets?.max_monthly_input_tokens?.toLocaleString() || 'no cap'} tokens`,
      ),
      settingRow(
        'This month · output',
        `${usageValue('monthly', 'output_tokens')} / ${settings.budgets?.max_monthly_output_tokens?.toLocaleString() || 'no cap'} tokens`,
      ),
      settingRow(
        'This month · estimated cost',
        `${usageValue('monthly', 'cost_usd')} / ${settings.budgets?.max_monthly_cost !== undefined ? `$${settings.budgets.max_monthly_cost.toFixed(4)}` : 'no cap'}`,
      ),
      createUsageBreakdown(usage),
      createSettingsEditor(settings),
    );
    if (settings.retrieval?.semantic?.enabled) await renderRetrievalControls();
  } catch (error) {
    elements.settings_content.replaceChildren(node('p', 'muted-copy', error.message));
  }
}

async function renderRetrievalControls() {
  const [index, exclusions] = await Promise.all([client.getSemanticIndex(), client.getRetrievalExclusions()]);
  const section = node('section', 'settings-section');
  section.append(
    node('h3', '', 'Semantic index'),
    node('p', 'muted-copy', `${index.files} files · ${index.chunks} chunks · model ${index.model || 'not indexed'}`),
  );
  const reindex = node('button', 'secondary-button', 'Reindex workspace');
  reindex.type = 'button';
  reindex.addEventListener('click', async () => {
    reindex.disabled = true;
    try {
      const settings = await client.getSettings();
      const destination = settings.retrieval.semantic.allow_remote
        ? 'the configured remote HTTPS embedding service'
        : 'the configured local embedding service';
      if (!window.confirm(`Reindexing sends redacted workspace chunks to ${destination}. Continue?`)) {
        reindex.disabled = false;
        return;
      }
      await client.manageSemanticIndex('reindex', { approved: true });
      showToast('Semantic index rebuilt.');
      await openSettings();
    } catch (error) {
      showToast(error.message);
      reindex.disabled = false;
    }
  });
  const clear = node('button', 'text-button', 'Clear index');
  clear.type = 'button';
  clear.addEventListener('click', async () => {
    if (!window.confirm('Remove the stored semantic index? It will be rebuilt on the next approved semantic search.')) return;
    try {
      await client.manageSemanticIndex('clear');
      showToast('Semantic index cleared.');
      await openSettings();
    } catch (error) {
      showToast(error.message);
    }
  });
  section.append(reindex, clear, node('h4', '', 'Excluded paths'));
  const form = node('form', 'retrieval-exclusion-form');
  const input = node('input', 'text-input');
  input.type = 'text';
  input.maxLength = 256;
  input.placeholder = 'src/generated/**';
  input.setAttribute('aria-label', 'Workspace-relative exclusion glob');
  const add = node('button', 'secondary-button', 'Exclude path');
  add.type = 'submit';
  form.append(input, add);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await client.changeRetrievalExclusion('add', input.value);
      showToast('Exclusion added.');
      await openSettings();
    } catch (error) {
      showToast(error.message);
    }
  });
  section.append(form);
  if (exclusions.patterns.length) {
    const list = node('ul', 'retrieval-exclusion-list');
    for (const pattern of exclusions.patterns) {
      const item = node('li', '');
      item.append(node('code', '', pattern));
      const remove = node('button', 'text-button', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        try {
          await client.changeRetrievalExclusion('remove', pattern);
          showToast('Exclusion removed.');
          await openSettings();
        } catch (error) {
          showToast(error.message);
        }
      });
      item.append(remove);
      list.append(item);
    }
    section.append(list);
  } else section.append(node('p', 'muted-copy', 'No user exclusions configured.'));
  elements.settings_content.append(section);
}

function processCanStop(status) {
  return ['running', 'starting', 'recoverable'].includes(status);
}
function processCanRemove(status) {
  return ['exited', 'failed', 'identity_mismatch', 'timed_out'].includes(status);
}

function processCard(record) {
  const card = node('article', 'data-card process-card');
  const heading = node('div', 'process-card-heading');
  const commandLine = [record.command, ...(Array.isArray(record.args) ? record.args : [])].filter(Boolean).join(' ').slice(0, 320);
  heading.append(
    node('strong', '', commandLine || 'Unknown command'),
    node('span', `process-status status-${record.status.replaceAll('_', '-')}`, record.status.replaceAll('_', ' ')),
  );
  const metadata = node('div', 'process-meta');
  metadata.append(
    node('span', '', `PID ${record.pid ?? '—'}`),
    node('span', '', `Started ${record.started_at ? new Date(record.started_at).toLocaleString() : '—'}`),
    ...(record.interactive ? [node('span', '', 'Interactive input enabled')] : []),
  );
  const workingDirectory = node('code', 'data-meta', record.cwd || 'Working directory unavailable');
  const actions = node('div', 'data-controls');
  const output = node('pre', 'process-output');
  output.hidden = true;
  const outputButton = node('button', 'text-button', 'View output');
  outputButton.type = 'button';
  outputButton.addEventListener('click', async () => {
    outputButton.disabled = true;
    try {
      const detail = await client.getProcess(record.id);
      output.textContent =
        [detail.stdout && `stdout:\n${detail.stdout}`, detail.stderr && `stderr:\n${detail.stderr}`].filter(Boolean).join('\n\n') ||
        'No output captured.';
      if (detail.output_truncated) output.textContent += '\n\n[Earlier output was truncated]';
      output.hidden = false;
      outputButton.textContent = 'Refresh output';
    } catch (error) {
      showToast(error.message);
    } finally {
      outputButton.disabled = false;
    }
  });
  actions.append(outputButton);
  if (record.interactive && processCanStop(record.status)) {
    const input = node('textarea', 'process-input');
    input.rows = 2;
    input.setAttribute('aria-label', `Input for background process ${record.pid ?? record.id}`);
    input.placeholder = 'Send input to this process';
    const send = node('button', 'text-button', 'Send input');
    send.type = 'button';
    send.addEventListener('click', async () => {
      if (!input.value) return;
      send.disabled = true;
      try {
        await client.writeProcessInput(record.id, input.value);
        input.value = '';
        await refreshProcesses();
        showToast('Input sent.');
      } catch (error) {
        showToast(error.message);
      } finally {
        send.disabled = false;
      }
    });
    actions.append(input, send);
  }
  if (processCanStop(record.status)) {
    const stop = node('button', 'text-button danger-text', 'Stop');
    stop.type = 'button';
    stop.addEventListener('click', async () => {
      if (!window.confirm(`Stop background process ${record.pid ?? record.id}?`)) return;
      stop.disabled = true;
      try {
        await client.stopProcess(record.id);
        await refreshProcesses();
        showToast('Process stopped.');
      } catch (error) {
        showToast(error.message);
        stop.disabled = false;
      }
    });
    actions.append(stop);
  }
  if (processCanRemove(record.status)) {
    const remove = node('button', 'text-button danger-text', 'Remove record');
    remove.type = 'button';
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try {
        await client.removeProcess(record.id);
        await refreshProcesses();
        showToast('Process record removed.');
      } catch (error) {
        showToast(error.message);
        remove.disabled = false;
      }
    });
    actions.append(remove);
  }
  card.append(heading, metadata, workingDirectory, actions, output);
  return card;
}

async function refreshProcesses() {
  elements.process_content.replaceChildren(node('p', 'muted-copy', 'Loading background processes…'));
  try {
    const processes = await client.listProcesses({ limit: 100 });
    if (!processes.length) {
      elements.process_content.replaceChildren(
        node(
          'p',
          'muted-copy',
          'No background processes have been recorded. Start a background job from an agent run and it will appear here.',
        ),
      );
      return;
    }
    elements.process_content.replaceChildren(...processes.map(processCard));
  } catch (error) {
    elements.process_content.replaceChildren(node('p', 'muted-copy', error.message));
  }
}

function openProcesses() {
  if (!elements.process_dialog.open) elements.process_dialog.showModal();
  void refreshProcesses();
}

const MEMORY_SECTIONS = [
  ['conventions', 'Conventions'],
  ['architecture_decisions', 'Architecture decisions'],
  ['user_preferences', 'User preferences'],
  ['lessons_learned', 'Lessons learned'],
  ['open_questions', 'Open questions'],
];

async function openMemory(scope = 'project') {
  const isGlobal = scope === 'global';
  const listItems = (section) => (isGlobal ? client.listGlobalMemory(section) : client.listMemory(section));
  const searchItems = (query, options) => (isGlobal ? client.searchGlobalMemory(query, options) : client.searchMemory(query, options));
  const addItem = (section, text) => (isGlobal ? client.addGlobalMemory(section, text) : client.addMemory(section, text));
  const updateItem = (section, id, text) =>
    isGlobal ? client.updateGlobalMemory(section, id, text) : client.updateMemory(section, id, text);
  const deleteItem = (section, id) => (isGlobal ? client.deleteGlobalMemory(section, id) : client.deleteMemory(section, id));
  elements.settings_title.textContent = isGlobal ? 'Global user memory' : 'Project memory';
  if (!elements.settings_dialog.open) elements.settings_dialog.showModal();
  const content = elements.settings_content;
  content.replaceChildren(node('p', 'muted-copy', `Loading ${isGlobal ? 'global user' : 'project'} memory…`));
  try {
    const sections = await Promise.all(MEMORY_SECTIONS.map(async ([key, label]) => ({ key, label, ...(await listItems(key)) })));
    const memoryActions = node('div', 'memory-actions');
    const scopeSwitch = node('button', 'secondary-button', isGlobal ? 'Project memory' : 'Global user memory');
    scopeSwitch.type = 'button';
    scopeSwitch.addEventListener('click', () => void openMemory(isGlobal ? 'project' : 'global'));
    memoryActions.append(scopeSwitch);
    const exportButton = node('button', 'secondary-button', 'Export memory');
    exportButton.type = 'button';
    const importButton = node('button', 'secondary-button', 'Import memory');
    importButton.type = 'button';
    const importFile = node('input');
    importFile.type = 'file';
    importFile.accept = 'application/json,.json';
    importFile.hidden = true;
    exportButton.addEventListener('click', async () => {
      exportButton.disabled = true;
      try {
        const memoryExport = isGlobal ? await client.exportGlobalMemory() : await client.exportMemory();
        const blob = new Blob([`${JSON.stringify(memoryExport, null, 2)}\n`], { type: 'application/json' });
        const downloadUrl = URL.createObjectURL(blob);
        const link = node('a');
        link.href = downloadUrl;
        link.download = isGlobal ? 'xyst-global-memory.json' : 'xyst-memory.json';
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
        showToast(`${isGlobal ? 'Global user' : 'Project'} memory exported. Review it before sharing.`);
      } catch (error) {
        showError(error);
      } finally {
        exportButton.disabled = false;
      }
    });
    importButton.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const file = importFile.files?.[0];
      importFile.value = '';
      if (!file) return;
      if (file.size > 4 * 1024 * 1024 + 64 * 1024) {
        showToast('The memory export exceeds the 4 MiB plus 64 KiB import limit.');
        return;
      }
      importButton.disabled = true;
      try {
        const memoryExport = JSON.parse(await file.text());
        if (memoryExport?.format !== 'xyst-memory' || ![1, 2].includes(memoryExport.format_version) || !memoryExport.memory?.sections)
          throw new Error('Choose a supported Xyst AI Assistant memory export.');
        const incomingSections = MEMORY_SECTIONS.map(([key]) => memoryExport.memory.sections[key]);
        if (!incomingSections.every(Array.isArray)) throw new Error('The memory export has invalid sections.');
        const incomingCount = incomingSections.reduce((total, items) => total + items.length, 0);
        if (incomingCount > 1_000) throw new Error('The memory export exceeds the 1,000-item import limit.');
        const filename = file.name.replace(/[\u0000-\u001f]/g, '').slice(0, 100) || 'memory export';
        if (
          !window.confirm(
            `Add up to ${incomingCount} memory items from "${filename}" to ${isGlobal ? 'global user memory across projects' : 'this project'}? Imported notes may be included as untrusted context in future runs. Existing entries are retained; duplicates are skipped.`,
          )
        )
          return;
        const imported = isGlobal ? await client.importGlobalMemory(memoryExport) : await client.importMemory(memoryExport);
        await openMemory(scope);
        showToast(
          `Imported ${imported.imported} item${imported.imported === 1 ? '' : 's'}; skipped ${imported.skipped_duplicates} duplicate${imported.skipped_duplicates === 1 ? '' : 's'}.`,
        );
      } catch (error) {
        showError(error);
      } finally {
        importButton.disabled = false;
      }
    });
    memoryActions.append(exportButton, importButton, importFile);
    const picker = node('select', 'data-picker');
    picker.setAttribute('aria-label', 'Memory section');
    for (const section of sections) {
      const option = node('option', '', `${section.label} · ${section.total}`);
      option.value = section.key;
      picker.append(option);
    }
    const list = node('div', 'data-list');
    const searchForm = node('form', 'memory-search-form');
    const searchInput = node('input', 'workspace-branch-input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search saved memory';
    searchInput.maxLength = 512;
    searchInput.setAttribute('aria-label', `Search ${isGlobal ? 'global user' : 'project'} memory`);
    const searchButton = node('button', 'secondary-button', 'Search');
    searchButton.type = 'submit';
    const clearSearch = node('button', 'text-button', 'Sections');
    clearSearch.type = 'button';
    clearSearch.hidden = true;
    searchForm.append(searchInput, searchButton, clearSearch);
    const form = node('form', 'data-add-form');
    const input = node('textarea', 'data-input');
    input.setAttribute('aria-label', 'New memory item');
    input.placeholder = `Add a ${isGlobal ? 'cross-project' : 'project-specific'} note…`;
    input.maxLength = 10_000;
    const add = node('button', 'send-button', 'Add memory');
    add.type = 'submit';
    form.append(input, add);
    const note = node(
      'p',
      'muted-copy',
      isGlobal
        ? 'Global memory is stored for this user and may be included as untrusted context across projects while enabled. Keep credentials and other secrets out of it.'
        : 'Memory is project-scoped and may be used as context in future runs. Keep credentials and other secrets out of it.',
    );
    let searchResultsNode = null;
    const draw = () => {
      picker.hidden = false;
      form.hidden = false;
      note.hidden = false;
      clearSearch.hidden = true;
      const section = sections.find((entry) => entry.key === picker.value);
      list.replaceChildren();
      if (!section?.items.length) list.append(node('p', 'empty-sessions', 'No saved items in this section.'));
      for (const item of section?.items || []) {
        const row = node('article', 'data-card');
        const text = node('textarea', 'data-input');
        text.value = item.text;
        text.maxLength = 10_000;
        text.setAttribute('aria-label', `Edit memory item from ${item.created_at}`);
        const controls = node('div', 'data-controls');
        const save = node('button', 'text-button', 'Save');
        save.type = 'button';
        save.addEventListener('click', async () => {
          save.disabled = true;
          try {
            await updateItem(section.key, item.id, text.value);
            await openMemory(scope);
            showToast('Memory updated.');
          } catch (error) {
            showError(error);
            save.disabled = false;
          }
        });
        const remove = node('button', 'text-button danger-text', 'Delete');
        remove.type = 'button';
        remove.addEventListener('click', async () => {
          if (!window.confirm(`Delete this ${isGlobal ? 'global user' : 'project'} memory item?`)) return;
          try {
            await deleteItem(section.key, item.id);
            await openMemory(scope);
            showToast('Memory item deleted.');
          } catch (error) {
            showError(error);
          }
        });
        controls.append(save, remove);
        row.append(text, controls, node('small', 'data-meta', formatMemoryProvenance(item)));
        list.append(row);
      }
    };
    clearSearch.addEventListener('click', () => {
      if (searchResultsNode?.isConnected) searchResultsNode.replaceWith(list);
      searchResultsNode = null;
      draw();
    });
    picker.addEventListener('change', draw);
    searchForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const query = searchInput.value.trim();
      if (!query) return;
      searchButton.disabled = true;
      try {
        const result = await searchItems(query, { limit: 100 });
        const results = node('div', 'data-list memory-search-results');
        if (searchResultsNode?.isConnected) searchResultsNode.replaceWith(results);
        else list.replaceWith(results);
        searchResultsNode = results;
        picker.hidden = true;
        form.hidden = true;
        note.hidden = true;
        clearSearch.hidden = false;
        if (!result.items.length) results.append(node('p', 'empty-sessions', `No memory contains “${query}”.`));
        for (const item of result.items) {
          const row = node('article', 'data-card');
          const text = node('textarea', 'data-input');
          text.value = item.text;
          text.maxLength = 10_000;
          text.setAttribute('aria-label', `Edit ${item.section.replaceAll('_', ' ')} memory`);
          const controls = node('div', 'data-controls');
          const save = node('button', 'text-button', 'Save');
          save.type = 'button';
          save.addEventListener('click', async () => {
            save.disabled = true;
            try {
              await updateItem(item.section, item.id, text.value);
              searchForm.requestSubmit();
              showToast('Memory updated.');
            } catch (error) {
              showError(error);
              save.disabled = false;
            }
          });
          const remove = node('button', 'text-button danger-text', 'Delete');
          remove.type = 'button';
          remove.addEventListener('click', async () => {
            if (!window.confirm(`Delete this ${isGlobal ? 'global user' : 'project'} memory item?`)) return;
            try {
              await deleteItem(item.section, item.id);
              searchForm.requestSubmit();
              showToast('Memory item deleted.');
            } catch (error) {
              showError(error);
            }
          });
          controls.append(save, remove);
          row.append(text, controls, node('small', 'data-meta', `${item.section.replaceAll('_', ' ')} · ${formatMemoryProvenance(item)}`));
          results.append(row);
        }
        if (result.total > result.items.length)
          results.append(
            node(
              'p',
              'muted-copy',
              `Showing the first ${result.items.length} of ${result.total} matches. Refine the search to narrow results.`,
            ),
          );
      } catch (error) {
        showError(error);
      } finally {
        searchButton.disabled = false;
      }
    });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!input.value.trim()) return;
      add.disabled = true;
      try {
        await addItem(picker.value, input.value);
        await openMemory(scope);
        showToast('Memory saved.');
      } catch (error) {
        showError(error);
        add.disabled = false;
      }
    });
    content.replaceChildren(memoryActions, searchForm, picker, list, form, note);
    draw();
  } catch (error) {
    const message =
      isGlobal && error.code === 'GLOBAL_MEMORY_DISABLED'
        ? 'Global memory is off. Open Runtime settings and enable “Use global user memory across projects” to manage or use it.'
        : error.message;
    content.replaceChildren(node('p', 'muted-copy', message));
  }
}

async function openGoals() {
  elements.settings_title.textContent = 'Project goals';
  if (!elements.settings_dialog.open) elements.settings_dialog.showModal();
  const content = elements.settings_content;
  content.replaceChildren(node('p', 'muted-copy', 'Loading project goals…'));
  try {
    const [goals, selectedSession] = await Promise.all([client.listGoals(), loadSelectedSessionForGoals()]);
    const list = node('div', 'data-list');
    if (!goals.length) list.append(node('p', 'empty-sessions', 'No project goals yet.'));
    for (const goal of goals) {
      const card = node('article', 'data-card');
      card.append(node('strong', 'goal-title', goal.title));
      if (goal.details) card.append(node('p', 'goal-details', goal.details));
      if (selectedSession) {
        const linked = new Set(selectedSession.persistent_goal_ids || []);
        const attach = node(
          'button',
          'text-button',
          linked.has(goal.id) ? 'Remove from selected conversation' : 'Add to selected conversation',
        );
        attach.type = 'button';
        attach.dataset.sessionGoalControl = 'true';
        attach.disabled = runController !== null;
        attach.setAttribute(
          'aria-label',
          `${linked.has(goal.id) ? 'Remove' : 'Add'} ${goal.title} ${linked.has(goal.id) ? 'from' : 'to'} ${selectedSession.title || 'selected conversation'}`,
        );
        attach.addEventListener('click', async () => {
          const next = new Set(selectedSession.persistent_goal_ids || []);
          if (next.has(goal.id)) next.delete(goal.id);
          else next.add(goal.id);
          for (const control of content.querySelectorAll('[data-session-goal-control]')) control.disabled = true;
          try {
            await client.setSessionGoals(selectedSession.id, [...next]);
            await openGoals();
            showToast(next.has(goal.id) ? 'Goal added to the selected conversation.' : 'Goal removed from the selected conversation.');
          } catch (error) {
            showError(error);
            for (const control of content.querySelectorAll('[data-session-goal-control]')) control.disabled = runController !== null;
          }
        });
        card.append(attach);
      }
      if (goal.progress?.length) {
        const progressList = node('div', 'goal-progress-list');
        for (const entry of goal.progress) {
          const progress = node('p', 'goal-details', entry.text);
          const metadata = [
            entry.source,
            entry.updated_at ? `edited ${new Date(entry.updated_at).toLocaleString()}` : new Date(entry.created_at).toLocaleString(),
            entry.reference,
          ]
            .filter(Boolean)
            .join(' · ');
          progress.append(node('small', 'data-meta', metadata));
          const progressControls = node('div', 'data-controls');
          const editProgress = node('button', 'text-button', 'Edit');
          editProgress.type = 'button';
          editProgress.addEventListener('click', async () => {
            const text = window.prompt('Edit progress', entry.text);
            if (text === null) return;
            const reference = window.prompt('Edit reference (optional)', entry.reference || '');
            if (reference === null) return;
            try {
              await client.updateGoalProgress(goal.id, entry.id, text, reference);
              await openGoals();
              showToast('Goal progress updated.');
            } catch (error) {
              showError(error);
            }
          });
          const deleteProgress = node('button', 'text-button danger-text', 'Delete');
          deleteProgress.type = 'button';
          deleteProgress.addEventListener('click', async () => {
            if (!window.confirm('Delete this progress entry?')) return;
            try {
              await client.deleteGoalProgress(goal.id, entry.id);
              await openGoals();
              showToast('Goal progress deleted.');
            } catch (error) {
              showError(error);
            }
          });
          progressControls.append(editProgress, deleteProgress);
          progress.append(progressControls);
          progressList.append(progress);
        }
        card.append(progressList);
      }
      const progressForm = node('form', 'goal-form');
      const progressText = node('textarea', 'data-input');
      progressText.placeholder = 'Add progress or a decision';
      progressText.maxLength = 2_000;
      progressText.required = true;
      const progressReference = node('input', 'data-input');
      progressReference.placeholder = 'Reference (optional file, issue, or link)';
      progressReference.maxLength = 1_000;
      const addProgress = node('button', 'text-button', 'Add progress');
      addProgress.type = 'submit';
      progressForm.append(progressText, progressReference, addProgress);
      progressForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        addProgress.disabled = true;
        try {
          await client.addGoalProgress(goal.id, progressText.value, progressReference.value);
          await openGoals();
          showToast('Goal progress saved.');
        } catch (error) {
          showError(error);
          addProgress.disabled = false;
        }
      });
      card.append(progressForm);
      const controls = node('div', 'data-controls');
      const status = node('button', 'text-button', goal.status === 'completed' ? 'Reopen' : 'Complete');
      status.type = 'button';
      status.addEventListener('click', async () => {
        try {
          await client.setGoalStatus(goal.id, goal.status === 'completed' ? 'active' : 'completed');
          await openGoals();
        } catch (error) {
          showError(error);
        }
      });
      const remove = node('button', 'text-button danger-text', 'Delete');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (!window.confirm('Delete this project goal?')) return;
        try {
          await client.deleteGoal(goal.id);
          await openGoals();
          showToast('Goal deleted.');
        } catch (error) {
          showError(error);
        }
      });
      controls.append(status, remove);
      card.append(node('small', 'data-meta', `${goal.status} · updated ${goal.updated_at}`), controls);
      list.append(card);
    }
    const form = node('form', 'goal-form');
    const title = node('input', 'data-input');
    title.placeholder = 'Goal title';
    title.maxLength = 500;
    title.required = true;
    const details = node('textarea', 'data-input');
    details.placeholder = 'Details (optional)';
    details.maxLength = 10_000;
    const add = node('button', 'send-button', 'Add goal');
    add.type = 'submit';
    form.append(title, details, add);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      add.disabled = true;
      try {
        await client.addGoal(title.value, details.value);
        await openGoals();
        showToast('Goal saved.');
      } catch (error) {
        showError(error);
        add.disabled = false;
      }
    });
    const sessionGoalNote = selectedSession
      ? node(
          'p',
          'muted-copy',
          `Select which project goals to carry with “${selectedSession.title || 'New conversation'}”. Goal notes remain untrusted context.`,
        )
      : node('p', 'muted-copy', 'Select a conversation to choose which project goals it carries into its context and portable export.');
    content.replaceChildren(
      sessionGoalNote,
      list,
      form,
      node('p', 'muted-copy', 'Goals are shared with future runs and preserved during context compaction.'),
    );
  } catch (error) {
    content.replaceChildren(node('p', 'muted-copy', error.message));
  }
}

async function loadSelectedSessionForGoals() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const sessionId = activeSessionId;
    if (!sessionId) return null;
    try {
      const session = await client.getSession(sessionId);
      if (activeSessionId === sessionId) return session;
    } catch (error) {
      if (error.status !== 404 && !['ENOENT', 'NOT_FOUND'].includes(error.code)) throw error;
      if (activeSessionId === sessionId) return null;
    }
  }
  return null;
}

async function openSkills() {
  elements.settings_title.textContent = 'Instruction skills';
  if (!elements.settings_dialog.open) elements.settings_dialog.showModal();
  const content = elements.settings_content;
  content.replaceChildren(node('p', 'muted-copy', 'Loading configured skills…'));
  try {
    const [skillState, packageState] = await Promise.allSettled([client.listSkills(), client.listSignedSkillPackages()]);
    const result = skillState.status === 'fulfilled' ? skillState.value : { enabled: false, skills: [] };
    const packageResult = packageState.status === 'fulfilled' ? packageState.value : { configured: false, packages: [] };
    const list = node('div', 'data-list');
    const detail = node('pre', 'skill-detail', 'Choose a skill to inspect its instructions.');
    const packageHeading = node('h3', 'skills-package-heading', 'Signed skill packages');
    const packageList = node('div', 'data-list');
    if (!packageResult.configured) {
      packageList.append(node('p', 'muted-copy', 'Configure signed package trust in the user config to manage activated skills here.'));
    } else if (!packageResult.packages.length) {
      packageList.append(node('p', 'empty-sessions', 'No signed skill packages have been activated.'));
    }
    for (const skillPackage of packageResult.packages) {
      const card = node('article', 'data-card skill-card');
      const activeVersion = skillPackage.active_version;
      card.append(
        node('strong', 'goal-title', skillPackage.package_id),
        node(
          'p',
          'goal-details',
          activeVersion
            ? `Active version ${activeVersion}`
            : skillPackage.available_versions.length
              ? 'Installed and not active'
              : 'Disabled for new runs',
        ),
      );
      const actions = node('div', 'card-actions');
      const manage = (label, operation, confirmation) => {
        const button = node('button', 'text-button', label);
        button.type = 'button';
        button.addEventListener('click', async () => {
          if (confirmation && !window.confirm(confirmation)) return;
          button.disabled = true;
          try {
            await operation();
            await openSkills();
          } catch (error) {
            detail.textContent = error.message;
            button.disabled = false;
          }
        });
        actions.append(button);
      };
      if (activeVersion) {
        manage(
          'Disable',
          () => client.disableSignedSkillPackage(skillPackage.package_id),
          `Disable signed skill '${skillPackage.package_id}' for new agent runs?`,
        );
        if (skillPackage.previous_versions.length) {
          const rollbackVersion = skillPackage.previous_versions[0];
          manage(
            `Roll back to ${rollbackVersion}`,
            () => client.rollbackSignedSkillPackage(skillPackage.package_id),
            `Reactivate the previous signed version ${rollbackVersion} of '${skillPackage.package_id}'? Its signature and revocation state will be checked.`,
          );
        }
      }
      const previousVersions = new Set(skillPackage.previous_versions);
      for (const version of skillPackage.available_versions) {
        if (version !== activeVersion && (!activeVersion || !previousVersions.has(version))) {
          manage(
            `Activate ${version}`,
            () => client.activateSignedSkillPackage(skillPackage.package_id, version),
            `Make installed signed skill '${skillPackage.package_id}' version ${version} available to new runs? Its signature and revocation state will be checked.`,
          );
        }
      }
      card.append(actions);
      packageList.append(card);
    }
    if (!result.enabled) list.append(node('p', 'empty-sessions', 'Skills are disabled in user configuration.'));
    else if (skillState.status === 'rejected') list.append(node('p', 'muted-copy', skillState.reason.message));
    else if (!result.skills.length) list.append(node('p', 'empty-sessions', 'No valid skills were found in the configured directories.'));
    if (packageState.status === 'rejected') packageList.replaceChildren(node('p', 'muted-copy', packageState.reason.message));
    for (const skill of result.skills) {
      const card = node('article', 'data-card skill-card');
      const heading = node('strong', 'goal-title', skill.name);
      const description = node('p', 'goal-details', skill.description);
      const load = node('button', 'text-button', 'Inspect instructions');
      load.type = 'button';
      load.addEventListener('click', async () => {
        load.disabled = true;
        try {
          const loaded = await client.getSkill(skill.name);
          detail.textContent = `${loaded.name} · source ${loaded.source} · ${loaded.trust}\n\n${loaded.content}`;
        } catch (error) {
          detail.textContent = error.message;
        } finally {
          load.disabled = false;
        }
      });
      card.append(heading, description, load);
      list.append(card);
    }
    content.replaceChildren(
      packageHeading,
      packageList,
      list,
      detail,
      node(
        'p',
        'muted-copy',
        'Skill instructions are untrusted reference material. Activation applies to new runs only; instructions already loaded into an active run cannot be recalled. Skills cannot grant permissions or override runtime policy.',
      ),
    );
  } catch (error) {
    content.replaceChildren(node('p', 'muted-copy', error.message));
  }
}

async function openExtensions() {
  elements.settings_title.textContent = 'Signed package updates';
  if (!elements.settings_dialog.open) elements.settings_dialog.showModal();
  const content = elements.settings_content;
  content.replaceChildren(node('p', 'muted-copy', 'Loading package update status…'));

  const render = async () => {
    const state = await client.getExtensionUpdates();
    const actions = node('div', 'card-actions');
    const check = node('button', 'text-button', 'Check for updates');
    check.type = 'button';
    check.disabled = !state.update_feed_configured;
    check.addEventListener('click', async () => {
      check.disabled = true;
      try {
        await client.checkExtensionUpdates();
        await render();
        showToast('Signed package update check completed.');
      } catch (error) {
        showError(error);
        check.disabled = false;
      }
    });
    actions.append(check);

    if (state.revocation_feed_configured) {
      const refresh = node('button', 'text-button', 'Refresh revocations');
      refresh.type = 'button';
      refresh.addEventListener('click', async () => {
        const confirmed = window.confirm(
          'Fetch and verify the configured revocation list now? It can disable revoked packages and may restart configured MCP server processes. Stop active runs first.',
        );
        if (!confirmed) return;
        refresh.disabled = true;
        try {
          const result = await client.refreshExtensionRevocations();
          await render();
          showToast(
            `Revocations refreshed · ${result.revoked_key_count} keys and ${result.revoked_package_count} package revisions listed${result.mcp_reconfigured ? ' · MCP connections reloaded' : ''}.`,
          );
        } catch (error) {
          showError(error);
          refresh.disabled = false;
        }
      });
      actions.append(refresh);
    }

    const statusCopy = {
      package_trust_not_configured:
        'Package trust is not configured. Add trusted signing keys in the user configuration before managing signed packages.',
      update_feed_not_configured:
        'Package trust is configured, but no signed package update feed is set. Configure update_feed_url and update_key_id in the user configuration.',
      revocation_refresh_required:
        'The configured signed revocation data is missing or expired. Refresh it before checking or staging package updates.',
      update_check_required: 'No current verified update metadata is cached. Check for updates to fetch and verify the configured feed.',
    };
    const summary = node(
      'p',
      'muted-copy',
      state.status === 'ready'
        ? `Verified feed sequence ${state.sequence} · expires ${new Date(state.expires_at).toLocaleString()}`
        : statusCopy[state.status] || 'Package update status is unavailable.',
    );
    const list = node('div', 'data-list');
    if (state.status === 'ready' && state.updates.length === 0) {
      list.append(node('p', 'empty-sessions', 'No newer eligible signed package updates are available.'));
    }
    for (const update of state.updates || []) {
      const card = node('article', 'data-card skill-card');
      card.append(
        node('strong', 'goal-title', update.package_id),
        node('p', 'goal-details', `${update.package_type.toUpperCase()} · ${update.current_version} → ${update.version}`),
      );
      const cardActions = node('div', 'card-actions');
      if (update.staged) {
        card.append(
          node('p', 'muted-copy', 'Update version is installed and remains inactive. Activation will recheck its signature and contents.'),
        );
        const manage = node('button', 'text-button', update.package_type === 'skill' ? 'Open Skills' : 'Open MCP');
        manage.type = 'button';
        manage.addEventListener('click', () => void (update.package_type === 'skill' ? openSkills() : openMcpServers()));
        cardActions.append(manage);
      } else {
        const stage = node('button', 'text-button', `Download & stage ${update.version}`);
        stage.type = 'button';
        stage.addEventListener('click', async () => {
          if (
            !window.confirm(
              `Download and verify signed ${update.package_type} package ${update.package_id} ${update.version}? It will be staged inactive; activation remains a separate action.`,
            )
          )
            return;
          stage.disabled = true;
          try {
            await client.installExtensionUpdate(update.package_type, update.package_id);
            await render();
            showToast(`${update.package_id} ${update.version} is verified and staged inactive.`);
          } catch (error) {
            showError(error);
            stage.disabled = false;
          }
        });
        cardActions.append(stage);
      }
      card.append(cardActions);
      list.append(card);
    }
    content.replaceChildren(
      actions,
      summary,
      list,
      node(
        'p',
        'muted-copy',
        'Checks and downloads happen only when you choose them. Every bundle is checked against the signed feed and publisher key. Staged versions stay inactive; activate them from Skills or MCP when you are ready.',
      ),
    );
  };

  try {
    await render();
  } catch (error) {
    content.replaceChildren(node('p', 'muted-copy', error.message));
  }
}

async function openMcpServers() {
  elements.settings_title.textContent = 'MCP servers';
  if (!elements.settings_dialog.open) elements.settings_dialog.showModal();
  const content = elements.settings_content;
  content.replaceChildren(node('p', 'muted-copy', 'Loading configured MCP servers…'));
  try {
    const [catalogState, packageState] = await Promise.allSettled([client.getMcpServerCatalog(), client.listSignedMcpPackages()]);
    if (catalogState.status === 'rejected') throw catalogState.reason;
    const catalog = catalogState.value;
    const servers = catalog.servers;
    const packageSection = renderSignedMcpPackageSection(
      packageState.status === 'fulfilled' ? packageState.value : null,
      catalog,
      packageState.status === 'rejected' ? packageState.reason : null,
    );
    mcpServerCatalog = servers;
    if (Array.isArray(mcpServerSelection)) {
      const configuredMcpServers = new Set(servers.map((server) => server.name));
      mcpServerSelection = mcpServerSelection.filter((name) => configuredMcpServers.has(name));
    }
    renderMcpRunSelection();
    const addButton = node('button', 'text-button', 'Add MCP server');
    addButton.type = 'button';
    addButton.disabled = catalog.enabled !== true;
    addButton.title = addButton.disabled ? 'MCP is disabled globally in user configuration.' : '';
    addButton.addEventListener('click', () => renderMcpServerEditor({ name: '', config: { transport: 'stdio' } }));
    const auditButton = node('button', 'text-button', 'Audit history');
    auditButton.type = 'button';
    auditButton.addEventListener('click', () => void openMcpAuditHistory());
    if (!servers.length) {
      content.replaceChildren(
        ...packageSection,
        addButton,
        auditButton,
        node(
          'p',
          'empty-sessions',
          catalog.enabled ? 'No MCP servers are configured in the user settings.' : 'MCP is disabled globally in user configuration.',
        ),
      );
      return;
    }
    const cards = servers.map((server) => {
      const card = node('article', 'data-card skill-card');
      const state =
        server.connection_state === 'connected'
          ? 'Connected'
          : server.connection_state === 'disabled'
            ? 'Disabled'
            : server.connection_state === 'error'
              ? `Error · ${server.error_code || 'MCP_CONNECT_FAILED'}`
              : 'Disconnected';
      const subtitle = server.package_id ? `${server.transport} · signed package ${server.package_id}` : server.transport;
      card.append(node('strong', 'goal-title', server.name), node('p', 'goal-details', `${state} · ${subtitle}`));
      const serverMetadata = [
        server.server_info?.name && server.server_info?.version
          ? `${server.server_info.name} ${server.server_info.version}`
          : server.server_info?.name || server.server_info?.version,
        server.protocol_version ? `Protocol ${server.protocol_version}` : null,
        server.capabilities?.length ? `Capabilities · ${server.capabilities.join(', ')}` : null,
      ].filter(Boolean);
      if (serverMetadata.length) card.append(node('p', 'muted-copy', serverMetadata.join(' · ')));
      const actions = node('div', 'card-actions');
      const test = node('button', 'text-button', 'Test connection');
      test.type = 'button';
      test.disabled = server.can_enable === false;
      test.title = test.disabled ? 'MCP is disabled globally in user configuration.' : '';
      const testResult = node('p', 'muted-copy', '');
      test.addEventListener('click', async () => {
        test.disabled = true;
        testResult.textContent = 'Testing connection…';
        try {
          const result = await client.testMcpServer(server.name);
          testResult.textContent = result.success
            ? `Connection succeeded · ${result.tools.length} tools/resources/prompts discovered.`
            : `Connection failed · ${result.error_code || 'MCP_CONNECT_FAILED'}`;
        } catch (error) {
          testResult.textContent = error.message;
        } finally {
          test.disabled = server.can_enable === false;
        }
      });
      const edit = node('button', 'text-button', 'Edit settings');
      edit.type = 'button';
      edit.addEventListener('click', async () => {
        edit.disabled = true;
        try {
          const config = await client.getMcpServerConfig(server.name);
          renderMcpServerEditor({ name: server.name, config });
        } catch (error) {
          showToast(error.message);
        } finally {
          edit.disabled = false;
        }
      });
      const toggle = node('button', 'text-button', server.enabled ? 'Disable' : 'Enable');
      toggle.type = 'button';
      toggle.disabled = !server.enabled && server.can_enable === false;
      toggle.title = toggle.disabled ? 'MCP is disabled globally in user configuration.' : '';
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          await client.setMcpServerEnabled(server.name, !server.enabled);
          showToast(`${server.name} ${server.enabled ? 'disabled' : 'enabled'} for new runs.`);
          await openMcpServers();
        } catch (error) {
          showToast(error.message);
          toggle.disabled = false;
        }
      });
      const remove = node('button', 'text-button', 'Remove');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (
          !window.confirm(
            `Remove the configured MCP server “${server.name}”? Its original config stays in place; you can add it again from this panel.`,
          )
        )
          return;
        remove.disabled = true;
        try {
          await client.removeMcpServer(server.name);
          showToast(`${server.name} removed from runtime settings.`);
          await openMcpServers();
        } catch (error) {
          showToast(error.message);
          remove.disabled = false;
        }
      });
      actions.append(test, edit, toggle, remove);
      card.append(actions);
      card.append(testResult);
      if (server.tools.length) {
        const toolList = node('ul', 'mcp-tool-list');
        for (const tool of server.tools) {
          const item = node('li', 'mcp-tool-item');
          item.append(node('strong', 'goal-title', tool.name), node('p', 'goal-details', `${tool.kind} · ${tool.description}`));
          toolList.append(item);
        }
        card.append(toolList);
      } else {
        card.append(node('p', 'muted-copy', 'No tools, resources, or prompts are currently available.'));
      }
      return card;
    });
    content.replaceChildren(
      ...packageSection,
      addButton,
      auditButton,
      ...cards,
      node(
        'p',
        'muted-copy',
        'MCP names and descriptions come from user-configured servers and are untrusted metadata. Tool access remains subject to runtime approval and sandbox policy.',
      ),
      node(
        'p',
        'muted-copy',
        'Changes are saved for future runs. Stop active runs before changing server state. Credentials must use env:VARIABLE or secret:vault-key references; raw secret values are not accepted.',
      ),
    );
  } catch (error) {
    content.replaceChildren(node('p', 'muted-copy', error.message));
  }
}

function renderSignedMcpPackageSection(packageState, catalog, packageError = null) {
  const heading = node('h3', 'skills-package-heading', 'Signed MCP packages');
  const packageList = node('div', 'data-list');
  if (packageError) {
    packageList.append(node('p', 'muted-copy', packageError.message));
  } else if (!packageState?.configured) {
    packageList.append(node('p', 'muted-copy', 'Configure signed package trust in the user settings to manage MCP packages here.'));
  } else if (!packageState.packages.length) {
    packageList.append(node('p', 'empty-sessions', 'No signed MCP packages are installed.'));
  } else {
    for (const mcpPackage of packageState.packages) {
      const card = node('article', 'data-card skill-card');
      const activeVersion = mcpPackage.active_version;
      const enabledServers = mcpPackage.enabled_configured_servers || [];
      const state = activeVersion
        ? `Active version ${activeVersion}`
        : mcpPackage.available_versions.length
          ? 'Installed and inactive'
          : 'No installed versions';
      card.append(node('strong', 'goal-title', mcpPackage.package_id), node('p', 'goal-details', state));
      card.append(
        node(
          'p',
          'muted-copy',
          mcpPackage.configured_servers.length
            ? `Configured for ${mcpPackage.configured_servers.join(', ')}${enabledServers.length ? ` · enabled: ${enabledServers.join(', ')}` : ''}`
            : 'No user-configured MCP server references this package.',
        ),
      );
      const actions = node('div', 'card-actions');
      const manage = (label, operation, confirmation) => {
        const button = node('button', 'text-button', label);
        button.type = 'button';
        button.addEventListener('click', async () => {
          if (!window.confirm(confirmation)) return;
          button.disabled = true;
          try {
            const response = await operation();
            showToast(response.result?.changed ? `${mcpPackage.package_id} updated.` : 'No package change was needed.');
            await openMcpServers();
          } catch (error) {
            showToast(error.message);
            button.disabled = false;
          }
        });
        actions.append(button);
      };
      const launchDetail = enabledServers.length
        ? ` This will reconnect enabled server${enabledServers.length === 1 ? '' : 's'} ${enabledServers.join(', ')} and may start signed code under the current OS account.`
        : ' It will stay inert until an enabled user MCP server references it.';
      if (activeVersion) {
        manage(
          'Disable package',
          () => client.disableSignedMcpPackage(mcpPackage.package_id),
          `Disable signed MCP package '${mcpPackage.package_id}'? Any running server using it will be disconnected.`,
        );
        if (mcpPackage.previous_versions.length) {
          const rollbackVersion = mcpPackage.previous_versions[0];
          manage(
            `Roll back to ${rollbackVersion}`,
            () => client.rollbackSignedMcpPackage(mcpPackage.package_id),
            `Reactivate signed MCP package '${mcpPackage.package_id}' version ${rollbackVersion}? Its signature and revocation state will be checked.${launchDetail}`,
          );
        }
      }
      const previousVersions = new Set(mcpPackage.previous_versions);
      for (const version of mcpPackage.available_versions) {
        if (version !== activeVersion && (!activeVersion || !previousVersions.has(version))) {
          manage(
            `Activate ${version}`,
            () => client.activateSignedMcpPackage(mcpPackage.package_id, version),
            `Activate signed MCP package '${mcpPackage.package_id}' version ${version}? Its signature and revocation state will be checked.${launchDetail}`,
          );
        }
      }
      card.append(actions);
      packageList.append(card);
    }
  }
  if (catalog.enabled !== true) {
    packageList.append(
      node('p', 'muted-copy', 'MCP is disabled globally; activated packages will not connect until it is enabled in user settings.'),
    );
  }
  return [
    heading,
    packageList,
    node(
      'p',
      'muted-copy',
      'Activation and rollback recheck signatures and revocations. Package actions are audited and can reconnect configured MCP processes. Stop active runs first. Publisher capability declarations do not grant operating-system access.',
    ),
  ];
}

async function openMcpAuditHistory() {
  elements.settings_title.textContent = 'MCP audit history';
  if (!elements.settings_dialog.open) elements.settings_dialog.showModal();
  const content = elements.settings_content;
  content.replaceChildren(node('p', 'muted-copy', 'Loading recent MCP audit events…'));
  try {
    const history = await client.listMcpAuditHistory({ limit: 100 });
    const back = node('button', 'text-button', 'Back to MCP servers');
    back.type = 'button';
    back.addEventListener('click', () => void openMcpServers());
    const refresh = node('button', 'text-button', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', () => void openMcpAuditHistory());
    const actions = node('div', 'card-actions');
    actions.append(back, refresh);
    const entries = history.entries.map((entry) => {
      const card = node('article', 'data-card');
      const subject = [entry.server, entry.action || entry.tool].filter(Boolean).join(' · ') || 'MCP event';
      const timestamp = Number.isFinite(Date.parse(entry.timestamp)) ? new Date(entry.timestamp).toLocaleString() : 'Unknown time';
      const outcome = entry.outcome || entry.decision || 'recorded';
      card.append(node('strong', 'goal-title', subject), node('p', 'goal-details', `${timestamp} · ${outcome}`));
      if (entry.error_code) card.append(node('p', 'connection-test-row failed', `Error · ${entry.error_code}`));
      return card;
    });
    content.replaceChildren(
      actions,
      ...(entries.length ? entries : [node('p', 'empty-sessions', 'No MCP audit events have been recorded yet.')]),
      ...(history.truncated
        ? [node('p', 'muted-copy', 'Showing the newest 100 events; older events are available in the workspace audit file.')]
        : []),
      node(
        'p',
        'muted-copy',
        'History shows sanitized lifecycle events and tool outcomes. Arguments, prompts, tool results, commands, and credential references are omitted.',
      ),
    );
  } catch (error) {
    const back = node('button', 'text-button', 'Back to MCP servers');
    back.type = 'button';
    back.addEventListener('click', () => void openMcpServers());
    content.replaceChildren(back, node('p', 'muted-copy', error.message));
  }
}

function renderMcpServerEditor({ name, config }) {
  elements.settings_title.textContent = name ? `Edit MCP server · ${name}` : 'Add MCP server';
  const content = elements.settings_content;
  const form = node('form', 'mcp-editor');
  const field = (labelText, value, { type = 'text', className = '' } = {}) => {
    const label = node('label', 'mcp-editor-field');
    label.append(node('span', '', labelText));
    const tag = type === 'textarea' ? 'textarea' : type === 'select' ? 'select' : 'input';
    const control = node(tag, 'data-input');
    if (tag === 'input') control.type = type;
    control.value = value ?? '';
    if (className) label.classList.add(className);
    label.append(control);
    form.append(label);
    return { label, control };
  };
  const named = field('Server name', name, { className: 'mcp-name-field' });
  named.control.required = true;
  named.control.pattern = '[a-z][a-z0-9_-]{0,31}';
  named.control.maxLength = 32;
  named.control.disabled = Boolean(name);
  const enabled = field('Enabled', '', { type: 'checkbox' });
  enabled.control.checked = config.enabled !== false;
  const transport = field('Transport', '', { type: 'select' });
  transport.control.replaceChildren(
    new Option('stdio', 'stdio'),
    new Option('Streamable HTTP', 'streamable_http'),
    new Option('Legacy HTTP + SSE', 'sse'),
  );
  transport.control.value = config.transport || 'stdio';
  const command = field('Command', config.command, { className: 'mcp-stdio-field' });
  const packageId = field('Signed MCP package ID', config.package_id, { className: 'mcp-stdio-field' });
  const args = field('Arguments · JSON string array', JSON.stringify(config.args || []), {
    type: 'textarea',
    className: 'mcp-stdio-field',
  });
  const cwd = field('Working directory', config.cwd, { className: 'mcp-stdio-field' });
  const env = field('Environment references · NAME=env:VARIABLE or NAME=secret:key', formatMcpReferences(config.env), {
    type: 'textarea',
    className: 'mcp-stdio-field',
  });
  const url = field('HTTPS or loopback URL', config.url, { className: 'mcp-http-field' });
  const headers = field('Header references · Header=env:VARIABLE or Header=secret:key', formatMcpReferences(config.headers), {
    type: 'textarea',
    className: 'mcp-http-field',
  });
  const timeout = field('Timeout · milliseconds (1000–120000)', config.timeout_ms || 30000, { type: 'number' });
  timeout.control.min = '1000';
  timeout.control.max = '120000';
  const feedback = node('p', 'muted-copy', '');
  const actions = node('div', 'card-actions');
  const save = node('button', 'send-button', name ? 'Save settings' : 'Add server');
  save.type = 'submit';
  const cancel = node('button', 'text-button', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => void openMcpServers());
  actions.append(save, cancel);
  form.append(feedback, actions);
  const updateTransportFields = () => {
    const isHttp = transport.control.value !== 'stdio';
    for (const label of form.querySelectorAll('.mcp-stdio-field')) label.hidden = isHttp;
    for (const label of form.querySelectorAll('.mcp-http-field')) label.hidden = !isHttp;
  };
  transport.control.addEventListener('change', updateTransportFields);
  updateTransportFields();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    feedback.textContent = 'Saving and connecting…';
    try {
      const chosenTransport = transport.control.value;
      const serverConfig = { enabled: enabled.control.checked, transport: chosenTransport, timeout_ms: Number(timeout.control.value) };
      if (chosenTransport === 'stdio') {
        serverConfig.command = command.control.value.trim() || null;
        serverConfig.package_id = packageId.control.value.trim() || null;
        serverConfig.args = parseMcpArgs(args.control.value);
        serverConfig.cwd = cwd.control.value.trim() || null;
        serverConfig.env = parseMcpReferences(env.control.value);
        serverConfig.url = null;
        serverConfig.headers = null;
      } else {
        serverConfig.url = url.control.value.trim();
        serverConfig.headers = parseMcpReferences(headers.control.value);
        for (const key of ['command', 'package_id', 'args', 'cwd', 'env']) serverConfig[key] = null;
      }
      if (name) await client.updateMcpServer(name, serverConfig);
      else await client.addMcpServer(named.control.value.trim(), serverConfig);
      showToast(`${name || named.control.value.trim()} saved for future runs.`);
      await openMcpServers();
    } catch (error) {
      feedback.textContent = error.message;
      save.disabled = false;
    }
  });
  content.replaceChildren(form);
}

function formatMcpReferences(references = {}) {
  return Object.entries(references)
    .map(([name, reference]) => `${name}=${reference}`)
    .join('\n');
}

function parseMcpReferences(value) {
  const result = {};
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('Each reference must use NAME=env:VARIABLE or NAME=secret:key.');
    const name = line.slice(0, separator).trim();
    const reference = line.slice(separator + 1).trim();
    if (Object.hasOwn(result, name)) throw new Error(`Duplicate reference name: ${name}`);
    result[name] = reference;
  }
  return result;
}

function parseMcpArgs(value) {
  let parsed;
  try {
    parsed = JSON.parse(value || '[]');
  } catch {
    throw new Error('Arguments must be a valid JSON array of strings.');
  }
  if (!Array.isArray(parsed) || parsed.some((argument) => typeof argument !== 'string'))
    throw new Error('Arguments must be a JSON array of strings.');
  return parsed;
}

async function initialize() {
  try {
    const [health, settings, usage, mcpServers] = await Promise.all([
      withStartupTimeout('runtime health check', (signal) => client.health({ signal })),
      withStartupTimeout('runtime settings', (signal) => client.getSettings({ signal })),
      withStartupTimeout('usage information', (signal) => client.getUsage({ signal })).catch(() => null),
      withStartupTimeout('MCP server list', (signal) => client.listMcpServers({ signal })).catch(() => []),
    ]);
    elements.semantic_search_toggle.closest('label').hidden = settings.retrieval?.semantic?.enabled !== true;
    if (health.status !== 'ready') throw new Error('The local runtime is not ready.');
    modelProfiles = settings.models || {};
    runtimeSettings = settings;
    renderConfiguredModelProfiles();
    mcpServerCatalog = mcpServers;
    renderMcpRunSelection();
    applyUiPreferences(settings.ui);
    usageSnapshot = usage;
    renderRunInspector();
    const routingEnabled = settings.routing?.enabled !== false;
    const fallback = node(
      'option',
      '',
      routingEnabled ? 'Auto · best match for this task' : settings.default_model || 'Configured default',
    );
    fallback.value = routingEnabled ? AUTO_MODEL_OPTION : settings.default_model || '';
    fallback.selected = true;
    elements.model_picker.replaceChildren(fallback);
    elements.model_picker.disabled = false;
    await withStartupTimeout('recent sessions', (signal) => refreshSessions({ signal }));
    clearError();
    setConnected(true);
    if (settings.app_updates?.mode === 'notify' && !appUpdateCheckedThisSession) {
      appUpdateCheckedThisSession = true;
      void client
        .checkApplicationUpdates()
        .then((result) => {
          if (result.update_available)
            showToast(
              `Xyst AI Assistant ${result.release.version} is available. Open Runtime settings and check again to prepare its verified download.`,
            );
        })
        .catch((error) => showToast(`Automatic update check failed: ${error.message}`));
    }
    void client
      .listModels()
      .then((profiles) => {
        const selected = elements.model_picker.value;
        const shouldSelectAuto = selected === AUTO_MODEL_OPTION || (!modelProfiles[selected] && settings.routing?.enabled !== false);
        const options = profiles.map((profile) => {
          const configuredModel = settings.models?.[profile.profile]?.model;
          const visionLabel = modelProfiles[profile.profile]?.supports_vision === true ? ' · Vision' : '';
          const unavailable = profile.error ? ' · unavailable' : '';
          return {
            value: profile.profile,
            label: `${profile.profile} · ${configuredModel || profile.models?.[0] || 'configured'}${visionLabel}${unavailable}`,
          };
        });
        if (!options.length) return;
        elements.model_picker.replaceChildren();
        const automaticOption = node(
          'option',
          '',
          settings.routing?.enabled === false ? 'Auto · configured default' : 'Auto · best match for this task',
        );
        automaticOption.value = AUTO_MODEL_OPTION;
        automaticOption.title = 'Choose a model automatically for each task. Select a profile to pin one model.';
        automaticOption.selected = shouldSelectAuto;
        elements.model_picker.append(automaticOption);
        for (const option of options) {
          const item = node('option', '', option.label);
          item.value = option.value;
          item.selected = option.value === selected || (!shouldSelectAuto && !selected && option.value === settings.default_model);
          elements.model_picker.append(item);
        }
        if (!elements.model_picker.value)
          elements.model_picker.value = shouldSelectAuto ? AUTO_MODEL_OPTION : settings.default_model || options[0].value;
        elements.model_picker.title = 'Auto routes each task to a configured model; choosing a profile pins it for the run.';
        appendLocalModelPickerOptions();
      })
      .catch(() => {
        /* current settings still provide a usable default if a provider is offline */
      });
    void refreshLocalModels({ quiet: true });
  } catch (error) {
    showError(error);
    elements.model_picker.replaceChildren(node('option', '', 'Runtime unavailable'));
    elements.model_picker.disabled = true;
  }
}

elements.prompt_form.addEventListener('submit', (event) => {
  event.preventDefault();
  void submitPrompt(elements.prompt_input.value);
});
elements.prompt_input.addEventListener('input', resizeComposer);
elements.model_picker.addEventListener('change', () => {
  const value = elements.model_picker.value;
  if (value.startsWith('local-discovery:')) {
    const index = Number(value.slice('local-discovery:'.length));
    if (localModelChoices[index]?.server.model_states?.[localModelChoices[index].model] === 'not_loaded')
      void loadAndConnectDiscoveredModel(index);
    else void connectDiscoveredModel(index);
    return;
  }
  renderRunModelControl();
});
elements.attach_images.addEventListener('click', () => elements.image_files.click());
elements.image_files.addEventListener('change', () => addImageFiles(elements.image_files.files || []));
elements.prompt_input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements.prompt_form.requestSubmit();
  }
});
elements.new_session.addEventListener('click', () => {
  if (runController) return;
  activeSessionId = null;
  elements.run_mode.value = 'agent';
  selectPrimaryTab('agent');
  mcpServerSelection = null;
  renderMcpRunSelection();
  currentRoutingDecision = null;
  renderRunInspector();
  elements.session_actions.hidden = true;
  elements.conversation_title.textContent = 'New conversation';
  resetTimeline();
  renderSessions([...sessionsById.values()]);
  elements.prompt_input.focus();
});
elements.refresh_sessions.addEventListener('click', () => void refreshSessions().catch(showError));
elements.import_session.addEventListener('click', () => elements.import_session_file.click());
elements.import_session_file.addEventListener('change', () => void importSessionFile(elements.import_session_file.files?.[0]));
elements.stop_run.addEventListener('click', () => void stopRun());
elements.pause_run.addEventListener('click', () => void toggleRunPause());
elements.change_run_model.addEventListener('click', () => void applyRunModelChange());
elements.apply_run_budgets.addEventListener('click', () => void applyRunBudgetChanges());
elements.send_direction.addEventListener('click', () => void sendRunDirection());
elements.search_form.addEventListener('submit', (event) => {
  event.preventDefault();
  void searchWorkspace(elements.workspace_search.value);
});
for (const tab of elements.primary_tabs.querySelectorAll('[role="tab"]')) {
  tab.addEventListener('click', () => {
    if (tab.dataset.mode) selectPrimaryTab(tab.dataset.mode);
    else {
      selectPrimaryTab('settings');
      if (!localDiscoveryCompleted) void refreshLocalModels({ quiet: true });
    }
  });
}
elements.primary_tabs.addEventListener('keydown', (event) => {
  const tabs = [...elements.primary_tabs.querySelectorAll('[role="tab"]')];
  const current = tabs.indexOf(document.activeElement);
  if (current < 0) return;
  const next =
    event.key === 'ArrowRight'
      ? (current + 1) % tabs.length
      : event.key === 'ArrowLeft'
        ? (current - 1 + tabs.length) % tabs.length
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : -1;
  if (next < 0) return;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
});
elements.discover_models_button.addEventListener('click', () => void refreshLocalModels());
elements.settings_discover_models.addEventListener('click', () => void refreshLocalModels());
elements.advanced_settings_button.addEventListener('click', () => void openSettings());
elements.toggle_sidebar.addEventListener('click', () => void toggleSidebar());
elements.memory_button.addEventListener('click', () => void openMemory());
elements.goals_button.addEventListener('click', () => void openGoals());
elements.skills_button.addEventListener('click', () => void openSkills());
elements.mcp_button.addEventListener('click', () => void openMcpServers());
elements.extensions_button.addEventListener('click', () => void openExtensions());
elements.processes_button.addEventListener('click', openProcesses);
elements.refresh_processes.addEventListener('click', () => void refreshProcesses());
elements.close_processes.addEventListener('click', () => elements.process_dialog.close());
elements.process_dialog.addEventListener('click', (event) => {
  if (event.target === elements.process_dialog) elements.process_dialog.close();
});
elements.workspace_button.addEventListener('click', workspacePanel.open);
elements.rename_session.addEventListener('click', () => void manageSession('rename'));
elements.recap_session.addEventListener('click', () => void showSessionRecap());
elements.close_recap.addEventListener('click', () => elements.recap_dialog.close());
elements.recap_dialog.addEventListener('click', (event) => {
  if (event.target === elements.recap_dialog) elements.recap_dialog.close();
});
elements.export_session.addEventListener('click', () => void manageSession('export'));
elements.fork_session.addEventListener('click', () => void manageSession('fork'));
elements.archive_session.addEventListener('click', () => void manageSession('archive'));
elements.delete_session.addEventListener('click', () => void manageSession('delete'));
elements.close_settings.addEventListener('click', () => elements.settings_dialog.close());
elements.settings_dialog.addEventListener('click', (event) => {
  if (event.target === elements.settings_dialog) elements.settings_dialog.close();
});
for (const suggestion of document.querySelectorAll('[data-prompt]'))
  suggestion.addEventListener('click', () => {
    elements.prompt_input.value = suggestion.dataset.prompt;
    resizeComposer();
    elements.prompt_input.focus();
  });
document.addEventListener('keydown', (event) => {
  if (runtimeSettings.ui?.shortcuts_enabled === false) return;
  const target = event.target instanceof Element ? event.target : null;
  const editingText = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'));
  const bindings = Object.fromEntries(
    Object.keys(DEFAULT_UI_SHORTCUTS).map((action) => [action, runtimeSettings.ui?.shortcuts?.[action] || DEFAULT_UI_SHORTCUTS[action]]),
  );
  if (matchesUiShortcut(event, bindings.toggle_sidebar) && !editingText) {
    event.preventDefault();
    void toggleSidebar();
  }
  if (matchesUiShortcut(event, bindings.new_session) && !editingText) {
    event.preventDefault();
    elements.new_session.click();
  }
  if (matchesUiShortcut(event, bindings.focus_search) && !editingText) {
    event.preventDefault();
    elements.workspace_search.focus();
  }
});

void initialize();
