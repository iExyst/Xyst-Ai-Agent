export const MODEL_CAPABILITIES_STALE_AFTER_DAYS = 180;

const CAPABILITY_FIELDS = Object.freeze([
  'context_length',
  'max_output_tokens',
  'supports_tools',
  'supports_vision',
  'coding_strength',
  'tool_calling_quality',
  'speed_score',
  'priority',
  'local',
]);

export function modelCapabilitiesDataStatus(profile, { now = Date.now() } = {}) {
  if (!CAPABILITY_FIELDS.some((field) => profile?.[field] !== undefined)) return 'unknown';
  const reviewedAt = parseDate(profile?.capabilities_updated_at);
  if (reviewedAt === null) return profile?.capabilities_updated_at ? 'invalid' : 'unreviewed';
  if (reviewedAt > now) return 'invalid';
  return Math.floor((now - reviewedAt) / 86_400_000) > MODEL_CAPABILITIES_STALE_AFTER_DAYS ? 'stale' : 'current';
}

export function modelCapabilitiesStatus(profile, { now = Date.now() } = {}) {
  const status = modelCapabilitiesDataStatus(profile, { now });
  if (status === 'unknown') return 'No capability metadata configured.';
  const source = profile?.capabilities_source ? ` · Source: ${profile.capabilities_source}` : '';
  if (status === 'unreviewed') return 'Capability review date missing; routing assumptions may be stale.';
  if (status === 'invalid') return 'Capability review date is invalid or in the future; correct it before relying on routing.';
  if (status === 'stale')
    return `Capabilities last checked ${profile.capabilities_updated_at} · stale (over ${MODEL_CAPABILITIES_STALE_AFTER_DAYS} days old)${source}`;
  return `Capabilities checked ${profile.capabilities_updated_at}${source}`;
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : null;
}
