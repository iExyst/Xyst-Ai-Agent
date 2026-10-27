import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TOOL_DEFINITIONS, TOOL_SCHEMA_VERSION } from '../src/tools/schemas.mjs';
import { AGENT_RUN_STATUSES, CONTROL_API_RUN_FAILURE_STATUSES, CONTROL_API_RUN_STATUSES, SESSION_STATUSES } from '../src/core/statuses.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('shared event declarations cover every runtime and API event emission', async () => {
  const [contracts, agent, subagents, api] = await Promise.all([
    fs.readFile(path.join(root, 'src/core/contracts.d.ts'), 'utf8'),
    fs.readFile(path.join(root, 'src/core/agent.mjs'), 'utf8'),
    fs.readFile(path.join(root, 'src/subagents/manager.mjs'), 'utf8'),
    fs.readFile(path.join(root, 'src/api/server.mjs'), 'utf8'),
  ]);
  const agentContract = extractSection(contracts, 'export type AgentEvent =', 'export interface SessionUsage');
  const apiContract = extractSection(contracts, 'export type ControlApiLifecycleEvent =', 'export type ControlApiRunEvent');

  const declaredAgentEvents = eventNames(agentContract);
  const emittedAgentEvents = new Set([...emittedNames(agent, '#emit'), ...emittedNames(subagents, '#emit')]);
  assert.deepEqual(
    [...emittedAgentEvents].sort(),
    [...declaredAgentEvents].sort(),
    'AgentEvent must match the runtime and subagent emit sites',
  );

  const declaredApiEvents = eventNames(apiContract);
  const emittedApiEvents = new Set([
    ...emittedNames(api, '#publish'),
    ...[...api.matchAll(/#writeEvent\(response,\s*\{[^}]*\btype:\s*'([^']+)'/g)].map((match) => match[1]),
  ]);
  assert.deepEqual([...emittedApiEvents].sort(), [...declaredApiEvents].sort(), 'ControlApiLifecycleEvent must match the API emit sites');
});

test('shared contracts distinguish router results from persisted decisions and cover runtime policy states', async () => {
  const [contracts, router, agent] = await Promise.all([
    fs.readFile(path.join(root, 'src/core/contracts.d.ts'), 'utf8'),
    fs.readFile(path.join(root, 'src/core/router.mjs'), 'utf8'),
    fs.readFile(path.join(root, 'src/core/agent.mjs'), 'utf8'),
  ]);

  assert.match(router, /return\s*\{\s*name,\s*config:\s*model,/);
  assert.match(contracts, /export interface RoutingDecision\s*\{\s*name: string;/);
  assert.match(contracts, /export interface RoutingDecisionRecord\s*\{\s*model: string;/);
  assert.match(agent, /working\.routing_decision\s*=\s*\{\s*model:\s*modelChoice\.name,/);
  assert.match(contracts, /export type ToolPermissionDecision\s*=\s*'allow'\s*\|\s*'require_approval'\s*\|\s*'deny'\s*\|\s*'defer'/);
  const agentRunStatus = contracts.match(/export type AgentRunStatus\s*=([\s\S]*?);/)?.[1];
  assert.ok(agentRunStatus, 'AgentRunStatus must be declared');
  assert.deepEqual([...agentRunStatus.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort(), [
    'budget_exceeded',
    'cancelled',
    'complete',
    'context_overflow',
    'failed',
    'invalid_review_output',
    'max_turns',
  ]);
  assert.deepEqual(
    [...agentRunStatus.matchAll(/'([^']+)'/g)].map((match) => match[1]),
    AGENT_RUN_STATUSES,
  );
  assert.match(contracts, /export type SessionStatus\s*=\s*'active'\s*\|\s*'archived'\s*\|\s*AgentRunStatus/);
  assert.match(contracts, /export type ControlApiRunStatus\s*=\s*'running'\s*\|\s*'paused'\s*\|\s*AgentRunStatus/);
  assert.deepEqual([...SESSION_STATUSES].sort(), ['active', 'archived', ...AGENT_RUN_STATUSES].sort());
  assert.deepEqual([...CONTROL_API_RUN_STATUSES].sort(), ['paused', 'running', ...AGENT_RUN_STATUSES].sort());
  assert.deepEqual([...CONTROL_API_RUN_FAILURE_STATUSES].sort(), ['cancelled', 'failed']);
  assert.match(contracts, /type:\s*'api_run_finished';\s*status:\s*AgentRunStatus/);
  assert.match(contracts, /type:\s*'api_run_failed';\s*status:\s*ControlApiRunFailureStatus/);
  assert.match(contracts, /export interface ControlApiRunState\s*\{[\s\S]*?status:\s*ControlApiRunStatus;/);
  assert.match(contracts, /export interface ControlApiRunRequest\s*\{[\s\S]*?worktree_id\?:\s*string;/);
  assert.match(contracts, /export interface ControlApiErrorResponse\s*\{\s*error:\s*string;\s*code\?:\s*string;/);
  assert.match(contracts, /export interface ControlApiErrorDetails\s*\{\s*code:\s*string;\s*message:\s*string;/);
  assert.match(agent, /decision:\s*'defer'/);
  assert.match(contracts, /export interface ToolApprovalRequest\s*\{[^}]*signal\?: AbortSignal;/s);
  assert.match(contracts, /export interface ToolDefinition\s*\{\s*schema_version: 1;\s*execution: ToolExecutionMetadata;/);
  assert.equal(TOOL_SCHEMA_VERSION, 1);
  assert.ok(Object.values(TOOL_DEFINITIONS).every((definition) => definition.schema_version === TOOL_SCHEMA_VERSION));
});

function extractSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing contract section ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker ${endMarker}`);
  return source.slice(start, end);
}

function eventNames(section) {
  return new Set([...section.matchAll(/\btype:\s*'([^']+)'/g)].map((match) => match[1]));
}

function emittedNames(source, method) {
  const escapedMethod = method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(`this\\.${escapedMethod}\\([^]*?\\{\\s*type:\\s*'([^']+)'`, 'g'))].map((match) => match[1]);
}
