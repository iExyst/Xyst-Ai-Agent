/** A persisted active session with no live run may have been interrupted mid-turn. */
export function isInterruptedSession(session, { running = false } = {}) {
  if (session?.status !== 'active' || running) return false;
  if (session.last_message_role === 'assistant') return session.last_message_has_tool_calls === true;
  return session.last_message_role === 'user' || session.last_message_role === 'tool';
}
