import { AgentRuntime } from './agent.mjs';
import { SessionStore } from '../session/store.mjs';
import { parseReviewFindings } from '../architect/review-schema.mjs';
import { validateRunBudgetChange } from './budgets.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

/** Runs deterministic agent scenarios without contacting an external provider. */
export async function evaluateAgentScenarios(dataset, { workspaceFactory, runtimeFactory = (options) => new AgentRuntime(options) } = {}) {
  if (dataset?.schema_version !== 1 || !Array.isArray(dataset.scenarios) || dataset.scenarios.length === 0)
    throw new TypeError('Agent evaluation dataset must use schema_version 1 and contain scenarios');
  if (typeof workspaceFactory !== 'function') throw new TypeError('Agent evaluation requires a workspaceFactory');
  const ids = new Set();
  for (const [index, scenario] of dataset.scenarios.entries()) {
    validateScenario(scenario, index);
    if (ids.has(scenario.id)) throw new TypeError(`Duplicate agent evaluation scenario id '${scenario.id}'`);
    ids.add(scenario.id);
  }
  const results = [];
  for (const scenario of dataset.scenarios) {
    results.push(await runScenario(scenario, workspaceFactory, runtimeFactory));
  }
  const passed = results.filter((result) => result.passed).length;
  const successful = results.filter((result) => result.status === 'complete').length;
  const modelCalls = results.reduce((sum, result) => sum + result.model_calls, 0);
  const toolCalls = results.reduce((sum, result) => sum + result.tool_calls, 0);
  const toolDenials = results.reduce((sum, result) => sum + result.tool_denials, 0);
  const inputTokens = sumKnown(results.map((result) => result.input_tokens));
  const outputTokens = sumKnown(results.map((result) => result.output_tokens));
  const estimatedCost = sumKnown(results.map((result) => result.estimated_cost_usd));
  const categories = Object.create(null);
  for (const result of results) {
    const category = (categories[result.category] ||= { total: 0, passed: 0 });
    category.total += 1;
    if (result.passed) category.passed += 1;
  }
  return {
    schema_version: 1,
    dataset_version: dataset.dataset_version,
    total: results.length,
    passed,
    failed: results.length - passed,
    success_rate: successful / results.length,
    task_success_rate: passed / results.length,
    model_calls: modelCalls,
    tool_calls: toolCalls,
    tool_denials: toolDenials,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    estimated_cost_usd: estimatedCost,
    scenarios_with_cost_estimate: results.filter((result) => result.estimated_cost_usd !== null).length,
    average_latency_ms: results.reduce((sum, result) => sum + result.duration_ms, 0) / results.length,
    by_category: Object.fromEntries(
      Object.entries(categories)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([category, metrics]) => [category, { ...metrics, accuracy: metrics.passed / metrics.total }]),
    ),
    results,
  };
}

async function runScenario(scenario, workspaceFactory, runtimeFactory) {
  const { workspaceRoot, stateRoot = workspaceRoot } = await workspaceFactory(scenario);
  const calls = [];
  const events = [];
  const cancellationController = scenario.cancel_after_tool ? new AbortController() : null;
  let cancellationTriggered = false;
  let fixtureIndex = 0;
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    const fixture = scenario.responses[fixtureIndex++];
    if (!fixture) throw new Error('Scenario fixture exhausted before the agent completed');
    return Response.json({
      choices: [
        {
          message: {
            role: 'assistant',
            content: fixture.content,
            ...(fixture.tool_calls?.length
              ? {
                  tool_calls: fixture.tool_calls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  })),
                }
              : {}),
          },
          ...(fixture.tool_calls?.length ? { finish_reason: 'tool_calls' } : {}),
        },
      ],
      ...(fixture.usage ? { usage: fixture.usage } : {}),
    });
  };
  const config = {
    default_model: 'evaluation-model',
    models: {
      'evaluation-model': {
        provider: 'openai-compatible',
        base_url: 'http://127.0.0.1/evaluation-fixture',
        model: scenario.model || 'evaluation-model',
        local: true,
        supports_tools: scenario.responses.some((fixture) => fixture.tool_calls?.length),
        context_length: 32768,
        input_cost_per_million: scenario.input_cost_per_million,
        output_cost_per_million: scenario.output_cost_per_million,
      },
    },
    budgets: {
      max_turns: Math.max(1, scenario.responses.length),
      max_input_tokens: 32768,
      max_output_tokens: 4096,
      ...scenario.budgets,
    },
    tools: { autonomy: 'assisted' },
  };
  const runtime = runtimeFactory({
    config,
    workspaceRoot,
    stateRoot,
    sessionStore: new SessionStore(stateRoot),
    fetchImpl,
    onEvent: (event) => {
      events.push(event);
      if (cancellationController && !cancellationTriggered && event.type === 'tool_finished' && event.tool === scenario.cancel_after_tool) {
        cancellationTriggered = true;
        cancellationController.abort();
      }
    },
  });
  const started = performance.now();
  try {
    const result = await runtime.run({
      prompt: scenario.prompt,
      mode: scenario.mode || 'agent',
      signal: cancellationController?.signal,
      approveTool: async ({ tool }) => scenario.approved_tools?.includes(tool.name) === true,
    });
    const durationMs = performance.now() - started;
    const text = result.session.messages.filter((message) => message.role === 'assistant').at(-1)?.content || '';
    const usage = result.session.usage || {};
    const actualModel = result.session.model || null;
    const status = result.status;
    const modelCallCheckPassed = scenario.expected_model_calls === undefined || calls.length === scenario.expected_model_calls;
    const cancellationCheckPassed = scenario.cancel_after_tool === undefined || cancellationTriggered;
    const planCheckPassed = scenario.expected_plan === undefined || result.session.plan === scenario.expected_plan;
    const reviewFindingsCheckPassed =
      scenario.expected_review_findings === undefined ||
      isDeepStrictEqual(result.session.review_findings, scenario.expected_review_findings);
    const modeChecksPassed = planCheckPassed && reviewFindingsCheckPassed;
    const toolObservations = result.session.messages.filter((message) => message.role === 'tool').map((message) => message.content);
    const observationChecksPassed = (scenario.expected_tool_observation_contains || []).every((fragment) =>
      toolObservations.some((content) => content.includes(fragment)),
    );
    const passed =
      status === scenario.expected_status &&
      actualModel === (scenario.expected_model || 'evaluation-model') &&
      modelCallCheckPassed &&
      cancellationCheckPassed &&
      scenario.expected_contains.every((fragment) => text.includes(fragment)) &&
      modeChecksPassed &&
      observationChecksPassed;
    const executedTools = events.filter((event) => event.type === 'tool_finished').map((event) => event.tool);
    const denied = events.filter((event) => event.type === 'tool_denied').length;
    const expectedTools = scenario.expected_tools || [];
    const toolChecksPassed = JSON.stringify(executedTools) === JSON.stringify(expectedTools);
    const denialChecksPassed = scenario.expected_tool_denials === undefined || denied === scenario.expected_tool_denials;
    const responseChecksPassed = scenario.expected_contains.every((fragment) => text.includes(fragment));
    const fileChecks = await checkExpectedFiles(workspaceRoot, scenario.expected_files || {});
    const fixturesConsumed = fixtureIndex === scenario.responses.length;
    return {
      id: scenario.id,
      category: scenario.category,
      passed: passed && toolChecksPassed && denialChecksPassed && fileChecks.passed === fileChecks.total && fixturesConsumed,
      status,
      expected_status: scenario.expected_status,
      model: actualModel,
      model_calls: calls.length,
      model_call_check_passed: modelCallCheckPassed,
      cancellation_triggered: cancellationTriggered,
      cancellation_check_passed: cancellationCheckPassed,
      tool_calls: executedTools.length,
      tool_denials: denied,
      plan_check_passed: planCheckPassed,
      review_findings_check_passed: reviewFindingsCheckPassed,
      mode_checks_passed: modeChecksPassed,
      observation_checks_passed: observationChecksPassed,
      input_tokens: nullableNonnegative(usage.input_tokens),
      output_tokens: nullableNonnegative(usage.output_tokens),
      estimated_cost_usd: nullableNonnegative(usage.estimated_cost),
      duration_ms: Math.round(durationMs * 100) / 100,
      response_checks_passed: scenario.expected_contains.filter((fragment) => text.includes(fragment)).length,
      response_checks_total: scenario.expected_contains.length,
      tool_checks_passed: toolChecksPassed,
      tool_denial_checks_passed: denialChecksPassed,
      file_checks_passed: fileChecks.passed,
      file_checks_total: fileChecks.total,
      fixture_responses_used: fixtureIndex,
      fixture_responses_expected: scenario.responses.length,
      ...(passed && toolChecksPassed && denialChecksPassed && fileChecks.passed === fileChecks.total && fixturesConsumed
        ? {}
        : {
            failure: failureReason({
              result,
              scenario,
              actualModel,
              modelCallCheckPassed,
              cancellationCheckPassed,
              responseChecksPassed,
              toolChecksPassed,
              denialChecksPassed,
              modeChecksPassed,
              observationChecksPassed,
              fileChecksPassed: fileChecks.passed === fileChecks.total,
              fixturesConsumed,
            }),
          }),
    };
  } finally {
    await runtime.close();
  }
}

function failureReason({
  result,
  scenario,
  actualModel,
  modelCallCheckPassed,
  cancellationCheckPassed,
  responseChecksPassed,
  toolChecksPassed,
  denialChecksPassed,
  modeChecksPassed,
  observationChecksPassed,
  fileChecksPassed,
  fixturesConsumed,
}) {
  if (result.status !== scenario.expected_status) return `status_mismatch:${result.status}`;
  if (actualModel !== (scenario.expected_model || 'evaluation-model')) return 'model_mismatch';
  if (!modelCallCheckPassed) return 'model_call_count_mismatch';
  if (!cancellationCheckPassed) return 'cancellation_trigger_not_reached';
  if (!responseChecksPassed) return 'response_check_failed';
  if (!toolChecksPassed) return 'tool_check_failed';
  if (!denialChecksPassed) return 'tool_denial_check_failed';
  if (!modeChecksPassed) return 'mode_state_check_failed';
  if (!observationChecksPassed) return 'observation_check_failed';
  if (!fileChecksPassed) return 'file_check_failed';
  if (!fixturesConsumed) return 'unused_response_fixtures';
  return 'unknown';
}

function validateScenario(scenario, index) {
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario))
    throw new TypeError(`Agent evaluation scenario ${index} must be an object`);
  if (typeof scenario.id !== 'string' || !scenario.id.trim()) throw new TypeError(`Agent evaluation scenario ${index} needs an id`);
  if (typeof scenario.category !== 'string' || !scenario.category.trim()) throw new TypeError(`Scenario '${scenario.id}' needs a category`);
  for (const [field, value] of [
    ['id', scenario.id],
    ['category', scenario.category],
  ])
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))
      throw new TypeError(`Scenario '${scenario.id}' ${field} must be a short identifier`);
  if (
    scenario.expected_model !== undefined &&
    (typeof scenario.expected_model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scenario.expected_model))
  )
    throw new TypeError(`Scenario '${scenario.id}' expected_model must be a short model identifier`);
  if (typeof scenario.prompt !== 'string' || !scenario.prompt.trim()) throw new TypeError(`Scenario '${scenario.id}' needs a prompt`);
  if (scenario.mode !== undefined && !['agent', 'plan', 'review'].includes(scenario.mode))
    throw new TypeError(`Scenario '${scenario.id}' mode must be agent, plan, or review`);
  if (!['complete', 'failed', 'cancelled', 'budget_exceeded', 'max_turns', 'context_overflow'].includes(scenario.expected_status))
    throw new TypeError(`Scenario '${scenario.id}' has an invalid expected_status`);
  if (!Array.isArray(scenario.expected_contains) || scenario.expected_contains.some((item) => typeof item !== 'string'))
    throw new TypeError(`Scenario '${scenario.id}' expected_contains must be an array of strings`);
  if (
    scenario.expected_model_calls !== undefined &&
    (!Number.isSafeInteger(scenario.expected_model_calls) || scenario.expected_model_calls < 0)
  )
    throw new TypeError(`Scenario '${scenario.id}' expected_model_calls must be a non-negative integer`);
  if (scenario.expected_plan !== undefined && (typeof scenario.expected_plan !== 'string' || scenario.mode !== 'plan'))
    throw new TypeError(`Scenario '${scenario.id}' expected_plan requires plan mode and a string value`);
  if (scenario.expected_review_findings !== undefined) {
    if (scenario.mode !== 'review' || !Array.isArray(scenario.expected_review_findings))
      throw new TypeError(`Scenario '${scenario.id}' expected_review_findings requires review mode and an array`);
    const normalized = parseReviewFindings(JSON.stringify(scenario.expected_review_findings));
    if (!normalized || !isDeepStrictEqual(normalized, scenario.expected_review_findings))
      throw new TypeError(`Scenario '${scenario.id}' expected_review_findings must contain valid normalized findings`);
  }
  if (
    scenario.expected_tool_observation_contains !== undefined &&
    (!Array.isArray(scenario.expected_tool_observation_contains) ||
      scenario.expected_tool_observation_contains.some((item) => typeof item !== 'string' || !item))
  )
    throw new TypeError(`Scenario '${scenario.id}' expected_tool_observation_contains must be an array of non-empty strings`);
  if (
    scenario.expected_tools !== undefined &&
    (!Array.isArray(scenario.expected_tools) || scenario.expected_tools.some((item) => typeof item !== 'string'))
  )
    throw new TypeError(`Scenario '${scenario.id}' expected_tools must be an array of strings`);
  if (
    scenario.cancel_after_tool !== undefined &&
    (typeof scenario.cancel_after_tool !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(scenario.cancel_after_tool) ||
      scenario.expected_status !== 'cancelled' ||
      !scenario.expected_tools?.includes(scenario.cancel_after_tool))
  )
    throw new TypeError(`Scenario '${scenario.id}' cancel_after_tool requires a named expected tool and cancelled status`);
  for (const field of ['files', 'expected_files']) validateRelativeFiles(scenario, field);
  if (scenario.budgets !== undefined) {
    try {
      validateRunBudgetChange(scenario.budgets);
    } catch (error) {
      throw new TypeError(`Scenario '${scenario.id}' budgets are invalid: ${error.message}`);
    }
  }
  if (
    scenario.expected_tool_denials !== undefined &&
    (!Number.isSafeInteger(scenario.expected_tool_denials) || scenario.expected_tool_denials < 0)
  )
    throw new TypeError(`Scenario '${scenario.id}' expected_tool_denials must be a non-negative integer`);
  if (
    scenario.approved_tools !== undefined &&
    (!Array.isArray(scenario.approved_tools) ||
      scenario.approved_tools.some((name) => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(name)) ||
      new Set(scenario.approved_tools).size !== scenario.approved_tools.length)
  )
    throw new TypeError(`Scenario '${scenario.id}' approved_tools must be an array of unique tool names`);
  if (!Array.isArray(scenario.responses) || scenario.responses.some((item) => !item || typeof item.content !== 'string'))
    throw new TypeError(`Scenario '${scenario.id}' needs at least one response fixture with string content`);
  for (const key of ['input_cost_per_million', 'output_cost_per_million'])
    if (scenario[key] !== undefined && (typeof scenario[key] !== 'number' || !Number.isFinite(scenario[key]) || scenario[key] < 0))
      throw new TypeError(`Scenario '${scenario.id}' ${key} must be a non-negative finite number`);
}

function validateRelativeFiles(scenario, field) {
  const files = scenario[field];
  if (
    files !== undefined &&
    (!files ||
      typeof files !== 'object' ||
      Array.isArray(files) ||
      Object.entries(files).some(
        ([file, contents]) =>
          !file ||
          typeof contents !== 'string' ||
          /[\u0000-\u001f]/.test(file) ||
          path.isAbsolute(file) ||
          /^[A-Za-z]:/.test(file) ||
          file.split(/[\\/]/).includes('..'),
      ))
  )
    throw new TypeError(`Scenario '${scenario.id}' ${field} must map safe relative paths to strings`);
}

async function checkExpectedFiles(workspaceRoot, expectedFiles) {
  let passed = 0;
  for (const [relativePath, expectedContents] of Object.entries(expectedFiles)) {
    const target = path.resolve(workspaceRoot, relativePath);
    const relativeTarget = path.relative(workspaceRoot, target);
    if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget))
      continue;
    try {
      if ((await fs.readFile(target, 'utf8')) === expectedContents) passed += 1;
    } catch {
      // Missing or unreadable expected files fail this scenario assertion.
    }
  }
  return { passed, total: Object.keys(expectedFiles).length };
}

function nullableNonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function sumKnown(values) {
  const known = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}
