import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAgentScenarios } from '../src/core/agent-evaluation.mjs';
import { createTempDirectory } from './helpers.mjs';

test('agent evaluation runs deterministic fixtures and reports privacy-safe quality and usage metrics', async (t) => {
  const root = await createTempDirectory('xyst-agent-eval-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await evaluateAgentScenarios(
    {
      schema_version: 1,
      dataset_version: 'test.1',
      scenarios: [
        {
          id: 'answer',
          category: 'simple',
          prompt: 'private evaluation prompt',
          expected_status: 'complete',
          expected_contains: ['expected answer'],
          input_cost_per_million: 1,
          output_cost_per_million: 2,
          responses: [
            {
              content: 'expected answer',
              usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            },
          ],
        },
      ],
    },
    { workspaceFactory: async () => ({ workspaceRoot: root }) },
  );
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.success_rate, 1);
  assert.equal(report.task_success_rate, 1);
  assert.equal(report.input_tokens, 10);
  assert.equal(report.output_tokens, 3);
  assert.ok(Math.abs(report.estimated_cost_usd - 0.000016) < 1e-12);
  assert.equal(report.results[0].model_calls, 1);
  assert.equal(report.results[0].response_checks_passed, 1);
  assert.equal(report.tool_calls, 0);
  assert.doesNotMatch(JSON.stringify(report), /private evaluation prompt|expected answer/);
});

test('agent evaluation verifies the actual tool execution sequence', async (t) => {
  const root = await createTempDirectory('xyst-agent-eval-tool-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'NOTES.md'), 'sandbox startup validated');
  const report = await evaluateAgentScenarios(
    {
      schema_version: 1,
      scenarios: [
        {
          id: 'read-project-note',
          category: 'retrieval',
          prompt: 'Read NOTES.md and report its main fact.',
          expected_status: 'complete',
          expected_contains: ['sandbox startup validated'],
          expected_tools: ['read_file'],
          responses: [
            { content: '', tool_calls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'NOTES.md' } }] },
            { content: 'The note says sandbox startup validated.' },
          ],
        },
      ],
    },
    { workspaceFactory: async () => ({ workspaceRoot: root }) },
  );
  assert.equal(report.passed, 1);
  assert.equal(report.tool_calls, 1);
  assert.deepEqual(report.results[0].tool_checks_passed, true);
  assert.equal(report.results[0].tool_denials, 0);
});

test('agent evaluation approves a configured edit and verifies the resulting file content', async (t) => {
  const root = await createTempDirectory('xyst-agent-eval-approved-edit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'settings.txt'), 'enabled=true\n');
  const report = await evaluateAgentScenarios(
    {
      schema_version: 1,
      scenarios: [
        {
          id: 'approved-edit',
          category: 'approval-and-edit',
          prompt: 'Update the setting.',
          expected_status: 'complete',
          expected_contains: ['enabled=false'],
          expected_tools: ['edit_file'],
          approved_tools: ['edit_file'],
          expected_files: { 'settings.txt': 'enabled=false\n' },
          responses: [
            {
              content: '',
              tool_calls: [
                {
                  id: 'edit-1',
                  name: 'edit_file',
                  arguments: { path: 'settings.txt', old_string: 'enabled=true', new_string: 'enabled=false' },
                },
              ],
            },
            { content: 'The setting is now enabled=false.' },
          ],
        },
      ],
    },
    { workspaceFactory: async () => ({ workspaceRoot: root }) },
  );
  assert.equal(report.passed, 1);
  assert.equal(report.results[0].tool_checks_passed, true);
  assert.equal(report.results[0].file_checks_passed, 1);
  assert.equal(report.results[0].tool_denials, 0);
  assert.equal(await fs.readFile(path.join(root, 'settings.txt'), 'utf8'), 'enabled=false\n');
});

test('agent evaluation verifies denied edits leave workspace content unchanged', async (t) => {
  const root = await createTempDirectory('xyst-agent-eval-denied-edit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'settings.txt'), 'mode=safe\n');
  const report = await evaluateAgentScenarios(
    {
      schema_version: 1,
      scenarios: [
        {
          id: 'denied-edit',
          category: 'approval-denial',
          prompt: 'Change mode to unsafe.',
          expected_status: 'complete',
          expected_contains: ['unchanged'],
          expected_tools: [],
          expected_tool_denials: 1,
          expected_files: { 'settings.txt': 'mode=safe\n' },
          responses: [
            {
              content: '',
              tool_calls: [
                {
                  id: 'edit-1',
                  name: 'edit_file',
                  arguments: { path: 'settings.txt', old_string: 'mode=safe', new_string: 'mode=unsafe' },
                },
              ],
            },
            { content: 'The requested edit was denied, and the file is unchanged.' },
          ],
        },
      ],
    },
    { workspaceFactory: async () => ({ workspaceRoot: root }) },
  );
  assert.equal(report.passed, 1);
  assert.equal(report.results[0].tool_denials, 1);
  assert.equal(report.results[0].tool_denial_checks_passed, true);
  assert.equal(report.results[0].file_checks_passed, 1);
  assert.equal(await fs.readFile(path.join(root, 'settings.txt'), 'utf8'), 'mode=safe\n');
});

test('agent evaluation rejects duplicate scenario IDs and unsupported dataset versions', async () => {
  await assert.rejects(
    evaluateAgentScenarios({ schema_version: 2, scenarios: [] }, { workspaceFactory: async () => ({ workspaceRoot: '.' }) }),
    /schema_version 1/,
  );
  const duplicate = {
    schema_version: 1,
    scenarios: [
      { id: 'same', category: 'x', prompt: 'a', expected_status: 'complete', expected_contains: [], responses: [{ content: 'a' }] },
      { id: 'same', category: 'x', prompt: 'b', expected_status: 'complete', expected_contains: [], responses: [{ content: 'b' }] },
    ],
  };
  await assert.rejects(
    evaluateAgentScenarios(duplicate, { workspaceFactory: async () => ({ workspaceRoot: path.resolve('.') }) }),
    /Duplicate agent evaluation scenario id/,
  );
});

test('agent evaluation marks unused provider fixtures as a dataset failure', async (t) => {
  const root = await createTempDirectory('xyst-agent-eval-unused-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const report = await evaluateAgentScenarios(
    {
      schema_version: 1,
      scenarios: [
        {
          id: 'unused-fixture',
          category: 'fixture-integrity',
          prompt: 'Return done.',
          expected_status: 'complete',
          expected_contains: ['done'],
          responses: [{ content: 'done' }, { content: 'this must not be silently ignored' }],
        },
      ],
    },
    { workspaceFactory: async () => ({ workspaceRoot: root }) },
  );
  assert.equal(report.failed, 1);
  assert.equal(report.results[0].failure, 'unused_response_fixtures');
});

test('versioned agent evaluation dataset covers coding, modes, and untrusted workspace content', async (t) => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dataset = JSON.parse(await fs.readFile(path.join(repoRoot, 'eval/agent-scenarios.json'), 'utf8'));
  const tempRoot = await createTempDirectory('xyst-agent-dataset-');
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const report = await evaluateAgentScenarios(dataset, {
    workspaceFactory: async (scenario) => {
      const workspaceRoot = path.join(tempRoot, scenario.id);
      await fs.mkdir(workspaceRoot, { recursive: true });
      for (const [relativePath, contents] of Object.entries(scenario.files || {})) {
        const target = path.resolve(workspaceRoot, relativePath);
        assert.ok(target.startsWith(`${workspaceRoot}${path.sep}`), `unsafe dataset path: ${relativePath}`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, contents, { flag: 'wx' });
      }
      return { workspaceRoot };
    },
  });

  assert.equal(report.dataset_version, '2026-10-25.2');
  assert.equal(report.total, 14);
  assert.equal(report.passed, report.total, JSON.stringify(report.results.filter((result) => !result.passed)));
  assert.equal(report.by_category['multi-file-coding'].passed, 1);
  assert.equal(report.by_category['budget-control'].passed, 1);
  assert.equal(report.by_category.cancellation.passed, 1);
  assert.equal(report.by_category['plan-mode'].passed, 1);
  assert.equal(report.by_category.retrieval.passed, 2);
  assert.equal(report.by_category['review-mode'].passed, 2);
  assert.equal(report.by_category['prompt-injection'].passed, 1);
  assert.equal(report.results.find((result) => result.id === 'plan-mode-persists-inspected-implementation-plan').plan_check_passed, true);
  assert.equal(report.results.find((result) => result.id === 'review-mode-persists-validated-evidence').review_findings_check_passed, true);
  assert.equal(
    report.results.find((result) => result.id === 'review-mode-structured-object-checks-boundary-contract').review_findings_check_passed,
    true,
  );
  const retrievalResult = report.results.find((result) => result.id === 'multi-file-retrieval-follows-import-to-configured-limit');
  assert.equal(retrievalResult.observation_checks_passed, true);
  assert.equal(retrievalResult.tool_checks_passed, true);
  assert.equal(retrievalResult.model_calls, 4);
  assert.equal(
    report.results.find((result) => result.id === 'workspace-injection-remains-untrusted-and-write-is-denied').observation_checks_passed,
    true,
  );
  const budgetResult = report.results.find((result) => result.id === 'session-cost-budget-blocks-provider-call');
  assert.equal(budgetResult.model_calls, 0);
  assert.equal(budgetResult.model_call_check_passed, true);
  const cancellationResult = report.results.find((result) => result.id === 'cancel-after-read-prevents-next-model-turn');
  assert.equal(cancellationResult.status, 'cancelled');
  assert.equal(cancellationResult.model_calls, 1);
  assert.equal(cancellationResult.cancellation_triggered, true);
  assert.equal(cancellationResult.file_checks_passed, 1);
});

test('agent evaluation rejects unsafe file assertions and invalid approval expectations', async () => {
  const base = {
    schema_version: 1,
    scenarios: [
      {
        id: 'invalid-assertion',
        category: 'validation',
        prompt: 'Check a fixture.',
        expected_status: 'complete',
        expected_contains: [],
        responses: [{ content: 'done' }],
      },
    ],
  };
  await assert.rejects(
    evaluateAgentScenarios(
      { ...base, scenarios: [{ ...base.scenarios[0], expected_files: { '../outside.txt': 'bad' } }] },
      { workspaceFactory: async () => ({ workspaceRoot: path.resolve('.') }) },
    ),
    /expected_files must map safe relative paths/,
  );
  await assert.rejects(
    evaluateAgentScenarios(
      { ...base, scenarios: [{ ...base.scenarios[0], expected_tool_denials: -1 }] },
      { workspaceFactory: async () => ({ workspaceRoot: path.resolve('.') }) },
    ),
    /expected_tool_denials must be a non-negative integer/,
  );
  await assert.rejects(
    evaluateAgentScenarios(
      { ...base, scenarios: [{ ...base.scenarios[0], approved_tools: ['edit_file', 'edit_file'] }] },
      { workspaceFactory: async () => ({ workspaceRoot: path.resolve('.') }) },
    ),
    /approved_tools must be an array of unique tool names/,
  );
  await assert.rejects(
    evaluateAgentScenarios(
      { ...base, scenarios: [{ ...base.scenarios[0], budgets: { unsupported_limit: 1 } }] },
      { workspaceFactory: async () => ({ workspaceRoot: path.resolve('.') }) },
    ),
    /budgets are invalid: budgets\.unsupported_limit is not a supported setting/,
  );
  await assert.rejects(
    evaluateAgentScenarios(
      { ...base, scenarios: [{ ...base.scenarios[0], expected_model_calls: -1 }] },
      { workspaceFactory: async () => ({ workspaceRoot: path.resolve('.') }) },
    ),
    /expected_model_calls must be a non-negative integer/,
  );
});
