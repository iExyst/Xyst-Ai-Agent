/** Version 1 runtime contracts. Keep provider-independent and event-driven so
 * CLI, desktop, and IDE clients can share one implementation.
 */
export type RunMode = 'agent' | 'review' | 'plan';
export type ToolApproval = 'auto' | 'ask' | 'deny';

/** Local authenticated HTTP control surface used by desktop and IDE clients. */
export interface ControlApiBootstrap {
  url: string;
  token: string;
  api_version: 1;
}

/** Error body returned by the local control API. Some legacy validation
 * failures omit the optional machine-readable code. */
export interface ControlApiErrorResponse {
  error: string;
  code?: string;
}

export interface ControlApiErrorDetails {
  code: string;
  message: string;
}

/** Runtime error exposed by ControlApiClient after parsing an API response. */
export interface ControlApiClientError extends Error {
  name: 'ControlApiError';
  message: string;
  status: number | null;
  code: string;
}

export interface ControlApiRunRequest {
  prompt: string;
  images?: Array<{ mime_type: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }>;
  mcp_servers?: string[] | null;
  session_id?: string;
  model?: string;
  mode?: RunMode;
  worktree_id?: string;
}

export interface ControlApiRunAccepted {
  run_id: string;
  status: 'running';
  events_url: string;
}

export interface ControlApiRunState {
  run_id: string;
  status: ControlApiRunStatus;
  model: string | null;
  pending_model_change: string | null;
  budgets: RuntimeBudgetSettings;
  initial_budgets: RuntimeBudgetSettings;
  pending_budget_change: RuntimeBudgetSettings | null;
  budget_adjustments_enabled: boolean;
  pause_requested: boolean;
  pending_directions: number;
  created_at: string;
  session_id: string | null;
  pending_approvals: string[];
  result: { status: AgentRunStatus; content: string; session_id: string } | null;
  error: ControlApiErrorDetails | null;
}

export interface AgentRequest {
  prompt: string;
  images?: Array<{ mime_type: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }>;
  mcpServers?: string[] | null;
  session?: SessionRecord;
  requestedModel?: string;
  mode?: RunMode;
  signal?: AbortSignal;
  streaming?: boolean;
  approveTool?: (proposal: ToolApprovalRequest) => Promise<ToolApprovalResponse> | ToolApprovalResponse;
}

export interface ToolApprovalRequest {
	tool: ToolDefinition;
  args: Record<string, unknown>;
	permission: ToolPermission;
  sessionId: string;
	signal?: AbortSignal;
  fileChange?: Record<string, unknown> | null;
}

export type ToolApprovalResponse = boolean | {
  approved: boolean;
  grant_scope?: 'session';
  grant_duration_ms?: number;
  accepted_hunks?: string[];
};

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens?: number;
}

export type RuntimeBudgetSettings = Partial<
  Record<
    | 'max_turns'
    | 'max_input_tokens'
    | 'max_output_tokens'
    | 'max_tool_output_bytes'
    | 'max_session_input_tokens'
    | 'max_session_output_tokens'
    | 'recovery_summary_input_tokens'
    | 'final_response_reserve_tokens'
    | 'max_session_cost'
    | 'max_daily_input_tokens'
    | 'max_daily_output_tokens'
    | 'max_monthly_input_tokens'
    | 'max_monthly_output_tokens'
    | 'max_daily_cost'
    | 'max_monthly_cost',
    number | null
  >
>;

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: Usage | null;
  finishReason: string | null;
}

export type ProviderStreamEvent = { type: 'text'; text: string } | { type: 'done'; response: ModelResponse };

export interface ProviderModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export interface ProviderMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: unknown;
  [key: string]: unknown;
}

export interface ProviderChatOptions {
  tools?: Array<Record<string, unknown>>;
  toolChoice?: string | Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Provider-independent operations required by AgentRuntime. */
export interface ModelProvider {
  listModels(options?: { signal?: AbortSignal }): Promise<ProviderModel[]>;
  chat(messages: ProviderMessage[], options?: ProviderChatOptions): Promise<ModelResponse>;
  stream(messages: ProviderMessage[], options?: ProviderChatOptions): AsyncIterable<ProviderStreamEvent>;
}

export interface ModelProviderFactoryOptions {
  apiKey: string | null;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

export type ModelProviderFactory = (
  profile: Record<string, unknown>,
  options: ModelProviderFactoryOptions,
) => ModelProvider | Promise<ModelProvider>;

export type ProviderErrorCode =
  | 'PROVIDER_ERROR'
  | 'INVALID_RESPONSE'
  | 'INVALID_STREAM'
  | 'CANCELLED'
  | 'REQUEST_TIMEOUT'
  | 'STREAM_FAILED'
  | 'CONNECTION_FAILED'
  | 'AUTHENTICATION_FAILED'
  | 'RATE_LIMITED'
  | 'CONTEXT_OVERFLOW'
  | 'PROVIDER_UNAVAILABLE'
  | 'BAD_REQUEST'
  | 'HTTP_ERROR';

export interface ProviderFailure {
  name: 'ProviderError';
  code: ProviderErrorCode;
  message: string;
  status: number | null;
  retryable: boolean;
}

export interface RoutingDecision {
	name: string;
  config: Record<string, unknown>;
  reason: string;
  factors: Record<string, unknown>;
  alternatives: Array<Record<string, unknown>>;
}

/** Stable, persisted form of a selected routing decision in a session. */
export interface RoutingDecisionRecord {
	model: string;
	reason: string;
	factors: Record<string, unknown>;
	alternatives: RoutingDecision['alternatives'];
	availability?: Record<string, unknown>;
	selected_at: string;
}

export type ToolPermissionDecision = 'allow' | 'require_approval' | 'deny' | 'defer';

export type ToolTimeoutPolicy =
	| { kind: 'platform_operation' }
	| { kind: 'fixed_ms'; milliseconds: number }
	| { kind: 'argument_seconds'; argument: string; default_seconds: number; max_seconds: number }
	| { kind: 'config_ms'; config_path: string; fallback_path?: string; default_ms: number; min_ms: number; max_ms: number };

export type ToolSandboxRequirement = 'not_applicable' | 'process' | 'unsupported';

export interface ToolExecutionMetadata {
	timeout: ToolTimeoutPolicy;
	sandbox: ToolSandboxRequirement;
}

export interface ToolPermission {
	decision: ToolPermissionDecision;
	/** Runtime-selected source, such as a config rule, user setting, or default. */
	source?: string;
	reason?: string;
	summary?: string;
	rule_id?: string;
}

export interface ToolDefinition {
	schema_version: 1;
	execution: ToolExecutionMetadata;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  destructive: boolean;
  approval: ToolApproval;
	_mcp?: { server: string; originalName: string };
}

export interface ToolResult {
  toolCallId: string;
  ok: boolean;
  content: string;
  error?: string;
}

export interface Observation {
  source: 'tool' | 'retrieval' | 'memory' | 'web' | 'system';
  content: string;
  untrusted: boolean;
  metadata?: Record<string, unknown>;
}

export interface EventBase {
  timestamp: string;
  correlation_id?: string;
}

export interface SessionEventBase extends EventBase {
  session_id: string;
}

export type AgentRunStatus =
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'budget_exceeded'
  | 'max_turns'
  | 'context_overflow'
  | 'invalid_review_output';
export type StoppedRunStatus = Exclude<AgentRunStatus, 'complete'>;
export type SessionStatus = 'active' | 'archived' | AgentRunStatus;
export type ControlApiRunStatus = 'running' | 'paused' | AgentRunStatus;
export type ControlApiRunFailureStatus = 'failed' | 'cancelled';

/** Events emitted directly by AgentRuntime, including its delegated subagent manager. */
export type AgentEvent =
	| (SessionEventBase & { type: 'run_started'; model: string; routing_reason: string; routing_decision: RoutingDecisionRecord })
  | (SessionEventBase & { type: 'model_load_started'; model: string })
  | (SessionEventBase & { type: 'model_load_finished'; model: string; already_loaded: boolean; context_length?: number })
  | (SessionEventBase & { type: 'model_load_failed'; model: string; code: string })
  | (SessionEventBase & { type: 'model_load_skipped'; model: string; reason: 'management_api_unavailable' })
  | (SessionEventBase & { type: 'retrieval_context_ready'; matches: number; included: boolean; truncated: boolean; duration_ms: number })
  | (SessionEventBase & { type: 'retrieval_context_started' })
  | (SessionEventBase & { type: 'retrieval_context_failed'; error_code: string; duration_ms: number })
  | (SessionEventBase & {
      type: 'compaction_started';
      trigger_tokens: number;
      trigger_reason?: 'context' | 'budget' | 'context_and_budget';
    })
  | (SessionEventBase & { type: 'compaction_finished'; archived_messages: number; retained_messages: number; duration_ms: number })
  | (SessionEventBase & { type: 'compaction_failed'; message: string; code: string; duration_ms: number })
  | (SessionEventBase & { type: 'recovery_summary_started'; model: string })
  | (SessionEventBase & { type: 'recovery_summary_finished'; model: string; duration_ms: number })
  | (SessionEventBase & { type: 'recovery_summary_failed'; code: string; duration_ms: number })
  | (SessionEventBase & { type: 'memory_context_started' })
  | (SessionEventBase & { type: 'memory_context_finished'; memory_items: number; active_goals: number; duration_ms: number })
  | (SessionEventBase & { type: 'memory_context_failed'; code: string; duration_ms: number })
  | (SessionEventBase & { type: 'session_persist_started' })
  | (SessionEventBase & { type: 'session_persist_finished'; duration_ms: number })
  | (SessionEventBase & { type: 'session_persist_failed'; duration_ms: number; code: string })
  | (SessionEventBase & { type: 'usage_recording_failed'; code: string })
  | (SessionEventBase & { type: 'hook_failed'; hook_event: string; code: string })
  | (SessionEventBase & {
      type: 'context_trimmed';
      dropped_turns: number;
      dropped_tool_calls?: number;
      compacted_tool_results?: number;
      dropped_tools?: string[];
      retained_tokens: number;
      reason?: 'provider_context_overflow' | 'tool_schema_budget';
    })
  | (SessionEventBase & { type: 'model_call_started'; turn: number; model: string; estimated_input_tokens: number })
  | (SessionEventBase & {
      type: 'run_model_changed';
      from_model: string;
      to_model: string;
      routing_decision: RoutingDecisionRecord;
    })
  | (SessionEventBase & { type: 'run_model_change_failed'; requested_model: string; code: string })
  | (SessionEventBase & { type: 'run_budgets_changed'; budgets: RuntimeBudgetSettings; updated_at: string })
  | (SessionEventBase & { type: 'run_budget_change_failed'; code: string })
  | (SessionEventBase & {
      type: 'run_runtime_policy_changed';
      autonomy: 'assisted' | 'unrestricted';
      sandbox: Record<string, unknown>;
      updated_at: string;
    })
  | (SessionEventBase & { type: 'run_runtime_policy_change_failed'; code: string })
  | (SessionEventBase & { type: 'assistant_delta'; text: string; recovery?: boolean })
  | (SessionEventBase & { type: 'model_fallback'; turn: number; from_model: string; to_model: string; cause: string; reason: string })
  | (SessionEventBase & {
      type: 'model_retry_scheduled';
      turn: number;
      model: string;
      attempt: number;
      delay_ms: number;
      cause: string;
    })
  | (SessionEventBase & { type: 'run_failed'; code: string; message: string })
  | (SessionEventBase & {
      type: 'model_call_finished';
      turn: number;
      model: string;
      usage: Usage | null;
      estimated_cost: number | null;
      duration_ms: number;
    })
  | (SessionEventBase & { type: 'model_call_failed'; turn: number; model: string; duration_ms: number; code: string })
  | (SessionEventBase & { type: 'run_finished'; status: 'complete'; turns: number; usage: SessionUsage })
  | (SessionEventBase & { type: 'tool_denied'; tool: string; tool_call_id: string; reason?: string })
  | (SessionEventBase & {
      type: 'tool_proposed';
      tool: string;
      tool_call_id: string;
      arguments: Record<string, unknown>;
		permission: ToolPermission;
      file_change?: Record<string, unknown>;
    })
  | (SessionEventBase & { type: 'tool_grant_used'; tool: string; tool_call_id: string; grant_id: string; expires_at: string })
  | (SessionEventBase & { type: 'tool_grant_limit_reached'; tool: string; limit: number })
  | (SessionEventBase & { type: 'tool_grant_created'; tool: string; grant_id: string; expires_at: string })
  | (SessionEventBase & { type: 'tool_started'; tool: string; tool_call_id: string })
  | (SessionEventBase & {
      type: 'untrusted_content_signal';
      tool: string;
      detector_version: 'xyst-patterns-1' | 'xyst-patterns-2' | 'xyst-patterns-3';
      signals: Array<'instruction_override' | 'role_impersonation' | 'credential_exfiltration' | 'approval_bypass'>;
    })
  | (SessionEventBase & { type: 'tool_failed'; tool: string; tool_call_id: string; message: string; duration_ms: number })
  | (SessionEventBase & {
      type: 'tool_finished';
      tool: string;
      tool_call_id: string;
      duration_ms: number;
      summary: string;
      applied_hunks?: string[];
    })
  | (SessionEventBase & { type: 'run_stopped'; status: StoppedRunStatus; reason: string; recovery_summary?: boolean })
  | (SessionEventBase & { type: 'user_direction_added'; content: string })
  | (EventBase & { type: 'subagent_task_started'; task_id: string; parent_session_id: string; worktree_id: string; branch: string })
  | (EventBase & {
      type: 'subagent_task_finished';
      task_id: string;
      status: SubagentTaskStatus;
      child_session_id?: string | null;
      changed_paths?: string[];
      error?: string;
    });

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number | null;
}

export type ControlApiRunCallbackEvent = AgentEvent & { run_id: string };

export interface ControlApiEventBase extends EventBase {
  run_id: string;
  sequence: number;
  correlation_id: string;
}

/** Additional sequenced lifecycle events emitted by the authenticated run API. */
export type ControlApiLifecycleEvent =
  | (ControlApiEventBase & { type: 'api_run_started' })
  | (ControlApiEventBase & { type: 'api_run_finished'; status: AgentRunStatus; session_id: string | null })
  | (ControlApiEventBase & { type: 'api_run_failed'; status: ControlApiRunFailureStatus; error: ControlApiErrorDetails })
  | (ControlApiEventBase & {
      type: 'approval_resolved';
      approval_id: string;
      session_id: string | null;
      tool: string;
      status: 'approved' | 'denied' | 'expired' | 'cancelled';
      duration_ms: number;
    })
  | (ControlApiEventBase & {
      type: 'approval_required';
      approval_id: string;
      session_id: string | null;
      tool: string;
      arguments: Record<string, unknown>;
      file_change?: Record<string, unknown>;
      summary: string;
      expires_in_ms: number;
      grant_options: {
        scopes: Array<'once' | 'session_exact_action' | 'exact_path_1h' | 'exact_command_1h'>;
        min_duration_ms: number;
        max_duration_ms: number;
        max_active_grants: number;
        exact_rule_duration_ms: number;
      };
    })
  | (ControlApiEventBase & { type: 'run_pause_requested' })
  | (ControlApiEventBase & { type: 'run_pause_cancelled' })
  | (ControlApiEventBase & { type: 'run_direction_queued'; pending: number })
  | (ControlApiEventBase & {
      type: 'run_policy_changed';
      policy: 'approval_rules';
      action: 'added' | 'revoked';
      rule_id: string;
      tool: string;
      scope: 'tool' | 'path_glob' | 'command_glob';
      decision: 'allow' | 'deny';
      expires_at: string;
    })
  | (ControlApiEventBase & { type: 'run_runtime_policy_queued'; autonomy: 'assisted' | 'unrestricted'; updated_at: string })
  | (ControlApiEventBase & { type: 'run_paused'; session_id: string })
  | (ControlApiEventBase & { type: 'run_resumed'; session_id: string })
  | (ControlApiEventBase & { type: 'api_event_history_truncated'; earliest_available_sequence: number });

export type ControlApiRunEvent = ControlApiLifecycleEvent | (ControlApiEventBase & AgentEvent);

export interface SessionRecord {
  schema_version: number;
  id: string;
  created_at: string;
  updated_at: string;
  status: SessionStatus;
  mcp_servers?: string[] | null;
  mode?: RunMode;
  model: string | null;
  routing_decision: Record<string, unknown> | null;
  messages: Array<Record<string, unknown>>;
  usage: { input_tokens: number; output_tokens: number; estimated_cost: number | null };
  failure?: { code: string; message: string; failed_at: string };
  persistent_goal_ids?: string[];
  permission_grants?: Array<{ id: string; tool: string; scope: 'exact_action'; arguments_hash: string; created_at: string; expires_at: string }>;
  compaction_summary?: string;
  compaction_archive?: string;
  compaction_archives?: string[];
  plan?: string;
  review_findings?: Array<Record<string, unknown>>;
}

export interface SessionGoalsUpdateRequest {
  goal_ids: string[];
}

export type SubagentTaskStatus = 'starting' | 'running' | 'complete' | 'stopped' | 'failed' | 'cancelled' | 'timed_out';

export interface SubagentUsage {
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number | null;
}

/** Bounded child outcome returned to the parent agent; excludes task-store owner and host metadata. */
export interface SubagentExecutionResult {
  schema_version: 1;
  task_id: string;
  status: SubagentTaskStatus;
  child_status: AgentRunStatus | null;
  child_session_id: string | null;
  worktree_id: string | null;
  branch: string | null;
  summary: string;
  summary_truncated: boolean;
  changed_paths: string[];
  changed_paths_truncated: boolean;
  usage: SubagentUsage | null;
  error: string | null;
  error_truncated: boolean;
}

export interface SubagentTaskRecord {
  id: string;
  status: SubagentTaskStatus;
  task: string;
  parent_session_id: string;
  child_session_id: string | null;
  worktree_id: string | null;
  branch: string | null;
  worktree_path: string | null;
  result: string | null;
  changed_paths: string[];
  usage?: SubagentUsage | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  owner?: {
    pid: number;
    hostname: string;
    process_identity: Record<string, string | number> | null;
  };
}
