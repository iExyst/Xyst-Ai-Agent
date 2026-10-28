/** A persisted active session with no live run may have been interrupted mid-turn. */
export function isInterruptedSession(session, { running = false } = {}) {
  if (session?.status !== 'active' || running) return false;
  if (session.last_message_role === 'assistant') return session.last_message_has_tool_calls === true;
  return session.last_message_role === 'user' || session.last_message_role === 'tool';
}

const ACTIVE_SESSION_KEY = 'xyst.activeSessionId';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Restore only a session that is present in the current workspace's session list. */
export function getRememberedSessionId(sessions, storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    const id = target.getItem(ACTIVE_SESSION_KEY);
    if (UUID_PATTERN.test(id || '') && sessions.some((session) => session.id === id)) return id;
    target.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return null;
}

/** Persist only the UUID, never the conversation, credentials, or run data. */
export function rememberSessionId(id, storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    if (UUID_PATTERN.test(id || '')) target.setItem(ACTIVE_SESSION_KEY, id);
    else target.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    // Session recovery remains optional when browser storage is unavailable.
  }
}

/** Restore the desktop's last selected UUID across native app/service restarts. */
export async function getDesktopRememberedSessionId() {
  try {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    const id = typeof invoke === 'function' ? await invoke('get_last_session') : null;
    return UUID_PATTERN.test(id || '') ? id : null;
  } catch {
    return null;
  }
}

/** Persist only the selected UUID through the narrow native desktop command. */
export function rememberDesktopSessionId(id) {
  try {
    const invoke = globalThis.__TAURI__?.core?.invoke;
    if (typeof invoke === 'function') {
      return invoke('set_last_session', { id: UUID_PATTERN.test(id || '') ? id : null }).catch(() => {});
    }
  } catch {
    // Browser mode and shutdown may not have a native bridge.
  }
}
