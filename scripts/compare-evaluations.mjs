import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareEvaluationRuns } from '../src/core/evaluation-comparison.mjs';

const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const jsonOutput = args.includes('--json');
const files = args.filter((argument) => argument !== '--json');

if (files.length !== 2) {
  process.stderr.write('Usage: pnpm eval:compare -- <baseline.json> <candidate.json> [--json]\n');
  process.exit(2);
}

try {
  const [baseline, candidate] = await Promise.all(files.map((file) => readRun(path.resolve(root, file))));
  const report = compareEvaluationRuns(baseline, candidate);
  if (jsonOutput) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(
      `Evaluation comparison ${report.dataset_version}: ${report.baseline_model_id} → ${report.candidate_model_id}; ` +
        `${report.overall.samples} paired tasks; success delta ${(report.overall.success_delta * 100).toFixed(1)} pp ` +
        `(95% CI ${(report.overall.confidence_interval_95[0] * 100).toFixed(1)} to ${(report.overall.confidence_interval_95[1] * 100).toFixed(1)} pp); ` +
        `${report.candidate_policy_violations} policy and ${report.candidate_privacy_violations} privacy violations; ` +
        `${report.passed ? 'promotion thresholds passed' : `thresholds failed: ${report.failures.join(', ')}`}\n`,
    );
    for (const [category, metrics] of Object.entries(report.categories)) {
      process.stdout.write(
        `  ${category}: ${metrics.samples} paired; ${(metrics.baseline_success_rate * 100).toFixed(1)}% → ` +
          `${(metrics.candidate_success_rate * 100).toFixed(1)}% ` +
          `(95% CI ${(metrics.confidence_interval_95[0] * 100).toFixed(1)} to ${(metrics.confidence_interval_95[1] * 100).toFixed(1)} pp)\n`,
      );
    }
  }
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Evaluation comparison failed: ${error.message}\n`);
  process.exitCode = 2;
}

async function readRun(file) {
  const info = await fs.stat(file);
  if (!info.isFile() || info.size > MAX_REPORT_BYTES) throw new Error('Evaluation report must be a regular file no larger than 4 MiB');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
