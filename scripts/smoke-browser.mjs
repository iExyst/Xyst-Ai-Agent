import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { terminateProcessTree } from '../src/platform/process.mjs';
import { buildExampleMcpPackage } from './build-example-mcp-package.mjs';
import { installSignedPackage } from '../src/extensions/signed-packages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TIMEOUT_MS = 30_000;

export async function smokeBrowser({ browserExecutable = process.env.XYST_BROWSER_EXECUTABLE } = {}) {
  const browser = browserExecutable || (await findBrowserExecutable());
  const progress = (message) => {
    if (process.env.XYST_SMOKE_PROGRESS === '1') process.stderr.write(`[browser-smoke] ${message}\n`);
  };
  const testRoot = path.join(ROOT, '.test-tmp');
  await fs.mkdir(testRoot, { recursive: true });
  const temporaryDirectory = await fs.mkdtemp(path.join(testRoot, 'xyst-browser-smoke-'));
  const workspace = path.join(temporaryDirectory, 'workspace');
  const profile = path.join(temporaryDirectory, 'browser-profile');
  await fs.mkdir(workspace);
  const environment = isolatedEnvironment(temporaryDirectory);
  let service;
  let mockProvider;
  let browserProcess;
  let browserProtocol;
  let protocol;
  const browserDiagnostics = [];
  try {
    progress('starting mock provider');
    mockProvider = await startMockProvider();
    progress('starting local service');
    service = await startService(workspace, environment, mockProvider.url);
    const appUrl = new URL('/app', service.url).href;
    progress('checking local UI route');
    const appResponse = await fetch(appUrl, { signal: AbortSignal.timeout(10_000) });
    assert.equal(appResponse.status, 200, 'Local UI route did not return a successful response');
    assert.match(appResponse.headers.get('content-type') || '', /^text\/html\b/i, 'Local UI route did not return HTML');
    const appHtml = await appResponse.text();
    assert.ok(Buffer.byteLength(appHtml) <= 2 * 1024 * 1024, 'Local UI response exceeds the smoke-test size limit');
    assert.match(appHtml, /<title>Xyst AI Assistant<\/title>/, 'Local UI response has the wrong product title');
    progress('launching headless browser');
    const useWebSocket = process.platform === 'win32';
    const remoteDebuggingArguments = useWebSocket
      ? ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--remote-allow-origins=*']
      : ['--remote-debugging-pipe'];
    browserProcess = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-mode',
        '--disable-background-networking',
        '--no-proxy-server',
        ...remoteDebuggingArguments,
        `--user-data-dir=${profile}`,
      ],
      {
        cwd: temporaryDirectory,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: useWebSocket ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      },
    );
    browserProcess.stderr.on('data', (chunk) => {
      if (Buffer.concat(browserDiagnostics).length < 8 * 1024) browserDiagnostics.push(chunk);
    });
    if (useWebSocket) {
      const port = await waitForDevtoolsPort(profile, browserDiagnostics);
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.ok, true, 'Headless browser did not expose its DevTools version endpoint');
      const version = await response.json();
      browserProtocol = await connectDevtoolsWebSocket(version.webSocketDebuggerUrl);
    } else {
      // Chromium reads commands from fd 3 and writes responses to fd 4.
      browserProtocol = await connectDevtoolsPipe(browserProcess.stdio[4], browserProcess.stdio[3], browserProcess, browserDiagnostics);
    }
    const target = await browserProtocol.call('Target.createTarget', { url: 'about:blank' });
    const attached = await browserProtocol.call('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    protocol = browserProtocol.withSession(attached.sessionId);
    const pageErrors = [];
    const failedResponses = [];
    const navigationEvents = [];
    protocol.onEvent(({ method, params }) => {
      if (
        [
          'Network.requestWillBeSent',
          'Network.loadingFailed',
          'Page.frameStartedLoading',
          'Page.frameNavigated',
          'Inspector.targetCrashed',
        ].includes(method) &&
        navigationEvents.length < 40
      ) {
        navigationEvents.push({
          method,
          url: params.request?.url || params.frame?.url || '',
          error: params.errorText || '',
        });
      }
      if (method === 'Runtime.exceptionThrown') {
        pageErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'JavaScript exception');
      } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        pageErrors.push(
          (params.args || [])
            .map((item) => item.value || item.description || '')
            .join(' ')
            .slice(0, 500),
        );
      } else if (method === 'Log.entryAdded' && params.entry?.level === 'error') {
        pageErrors.push(params.entry.text || 'Browser console error');
      } else if (method === 'Network.responseReceived' && params.response?.status >= 400) {
        failedResponses.push({ status: params.response.status, url: params.response.url });
      }
    });
    await protocol.call('Page.enable');
    await protocol.call('Runtime.enable');
    await protocol.call('Log.enable');
    await protocol.call('Network.enable');
    await protocol.call('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await protocol.call('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        const originalFetch = window.fetch.bind(window);
        const localModelId = 'browser-local-smoke';
        const modelId = 'browser-unloaded-smoke';
        const configuredModelId = 'browser-configured-smoke';
        const loadedModels = new Set();
        let emptyDiscoveryAfterLoad = false;
        window.__xystSmokeLoadRequests = [];
        window.__xystSmokeLocalDiscovery = [];
        window.fetch = async (input, init = {}) => {
          const url = typeof input === 'string' ? input : input.url;
          if (url.endsWith('/v1/local-models/load') && init.method === 'POST') {
            const request = JSON.parse(init.body || '{}');
            window.__xystSmokeLoadRequests.push(request.model);
            if (![modelId, configuredModelId].includes(request.model))
              return Response.json({ error: 'Unexpected model load in browser smoke' }, { status: 400 });
            loadedModels.add(request.model);
            emptyDiscoveryAfterLoad = true;
            return Response.json({ model: request.model, loaded: true, already_loaded: false, context_length: 8192 });
          }
          const response = await originalFetch(input, init);
          if (!url.endsWith('/v1/local-models') || (init.method && init.method !== 'GET')) return response;
          const result = await response.json();
          result.servers = (result.servers || []).filter((server) => server.base_url !== 'http://127.0.0.1:1234/v1');
          if (emptyDiscoveryAfterLoad) {
            emptyDiscoveryAfterLoad = false;
            result.servers = [];
            return Response.json(result, { status: response.status });
          }
          result.servers.push({
            name: 'lm-studio',
            base_url: 'http://127.0.0.1:1234/v1',
            models: [localModelId, modelId, configuredModelId],
            model_states: {
              [localModelId]: 'loaded',
              [modelId]: loadedModels.has(modelId) ? 'loaded' : 'not_loaded',
              [configuredModelId]: loadedModels.has(configuredModelId) ? 'loaded' : 'not_loaded',
            },
            model_context_lengths: Object.fromEntries([...loadedModels].map((model) => [model, 8192])),
            model_capabilities: {
              [localModelId]: { supports_tools: true, supports_vision: false },
              [modelId]: { supports_tools: true, supports_vision: false },
              [configuredModelId]: { supports_tools: false, supports_vision: true },
            },
          });
          window.__xystSmokeLocalDiscovery.push({ status: response.status, servers: result.servers.map((server) => server.name) });
          return Response.json(result, { status: response.status });
        };
      })();`,
    });
    try {
      await protocol.call('Page.navigate', { url: appUrl });
    } catch (error) {
      const browserLog = Buffer.concat(browserDiagnostics).toString('utf8').trim().slice(-2_000);
      throw new Error(
        `${error.message}; requested URL ${appUrl}; navigation events ${JSON.stringify(navigationEvents)}${browserLog ? `; browser stderr ${browserLog}` : ''}`,
      );
    }
    await waitForAppReady(protocol, pageErrors, failedResponses);
    progress('checking workspace accessibility and settings');

    const pageState = await evaluate(
      protocol,
      `(() => {
      const visible = (element) => {
        if (element.closest('[hidden], [aria-hidden="true"]')) return false;
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
      };
      const controls = [...document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])')]
        .filter(visible)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          id: element.id,
          name: element.getAttribute('aria-label') || element.labels?.[0]?.innerText?.trim() || element.innerText?.trim() || element.title || '',
          disabled: Boolean(element.disabled),
        }));
      const header = document.querySelector('.topbar');
      const actions = header?.querySelector('.topbar-actions');
      const headerRect = header?.getBoundingClientRect();
      const sidebarHeading = document.querySelector('.section-heading');
      const recentLabelRect = sidebarHeading?.querySelector(':scope > span')?.getBoundingClientRect();
      const importButtonRect = sidebarHeading?.querySelector('#import-session')?.getBoundingClientRect();
      const sidebarHeadingRect = sidebarHeading?.getBoundingClientRect();
      const actionRects = [...(actions?.children || [])]
        .filter((element) => visible(element))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        });
      const actionOverlap = actionRects.some((left, index) => actionRects.slice(index + 1).some((right) =>
        Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1 &&
        Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1));
      return {
        title: document.title,
        welcome: document.querySelector('#welcome h1')?.innerText?.replace(/\\s+/g, ' ').trim() || '',
        connection: document.querySelector('#connection-indicator')?.getAttribute('aria-label') || '',
        navigationName: document.querySelector('#session-list')?.getAttribute('aria-label') || '',
        mainCount: document.querySelectorAll('main, [role="main"]').length,
        layout: {
          viewportWidth: window.innerWidth,
          documentWidth: document.documentElement.scrollWidth,
          actionOverflow: actions ? actions.scrollWidth > actions.clientWidth + 1 : true,
          actionOverlap,
          actionsInsideHeader: Boolean(headerRect && actions && actions.getBoundingClientRect().right <= headerRect.right + 1),
          sidebarHeadingOverlap: Boolean(recentLabelRect && importButtonRect && Math.min(recentLabelRect.right, importButtonRect.right) - Math.max(recentLabelRect.left, importButtonRect.left) > 1),
          importInsideSidebarHeading: Boolean(sidebarHeadingRect && importButtonRect && importButtonRect.right <= sidebarHeadingRect.right + 1),
        },
        controls,
      };
    })()`,
    );
    assert.equal(pageState.title, 'Xyst AI Assistant');
    assert.ok(pageState.welcome, 'The first-run welcome content did not render');
    assert.equal(pageState.connection, 'Connected to local runtime', 'The browser UI did not connect to its local runtime');
    assert.equal(pageState.mainCount, 1, 'The app must expose one primary main landmark');
    assert.equal(pageState.navigationName, 'Recent conversations', 'Session navigation must have an accessible name');
    assert.equal(pageState.layout.viewportWidth, 900);
    assert.ok(
      pageState.layout.documentWidth <= pageState.layout.viewportWidth,
      'The app must not introduce horizontal page overflow at the minimum supported window width',
    );
    assert.deepEqual(
      {
        actionOverflow: pageState.layout.actionOverflow,
        actionOverlap: pageState.layout.actionOverlap,
        actionsInsideHeader: pageState.layout.actionsInsideHeader,
      },
      { actionOverflow: false, actionOverlap: false, actionsInsideHeader: true },
      'The desktop toolbar must remain readable within the minimum supported window width',
    );
    assert.deepEqual(
      {
        sidebarHeadingOverlap: pageState.layout.sidebarHeadingOverlap,
        importInsideSidebarHeading: pageState.layout.importInsideSidebarHeading,
      },
      { sidebarHeadingOverlap: false, importInsideSidebarHeading: true },
      'The sidebar heading and session import action must remain separate and contained',
    );

    progress('checking responsive window resizing');
    const resizeLayouts = [];
    for (const viewport of [
      { width: 1440, height: 920 },
      { width: 1180, height: 720 },
      { width: 900, height: 600 },
      { width: 760, height: 540 },
    ]) {
      await protocol.call('Emulation.setDeviceMetricsOverride', {
        ...viewport,
        deviceScaleFactor: 1,
        mobile: false,
      });
      const layout = await evaluate(
        protocol,
        `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const rect = (selector) => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const bounds = element.getBoundingClientRect();
            return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
          };
          const frame = document.querySelector('#app-frame');
          const main = document.querySelector('.main-panel');
          const timeline = document.querySelector('#timeline');
          const frameRect = rect('#app-frame');
          const mainRect = rect('.main-panel');
          const composerRect = rect('.composer-wrap');
          resolve({
            viewportWidth: innerWidth,
            viewportHeight: innerHeight,
            documentWidth: document.documentElement.scrollWidth,
            documentHeight: document.documentElement.scrollHeight,
            frame: frameRect,
            main: mainRect,
            frameClientHeight: frame.clientHeight,
            frameScrollHeight: frame.scrollHeight,
            mainClientHeight: main.clientHeight,
            mainScrollHeight: main.scrollHeight,
            timelineClientHeight: timeline.clientHeight,
            composerBottom: composerRect?.bottom ?? null,
          });
        })))`,
      );
      resizeLayouts.push(layout);
      assert.equal(layout.viewportWidth, viewport.width);
      assert.equal(layout.viewportHeight, viewport.height);
      assert.ok(
        layout.documentWidth <= viewport.width,
        `Horizontal page overflow at ${viewport.width}×${viewport.height}: ${JSON.stringify(layout)}`,
      );
      assert.ok(Math.abs(layout.frame.width - viewport.width) <= 1, `App shell did not track the resized width: ${JSON.stringify(layout)}`);
      assert.ok(
        Math.abs(layout.frame.height - viewport.height) <= 1,
        `App shell did not track the resized height: ${JSON.stringify(layout)}`,
      );
      assert.ok(
        layout.frameScrollHeight <= layout.frameClientHeight + 1,
        `App shell grew beyond the resized height: ${JSON.stringify(layout)}`,
      );
      assert.ok(
        layout.mainScrollHeight <= layout.mainClientHeight + 1,
        `Main panel grew beyond the resized height: ${JSON.stringify(layout)}`,
      );
      assert.ok(layout.timelineClientHeight > 0, `Conversation area collapsed at ${viewport.width}×${viewport.height}`);
      assert.ok(layout.composerBottom <= layout.main.bottom + 1, `Composer was clipped by the resized window: ${JSON.stringify(layout)}`);
    }
    await protocol.call('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    assert.ok(pageState.controls.length >= 8, 'Expected the primary workspace controls to be visible');
    assert.ok(
      pageState.controls.every((control) => control.name),
      `A visible interactive control has no accessible name: ${JSON.stringify(pageState.controls.filter((control) => !control.name))}`,
    );

    const tabState = await evaluate(
      protocol,
      `(() => {
        document.querySelector('#tab-plan').click();
        const plan = { mode: document.querySelector('#run-mode').value, selected: document.querySelector('#tab-plan').getAttribute('aria-selected') };
        document.querySelector('#tab-review').click();
        const review = { mode: document.querySelector('#run-mode').value, selected: document.querySelector('#tab-review').getAttribute('aria-selected') };
        document.querySelector('#settings-button').click();
        const settings = { visible: !document.querySelector('#settings-view').hidden, selected: document.querySelector('#settings-button').getAttribute('aria-selected') };
        document.querySelector('#tab-agent').click();
        document.querySelector('#tab-agent').focus();
        document.querySelector('#tab-agent').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        const keyboardPlan = document.querySelector('#run-mode').value;
        document.querySelector('#tab-agent').click();
        return { plan, review, settings, keyboardPlan };
      })()`,
    );
    assert.deepEqual(
      tabState,
      {
        plan: { mode: 'plan', selected: 'true' },
        review: { mode: 'review', selected: 'true' },
        settings: { visible: true, selected: 'true' },
        keyboardPlan: 'plan',
      },
      'Mode tabs must select their run mode and Settings must open its own page',
    );

    progress('checking local model discovery and selection');
    const initialModelChoice = await evaluate(
      protocol,
      `(() => ({ value: document.querySelector('#model-picker').value, label: document.querySelector('#model-picker').selectedOptions[0]?.textContent.trim() || '' }))()`,
    );
    assert.equal(initialModelChoice.value, '__xyst_auto__', 'The composer should start with automatic task-aware model routing');
    assert.match(initialModelChoice.label, /^Auto · best match for this task$/);
    const localDiscovery = await waitForLocalModelChoice(protocol, 'browser-local-smoke');
    if (!localDiscovery) {
      const observedDiscovery = await evaluate(
        protocol,
        `(() => ({
          options: [...document.querySelector('#model-picker').options].map((item) => item.textContent.trim()),
          cards: [...document.querySelectorAll('#local-model-results .local-model-row')].map((item) => item.innerText),
          responses: window.__xystSmokeLocalDiscovery || [],
        }))()`,
      );
      assert.ok(localDiscovery, `The model selector did not expose local server models: ${JSON.stringify(observedDiscovery)}`);
    }
    assert.ok(await waitForLocalModelChoice(protocol, 'browser-secondary-smoke'), 'The second local server was not discovered');
    await evaluate(
      protocol,
      `(() => {
        document.querySelector('#settings-button').click();
        const option = [...document.querySelector('#model-picker').options].find((item) => item.textContent.includes('browser-local-smoke'));
        if (!option) throw new Error('LM Studio discovery result is missing from the model selector');
        document.querySelector('#model-picker').value = option.value;
        document.querySelector('#model-picker').dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
    );
    await waitForToast(protocol, 'Connected browser-local-smoke from browser-smoke.');
    const settingsAfterLocalConnection = await evaluate(
      protocol,
      `(() => ({ visible: !document.querySelector('#settings-view').hidden, selected: document.querySelector('#settings-button').getAttribute('aria-selected') }))()`,
    );
    assert.deepEqual(settingsAfterLocalConnection, { visible: true, selected: 'true' }, 'Adding a local model must leave Settings open');
    const secondaryModelPreserved = await evaluate(
      protocol,
      `(() => [...document.querySelector('#model-picker').options].some((item) => item.textContent.includes('browser-secondary-smoke')))()`,
    );
    assert.equal(secondaryModelPreserved, true, 'Connecting one local model must preserve choices from other local servers');
    const localProfile = await evaluate(
      protocol,
      `(() => ({ selected: document.querySelector('#model-picker').value, listed: document.querySelector('#configured-models-list').innerText.includes('browser-local-smoke') }))()`,
    );
    assert.deepEqual(localProfile, { selected: 'browser-smoke-browser-local-smoke', listed: true });
    await evaluate(
      protocol,
      `(() => {
        const existing = [...document.querySelector('#model-picker').options].find((item) => item.textContent.includes('browser-approval-smoke') && item.value.startsWith('local-discovery:'));
        if (!existing) throw new Error('Existing local server model was not discoverable');
        document.querySelector('#model-picker').value = existing.value;
        document.querySelector('#model-picker').dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
    );
    await waitForToast(protocol, 'Connected browser-approval-smoke from browser-smoke.');
    const reusedModel = await evaluate(
      protocol,
      `(() => ({ selected: document.querySelector('#model-picker').value, profileCount: document.querySelectorAll('#configured-models-list .configured-model-row').length }))()`,
    );
    assert.deepEqual(
      reusedModel,
      { selected: 'approval-smoke', profileCount: 4 },
      'Selecting an already configured model should reuse its profile',
    );
    await evaluate(protocol, `document.querySelector('#settings-discover-models').click()`);
    assert.ok(await waitForLocalModelChoice(protocol, 'browser-unloaded-smoke'), 'The unloaded LM Studio test model was not discovered');
    const unloadedModelState = await evaluate(
      protocol,
      `(() => {
        const row = [...document.querySelectorAll('#local-model-results .local-model-row')]
          .find((item) => item.innerText.includes('browser-unloaded-smoke'));
        return {
          details: row?.innerText || '',
          rawDetails: row?.textContent || '',
          action: row?.querySelector('button')?.textContent.trim() || '',
          rowCount: document.querySelectorAll('#local-model-results .local-model-row').length,
          resultsText: document.querySelector('#local-model-results')?.innerText || '',
          settingsVisible: !document.querySelector('#settings-view')?.hidden,
          selectedSettingsTab: document.querySelector('#settings-button')?.getAttribute('aria-selected') || '',
          modelOptionPresent: [...document.querySelector('#model-picker').options].some((item) => item.textContent.includes('browser-unloaded-smoke')),
        };
      })()`,
    );
    assert.match(unloadedModelState.details, /Installed · not loaded/, JSON.stringify(unloadedModelState));
    assert.match(unloadedModelState.details, /tool use/);
    assert.match(unloadedModelState.details, /text only/);
    assert.equal(unloadedModelState.action, 'Load & use');
    assert.deepEqual(await evaluate(protocol, 'window.__xystSmokeLoadRequests'), [], 'Discovery must not load models implicitly');
    await waitForLocalModelChoice(protocol, 'browser-configured-smoke');
    const configuredModelState = await evaluate(
      protocol,
      `(() => {
        const row = [...document.querySelectorAll('#local-model-results .local-model-row')]
          .find((item) => item.innerText.includes('browser-configured-smoke'));
        return { details: row?.innerText || '', action: row?.querySelector('button')?.textContent.trim() || '' };
      })()`,
    );
    assert.match(configuredModelState.details, /already configured/);
    assert.match(configuredModelState.details, /not tool-tuned/);
    assert.match(configuredModelState.details, /vision/);
    assert.equal(configuredModelState.action, 'Load model');
    await evaluate(
      protocol,
      `(() => {
        const row = [...document.querySelectorAll('#local-model-results .local-model-row')]
          .find((item) => item.innerText.includes('browser-configured-smoke'));
        row.querySelector('button').click();
      })()`,
    );
    await waitForToast(protocol, 'Loaded browser-configured-smoke in lm-studio.');
    const configuredModelLoadResult = await evaluate(
      protocol,
      `(() => ({
        selected: document.querySelector('#model-picker').value,
        details: [...document.querySelectorAll('#local-model-results .local-model-row')]
          .find((item) => item.innerText.includes('browser-configured-smoke'))?.innerText || '',
      }))()`,
    );
    assert.equal(configuredModelLoadResult.selected, 'approval-smoke', 'Loading a configured profile must not change the default model');
    assert.match(configuredModelLoadResult.details, /Loaded in LM Studio/);
    assert.deepEqual(await evaluate(protocol, 'window.__xystSmokeLoadRequests'), ['browser-configured-smoke']);
    await evaluate(
      protocol,
      `(() => {
        const row = [...document.querySelectorAll('#local-model-results .local-model-row')]
          .find((item) => item.innerText.includes('browser-unloaded-smoke'));
        row.querySelector('button').click();
      })()`,
    );
    await waitForToast(protocol, 'Connected browser-unloaded-smoke from lm-studio.');
    const loadedModelState = await evaluate(
      protocol,
      `(() => {
        const row = [...document.querySelectorAll('#local-model-results .local-model-row')]
          .find((item) => item.innerText.includes('browser-unloaded-smoke'));
        return { details: row?.innerText || '', action: row?.querySelector('button')?.textContent.trim() || '' };
      })()`,
    );
    assert.match(loadedModelState.details, /Loaded in LM Studio/);
    assert.match(loadedModelState.details, /tool use/);
    const connectedProfile = await evaluate(
      protocol,
      `(async () => {
        const token = document.querySelector('meta[name="xyst-token"]').content;
        const response = await fetch('/v1/settings', { headers: { authorization: 'Bearer ' + token } });
        if (!response.ok) throw new Error('Could not inspect the connected local model profile');
        const settings = await response.json();
        const profile = settings.settings.models['lm-studio-browser-unloaded-smoke'];
        return { supports_tools: profile?.supports_tools, supports_vision: profile?.supports_vision };
      })()`,
    );
    assert.deepEqual(connectedProfile, { supports_tools: true, supports_vision: false });
    assert.deepEqual(await evaluate(protocol, 'window.__xystSmokeLoadRequests'), ['browser-configured-smoke', 'browser-unloaded-smoke']);
    await evaluate(
      protocol,
      `(async () => {
        const token = document.querySelector('meta[name="xyst-token"]').content;
        const response = await fetch('/v1/settings', {
          method: 'PATCH',
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({
            models: {
              'browser-smoke-browser-local-smoke': null,
              'lm-studio-browser-configured-smoke': null,
              'lm-studio-browser-unloaded-smoke': null,
            },
            default_model: 'approval-smoke',
          }),
        });
        if (!response.ok) throw new Error('Could not restore browser smoke model settings');
        location.reload();
      })()`,
    );
    await waitForAppReady(protocol, pageErrors, failedResponses);

    const themeRendering = await evaluate(
      protocol,
      `(async () => {
        const root = document.documentElement;
        const originalTheme = root.dataset.theme || 'system';
        const probeDefinitions = {
          settings: ['div', 'settings-dialog'],
          dataCard: ['div', 'data-card'],
          composer: ['div', 'composer'],
          secondaryButton: ['button', 'secondary-button'],
          mutedCopy: ['p', 'muted-copy'],
          toast: ['div', 'toast'],
          suggestionCard: ['button', 'suggestion-card'],
          toolActivity: ['div', 'tool-activity'],
          toolDetail: ['details', 'tool-detail'],
          toolDetailBody: ['pre', 'tool-detail-body'],
          statusBanner: ['div', 'status-banner'],
          semanticToggle: ['label', 'semantic-toggle'],
          runError: ['span', 'run-error'],
        };
        const inspect = async (theme) => {
          root.dataset.theme = theme;
          const probes = Object.fromEntries(Object.entries(probeDefinitions).map(([name, [tag, className]]) => {
            const element = document.createElement(tag);
            element.className = className;
            document.body.append(element);
            return [name, element];
          }));
          const assistantMessage = document.createElement('article');
          assistantMessage.className = 'message assistant';
          const assistantMeta = document.createElement('div');
          assistantMeta.className = 'message-meta';
          assistantMessage.append(assistantMeta);
          document.body.append(assistantMessage);
          const workspaceCopyProbe = document.createElement('div');
          workspaceCopyProbe.className = 'workspace-copy';
          const workspaceHeadingProbe = document.createElement('strong');
          workspaceCopyProbe.append(workspaceHeadingProbe);
          document.body.append(workspaceCopyProbe);
          try {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          void document.body.offsetWidth;
          const styles = getComputedStyle(root);
          const tokenRgb = (name) => {
            const value = styles.getPropertyValue(name).trim();
            const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
            if (!match) throw new Error('Theme token is not a supported hex color: ' + name);
            const hex = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1];
            return 'rgb(' + hex.match(/../g).map((channel) => Number.parseInt(channel, 16)).join(', ') + ')';
          };
          return {
            canvas: styles.getPropertyValue('--canvas').trim(),
            surface: styles.getPropertyValue('--surface').trim(),
            codeSurface: styles.getPropertyValue('--surface-code').trim(),
            warningSurface: styles.getPropertyValue('--warning-surface').trim(),
            brand: Object.fromEntries(['cyan', 'mint', 'lime', 'violet', 'blue'].map((name) => [
              name,
              styles.getPropertyValue('--brand-' + name).trim(),
            ])),
            sidebarBackground: getComputedStyle(document.querySelector('.sidebar')).backgroundImage,
            colorScheme: styles.colorScheme,
            surfaces: {
              settings: getComputedStyle(probes.settings).backgroundColor,
              dataCard: getComputedStyle(probes.dataCard).backgroundColor,
              composer: getComputedStyle(probes.composer).backgroundColor,
              secondaryButton: getComputedStyle(probes.secondaryButton).backgroundColor,
              toastText: getComputedStyle(probes.toast).color,
              mutedCopy: getComputedStyle(probes.mutedCopy).color,
              suggestionBackground: getComputedStyle(probes.suggestionCard).backgroundColor,
              suggestionRadius: getComputedStyle(probes.suggestionCard).borderRadius,
              toolActivityBackground: getComputedStyle(probes.toolActivity).backgroundColor,
              toolDetailBackground: getComputedStyle(probes.toolDetail).backgroundColor,
              toolDetailText: getComputedStyle(probes.toolDetail).color,
              codeBackground: getComputedStyle(probes.toolDetailBody).backgroundColor,
              statusBackground: getComputedStyle(probes.statusBanner).backgroundColor,
              semanticToggleText: getComputedStyle(probes.semanticToggle).color,
              workspaceHeading: getComputedStyle(workspaceHeadingProbe).color,
              runError: getComputedStyle(probes.runError).color,
              assistantBadge: getComputedStyle(assistantMeta, '::before').backgroundImage,
              assistantMeta: getComputedStyle(assistantMeta).color,
            },
            reference: {
              surface: tokenRgb('--surface'),
              codeSurface: tokenRgb('--surface-code'),
              raised: tokenRgb('--surface-raised'),
              text: tokenRgb('--text'),
              subtleText: tokenRgb('--text-subtle'),
              strongText: tokenRgb('--text-strong'),
              danger: tokenRgb('--danger-strong'),
              mint: tokenRgb('--brand-mint'),
              mutedText: tokenRgb('--muted'),
              warningSurface: tokenRgb('--warning-surface'),
            },
          };
          } finally {
            Object.values(probes).forEach((element) => element.remove());
            assistantMessage.remove();
            workspaceCopyProbe.remove();
          }
        };
        const dark = await inspect('dark');
        const light = await inspect('light');
        root.dataset.theme = originalTheme;
        return {
          dark,
          light,
          logoLoaded: document.querySelector('.welcome-orbit img')?.naturalWidth > 0,
        };
      })()`,
    );
    assert.deepEqual(
      themeRendering.dark.brand,
      { cyan: '#58eaff', mint: '#a1fff1', lime: '#c5ff48', violet: '#b78aff', blue: '#176cff' },
      'Dark theme must use the colors from the Xyst alien artwork',
    );
    assert.match(themeRendering.dark.sidebarBackground, /linear-gradient/, 'Dark theme sidebar must use the branded surface treatment');
    assert.equal(themeRendering.dark.colorScheme, 'dark');
    assert.equal(
      themeRendering.dark.surfaces.settings,
      themeRendering.dark.reference.surface,
      'Settings must use the branded panel surface',
    );
    assert.equal(
      themeRendering.dark.surfaces.dataCard,
      themeRendering.dark.reference.surface,
      'Data cards must use the branded panel surface',
    );
    assert.equal(
      themeRendering.dark.surfaces.composer,
      themeRendering.dark.reference.surface,
      'The composer must use the branded panel surface',
    );
    assert.equal(
      themeRendering.dark.surfaces.secondaryButton,
      themeRendering.dark.reference.raised,
      'Secondary actions must use the raised brand surface',
    );
    assert.equal(
      themeRendering.dark.surfaces.mutedCopy,
      themeRendering.dark.reference.subtleText,
      'Supporting copy must use the theme text scale',
    );
    assert.equal(
      themeRendering.dark.surfaces.toastText,
      themeRendering.dark.reference.text,
      'Notifications must use the primary theme text',
    );
    for (const [name, value] of Object.entries({
      suggestionBackground: themeRendering.dark.reference.surface,
      toolActivityBackground: themeRendering.dark.reference.surface,
      toolDetailBackground: themeRendering.dark.reference.codeSurface,
      codeBackground: themeRendering.dark.reference.codeSurface,
      statusBackground: themeRendering.dark.reference.warningSurface,
      semanticToggleText: themeRendering.dark.reference.subtleText,
      workspaceHeading: themeRendering.dark.reference.strongText,
      runError: themeRendering.dark.reference.danger,
      toolDetailText: themeRendering.dark.reference.mutedText,
      assistantMeta: themeRendering.dark.reference.mint,
    }))
      assert.equal(themeRendering.dark.surfaces[name], value, `Dark ${name} must use its Xyst semantic token`);
    assert.equal(themeRendering.dark.surfaces.suggestionRadius, '12px', 'Suggestion cards must use the rounded Xyst shape language');
    assert.match(themeRendering.dark.surfaces.assistantBadge, /brand-icon\.png/, 'Assistant messages must carry the Xyst alien mark');
    assert.equal(themeRendering.light.surface, '#ffffff', 'Light theme must preserve readable light surfaces');
    assert.match(themeRendering.light.sidebarBackground, /linear-gradient/, 'Light theme sidebar must keep the branded surface treatment');
    assert.equal(themeRendering.light.colorScheme, 'light');
    assert.equal(
      themeRendering.light.surfaces.settings,
      themeRendering.light.reference.surface,
      'Light settings must use the light palette',
    );
    assert.equal(
      themeRendering.light.surfaces.dataCard,
      themeRendering.light.reference.surface,
      'Light data cards must use the light palette',
    );
    assert.equal(
      themeRendering.light.surfaces.composer,
      themeRendering.light.reference.surface,
      'Light composer must use the light palette',
    );
    assert.equal(
      themeRendering.light.surfaces.secondaryButton,
      themeRendering.light.reference.raised,
      'Light secondary actions must use the raised surface',
    );
    assert.equal(
      themeRendering.light.surfaces.mutedCopy,
      themeRendering.light.reference.subtleText,
      'Light supporting copy must use the theme text scale',
    );
    assert.equal(
      themeRendering.light.surfaces.toastText,
      themeRendering.light.reference.text,
      'Light notifications must use the primary theme text',
    );
    for (const [name, value] of Object.entries({
      suggestionBackground: themeRendering.light.reference.surface,
      toolActivityBackground: themeRendering.light.reference.surface,
      toolDetailBackground: themeRendering.light.reference.codeSurface,
      codeBackground: themeRendering.light.reference.codeSurface,
      statusBackground: themeRendering.light.reference.warningSurface,
      semanticToggleText: themeRendering.light.reference.subtleText,
      workspaceHeading: themeRendering.light.reference.strongText,
      runError: themeRendering.light.reference.danger,
      toolDetailText: themeRendering.light.reference.mutedText,
      assistantMeta: themeRendering.light.reference.mint,
    }))
      assert.equal(themeRendering.light.surfaces[name], value, `Light ${name} must use its Xyst semantic token`);
    assert.equal(
      themeRendering.light.surfaces.suggestionRadius,
      '12px',
      'Light suggestion cards must keep the rounded Xyst shape language',
    );
    assert.notEqual(themeRendering.dark.canvas, themeRendering.light.canvas, 'Dark and light themes must remain distinct');
    assert.equal(themeRendering.logoLoaded, true, 'The welcome screen must load the Xyst alien brand image');

    const tree = await protocol.call('Accessibility.getFullAXTree');
    const accessibleNodes = tree.nodes.filter((node) => !node.ignored);
    const roles = accessibleNodes.map((node) => node.role?.value);
    assert.ok(roles.includes('main'), 'Accessibility tree is missing the main landmark');
    const unnamedControls = accessibleNodes
      .filter((node) => ['button', 'link', 'checkbox', 'radioButton', 'textField', 'combobox', 'slider'].includes(node.role?.value))
      .filter((node) => !node.name?.value?.trim())
      .map((node) => ({ role: node.role?.value, name: node.name?.value || '', value: node.value?.value || '' }));
    assert.deepEqual(unnamedControls, [], 'Accessibility tree contains unnamed interactive controls');

    await evaluate(protocol, `document.querySelector('body').focus()`);
    const keyboardFocus = [];
    for (let index = 0; index < 5; index += 1) {
      await protocol.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await protocol.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      keyboardFocus.push(
        await evaluate(
          protocol,
          `(() => {
        const element = document.activeElement;
        return element && element !== document.body
          ? (element.getAttribute('aria-label') || element.labels?.[0]?.innerText?.trim() || element.innerText?.trim() || element.title || element.id || '')
          : '';
      })()`,
        ),
      );
    }
    assert.ok(keyboardFocus.every(Boolean), `Keyboard focus did not reach named controls: ${JSON.stringify(keyboardFocus)}`);
    const updateChoices = await waitForUpdateChoices(protocol);
    assert.deepEqual(updateChoices.checkModes, ['Never check', 'Only when I check', 'Check when Xyst AI Assistant starts and notify me']);
    assert.deepEqual(updateChoices.releaseChannels, ['Stable', 'Preview']);
    assert.match(updateChoices.feedLabel, /Signed release feed URL/);
    assert.match(updateChoices.keyLabel, /Trusted Ed25519 public key/);
    assert.equal(updateChoices.checkButton, 'Check for updates now');
    const liveSearchChoices = await evaluate(
      protocol,
      `(() => {
        const section = [...document.querySelectorAll('#settings-content fieldset')]
          .find((item) => item.querySelector('legend')?.textContent === 'Live web search');
        const source = section?.querySelector('select');
        if (!section || !source) return null;
        const values = [...source.options].map((option) => option.value);
        source.value = 'automatic';
        source.dispatchEvent(new Event('change', { bubbles: true }));
        const keylessFieldsHidden = section.querySelector('input[type="password"]')?.closest('label')?.hidden === true;
        source.value = 'brave';
        source.dispatchEvent(new Event('change', { bubbles: true }));
        const keyEntryShown = section.querySelector('input[type="password"]')?.closest('label')?.hidden === false;
        return { values, keylessFieldsHidden, keyEntryShown };
      })()`,
    );
    assert.deepEqual(liveSearchChoices, { values: ['automatic', 'wikipedia', 'brave'], keylessFieldsHidden: true, keyEntryShown: true });
    const braveFallback = await saveWebSearchProvider(protocol, 'brave');
    assert.equal(braveFallback.provider, 'brave');
    assert.match(braveFallback.status, /Automatic keyless live results/);
    const restoredKeylessSearch = await saveWebSearchProvider(protocol, 'automatic');
    assert.equal(restoredKeylessSearch.provider, 'automatic');
    assert.match(restoredKeylessSearch.status, /Automatic · live news \+ references/);
    const capabilitySettings = await updateModelCapabilitySettings(protocol);
    assert.equal(capabilitySettings.contextLength, '16384');
    assert.equal(capabilitySettings.supportsTools, 'true');
    assert.equal(capabilitySettings.supportsVision, 'true');
    assert.equal(capabilitySettings.speedScore, '8');
    assert.equal(capabilitySettings.priority, '15');
    const roleSettings = await updateRoutingRoleSettings(protocol);
    assert.equal(roleSettings.reviewModel, '');
    assert.equal(roleSettings.planModel, '');
    const orchestrationSettings = await updateSubagentSettings(protocol);
    assert.deepEqual(orchestrationSettings, { enabled: false, concurrency: '3' });
    const shortcutSettings = await updateUiShortcutSettings(protocol);
    assert.equal(shortcutSettings.toggleSidebar, 'Alt+B');
    assert.equal(shortcutSettings.newSession, 'Alt+M');
    assert.equal(shortcutSettings.focusSearch, '/');
    const dataDirectorySettings = await updateDataDirectorySettings(protocol, path.join(temporaryDirectory, 'custom-user-data'));
    assert.match(dataDirectorySettings.directory, /custom-user-data/);
    progress('checking signed package panels');
    const skillPackages = await waitForSignedSkillPanel(protocol);
    assert.match(skillPackages.title, /Instruction skills/);
    assert.match(skillPackages.text, /Signed skill packages/);
    assert.match(skillPackages.text, /No signed skill packages have been activated/);
    const extensionUpdates = await waitForExtensionUpdatesPanel(protocol);
    assert.match(extensionUpdates.title, /Signed package updates/);
    assert.match(extensionUpdates.text, /no signed package update feed is set/i);
    assert.equal(extensionUpdates.checkDisabled, true);
    const mcpCatalog = await waitForMcpCatalog(protocol);
    assert.match(mcpCatalog.title, /MCP servers/);
    assert.match(mcpCatalog.text, /Signed MCP packages/);
    assert.match(mcpCatalog.text, /hello-world-mcp/);
    assert.match(mcpCatalog.text, /Activate 1\.1\.0/);
    assert.match(mcpCatalog.text, /smoke/);
    assert.match(mcpCatalog.text, /Enable/);
    await evaluate(
      protocol,
      `window.confirm = () => true; [...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Activate 1.0.0').click()`,
    );
    const activatedMcpPackage = await waitForMcpState(protocol, 'Active version 1.0.0');
    await evaluate(
      protocol,
      `window.confirm = () => true; [...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Activate 1.1.0').click()`,
    );
    await waitForMcpState(protocol, 'Active version 1.1.0');
    await evaluate(
      protocol,
      `window.confirm = () => true; [...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Roll back to 1.0.0').click()`,
    );
    await waitForMcpState(protocol, 'Active version 1.0.0');
    await evaluate(
      protocol,
      `window.confirm = () => true; [...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Disable package').click()`,
    );
    await waitForMcpState(protocol, 'Installed and inactive');
    const runMcpSelection = await evaluate(
      protocol,
      `(() => ({ hidden: document.querySelector('#mcp-selection').hidden, summary: document.querySelector('#mcp-selection-summary').textContent.trim(), choices: document.querySelectorAll('#mcp-selection-options input[type=checkbox]').length }))()`,
    );
    assert.equal(runMcpSelection.hidden, false);
    assert.equal(runMcpSelection.summary, 'MCP tools · all configured servers');
    assert.equal(runMcpSelection.choices, 1);
    await evaluate(protocol, `document.querySelector('#mcp-selection').open = true`);
    await evaluate(protocol, `document.querySelector('#mcp-selection-options input[type=checkbox]').click()`);
    const selectedNone = await evaluate(protocol, `document.querySelector('#mcp-selection-summary').textContent.trim()`);
    assert.equal(selectedNone, 'MCP tools · none selected');
    await evaluate(
      protocol,
      `([...document.querySelectorAll('#mcp-selection-options button')].find((button) => button.textContent.trim() === 'Use all configured servers')).click()`,
    );
    await evaluate(
      protocol,
      `([...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Enable')).click()`,
    );
    const enabledMcp = await waitForMcpState(protocol, 'Error · MCP_SPAWN_FAILED');
    assert.match(enabledMcp.text, /Disable/);
    await evaluate(
      protocol,
      `([...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Disable')).click()`,
    );
    const disabledMcp = await waitForMcpState(protocol, 'Disabled');
    assert.match(disabledMcp.text, /Enable/);
    await evaluate(
      protocol,
      `([...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Test connection')).click()`,
    );
    const testedMcp = await waitForMcpState(protocol, 'Connection failed · MCP_SPAWN_FAILED');
    assert.match(testedMcp.text, /Edit settings/);
    await evaluate(
      protocol,
      `([...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Edit settings')).click()`,
    );
    const editor = await waitForMcpState(protocol, 'Save settings');
    assert.match(editor.text, /Command/);
    await evaluate(
      protocol,
      `([...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Cancel')).click()`,
    );
    await waitForMcpState(protocol, 'Add MCP server');
    await evaluate(
      protocol,
      `([...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Add MCP server')).click()`,
    );
    await waitForMcpState(protocol, 'Add server');
    assert.deepEqual(
      await evaluate(protocol, `Array.from(document.querySelector('.mcp-editor select').options, (option) => option.value)`),
      ['stdio', 'streamable_http', 'sse'],
    );
    await evaluate(
      protocol,
      `(() => {
        const name = document.querySelector('.mcp-name-field input');
        const command = document.querySelector('.mcp-stdio-field input');
        name.value = 'smoke-added';
        command.value = 'xyst-missing-added-server';
        name.dispatchEvent(new Event('input', { bubbles: true }));
        command.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.mcp-editor').requestSubmit();
      })()`,
    );
    const addedMcp = await waitForMcpState(protocol, 'smoke-added');
    assert.match(addedMcp.text, /Error · MCP_SPAWN_FAILED/);
    await evaluate(
      protocol,
      `([...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Audit history')).click()`,
    );
    const mcpAudit = await waitForMcpState(protocol, 'smoke-added · add');
    assert.match(mcpAudit.text, /smoke-added · add/);
    assert.doesNotMatch(mcpAudit.text, /xyst-missing|command=/i);
    await evaluate(
      protocol,
      `([...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Back to MCP servers')).click()`,
    );
    progress('checking MCP editor and audit controls');
    await waitForMcpState(protocol, 'smoke-added');
    await evaluate(protocol, `document.querySelector('#settings-dialog').close()`);
    await evaluate(
      protocol,
      `(() => {
        const selection = document.querySelector('#mcp-selection');
        selection.open = true;
        for (const input of document.querySelectorAll('#mcp-selection-options input[type="checkbox"]')) {
          if (input.checked) input.click();
        }
      })()`,
    );

    progress('checking assisted approval and file write');
    await evaluate(
      protocol,
      `(() => {
        const prompt = document.querySelector('#prompt-input');
        prompt.value = 'Create the approval smoke file.';
        prompt.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#send-button').click();
      })()`,
    );
    const firstModelRequest = await mockProvider.firstRequest;
    assert.equal(firstModelRequest.model, 'browser-approval-smoke');
    assert.equal(firstModelRequest.prompt_cache_key, 'browser-smoke-cache');
    assert.equal(firstModelRequest.prompt_cache_retention, '24h');
    await waitForRunPauseControl(protocol, 'Pause run');
    await evaluate(protocol, `document.querySelector('#pause-run').click()`);
    await waitForToast(protocol, 'Pause requested; the current operation will finish first.');
    mockProvider.releaseFirstResponse();
    const approval = await waitForApprovalCard(protocol);
    assert.equal(approval.heading, 'Review this action');
    assert.match(approval.details, /"tool": "write_file"/);
    assert.match(approval.details, /approval-smoke\.txt/);
    assert.equal(approval.hunkCount, 1, 'A single-file create should render its reviewed diff hunk');
    assert.deepEqual(
      approval.buttons.filter((button) => button.grantScope).map((button) => button.label),
      ['Approve all hunks', 'Allow this action in session', 'Allow this path for 1 hour'],
    );
    assert.equal(approval.buttons.at(-1).label, 'Deny');
    assert.ok(approval.buttons.some((button) => button.label === 'Select all'));
    assert.ok(approval.buttons.some((button) => button.label === 'Select none'));
    assert.equal(approval.selectedHunks, approval.hunkCount);
    assert.ok(approval.buttons.every((button) => button.accessibleName));
    assert.ok(approval.buttons.filter((button) => button.grantScope).every((button) => !button.disabled));
    assert.equal(approval.buttons.find((button) => button.label === 'Select all').disabled, true);
    assert.equal(approval.buttons.find((button) => button.label === 'Select none').disabled, false);
    const livePolicy = await browserApiMutation(
      service,
      '/v1/approval-rules',
      'POST',
      { tool: 'write_file', scope: 'tool', decision: 'allow', duration_ms: 60_000 },
      201,
    );
    await waitForTimelineText(protocol, 'Approval policy added: allow write_file (tool). Pending tools are rechecked before execution.');
    await browserApiMutation(service, `/v1/approval-rules/${livePolicy.rule.id}`, 'DELETE', {}, 200);
    await waitForTimelineText(protocol, 'Approval policy revoked: allow write_file (tool). Pending tools are rechecked before execution.');
    await protocol.call('Page.navigate', { url: appUrl });
    const reconnectedApproval = await waitForApprovalCard(protocol);
    assert.match(reconnectedApproval.details, /approval-smoke\.txt/, 'Reloading the browser must restore a pending approval');
    await evaluate(protocol, `document.querySelector('#approval-region [data-grant-scope="once"]').click()`);
    const approvalSubmitted = await waitForApprovalSubmitted(protocol);
    assert.equal(approvalSubmitted, 'Approval submitted.');
    await waitForRunPauseControl(protocol, 'Resume run');
    await waitForRunBudgetControls(protocol);
    await evaluate(
      protocol,
      `(() => {
        const output = document.querySelector('[data-budget-field="max_output_tokens"]');
        const reserve = document.querySelector('[data-budget-field="final_response_reserve_tokens"]');
        output.value = '400';
        reserve.value = '100';
        document.querySelector('#apply-run-budgets').click();
      })()`,
    );
    await waitForToast(protocol, 'Budget changes queued for 2 setting(s).');
    await evaluate(
      protocol,
      `(() => {
        const picker = document.querySelector('#model-picker');
        picker.value = 'browser-approval-fast';
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        document.querySelector('#change-run-model').click();
      })()`,
    );
    await waitForToast(protocol, 'Model change to browser-approval-fast is queued. Resume the run to apply it.');
    await evaluate(protocol, `document.querySelector('#pause-run').click()`);
    await mockProvider.secondRequest;
    await waitForRunBudgetApplied(protocol);
    await waitForToast(protocol, 'Run switched to browser-approval-fast.');
    mockProvider.releaseSecondResponse();
    const runAnswer = await waitForApprovalRunAnswer(protocol);
    assert.equal(runAnswer, 'Browser approval workflow completed.');
    assert.equal(await fs.readFile(path.join(workspace, 'approval-smoke.txt'), 'utf8'), 'approved by browser smoke\n');
    assert.equal(mockProvider.chatRequests, 2, 'The mock provider should make one tool-call turn and one final-answer turn');
    assert.deepEqual(mockProvider.requestModels, ['browser-approval-smoke', 'browser-approval-fast']);
    assert.ok(mockProvider.outputCaps[1] <= 300, 'the active-run output cap and reserve constrain the next request');

    progress('checking project goal conversation controls');
    await evaluate(protocol, `document.querySelector('#goals-button').click()`);
    await waitForGoalPanel(protocol, 'No project goals yet.');
    await evaluate(
      protocol,
      `(() => {
        const form = [...document.querySelectorAll('#settings-content form')].find((item) => item.querySelector('input[placeholder="Goal title"]'));
        if (!form) throw new Error('Project goal form is missing');
        form.querySelector('input').value = 'Browser goal smoke';
        form.querySelector('textarea').value = 'Goal attached and removed through the conversation controls.';
        form.requestSubmit();
      })()`,
    );
    await waitForGoalPanel(protocol, 'Browser goal smoke');
    await evaluate(
      protocol,
      `(() => {
        const button = [...document.querySelectorAll('#settings-content button')].find((item) => item.textContent.trim() === 'Add to selected conversation');
        if (!button) throw new Error('No selected-conversation goal control was rendered');
        button.click();
      })()`,
    );
    await waitForToast(protocol, 'Goal added to the selected conversation.');
    const sessionResponse = await browserApiRequest(service, '/v1/sessions');
    assert.equal(sessionResponse.sessions.length, 1, 'The browser smoke should have one saved conversation');
    const smokeSession = sessionResponse.sessions[0];
    const savedSession = await browserApiRequest(service, `/v1/sessions/${encodeURIComponent(smokeSession.id)}`);
    const linkedGoalIds = savedSession.persistent_goal_ids || [];
    assert.equal(linkedGoalIds.length, 1, 'The browser goal control should persist the conversation reference');
    const exportedSession = await browserApiRequest(service, `/v1/sessions/${encodeURIComponent(smokeSession.id)}/export`);
    assert.equal(exportedSession.goals?.goals?.length, 1, 'Portable export should include the referenced goal snapshot');
    assert.equal(exportedSession.goals.goals[0].title, 'Browser goal smoke');

    progress('resuming the browser-created conversation in the CLI');
    const cliResult = await resumeSessionInCli({
      workspace,
      configPath: service.configPath,
      environment,
      sessionId: smokeSession.id,
    });
    assert.equal(cliResult.session_id, smokeSession.id, 'The CLI must resume the browser-created session in place');
    assert.equal(mockProvider.chatRequests, 3, 'The CLI continuation should make one additional provider request');
    const cliContext = JSON.stringify(mockProvider.requestAt(2).messages);
    assert.match(cliContext, /Browser goal smoke/);
    assert.match(cliContext, /Goal attached and removed through the conversation controls/);
    assert.match(cliContext, /untrusted user-maintained references/);
    const continuedSession = await browserApiRequest(service, `/v1/sessions/${encodeURIComponent(smokeSession.id)}`);
    assert.equal(continuedSession.id, smokeSession.id);
    assert.ok(continuedSession.messages.some((message) => message.role === 'user' && message.content === 'Continue from the browser.'));
    assert.ok(continuedSession.messages.some((message) => message.role === 'assistant' && message.content === 'CLI continuation answer.'));
    assert.deepEqual(continuedSession.persistent_goal_ids, linkedGoalIds);
    const continuedExport = await browserApiRequest(service, `/v1/sessions/${encodeURIComponent(smokeSession.id)}/export`);
    assert.equal(continuedExport.goals?.goals?.[0]?.title, 'Browser goal smoke');

    await protocol.call('Page.reload', { ignoreCache: true });
    await waitForAppReady(protocol, pageErrors, failedResponses);
    await evaluate(
      protocol,
      `(() => {
        const session = document.querySelector('#session-list .session-open-button');
        if (!session) throw new Error('The browser conversation list did not render the saved session');
        session.click();
      })()`,
    );
    await waitForTimelineText(protocol, 'CLI continuation answer.');
    const interruptedExport = structuredClone(continuedExport);
    interruptedExport.session.title = 'Interrupted run smoke';
    interruptedExport.session.messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'browser-interrupted-write',
          type: 'function',
          function: { name: 'write_file', arguments: JSON.stringify({ path: 'interrupted.txt', content: 'not executed' }) },
        },
      ],
    });
    const interruptedSession = await browserApiMutation(service, '/v1/sessions/import', 'POST', interruptedExport, 201);
    const interruptedSummary = (await browserApiRequest(service, '/v1/sessions')).sessions.find(
      (session) => session.id === interruptedSession.session.id,
    );
    assert.equal(interruptedSummary.run_active, false, 'An imported resumable session must not be reported as running');
    assert.equal(interruptedSummary.last_message_role, 'assistant');
    assert.equal(interruptedSummary.last_message_has_tool_calls, true);
    await evaluate(protocol, `document.querySelector('#refresh-sessions').click()`);
    await waitForSessionEntry(protocol, interruptedSession.session.id);
    const interruptedStatus = await evaluate(
      protocol,
      `(() => [...document.querySelectorAll('#session-list .session-item')]
        .find((item) => item.dataset.sessionId === ${JSON.stringify(interruptedSession.session.id)})
        ?.querySelector('.session-detail')?.textContent || '')()`,
    );
    assert.match(interruptedStatus, /^Interrupted · /, 'Saved unfinished sessions must not be labeled as currently running');
    await evaluate(
      protocol,
      `([...document.querySelectorAll('#session-list .session-item')]
        .find((item) => item.dataset.sessionId === ${JSON.stringify(interruptedSession.session.id)})
        ?.querySelector('.session-open-button')?.click())`,
    );
    await waitForTimelineText(protocol, 'This conversation has an unfinished turn and is not currently running.');
    const failedExport = structuredClone(continuedExport);
    failedExport.session.title = 'Failed run smoke';
    failedExport.session.status = 'failed';
    failedExport.session.failure = {
      code: 'RATE_LIMITED',
      message: 'LM Studio returned HTTP 429. Retry the run after the provider limit clears.',
      failed_at: '2026-10-24T12:00:00.000Z',
    };
    const failedSession = await browserApiMutation(service, '/v1/sessions/import', 'POST', failedExport, 201);
    await evaluate(protocol, 'document.querySelector("#refresh-sessions").click()');
    await waitForSessionEntry(protocol, failedSession.session.id);
    const failedSessionSelector =
      '([...document.querySelectorAll("#session-list .session-item")].find((item) => item.dataset.sessionId === ' +
      JSON.stringify(failedSession.session.id) +
      ').querySelector(".session-open-button").click())';
    await evaluate(protocol, failedSessionSelector);
    await waitForTimelineText(
      protocol,
      'Run failed · RATE_LIMITED: LM Studio returned HTTP 429. Retry the run after the provider limit clears.',
    );
    await browserApiMutation(service, `/v1/sessions/${encodeURIComponent(failedSession.session.id)}`, 'DELETE', {}, 200);
    await browserApiMutation(service, `/v1/sessions/${encodeURIComponent(interruptedSession.session.id)}`, 'DELETE', {}, 200);
    await evaluate(
      protocol,
      `([...document.querySelectorAll('#session-list .session-item')]
        .find((item) => item.dataset.sessionId === ${JSON.stringify(smokeSession.id)})
        ?.querySelector('.session-open-button')?.click())`,
    );
    await waitForTimelineText(protocol, 'CLI continuation answer.');
    const recentScroll = await evaluate(
      protocol,
      `(() => {
        const list = document.querySelector('#session-list');
        const originalChildren = [...list.children];
        const template = originalChildren[0];
        for (let index = 0; index < 20; index += 1) list.append(template.cloneNode(true));
        list.scrollTop = list.scrollHeight;
        const result = {
          clientHeight: list.clientHeight,
          scrollHeight: list.scrollHeight,
          scrollTop: list.scrollTop,
          hasOverflow: list.scrollHeight > list.clientHeight,
          canScroll: list.scrollTop > 0,
        };
        list.replaceChildren(...originalChildren);
        list.scrollTop = 0;
        return result;
      })()`,
    );
    assert.ok(recentScroll.clientHeight > 0, 'Recent conversations must have a visible scroll area');
    assert.ok(recentScroll.hasOverflow && recentScroll.canScroll, `Recent conversations did not scroll: ${JSON.stringify(recentScroll)}`);
    await evaluate(protocol, `document.querySelector('#goals-button').click()`);
    await waitForGoalPanel(protocol, 'Browser goal smoke');

    await evaluate(
      protocol,
      `(() => {
        const button = [...document.querySelectorAll('#settings-content button')].find((item) => item.textContent.trim() === 'Remove from selected conversation');
        if (!button) throw new Error('The attached goal did not render its remove control');
        button.click();
      })()`,
    );
    await waitForToast(protocol, 'Goal removed from the selected conversation.');
    const clearedSessionResponse = await browserApiRequest(service, `/v1/sessions/${encodeURIComponent(smokeSession.id)}`);
    assert.deepEqual(clearedSessionResponse.persistent_goal_ids, [], 'Removing a goal should clear its persisted conversation reference');

    const deletionExport = structuredClone(continuedExport);
    deletionExport.session.title = 'Browser delete smoke';
    const importedForDeletion = await browserApiMutation(service, '/v1/sessions/import', 'POST', deletionExport, 201);
    assert.equal(importedForDeletion.session.title, 'Browser delete smoke');
    await evaluate(protocol, `document.querySelector('#refresh-sessions').click()`);
    await waitForSessionEntry(protocol, importedForDeletion.session.id);
    const deleteControl = await evaluate(
      protocol,
      `(() => {
        const item = [...document.querySelectorAll('#session-list .session-item')]
          .find((entry) => entry.querySelector('.session-open-button')?.getAttribute('aria-label') === 'Open conversation Browser delete smoke');
        const button = item?.querySelector('.session-delete-button');
        if (!button || button.disabled) throw new Error('The saved conversation delete action is unavailable');
        window.confirm = () => true;
        button.click();
        return { label: button.getAttribute('aria-label'), disabled: button.disabled };
      })()`,
    );
    assert.equal(deleteControl.label, 'Delete conversation Browser delete smoke');
    await waitForToast(protocol, 'Deleted “Browser delete smoke”.');
    const afterDelete = await browserApiRequest(service, '/v1/sessions');
    assert.ok(
      !afterDelete.sessions.some((session) => session.id === importedForDeletion.session.id),
      'Deleting a sidebar conversation must remove its saved record',
    );

    progress('browser assertions complete');
    return {
      browser: path.basename(browser),
      title: pageState.title,
      connection: pageState.connection,
      responsiveWindowSizes: resizeLayouts.map(({ viewportWidth, viewportHeight }) => `${viewportWidth}x${viewportHeight}`),
      recentConversationList: { scrollable: recentScroll.canScroll, deleteAction: deleteControl.label },
      themeRendering,
      visibleControls: pageState.controls.length,
      accessibilityNodes: accessibleNodes.length,
      keyboardFocus,
      updateChoices: { modes: updateChoices.checkModes.length, channels: updateChoices.releaseChannels },
      dataDirectory: dataDirectorySettings.directory,
      signedSkillPanel: { open: skillPackages.open, trustConfigured: true },
      packageUpdatePanel: { open: extensionUpdates.open, updateFeedConfigured: false, explicitCheckDisabled: true },
      signedMcpPackagePanel: { open: activatedMcpPackage.open, versionActivation: true, rollback: true, disable: true },
      mcpCatalog: {
        open: mcpCatalog.open,
        configuredServers: 2,
        lifecycleControls: true,
        addEditTestControls: true,
        perThreadSelection: true,
        auditHistory: true,
      },
      sessionGoalAssociation: {
        attached: true,
        portableGoalSnapshot: true,
        cliResume: true,
        browserReopen: true,
        removed: true,
      },
      approvalWorkflow: {
        renderedChoices: approval.buttons.filter((button) => button.grantScope).map((button) => button.label),
        approvedOnce: approvalSubmitted === 'Approval submitted.',
        reviewedHunks: approval.hunkCount,
        verifiedWrite: true,
        providerTurns: mockProvider.chatRequests,
      },
      activeRunPolicyEvents: true,
      safeModelSwitch: mockProvider.requestModels[1] === 'browser-approval-fast',
      activeRunBudgetChange: mockProvider.outputCaps[1] <= 300,
      localModelLoad: true,
    };
  } finally {
    try {
      if (browserProtocol) {
        await browserProtocol.call('Browser.close').catch(() => {});
        browserProtocol.close();
      }
      if (browserProcess) {
        await waitForExit(browserProcess, 5_000).catch(() => terminateProcessTree(browserProcess, 'force'));
      }
      try {
        if (service) await service.stop();
      } finally {
        if (mockProvider) await mockProvider.close();
      }
    } finally {
      await removeTemporaryDirectory(temporaryDirectory);
    }
  }
}

async function startService(workspace, env, providerUrl) {
  const configDirectory =
    process.platform === 'win32' ? path.join(env.APPDATA, 'Xyst AI Assistant') : path.join(env.XDG_CONFIG_HOME, 'xyst-ai-assistant');
  await fs.mkdir(configDirectory, { recursive: true });
  const configPath = path.join(configDirectory, 'config.toml');
  const packageTrust = await prepareSmokeMcpPackages(workspace);
  await fs.writeFile(
    configPath,
    [
      'default_model = "approval-smoke"',
      '[models.approval-smoke]',
      'provider = "openai-compatible"',
      `base_url = "${providerUrl}"`,
      'model = "browser-approval-smoke"',
      'supports_tools = true',
      'context_length = 16000',
      '[models.browser-approval-fast]',
      'provider = "openai-compatible"',
      `base_url = "${providerUrl}"`,
      'model = "browser-approval-fast"',
      'supports_tools = true',
      'context_length = 16000',
      '[models.lm-studio-browser-configured-smoke]',
      'provider = "openai-compatible"',
      'base_url = "http://127.0.0.1:1234/v1"',
      'model = "browser-configured-smoke"',
      'supports_tools = true',
      'context_length = 8192',
      'local = true',
      '[local_servers.browser-smoke]',
      `base_url = "${providerUrl}"`,
      '[local_servers.browser-smoke-secondary]',
      `base_url = "${providerUrl}/secondary"`,
      '[tools]',
      'autonomy = "assisted"',
      'shell_enabled = true',
      '[extensions]',
      `install_directory = ${JSON.stringify(packageTrust.installRoot)}`,
      `trusted_keys = { "smoke-publisher" = ${JSON.stringify(packageTrust.publicKeyPem)} }`,
      '[mcp]',
      'enabled = true',
      '[mcp.servers.smoke]',
      'enabled = false',
      'command = "xyst-missing-mcp-command"',
      '',
    ].join('\n'),
  );
  const child = spawn(
    process.execPath,
    [path.join(ROOT, 'src/cli.mjs'), '--workspace', workspace, '--desktop-parent', 'serve', '--port', '0'],
    {
      cwd: workspace,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const stderr = [];
  let stderrBytes = 0;
  child.stderr.on('data', (chunk) => {
    const remaining = 16 * 1024 - stderrBytes;
    if (remaining > 0) stderr.push(chunk.subarray(0, remaining));
    stderrBytes += Math.max(0, Math.min(chunk.length, remaining));
  });
  const watchdog = setTimeout(() => terminateProcessTree(child, 'force'), 60_000);
  try {
    const line = await readLine(child.stdout, child, 20_000);
    const bootstrap = JSON.parse(line);
    const url = new URL(bootstrap.url);
    assert.equal(bootstrap.api_version, 1);
    assert.equal(url.hostname, '127.0.0.1');
    const health = await fetch(new URL('/v1/health', url), { headers: { authorization: `Bearer ${bootstrap.token}` } });
    assert.equal(health.status, 200, 'Local control API did not start');
    return {
      url,
      token: bootstrap.token,
      configPath,
      stop: async () => {
        child.stdin.end('xyst-desktop-shutdown\n');
        const code = await waitForExit(child, 10_000);
        assert.equal(code, 0, `Local control API exited unsuccessfully: ${Buffer.concat(stderr).toString('utf8')}`);
      },
    };
  } catch (error) {
    terminateProcessTree(child, 'force');
    await waitForExit(child, 5_000).catch(() => {});
    const detail = Buffer.concat(stderr).toString('utf8').trim();
    if (detail) error.message += `; service stderr: ${detail}`;
    throw error;
  } finally {
    clearTimeout(watchdog);
  }
}

async function prepareSmokeMcpPackages(workspace) {
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPath = path.join(workspace, 'smoke-publisher-private.pem');
  const installRoot = path.join(workspace, '.smoke-extensions');
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  await fs.writeFile(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  for (const version of ['1.0.0', '1.1.0']) {
    const source = path.join(workspace, `smoke-package-${version}`);
    await buildExampleMcpPackage({
      keyId: 'smoke-publisher',
      privateKeyPath,
      outputDirectory: source,
      version,
    });
    await installSignedPackage(source, { installRoot, trustedKeys: { 'smoke-publisher': publicKeyPem } });
  }
  return { installRoot, publicKeyPem };
}

async function startMockProvider() {
  let chatRequests = 0;
  const requests = [];
  let announceFirstRequest;
  const firstRequest = new Promise((resolve) => {
    announceFirstRequest = resolve;
  });
  let announceSecondRequest;
  const secondRequest = new Promise((resolve) => {
    announceSecondRequest = resolve;
  });
  let releaseFirstResponse;
  const firstResponseGate = new Promise((resolve) => {
    releaseFirstResponse = resolve;
  });
  let releaseSecondResponse;
  const secondResponseGate = new Promise((resolve) => {
    releaseSecondResponse = resolve;
  });
  const server = http.createServer((request, response) => {
    const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && (requestPath === '/v1/models' || requestPath === '/v1/secondary/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      const models =
        requestPath === '/v1/secondary/models'
          ? [{ id: 'browser-secondary-smoke' }]
          : [{ id: 'browser-approval-smoke' }, { id: 'browser-approval-fast' }, { id: 'browser-local-smoke' }];
      response.end(JSON.stringify({ data: models }));
      return;
    }
    if (request.method !== 'POST' || new URL(request.url, 'http://127.0.0.1').pathname !== '/v1/chat/completions') {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > 1_000_000) request.destroy(new Error('Mock provider request exceeded its test limit'));
    });
    request.on('end', () => {
      let requestBody;
      try {
        requestBody = JSON.parse(body);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (
        requestBody.stream !== true ||
        !Array.isArray(requestBody.tools) ||
        !requestBody.tools.some((tool) => tool.function?.name === 'write_file')
      ) {
        response.writeHead(400);
        response.end();
        return;
      }
      chatRequests += 1;
      requests.push(requestBody);
      const sendResponse = () => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
        const frames =
          chatRequests === 1
            ? [
                {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: 0,
                            id: 'browser_approval_write',
                            function: {
                              name: 'write_file',
                              arguments: JSON.stringify({ path: 'approval-smoke.txt', content: 'approved by browser smoke\n' }),
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
              ]
            : chatRequests === 2
              ? [
                  { choices: [{ delta: { content: 'Browser approval workflow completed.' } }] },
                  { choices: [{ delta: {}, finish_reason: 'stop' }] },
                ]
              : chatRequests === 3
                ? [{ choices: [{ delta: { content: 'CLI continuation answer.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
                : [];
        for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`);
        response.end('data: [DONE]\n\n');
      };
      if (chatRequests === 1) {
        announceFirstRequest(requestBody);
        void firstResponseGate.then(sendResponse);
      } else if (chatRequests === 2) {
        announceSecondRequest(requestBody);
        void secondResponseGate.then(sendResponse);
      } else sendResponse();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    get chatRequests() {
      return chatRequests;
    },
    get firstRequest() {
      return firstRequest;
    },
    get secondRequest() {
      return secondRequest;
    },
    get requestModels() {
      return requests.map((item) => item.model);
    },
    get outputCaps() {
      return requests.map((item) => item.max_tokens);
    },
    requestAt(index) {
      return structuredClone(requests[index]);
    },
    releaseFirstResponse() {
      releaseFirstResponse();
    },
    releaseSecondResponse() {
      releaseSecondResponse();
    },
    close: () => {
      releaseFirstResponse();
      releaseSecondResponse();
      return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function waitForApprovalCard(protocol) {
  const deadline = Date.now() + 20_000;
  let lastState;
  while (Date.now() < deadline) {
    const state = await evaluate(
      protocol,
      `(() => {
        const card = document.querySelector('#approval-region .approval-card');
        if (!card) return null;
        return {
          heading: card.querySelector('.approval-title')?.textContent.replace(/^!/, '').trim() || '',
          details: card.querySelector('.approval-details')?.textContent || '',
          hunkCount: card.querySelectorAll('[data-hunk-id]').length,
          selectedHunks: card.querySelectorAll('[data-hunk-id]:checked').length,
          buttons: [...card.querySelectorAll('button')].map((button) => ({
            label: button.textContent.trim(),
            grantScope: button.dataset.grantScope || '',
            accessibleName: button.getAttribute('aria-label') || button.textContent.trim(),
            disabled: button.disabled,
          })),
        };
      })()`,
    );
    lastState = state;
    if (state?.heading && state.buttons.length) return state;
    await delay(50);
  }
  throw new Error(`Browser approval card did not render: ${JSON.stringify(lastState)}`);
}

async function waitForApprovalSubmitted(protocol) {
  const deadline = Date.now() + 10_000;
  let lastText = '';
  while (Date.now() < deadline) {
    lastText = await evaluate(protocol, `document.querySelector('#approval-region .approval-card')?.innerText || ''`);
    if (lastText.includes('Approval submitted.')) return 'Approval submitted.';
    await delay(50);
  }
  throw new Error(`Browser approval was not acknowledged: ${lastText}`);
}

async function waitForRunPauseControl(protocol, label) {
  const deadline = Date.now() + 15_000;
  let state;
  while (Date.now() < deadline) {
    state = await evaluate(
      protocol,
      `(() => ({
        pauseHidden: document.querySelector('#pause-run').hidden,
        pauseLabel: document.querySelector('#pause-run').textContent.trim(),
        modelChangeHidden: document.querySelector('#change-run-model').hidden,
      }))()`,
    );
    if (!state.pauseHidden && state.pauseLabel === label && (label !== 'Resume run' || !state.modelChangeHidden)) return state;
    await delay(50);
  }
  throw new Error(`Run control did not reach '${label}': ${JSON.stringify(state)}`);
}

async function waitForRunBudgetControls(protocol) {
  const deadline = Date.now() + 10_000;
  let state;
  while (Date.now() < deadline) {
    state = await evaluate(
      protocol,
      `(() => ({
        hidden: document.querySelector('#run-budget-controls').hidden,
        output: Boolean(document.querySelector('[data-budget-field="max_output_tokens"]')),
        enabled: !document.querySelector('#apply-run-budgets').disabled,
      }))()`,
    );
    if (!state.hidden && state.output && state.enabled) return state;
    await delay(50);
  }
  throw new Error(`Active-run budget controls did not become available: ${JSON.stringify(state)}`);
}

async function waitForRunBudgetApplied(protocol) {
  const deadline = Date.now() + 10_000;
  let status = '';
  while (Date.now() < deadline) {
    status = await evaluate(protocol, `document.querySelector('#run-budget-status').textContent.trim()`);
    if (status === 'Budget changes are active for this run.') return status;
    await delay(50);
  }
  throw new Error(`Active-run budget change was not confirmed: '${status}'`);
}

async function waitForToast(protocol, text) {
  const deadline = Date.now() + 10_000;
  let lastText = '';
  while (Date.now() < deadline) {
    lastText = await evaluate(protocol, `document.querySelector('#toast').textContent.trim()`);
    if (lastText === text) return lastText;
    await delay(50);
  }
  throw new Error(`Expected browser toast '${text}', received '${lastText}'`);
}

async function waitForGoalPanel(protocol, expectedText) {
  const deadline = Date.now() + 10_000;
  let lastState;
  while (Date.now() < deadline) {
    lastState = await evaluate(
      protocol,
      `(() => ({
        open: document.querySelector('#settings-dialog')?.open === true,
        title: document.querySelector('#settings-title')?.textContent || '',
        text: document.querySelector('#settings-content')?.innerText || '',
        activeSession: document.querySelector('#session-list .session-item.active')?.dataset.sessionId || null,
        sessions: [...document.querySelectorAll('#session-list .session-item')].map((item) => ({
          id: item.dataset.sessionId || '',
          title: item.querySelector('.session-title')?.textContent || '',
        })),
      }))()`,
    );
    if (lastState.open && lastState.title === 'Project goals' && lastState.text.includes(expectedText)) return lastState;
    await delay(50);
  }
  throw new Error(`Project goals panel did not show ${JSON.stringify(expectedText)}: ${JSON.stringify(lastState)}`);
}

async function browserApiRequest(service, pathname) {
  const response = await fetch(new URL(pathname, service.url), {
    headers: { authorization: `Bearer ${service.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, `Local API request failed for ${pathname}`);
  return response.json();
}

async function browserApiMutation(service, pathname, method, body, expectedStatus) {
  const response = await fetch(new URL(pathname, service.url), {
    method,
    headers: { authorization: `Bearer ${service.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, expectedStatus, `Local API mutation failed for ${pathname}`);
  return response.json();
}

async function waitForSessionEntry(protocol, id) {
  const sessionId = JSON.stringify(id);
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const found = await evaluate(
      protocol,
      `([...document.querySelectorAll('#session-list .session-item')].some((item) => item.dataset.sessionId === ${sessionId}))`,
    );
    if (found) return;
    await delay(50);
  }
  throw new Error(`The conversation ${id} did not appear in Recent conversations`);
}

function resumeSessionInCli({ workspace, configPath, environment, sessionId }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, 'src/cli.mjs'),
        '--json',
        '--resume',
        sessionId,
        '--workspace',
        workspace,
        '--config',
        configPath,
        'Continue from the browser.',
      ],
      { cwd: workspace, env: environment, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const outputLimit = 256 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputExceeded = false;
    const append = (current, chunk) => {
      if (Buffer.byteLength(current) + chunk.length > outputLimit) {
        outputExceeded = true;
        void terminateProcessTree(child, 'force').catch(() => {});
        return current;
      }
      return current + chunk.toString('utf8');
    };
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    const watchdog = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(child, 'force').catch(() => {});
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(watchdog);
      if (timedOut) return reject(new Error('CLI session resume timed out after 20 seconds'));
      if (outputExceeded) return reject(new Error('CLI session resume exceeded the captured output limit'));
      if (code !== 0) return reject(new Error(`CLI session resume failed (code=${code}, signal=${signal}): ${stderr.trim()}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`CLI session resume returned invalid JSON: ${error.message}; stderr: ${stderr.trim()}`));
      }
    });
  });
}

async function waitForTimelineText(protocol, expectedText) {
  const deadline = Date.now() + 15_000;
  let lastText = '';
  while (Date.now() < deadline) {
    lastText = await evaluate(protocol, `document.querySelector('#timeline')?.innerText || ''`);
    if (lastText.includes(expectedText)) return lastText;
    await delay(50);
  }
  throw new Error(`Browser transcript did not show '${expectedText}': ${lastText.slice(-500)}`);
}

async function waitForApprovalRunAnswer(protocol) {
  const deadline = Date.now() + 20_000;
  let lastText = '';
  while (Date.now() < deadline) {
    lastText = await evaluate(
      protocol,
      `(() => [...document.querySelectorAll('#timeline .message.assistant .message-body')].at(-1)?.textContent || '')()`,
    );
    if (lastText.includes('Browser approval workflow completed.')) return 'Browser approval workflow completed.';
    await delay(50);
  }
  throw new Error(`Browser approval run did not finish: ${lastText}`);
}

async function removeTemporaryDirectory(directory) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error.code)) throw error;
      await delay(100);
    }
  }
  throw lastError;
}

async function waitForDevtoolsPort(profile, diagnostics) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const [portLine] = (await fs.readFile(portFile, 'utf8')).split(/\r?\n/);
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
    } catch (error) {
      if (!['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    }
    // Edge can exit its launcher process with code 0 while a relaunch process
    // continues startup and writes DevToolsActivePort.
    await delay(50);
  }
  const detail = Buffer.concat(diagnostics).toString('utf8').trim();
  throw new Error(`Timed out waiting for headless browser DevTools${detail ? `: ${detail}` : ''}`);
}

function connectDevtoolsPipe(readable, writable, browserProcess, browserDiagnostics) {
  return new Promise((resolve, reject) => {
    const pending = new Map();
    const listeners = new Set();
    let nextId = 0;
    let buffered = '';
    const failAll = (error) => {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      pending.clear();
    };
    const transport = {
      call(method, params = {}, sessionId = undefined) {
        const id = ++nextId;
        return new Promise((callResolve, callReject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            callReject(new Error(`Browser DevTools call timed out: ${method}`));
          }, 10_000);
          pending.set(id, { resolve: callResolve, reject: callReject, timer });
          writable.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
        });
      },
      withSession(sessionId) {
        return {
          onEvent(listener) {
            const scopedListener = (message) => {
              if (message.sessionId === sessionId) listener(message);
            };
            listeners.add(scopedListener);
            return () => listeners.delete(scopedListener);
          },
          call(method, params = {}) {
            return transport.call(method, params, sessionId);
          },
          closeBrowser() {
            return transport.call('Browser.close');
          },
          close() {
            transport.close();
          },
        };
      },
      closeBrowser() {
        return transport.call('Browser.close');
      },
      close() {
        failAll(new Error('Browser DevTools connection closed'));
        writable.end();
        readable.destroy();
      },
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    readable.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      if (Buffer.byteLength(buffered) > 8 * 1024 * 1024) {
        failAll(new Error('Browser DevTools message exceeds the size limit'));
        readable.destroy();
        return;
      }
      let boundary = buffered.indexOf('\0');
      while (boundary >= 0) {
        const raw = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 1);
        boundary = buffered.indexOf('\0');
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          failAll(new Error('Browser DevTools returned invalid JSON'));
          continue;
        }
        if (message.method) {
          for (const listener of listeners) listener(message);
          continue;
        }
        const item = pending.get(message.id);
        if (!item) continue;
        clearTimeout(item.timer);
        pending.delete(message.id);
        if (message.error) item.reject(new Error(`Browser DevTools error: ${message.error.message}`));
        else item.resolve(message.result || {});
      }
    });
    readable.once('error', (error) => failAll(error));
    readable.once('end', () => {
      const detail = Buffer.concat(browserDiagnostics).toString('utf8').trim();
      failAll(
        new Error(`Browser DevTools pipe closed (browser exit code ${browserProcess.exitCode ?? 'running'})${detail ? `: ${detail}` : ''}`),
      );
    });
    writable.once('error', (error) => failAll(error));
    if (!readable || !writable) reject(new Error('Headless browser did not expose DevTools pipes'));
    else resolve(transport);
  });
}

function connectDevtoolsWebSocket(url) {
  if (typeof WebSocket !== 'function') throw new Error('Node.js WebSocket support is required for the browser smoke');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const listeners = new Set();
    let nextId = 0;
    const failAll = (error) => {
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      pending.clear();
    };
    socket.addEventListener(
      'open',
      () =>
        resolve({
          call(method, params = {}, sessionId = undefined) {
            const id = ++nextId;
            return new Promise((callResolve, callReject) => {
              const timer = setTimeout(() => {
                pending.delete(id);
                callReject(new Error(`Browser DevTools call timed out: ${method}`));
              }, 10_000);
              pending.set(id, { resolve: callResolve, reject: callReject, timer });
              socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
            });
          },
          withSession(sessionId) {
            return {
              onEvent(listener) {
                const scopedListener = (message) => {
                  if (message.sessionId === sessionId) listener(message);
                };
                listeners.add(scopedListener);
                return () => listeners.delete(scopedListener);
              },
              call(method, params = {}) {
                return socketCall(method, params, sessionId);
              },
              close() {
                socket.close();
              },
            };
          },
          closeBrowser() {
            return socketCall('Browser.close');
          },
          close() {
            failAll(new Error('Browser DevTools connection closed'));
            socket.close();
          },
          onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        }),
      { once: true },
    );
    const socketCall = (method, params = {}, sessionId = undefined) => {
      const id = ++nextId;
      return new Promise((callResolve, callReject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          callReject(new Error(`Browser DevTools call timed out: ${method}`));
        }, 10_000);
        pending.set(id, { resolve: callResolve, reject: callReject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    };
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.method) {
        for (const listener of listeners) listener(message);
        return;
      }
      const item = pending.get(message.id);
      if (!item) return;
      clearTimeout(item.timer);
      pending.delete(message.id);
      if (message.error) item.reject(new Error(`Browser DevTools error: ${message.error.message}`));
      else item.resolve(message.result || {});
    });
    socket.addEventListener('error', () => failAll(new Error('Browser DevTools WebSocket connection failed')));
    socket.addEventListener('close', () => failAll(new Error('Browser DevTools WebSocket closed')));
    setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) reject(new Error('Timed out connecting to headless browser DevTools'));
    }, 10_000);
  });
}

async function waitForUpdateChoices(protocol) {
  await evaluate(
    protocol,
    `document.querySelector('#settings-button').click(); document.querySelector('#advanced-settings-button').click()`,
  );
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await evaluate(
      protocol,
      `(() => {
        const section = [...document.querySelectorAll('#settings-content fieldset')]
          .find((item) => item.querySelector('legend')?.textContent === 'Application updates');
        if (!section) return null;
        return {
          open: document.querySelector('#settings-dialog')?.open === true,
          checkModes: [...section.querySelectorAll('select[name="app_updates.mode"] option')].map((option) => option.textContent),
          releaseChannels: [...section.querySelectorAll('select[name="app_updates.channel"] option')].map((option) => option.textContent),
          feedLabel: section.querySelector('input[type="url"]')?.closest('label')?.innerText.replace(/\\s+/g, ' ').trim() || '',
          keyLabel: section.querySelector('textarea')?.closest('label')?.innerText.replace(/\\s+/g, ' ').trim() || '',
          checkButton: [...section.querySelectorAll('button')].find((button) => button.textContent === 'Check for updates now')?.textContent || '',
        };
      })()`,
    );
    if (state?.open && state.checkModes.length === 3 && state.releaseChannels.length === 2) return state;
    await delay(50);
  }
  throw new Error('Runtime settings did not show the user-controlled application update options');
}

async function waitForLocalModelChoice(protocol, modelId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await evaluate(
      protocol,
      `(() => ({
        option: [...document.querySelector('#model-picker').options].some((item) => item.textContent.includes(${JSON.stringify(modelId)})),
        card: [...document.querySelectorAll('#local-model-results .local-model-row')].some((item) => item.textContent.includes(${JSON.stringify(modelId)})),
      }))()`,
    );
    if (state.option && state.card) return true;
    await delay(50);
  }
  return false;
}

async function updateModelCapabilitySettings(protocol) {
  const submitted = await evaluate(
    protocol,
    `(() => {
      const profile = [...document.querySelectorAll('#settings-content fieldset.provider-profile-editor')]
        .find((item) => item.querySelector('legend')?.textContent === 'approval-smoke');
      if (!profile) return false;
      const context = profile.querySelector('[aria-label="approval-smoke context length in tokens"]');
      const tools = profile.querySelector('[aria-label="approval-smoke Supports tool calls"]');
      const vision = profile.querySelector('[aria-label="approval-smoke Supports image input"]');
    const promptCache = profile.querySelector('[aria-label="approval-smoke Provider supports prompt cache controls"]');
    const promptCacheKey = profile.querySelector('[aria-label="approval-smoke prompt cache key"]');
    const promptCacheRetention = profile.querySelector('[aria-label="approval-smoke prompt cache retention"]');
      const reasoning = profile.querySelector('[aria-label="approval-smoke reasoning effort"]');
      const speed = profile.querySelector('[aria-label="approval-smoke Speed score · 1–10"]');
      const priority = profile.querySelector('[aria-label="approval-smoke Routing priority · 0–1000 (lower first)"]');
      const credentialLabel = [...profile.querySelectorAll('label')]
        .find((label) => label.querySelector('span')?.textContent === 'Optional model API credential');
      const credentialNameLabel = [...profile.querySelectorAll('label')]
        .find((label) => label.querySelector('span')?.textContent === 'Credential storage name');
      const credentialNote = [...profile.querySelectorAll('p')]
        .some((note) => note.textContent.includes('This credential is only for the model connection, not web search'));
      const credentialNameInput = credentialNameLabel?.querySelector('input');
      const save = [...profile.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Save profile');
    if (!context || !tools || !vision || !promptCache || !promptCacheKey || !promptCacheRetention || !reasoning || !speed || !priority || !credentialLabel || !credentialNote || !credentialNameInput || credentialNameInput.value || !credentialNameInput.placeholder.includes('Auto-generated') || !save) return false;
      context.value = '16384';
      context.dispatchEvent(new Event('change', { bubbles: true }));
      tools.value = 'true';
      tools.dispatchEvent(new Event('change', { bubbles: true }));
      vision.value = 'true';
      vision.dispatchEvent(new Event('change', { bubbles: true }));
    promptCache.value = 'true';
    promptCache.dispatchEvent(new Event('change', { bubbles: true }));
    promptCacheKey.value = 'browser-smoke-cache';
    promptCacheKey.dispatchEvent(new Event('change', { bubbles: true }));
    promptCacheRetention.value = '24h';
    promptCacheRetention.dispatchEvent(new Event('change', { bubbles: true }));
      reasoning.value = 'none';
      reasoning.dispatchEvent(new Event('change', { bubbles: true }));
      speed.value = '8';
      speed.dispatchEvent(new Event('change', { bubbles: true }));
      priority.value = '15';
      priority.dispatchEvent(new Event('change', { bubbles: true }));
      save.click();
      return true;
    })()`,
  );
  assert.equal(submitted, true, 'Model capability settings should be editable in Runtime settings');
  const deadline = Date.now() + 10_000;
  let lastSettings = null;
  while (Date.now() < deadline) {
    const settings = await evaluate(
      protocol,
      `(() => {
        const profile = [...document.querySelectorAll('#settings-content fieldset.provider-profile-editor')]
          .find((item) => item.querySelector('legend')?.textContent === 'approval-smoke');
        if (!profile) return null;
        const save = [...profile.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Save profile');
        const inputs = [
          profile.querySelector('[aria-label="approval-smoke context length in tokens"]'),
          profile.querySelector('[aria-label="approval-smoke Supports tool calls"]'),
          profile.querySelector('[aria-label="approval-smoke Supports image input"]'),
          profile.querySelector('[aria-label="approval-smoke Provider supports prompt cache controls"]'),
          profile.querySelector('[aria-label="approval-smoke prompt cache key"]'),
          profile.querySelector('[aria-label="approval-smoke prompt cache retention"]'),
          profile.querySelector('[aria-label="approval-smoke reasoning effort"]'),
          profile.querySelector('[aria-label="approval-smoke Speed score · 1–10"]'),
          profile.querySelector('[aria-label="approval-smoke Routing priority · 0–1000 (lower first)"]'),
        ];
        return {
          contextLength: inputs[0]?.value || '',
          supportsTools: inputs[1]?.value || '',
          supportsVision: inputs[2]?.value || '',
          promptCacheEnabled: inputs[3]?.value || '',
          promptCacheKey: inputs[4]?.value || '',
          promptCacheRetention: inputs[5]?.value || '',
          reasoningEffort: inputs[6]?.value || '',
          speedScore: inputs[7]?.value || '',
          priority: inputs[8]?.value || '',
          saving: save?.disabled ?? true,
          dirty: inputs.some((input) => input?.dataset.dirty === 'true'),
        };
      })()`,
    );
    lastSettings = settings;
    if (
      settings?.contextLength === '16384' &&
      settings.supportsTools === 'true' &&
      settings.supportsVision === 'true' &&
      settings.promptCacheEnabled === 'true' &&
      settings.promptCacheKey === 'browser-smoke-cache' &&
      settings.promptCacheRetention === '24h' &&
      settings.reasoningEffort === 'none' &&
      settings.speedScore === '8' &&
      settings.priority === '15' &&
      !settings.saving &&
      !settings.dirty
    )
      return settings;
    await delay(50);
  }
  throw new Error(`Runtime settings did not persist model capabilities and prompt cache controls: ${JSON.stringify(lastSettings)}`);
}

async function saveWebSearchProvider(protocol, provider) {
  const submitted = await evaluate(
    protocol,
    `(() => {
      const form = document.querySelector('#settings-content form.runtime-settings-form');
      const section = [...(form?.querySelectorAll('fieldset') || [])]
        .find((item) => item.querySelector('legend')?.textContent === 'Live web search');
      const source = section?.querySelector('select');
      const save = form?.querySelector('button[type="submit"]');
      if (!source || !save) return false;
      source.value = ${JSON.stringify(provider)};
      source.dispatchEvent(new Event('change', { bubbles: true }));
      save.click();
      return true;
    })()`,
  );
  assert.equal(submitted, true, 'Live web search provider should be editable in Runtime settings');
  const expectedStatus = provider === 'brave' ? /Automatic keyless live results/ : /Automatic · live news \+ references/;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const state = await evaluate(
      protocol,
      `(() => {
        const source = [...document.querySelectorAll('#settings-content form.runtime-settings-form fieldset')]
          .find((item) => item.querySelector('legend')?.textContent === 'Live web search')?.querySelector('select');
        const row = [...document.querySelectorAll('#settings-content .setting-row')]
          .find((item) => item.firstElementChild?.textContent === 'Web search');
        return { provider: source?.value || null, status: row?.lastElementChild?.textContent || '' };
      })()`,
    );
    if (state.provider === provider && expectedStatus.test(state.status)) return state;
    await delay(50);
  }
  throw new Error(`Live web search provider did not save as ${provider}`);
}

async function updateRoutingRoleSettings(protocol) {
  const submitted = await evaluate(
    protocol,
    `(() => {
      const form = document.querySelector('#settings-content form.runtime-settings-form');
      const review = form?.querySelector('select[name="review_model"]');
      const plan = form?.querySelector('select[name="plan_model"]');
      const save = form?.querySelector('button[type="submit"]');
      if (!review || !plan || !save || ![...review.options].some((option) => option.value === 'approval-smoke')) return false;
      review.value = 'approval-smoke';
      review.dispatchEvent(new Event('change', { bubbles: true }));
      plan.value = 'approval-smoke';
      plan.dispatchEvent(new Event('change', { bubbles: true }));
      save.click();
      return true;
    })()`,
  );
  assert.equal(submitted, true, 'Review and plan model roles should be editable in Runtime settings');

  const waitForRoles = async (expected) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const roles = await evaluate(
        protocol,
        `(() => {
          const form = document.querySelector('#settings-content form.runtime-settings-form');
          const review = form?.querySelector('select[name="review_model"]');
          const plan = form?.querySelector('select[name="plan_model"]');
          return {
            reviewModel: review?.value ?? null,
            planModel: plan?.value ?? null,
            saving: form?.querySelector('button[type="submit"]')?.disabled ?? true,
            dirty: review?.dataset.dirty === 'true' || plan?.dataset.dirty === 'true',
          };
        })()`,
      );
      if (roles.reviewModel === expected && roles.planModel === expected && !roles.saving && !roles.dirty) return roles;
      await delay(50);
    }
    throw new Error(`Runtime settings did not persist review/plan model roles as '${expected}'`);
  };

  await waitForRoles('approval-smoke');
  await evaluate(
    protocol,
    `(() => {
      const form = document.querySelector('#settings-content form.runtime-settings-form');
      const review = form.querySelector('select[name="review_model"]');
      const plan = form.querySelector('select[name="plan_model"]');
      review.value = '';
      review.dispatchEvent(new Event('change', { bubbles: true }));
      plan.value = '';
      plan.dispatchEvent(new Event('change', { bubbles: true }));
      form.querySelector('button[type="submit"]').click();
    })()`,
  );
  return waitForRoles('');
}

async function updateSubagentSettings(protocol) {
  const enabled = await evaluate(
    protocol,
    `(() => {
      const form = document.querySelector('#settings-content form.runtime-settings-form');
      const toggle = form?.querySelector('[name="subagents.enabled"]');
      const concurrency = form?.querySelector('[name="subagents.max_concurrent"]');
      const save = form?.querySelector('button[type="submit"]');
      if (!toggle || !concurrency || !save) return false;
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      concurrency.value = '3';
      concurrency.dispatchEvent(new Event('change', { bubbles: true }));
      save.click();
      return true;
    })()`,
  );
  assert.equal(enabled, true, 'Agent orchestration should be configurable in Runtime settings');

  const deadline = Date.now() + 10_000;
  let enabledState;
  while (Date.now() < deadline) {
    const state = await evaluate(
      protocol,
      `(() => {
        const form = document.querySelector('#settings-content form.runtime-settings-form');
        const toggle = form?.querySelector('[name="subagents.enabled"]');
        const concurrency = form?.querySelector('[name="subagents.max_concurrent"]');
        return {
          enabled: toggle?.checked ?? null,
          concurrency: concurrency?.value ?? null,
          saving: form?.querySelector('button[type="submit"]')?.disabled ?? true,
          dirty: toggle?.dataset.dirty === 'true' || concurrency?.dataset.dirty === 'true',
        };
      })()`,
    );
    if (state.enabled === true && state.concurrency === '3' && !state.saving && !state.dirty) {
      enabledState = state;
      break;
    }
    await delay(50);
  }
  if (!enabledState) throw new Error('Runtime settings did not enable subagents with the selected concurrency');

  const disabled = await evaluate(
    protocol,
    `(() => {
      const form = document.querySelector('#settings-content form.runtime-settings-form');
      const toggle = form?.querySelector('[name="subagents.enabled"]');
      const save = form?.querySelector('button[type="submit"]');
      if (!toggle || !save) return false;
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
      save.click();
      return true;
    })()`,
  );
  assert.equal(disabled, true, 'Agent orchestration should be switchable off again');

  const restoreDeadline = Date.now() + 10_000;
  while (Date.now() < restoreDeadline) {
    const state = await evaluate(
      protocol,
      `(() => {
        const form = document.querySelector('#settings-content form.runtime-settings-form');
        const toggle = form?.querySelector('[name="subagents.enabled"]');
        const concurrency = form?.querySelector('[name="subagents.max_concurrent"]');
        return {
          enabled: toggle?.checked ?? null,
          concurrency: concurrency?.value ?? null,
          saving: form?.querySelector('button[type="submit"]')?.disabled ?? true,
          dirty: toggle?.dataset.dirty === 'true' || concurrency?.dataset.dirty === 'true',
        };
      })()`,
    );
    if (state.enabled === false && state.concurrency === '3' && !state.saving && !state.dirty)
      return { enabled: state.enabled, concurrency: state.concurrency };
    await delay(50);
  }
  throw new Error('Runtime settings did not persist the subagent availability toggle and concurrency setting');
}

async function updateUiShortcutSettings(protocol) {
  const submitBindings = async (bindings) => {
    const result = await evaluate(
      protocol,
      `(() => {
        const form = document.querySelector('#settings-content form.runtime-settings-form');
        const bindings = ${JSON.stringify(bindings)};
        const inputs = {
          toggle_sidebar: form?.querySelector('[aria-label="Toggle sidebar shortcut"]'),
          new_session: form?.querySelector('[aria-label="Start new session shortcut"]'),
          focus_search: form?.querySelector('[aria-label="Focus workspace search shortcut"]'),
        };
        if (Object.values(inputs).some((input) => !input)) return false;
        for (const [action, value] of Object.entries(bindings)) {
          inputs[action].value = value;
          inputs[action].dispatchEvent(new Event('change', { bubbles: true }));
        }
        form.querySelector('button[type="submit"]').click();
        return true;
      })()`,
    );
    assert.equal(result, true, 'Shortcut bindings should be editable in Runtime settings');
  };
  const readBindings = () =>
    evaluate(
      protocol,
      `(() => {
        const form = document.querySelector('#settings-content form.runtime-settings-form');
        return {
          toggleSidebar: form?.querySelector('[aria-label="Toggle sidebar shortcut"]')?.value ?? null,
          newSession: form?.querySelector('[aria-label="Start new session shortcut"]')?.value ?? null,
          focusSearch: form?.querySelector('[aria-label="Focus workspace search shortcut"]')?.value ?? null,
          saving: form?.querySelector('button[type="submit"]')?.disabled ?? true,
          dirty: [...(form?.querySelectorAll('[aria-label$="shortcut"]') || [])].some((input) => input.dataset.dirty === 'true'),
        };
      })()`,
    );
  const waitForBindings = async (expected) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = await readBindings();
      if (
        state.toggleSidebar === expected.toggleSidebar &&
        state.newSession === expected.newSession &&
        state.focusSearch === expected.focusSearch &&
        !state.saving &&
        !state.dirty
      )
        return state;
      await delay(50);
    }
    throw new Error(`Runtime settings did not persist shortcut bindings: ${JSON.stringify(expected)}`);
  };

  await submitBindings({ toggle_sidebar: 'Alt+B', new_session: 'Alt+N', focus_search: 'Ctrl+Shift+F' });
  await waitForBindings({ toggleSidebar: 'Alt+B', newSession: 'Alt+N', focusSearch: 'Ctrl+Shift+F' });
  await submitBindings({ new_session: 'Alt+M' });
  await waitForBindings({ toggleSidebar: 'Alt+B', newSession: 'Alt+M', focusSearch: 'Ctrl+Shift+F' });
  await submitBindings({ focus_search: '' });
  return waitForBindings({ toggleSidebar: 'Alt+B', newSession: 'Alt+M', focusSearch: '/' });
}

async function updateDataDirectorySettings(protocol, directory) {
  const defaultDirectory = await evaluate(
    protocol,
    `document.querySelector('#settings-content [aria-label="Xyst AI Assistant user data directory"]')?.value || ''`,
  );
  const submitted = await evaluate(
    protocol,
    `(() => {
      const form = document.querySelector('#settings-content form.runtime-settings-form');
      const input = form?.querySelector('[aria-label="Xyst AI Assistant user data directory"]');
      if (!input) return false;
      input.value = ${JSON.stringify(directory)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      form.querySelector('button[type="submit"]').click();
      return true;
    })()`,
  );
  assert.equal(submitted, true, 'The user data directory should be editable in Runtime settings');
  const customPathDeadline = Date.now() + 10_000;
  let customPathSaved = false;
  while (Date.now() < customPathDeadline) {
    const state = await evaluate(
      protocol,
      `(() => {
        const form = document.querySelector('#settings-content form.runtime-settings-form');
        const input = form?.querySelector('[aria-label="Xyst AI Assistant user data directory"]');
        return { directory: input?.value || '', saving: form?.querySelector('button[type="submit"]')?.disabled ?? true, dirty: input?.dataset.dirty === 'true' };
      })()`,
    );
    if (state.directory === directory && !state.saving && !state.dirty) {
      customPathSaved = true;
      break;
    }
    await delay(50);
  }
  if (!customPathSaved) throw new Error('Runtime settings did not persist the custom user data directory');
  if (!defaultDirectory) throw new Error('Runtime settings did not show the default user data directory');
  await evaluate(
    protocol,
    `(() => {
      const button = [...document.querySelectorAll('#settings-content button')].find((item) => item.textContent.trim() === 'Use default location');
      if (!button) return false;
      button.click();
      document.querySelector('#settings-content form.runtime-settings-form button[type="submit"]').click();
      return true;
    })()`,
  ).then((result) => assert.equal(result, true, 'The default data location should be restorable'));
  const restorationDeadline = Date.now() + 10_000;
  while (Date.now() < restorationDeadline) {
    const state = await evaluate(
      protocol,
      `(() => {
        const form = document.querySelector('#settings-content form.runtime-settings-form');
        const input = form?.querySelector('[aria-label="Xyst AI Assistant user data directory"]');
        return { directory: input?.value || '', saving: form?.querySelector('button[type="submit"]')?.disabled ?? true, dirty: input?.dataset.dirty === 'true' };
      })()`,
    );
    if (state.directory === defaultDirectory && !state.saving && !state.dirty) return { directory, restored: state.directory };
    await delay(50);
  }
  throw new Error('Runtime settings did not restore the default user data directory');
}

async function waitForSignedSkillPanel(protocol) {
  await evaluate(protocol, `document.querySelector('#settings-dialog').close(); document.querySelector('#skills-button').click()`);
  const deadline = Date.now() + 10_000;
  let lastState;
  while (Date.now() < deadline) {
    const state = await evaluate(
      protocol,
      `(() => ({
        open: document.querySelector('#settings-dialog')?.open === true,
        title: document.querySelector('#settings-title')?.textContent || '',
        text: document.querySelector('#settings-content')?.innerText || '',
      }))()`,
    );
    lastState = state;
    if (state.open && state.text.includes('Signed skill packages')) return state;
    await delay(50);
  }
  throw new Error(`Skills panel did not show signed skill package controls: ${JSON.stringify(lastState)}`);
}

async function waitForExtensionUpdatesPanel(protocol) {
  await evaluate(protocol, `document.querySelector('#settings-dialog').close(); document.querySelector('#extensions-button').click()`);
  const deadline = Date.now() + 10_000;
  let lastState;
  while (Date.now() < deadline) {
    const state = await evaluate(
      protocol,
      `(() => ({
        open: document.querySelector('#settings-dialog')?.open === true,
        title: document.querySelector('#settings-title')?.textContent || '',
        text: document.querySelector('#settings-content')?.innerText || '',
        checkDisabled: [...document.querySelectorAll('#settings-content button')].find((button) => button.textContent.trim() === 'Check for updates')?.disabled ?? false,
      }))()`,
    );
    lastState = state;
    if (state.open && state.text.includes('no signed package update feed is set')) return state;
    await delay(50);
  }
  throw new Error(`Package update panel did not show the unconfigured state: ${JSON.stringify(lastState)}`);
}

async function waitForMcpCatalog(protocol) {
  await evaluate(protocol, `document.querySelector('#settings-dialog').close(); document.querySelector('#mcp-button').click()`);
  const deadline = Date.now() + 10_000;
  let lastState;
  while (Date.now() < deadline) {
    const state = await evaluate(
      protocol,
      `(() => ({
        open: document.querySelector('#settings-dialog')?.open === true,
        title: document.querySelector('#settings-title')?.textContent || '',
        text: document.querySelector('#settings-content')?.innerText || '',
      }))()`,
    );
    lastState = state;
    if (state.open && state.text.includes('smoke')) return state;
    await delay(50);
  }
  throw new Error(`MCP catalog did not show the configured server state: ${JSON.stringify(lastState)}`);
}

async function waitForMcpState(protocol, expectedText) {
  const deadline = Date.now() + 10_000;
  let lastState;
  while (Date.now() < deadline) {
    const state = await evaluate(
      protocol,
      `(() => ({ open: document.querySelector('#settings-dialog')?.open === true, text: document.querySelector('#settings-content')?.innerText || '' }))()`,
    );
    lastState = state;
    if (state.open && state.text.includes(expectedText)) return state;
    await delay(50);
  }
  throw new Error(`MCP panel did not show ${JSON.stringify(expectedText)}: ${JSON.stringify(lastState)}`);
}

async function waitForAppReady(protocol, pageErrors, failedResponses) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await evaluate(
      protocol,
      `({
        ready: document.readyState,
        title: document.title,
        welcome: !!document.querySelector('#welcome h1'),
        controls: !!document.querySelector('#prompt-input'),
        connected: document.querySelector('#connection-indicator')?.getAttribute('aria-label') === 'Connected to local runtime',
        unavailable: document.querySelector('#connection-indicator')?.getAttribute('aria-label') === 'Runtime unavailable',
      })`,
    );
    if (state.ready === 'complete' && state.controls && state.connected) return;
    if (state.unavailable) break;
    await delay(100);
  }
  const state = await evaluate(
    protocol,
    `({ url: location.href, ready: document.readyState, title: document.title, welcome: !!document.querySelector('#welcome h1'), controls: !!document.querySelector('#prompt-input'), connection: document.querySelector('#connection-indicator')?.getAttribute('aria-label') || '', status: document.querySelector('#workspace-status')?.textContent || '', banner: document.querySelector('#status-banner')?.textContent || '', tokenLength: document.querySelector('meta[name="xyst-token"]')?.content?.length || 0, tokenShapeValid: /^[A-Za-z0-9_-]{32,}$/.test(document.querySelector('meta[name="xyst-token"]')?.content || '') })`,
  );
  const resources = await evaluate(
    protocol,
    `performance.getEntriesByType('resource').filter((entry) => /\\/(app|api-client)\\.mjs|\\/v1\\//.test(entry.name)).slice(-20).map((entry) => ({ name: new URL(entry.name).pathname, duration: Math.round(entry.duration), size: entry.transferSize }))`,
  );
  const apiDiagnostics = await evaluate(
    protocol,
    `(async () => {
      const token = document.querySelector('meta[name="xyst-token"]')?.content || '';
      return await Promise.all(['/v1/health', '/v1/settings', '/v1/usage', '/v1/sessions'].map(async (pathname) => {
        try {
          const response = await fetch(pathname, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(1500) });
          const body = await response.json().catch(() => ({}));
          return { pathname, status: response.status, error: typeof body.error === 'string' ? body.error.slice(0, 200) : '', code: body.code || '' };
        } catch (error) { return { pathname, error: error.name + ': ' + error.message }; }
      }));
    })()`,
  );
  throw new Error(
    `The local Xyst AI Assistant UI did not reach its ready state: ${JSON.stringify(state)}; page errors: ${JSON.stringify(pageErrors.slice(-12))}; failed responses: ${JSON.stringify(failedResponses.slice(-12))}; API diagnostics: ${JSON.stringify(apiDiagnostics)}; resources: ${JSON.stringify(resources)}`,
  );
}

async function evaluate(protocol, expression) {
  const result = await protocol.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    timeout: 5_000,
  });
  if (result.exceptionDetails)
    throw new Error(
      `Browser page evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'unknown error'}`,
    );
  return result.result?.value;
}

async function findBrowserExecutable() {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          'msedge.exe',
          'chrome.exe',
        ]
      : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [candidate], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3_000,
    });
    if (lookup.status === 0 && lookup.stdout.trim()) return lookup.stdout.trim().split(/\r?\n/)[0];
  }
  throw new Error('Install Chrome/Edge/Chromium or set XYST_BROWSER_EXECUTABLE before running the browser smoke');
}

function isolatedEnvironment(temporaryDirectory) {
  const env = { ...process.env };
  if (process.platform === 'win32') {
    env.LOCALAPPDATA = path.join(temporaryDirectory, 'LocalAppData');
    env.APPDATA = path.join(temporaryDirectory, 'RoamingAppData');
  } else {
    env.XDG_CONFIG_HOME = path.join(temporaryDirectory, 'config');
    env.XDG_DATA_HOME = path.join(temporaryDirectory, 'data');
  }
  return env;
}

function readLine(stream, child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('Timed out waiting for local API bootstrap')), timeoutMs);
    const finish = (error, value) => {
      clearTimeout(timer);
      stream.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer) > 16 * 1024) return finish(new Error('Local API bootstrap exceeds its size limit'));
      const newline = buffer.indexOf('\n');
      if (newline >= 0) finish(null, buffer.slice(0, newline).trim());
    };
    const onError = (error) => finish(error);
    const onClose = (code, signal) => finish(new Error(`Local API exited before bootstrap (code=${code}, signal=${signal})`));
    stream.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Process did not exit within ${timeoutMs} ms`)), timeoutMs);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  smokeBrowser({ browserExecutable: process.argv[2] })
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`Browser smoke: ${error.message}\n`);
      process.exitCode = 1;
    });
}
