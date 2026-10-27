/** Encode tool output as data with provenance; tool output never becomes instruction text. */
export function encodeToolObservation({ toolName, toolCallId, result, origin = null }) {
  if (typeof toolName !== 'string' || !toolName || typeof toolCallId !== 'string' || !toolCallId) {
    throw new TypeError('Tool observations require a source tool name and call ID');
  }
  if (origin !== null && (!origin || typeof origin !== 'object' || typeof origin.kind !== 'string' || typeof origin.name !== 'string')) {
    throw new TypeError('Tool observation origin must contain a source kind and name');
  }
  return JSON.stringify({
    type: 'untrusted_observation',
    source: { kind: 'tool', name: toolName, tool_call_id: toolCallId },
    ...(origin ? { origin: { ...origin, trust: 'untrusted' } } : {}),
    trust: 'untrusted',
    content: result,
  });
}
