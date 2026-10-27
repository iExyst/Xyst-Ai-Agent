import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliStatus, detectSandboxCapability } from '../src/cli/status.mjs';

test('CLI status explains selected local model, routing, autonomy, sandbox, and budgets', () => {
  const status = createCliStatus({
    workspace: 'C:/project',
    config: {
      default_model: 'fast-local',
      tools: { autonomy: 'unrestricted' },
      sandbox: { mode: 'required' },
      budgets: { max_tokens: 5000 },
      models: { 'fast-local': { model: 'qwen', base_url: 'http://user:secret@127.0.0.1:1234/v1?token=hidden', local: true } },
    },
    session: {
      id: 'session-1',
      status: 'active',
      mode: 'agent',
      usage: { input_tokens: 12, output_tokens: 4 },
      routing_decision: { model: 'fast-local', reason: 'preferred capable local model', factors: { prefer_local: true }, alternatives: [] },
    },
    sharedBudget: { daily: { input_tokens: 20 }, monthly: { input_tokens: 40 } },
    sandboxCapability: { backend: 'bubblewrap', available: true, reason: null },
  });
  assert.equal(status.model.locality, 'local');
  assert.equal(status.model.endpoint_origin, 'http://127.0.0.1:1234');
  assert.equal(status.routing.reason, 'preferred capable local model');
  assert.equal(status.autonomy, 'unrestricted');
  assert.equal(status.sandbox.backend_available, true);
  assert.equal(status.sandbox.active_for_current_run, null);
  assert.equal(status.budget.limits.max_tokens, 5000);
  assert.equal(status.budget.shared_monthly.input_tokens, 40);
  assert.doesNotMatch(JSON.stringify(status), /secret|hidden/);
});

test('CLI status distinguishes an unknown override from a configured model', () => {
  const status = createCliStatus({
    workspace: '/project',
    config: { models: {}, tools: {}, budgets: {} },
    modelOverride: 'missing-profile',
    sharedBudget: { daily: {}, monthly: {} },
    sandboxCapability: { backend: null, available: false, reason: 'unsupported_platform' },
  });
  assert.equal(status.model.profile, 'missing-profile');
  assert.equal(status.model.locality, 'unavailable');
  assert.equal(status.routing.reason, null);
});

test('sandbox capability detection reports unsupported platforms explicitly', async () => {
  assert.deepEqual(await detectSandboxCapability({ platform: 'darwin' }), {
    backend: null,
    available: false,
    reason: 'unsupported_platform',
  });
});

test('sandbox capability detection reports Linux Bubblewrap availability and absence', async () => {
  assert.deepEqual(await detectSandboxCapability({ platform: 'linux', findLinuxBubblewrap: async () => '/usr/bin/bwrap' }), {
    backend: 'bubblewrap',
    available: true,
    reason: null,
  });
  assert.deepEqual(await detectSandboxCapability({ platform: 'linux', findLinuxBubblewrap: async () => null }), {
    backend: 'bubblewrap',
    available: false,
    reason: 'trusted_bubblewrap_unavailable',
  });
});

test('sandbox capability detection reports Windows helper availability and absence', async () => {
  const seen = [];
  const finder = async (options) => {
    seen.push(options);
    return 'C:/Xyst AI Assistant/xyst-sandbox-helper.exe';
  };
  assert.deepEqual(await detectSandboxCapability({ platform: 'win32', workspaceRoot: 'C:/workspace', findWindowsHelper: finder }), {
    backend: 'windows_appcontainer',
    available: true,
    reason: null,
  });
  assert.deepEqual(seen, [{ platform: 'win32', workspaceRoot: 'C:/workspace' }]);
  assert.deepEqual(await detectSandboxCapability({ platform: 'win32', findWindowsHelper: async () => null }), {
    backend: 'windows_appcontainer',
    available: false,
    reason: 'windows_appcontainer_helper_unavailable',
  });
});
