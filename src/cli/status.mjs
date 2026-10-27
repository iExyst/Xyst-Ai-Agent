import { findBubblewrap, findWindowsSandboxHelper } from '../platform/sandbox.mjs';

export async function detectSandboxCapability({
  platform = process.platform,
  workspaceRoot,
  findLinuxBubblewrap = findBubblewrap,
  findWindowsHelper = findWindowsSandboxHelper,
} = {}) {
  if (platform === 'linux') {
    const backend = await findLinuxBubblewrap();
    return {
      backend: 'bubblewrap',
      available: Boolean(backend),
      reason: backend ? null : 'trusted_bubblewrap_unavailable',
    };
  }
  if (platform === 'win32') {
    const backend = await findWindowsHelper({ platform, workspaceRoot });
    return {
      backend: 'windows_appcontainer',
      available: Boolean(backend),
      reason: backend ? null : 'windows_appcontainer_helper_unavailable',
    };
  }
  return { backend: null, available: false, reason: 'unsupported_platform' };
}

export function createCliStatus({ workspace, config, session, modelOverride, sharedBudget, sandboxCapability }) {
  const profileName = session?.model || modelOverride || config.default_model || null;
  const profile = profileName ? config.models?.[profileName] : null;
  const endpointOrigin = safeOrigin(profile?.base_url);
  return {
    workspace,
    session_id: session?.id || null,
    session_status: session?.status || 'idle',
    mode: session?.mode || null,
    autonomy: config.tools?.autonomy || 'unrestricted',
    model: profileName
      ? {
          profile: profileName,
          provider_model: profile?.model || null,
          locality: profile?.local === true ? 'local' : profile ? 'remote' : 'unavailable',
          endpoint_origin: endpointOrigin,
        }
      : null,
    routing: session?.routing_decision
      ? {
          reason: session.routing_decision.reason || null,
          selected_at: session.routing_decision.selected_at || null,
          factors: session.routing_decision.factors || null,
          alternatives: session.routing_decision.alternatives || [],
        }
      : { reason: null, selected_at: null, factors: null, alternatives: [] },
    sandbox: {
      mode: config.sandbox?.mode || 'none',
      backend: sandboxCapability.backend,
      backend_available: sandboxCapability.available,
      reason: sandboxCapability.reason,
      active_for_current_run: null,
    },
    budget: {
      limits: config.budgets || {},
      session_usage: session?.usage || null,
      shared_daily: sharedBudget.daily,
      shared_monthly: sharedBudget.monthly,
    },
  };
}

function safeOrigin(value) {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
