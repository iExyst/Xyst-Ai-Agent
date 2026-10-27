export const AGENT_RUN_STATUSES = Object.freeze([
  'complete',
  'failed',
  'cancelled',
  'budget_exceeded',
  'max_turns',
  'context_overflow',
  'invalid_review_output',
]);

export const SESSION_STATUSES = Object.freeze(['active', 'archived', ...AGENT_RUN_STATUSES]);
export const CONTROL_API_RUN_STATUSES = Object.freeze(['running', 'paused', ...AGENT_RUN_STATUSES]);
export const CONTROL_API_RUN_FAILURE_STATUSES = Object.freeze(['failed', 'cancelled']);
