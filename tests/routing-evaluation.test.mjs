import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateRoutingCases, validateRoutingDataset } from '../src/core/routing-evaluation.mjs';
import { selectModel } from '../src/core/router.mjs';

const datasetPath = path.join(process.cwd(), 'eval', 'routing-cases.json');

test('routing evaluation dataset measures expected strategies and reports per-category accuracy', async () => {
  const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
  assert.equal(validateRoutingDataset(dataset), dataset);
  assert.equal(dataset.schema_version, 1);
  assert.match(dataset.dataset_version, /^\d{4}-\d{2}-\d{2}\.\d+$/);
  const report = evaluateRoutingCases(dataset.cases);
  assert.equal(report.total, 26);
  assert.equal(report.passed, 26);
  assert.equal(report.failed, 0);
  assert.equal(report.accuracy, 1);
  assert.equal(report.by_category.cost.accuracy, 1);
  assert.equal(report.results.find((item) => item.id === 'everyday-find-file-version-requires-tools').required_tools, true);
  assert.equal(report.results.find((item) => item.id === 'everyday-configuration-question-does-not-require-tools').required_tools, false);
  assert.equal(report.results.find((item) => item.id === 'classifier-routes-xyst-agent-problem-to-quality').selected_model, 'strong');
  assert.equal(
    report.results.find((item) => item.id === 'quality-routing-prefers-code-specialist-when-scores-are-unknown').selected_model,
    'coder',
  );
  assert.equal(report.results.find((item) => item.id === 'local-preference-precedes-quality-fallback').selected_model, 'local');
  const codeSpecialistDecision = selectModel(
    {
      default_model: 'general',
      models: {
        general: { model: 'qwen3-4b-instruct', local: true, supports_tools: true },
        coder: { model: 'qwen3-coder-30b-instruct', local: true, supports_tools: true },
      },
    },
    { taskType: 'agent', requireTools: true, taskPrompt: 'Fix this coding issue in the project.' },
  );
  assert.match(codeSpecialistDecision.reason, /code-specialized profile won an equal-score tie/);
  const explicitRatingDecision = selectModel(
    {
      default_model: 'coder',
      models: {
        general: { model: 'qwen3-4b-instruct', local: true, supports_tools: true, coding_strength: 10, tool_calling_quality: 10 },
        coder: { model: 'qwen3-coder-30b-instruct', local: true, supports_tools: true, coding_strength: 5, tool_calling_quality: 5 },
      },
    },
    { taskType: 'agent', requireTools: true, taskPrompt: 'Fix this coding issue in the project.' },
  );
  assert.equal(explicitRatingDecision.name, 'general', 'Configured quality ratings take precedence over model-name hints');
  const neutralDecision = selectModel(
    {
      default_model: 'general',
      models: {
        general: { model: 'qwen3-4b-instruct', local: true, supports_tools: true },
        coder: { model: 'qwen3-coder-30b-instruct', local: true, supports_tools: true },
      },
    },
    { taskType: 'agent', requireTools: true, taskPrompt: 'Tell me about this setting.' },
  );
  assert.equal(neutralDecision.name, 'general', 'Neutral requests retain the configured default');
});

test('routing evaluation dataset validation rejects missing versions and empty cases', () => {
  assert.throws(() => validateRoutingDataset([]), /versioned routing dataset/);
  assert.throws(() => validateRoutingDataset({ schema_version: 1, dataset_version: 'invalid', cases: [{}] }), /versioned routing dataset/);
  assert.throws(() => validateRoutingDataset({ schema_version: 1, dataset_version: '2026-10-24.1', cases: [] }), /non-empty array/);
});

test('routing evaluation returns mismatches and fails closed on malformed or duplicate cases', () => {
  const base = { id: 'case', category: 'quality', expected_model: 'expected', config: { models: { actual: {} } } };
  const report = evaluateRoutingCases([base]);
  assert.equal(report.failed, 1);
  assert.equal(report.results[0].selected_model, 'actual');
  assert.throws(() => evaluateRoutingCases([base, base]), /Duplicate/);
  assert.throws(() => evaluateRoutingCases([{ ...base, config: {} }]), /model profiles/);
  assert.throws(() => evaluateRoutingCases([]), /non-empty/);
});
