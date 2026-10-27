import { encodeToolObservation } from './observations.mjs';

const INTERRUPTED_TOOL_RESULT =
  'Xyst was interrupted before saving this tool result. The action outcome is unknown. Inspect the current state before repeating this action.';

/** Close dangling tool calls in a saved transcript without replaying their actions. */
export function recoverInterruptedToolCalls(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return { messages, recovered: 0 };

  const recoveredMessages = [];
  let recovered = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    recoveredMessages.push(message);
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) continue;

    const calls = message.tool_calls.filter(
      (call) => typeof call?.id === 'string' && call.id && typeof call?.function?.name === 'string' && call.function.name,
    );
    if (calls.length === 0) continue;
    const callIds = new Set(calls.map((call) => call.id));
    const completedIds = new Set();
    const savedResults = [];
    for (let next = index + 1; next < messages.length; next += 1) {
      const result = messages[next];
      if (result?.role !== 'tool' || !callIds.has(result.tool_call_id)) break;
      completedIds.add(result.tool_call_id);
      savedResults.push(result);
    }
    recoveredMessages.push(...savedResults);
    index += savedResults.length;

    for (const call of calls) {
      if (completedIds.has(call.id)) continue;
      recoveredMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: encodeToolObservation({
          toolName: call.function.name,
          toolCallId: call.id,
          result: { error: INTERRUPTED_TOOL_RESULT, outcome: 'unknown' },
        }),
      });
      recovered += 1;
    }
  }

  return recovered ? { messages: recoveredMessages, recovered } : { messages, recovered: 0 };
}
