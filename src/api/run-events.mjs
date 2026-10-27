import { AGENT_RUN_STATUSES, CONTROL_API_RUN_FAILURE_STATUSES } from '../core/statuses.mjs';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Return a stable validation message for terminal Control API event payloads. */
export function validateControlApiTerminalEvent(type, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Terminal event payload must be an object';
  if (payload.type !== undefined && payload.type !== type) return 'Terminal event type does not match its payload';

  if (type === 'api_run_finished') {
    if (!AGENT_RUN_STATUSES.includes(payload.status)) return 'api_run_finished status is invalid';
    if (payload.session_id !== null && (typeof payload.session_id !== 'string' || !UUID_PATTERN.test(payload.session_id)))
      return 'api_run_finished session_id must be null or a valid session UUID';
    return null;
  }

  if (type === 'api_run_failed') {
    if (!CONTROL_API_RUN_FAILURE_STATUSES.includes(payload.status)) return 'api_run_failed status is invalid';
    if (
      !payload.error ||
      typeof payload.error !== 'object' ||
      Array.isArray(payload.error) ||
      typeof payload.error.code !== 'string' ||
      !payload.error.code.trim() ||
      payload.error.code.length > 128 ||
      typeof payload.error.message !== 'string' ||
      !payload.error.message.trim() ||
      payload.error.message.length > 4_000
    )
      return 'api_run_failed error must contain a non-empty code and message within the size limits';
    return null;
  }

  return null;
}
