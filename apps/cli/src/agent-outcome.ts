export type AgentOutcomeStatus = "completed" | "unverified" | "cancelled" | "limit";

/** Return a concise recovery hint for an agent run that did not complete successfully. */
export function agentOutcomeNotice(status: AgentOutcomeStatus, sessionId: string): string | undefined {
  if (status === "completed") return undefined;
  const inspect = `xyst session calls ${sessionId}`;
  const resume = `xyst agent resume ${sessionId} <message>`;
  if (status === "unverified") {
    return `Xyst status: unverified. Completion criteria were not verified; treat any success claim above as unverified. Inspect the session with ${inspect} or resume it with ${resume}.`;
  }
  if (status === "limit") {
    return `Xyst status: turn limit reached. The session is saved; inspect it with ${inspect} or resume it with ${resume}.`;
  }
  return `Xyst status: cancelled. The session is saved; inspect it with ${inspect} or resume it with ${resume}.`;
}
