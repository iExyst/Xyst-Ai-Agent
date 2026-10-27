import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { compareEvaluationRuns } from '../src/core/evaluation-comparison.mjs';
import { createTempDirectory } from './helpers.mjs';

test('paired evaluation comparison passes only with measured, policy-clean improvement', () => {
  const baseline = makeRun('baseline', (index) => task(index, false));
  const candidate = makeRun('candidate', (index) => task(index, true));
  const report = compareEvaluationRuns(baseline, candidate);

  assert.equal(report.passed, true);
  assert.equal(report.overall.samples, 30);
  assert.equal(report.overall.success_delta, 1);
  assert.deepEqual(report.overall.confidence_interval_95, [1, 1]);
  assert.equal(report.categories.retrieval.samples, 30);
  assert.equal(report.candidate_policy_violations, 0);
  assert.equal(report.candidate_privacy_violations, 0);
});

test('paired comparison rejects category regression beyond five percentage points', () => {
  const baseline = makeRun('baseline', (index) => task(index, index < 29));
  const candidate = makeRun('candidate', (index) => task(index, index < 26));
  const report = compareEvaluationRuns(baseline, candidate);

  assert.equal(report.passed, false);
  assert.equal(report.categories.retrieval.success_delta, -0.1);
  assert.ok(report.failures.includes('category_regression:retrieval'));
});

test('comparison blocks candidate policy and privacy violations even when task success improves', () => {
  const baseline = makeRun('baseline', (index) => task(index, false));
  const candidate = makeRun('candidate', (index) => ({
    ...task(index, true),
    policy_violations: index === 0 ? 1 : 0,
    privacy_violations: index === 1 ? 1 : 0,
  }));
  const report = compareEvaluationRuns(baseline, candidate);

  assert.equal(report.passed, false);
  assert.equal(report.candidate_policy_violations, 1);
  assert.equal(report.candidate_privacy_violations, 1);
  assert.ok(report.failures.includes('candidate_policy_violations'));
  assert.ok(report.failures.includes('candidate_privacy_violations'));
});

test('comparison requires thirty paired tasks in every category', () => {
  const makeSplitRun = (modelId, success) =>
    makeRun(modelId, (index) => ({
      ...task(index, success),
      category: index < 15 ? 'privacy' : 'tool-use',
    }));
  const report = compareEvaluationRuns(makeSplitRun('baseline', false), makeSplitRun('candidate', true));

  assert.equal(report.passed, false);
  assert.ok(report.failures.includes('category_sample_size:privacy'));
  assert.ok(report.failures.includes('category_sample_size:tool-use'));
});

test('comparison rejects different suites, environments, task pairings, and unsafe extra fields', () => {
  const baseline = makeRun('baseline', (index) => task(index, false));
  const candidate = makeRun('candidate', (index) => task(index, true));

  assert.throws(() => compareEvaluationRuns(baseline, { ...candidate, dataset_version: 'suite-2' }), /same dataset_version/);
  assert.throws(() => compareEvaluationRuns(baseline, { ...candidate, hardware_class: 'other-host' }), /identical hardware_class/);
  assert.throws(
    () => compareEvaluationRuns(baseline, { ...candidate, tasks: candidate.tasks.slice(1).concat(task(30, true)) }),
    /exactly the same task IDs/,
  );
  assert.throws(
    () => compareEvaluationRuns({ ...baseline, tasks: baseline.tasks.map((item) => ({ ...item, prompt: 'private text' })) }, candidate),
    /unsupported fields/,
  );
});

test('paired comparison requires positive overall improvement confidence', () => {
  const sameBaseline = makeRun('baseline', (index) => task(index, index < 25));
  const sameCandidate = makeRun('candidate', (index) => task(index, index < 25));
  const report = compareEvaluationRuns(sameBaseline, sameCandidate);

  assert.equal(report.overall.success_delta, 0);
  assert.deepEqual(report.overall.confidence_interval_95, [0, 0]);
  assert.ok(report.failures.includes('improvement_not_statistically_supported'));
});

test('paired bootstrap intervals are stable when input records are reordered', () => {
  const baseline = makeRun('baseline', (index) => task(index, index % 3 === 0));
  const candidate = makeRun('candidate', (index) => task(index, index % 3 !== 0));
  const first = compareEvaluationRuns(baseline, candidate);
  const reordered = compareEvaluationRuns(
    { ...baseline, tasks: baseline.tasks.toReversed() },
    { ...candidate, tasks: candidate.tasks.toReversed() },
  );

  assert.deepEqual(reordered.overall.confidence_interval_95, first.overall.confidence_interval_95);
  assert.deepEqual(reordered.categories, first.categories);
});

test('evaluation comparison CLI emits only the aggregate report and returns its threshold status', async () => {
  const directory = await createTempDirectory('xyst-eval-compare-');
  const baseline = makeRun('baseline', (index) => task(index, false));
  const candidate = makeRun('candidate', (index) => task(index, true));
  const baselinePath = path.join(directory, 'baseline.json');
  const candidatePath = path.join(directory, 'candidate.json');
  await Promise.all([fs.writeFile(baselinePath, JSON.stringify(baseline)), fs.writeFile(candidatePath, JSON.stringify(candidate))]);
  const script = path.resolve('scripts/compare-evaluations.mjs');
  const result = spawnSync(process.execPath, [script, baselinePath, candidatePath, '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.passed, true);
  assert.equal(report.overall.success_delta, 1);
  assert.equal(result.stdout.includes('prompt'), false);

  const unchanged = makeRun('candidate', (index) => task(index, false));
  await fs.writeFile(candidatePath, JSON.stringify(unchanged));
  const rejected = spawnSync(process.execPath, [script, baselinePath, candidatePath, '--json'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).passed, false);
});

function makeRun(modelId, makeTask) {
  return {
    schema_version: 1,
    dataset_version: 'synthetic-2026-10-22.1',
    model_id: modelId,
    runtime_version: '0.1.0',
    server_version: 'lm-studio-test',
    platform: 'win32-x64',
    hardware_class: 'test-host-class',
    settings_id: 'temp-0-seed-7',
    tasks: Array.from({ length: 30 }, (_, index) => makeTask(index)),
  };
}

function task(index, success) {
  return {
    id: `task-${String(index).padStart(2, '0')}`,
    category: 'retrieval',
    success,
    policy_violations: 0,
    privacy_violations: 0,
  };
}
