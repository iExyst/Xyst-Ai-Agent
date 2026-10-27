import { createHash, randomUUID } from 'node:crypto';

export const MIN_SESSION_GRANT_MS = 60_000;
export const MAX_SESSION_GRANT_MS = 24 * 60 * 60 * 1000;
export const MAX_SESSION_GRANTS = 100;

export function createSessionGrant(tool, args, durationMs, now = new Date()) {
  if (!Number.isInteger(durationMs) || durationMs < MIN_SESSION_GRANT_MS || durationMs > MAX_SESSION_GRANT_MS) {
    throw new TypeError(`Session grant duration must be between ${MIN_SESSION_GRANT_MS} and ${MAX_SESSION_GRANT_MS} milliseconds`);
  }
  return {
    id: randomUUID(),
    tool,
    scope: 'exact_action',
    arguments_hash: hashAction(tool, args),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + durationMs).toISOString(),
  };
}

export function findSessionGrant(session, tool, args, now = Date.now()) {
  return (
    (session.permission_grants || []).find(
      (grant) =>
        grant.tool === tool &&
        grant.scope === 'exact_action' &&
        grant.arguments_hash === hashAction(tool, args) &&
        Date.parse(grant.expires_at) > now,
    ) || null
  );
}

function hashAction(tool, args) {
  const canonical = stableStringify(args);
  return createHash('sha256').update(`${tool}\0${canonical}`).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}
