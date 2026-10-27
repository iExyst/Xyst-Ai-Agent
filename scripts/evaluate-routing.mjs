import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateRoutingCases, formatMismatch, validateRoutingDataset } from '../src/core/routing-evaluation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const datasetPath = path.resolve(root, process.argv[2] || 'eval/routing-cases.json');
let dataset;
try {
  dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
} catch (error) {
  process.stderr.write(`Could not read routing evaluation dataset '${datasetPath}': ${error.message}\n`);
  process.exitCode = 2;
  process.exit();
}

try {
  validateRoutingDataset(dataset);
  const report = evaluateRoutingCases(dataset.cases);
  process.stdout.write(
    `Routing evaluation ${dataset.dataset_version}: ${report.passed}/${report.total} passed (${(report.accuracy * 100).toFixed(1)}%)\n`,
  );
  for (const [category, metrics] of Object.entries(report.by_category)) {
    process.stdout.write(`  ${category}: ${metrics.passed}/${metrics.total} (${(metrics.accuracy * 100).toFixed(1)}%)\n`);
  }
  if (report.classifier_comparison) {
    const comparison = report.classifier_comparison;
    process.stdout.write(
      `Classifier vs deterministic baseline: ${comparison.improved} improved, ${comparison.regressed} regressed, ${comparison.unchanged} unchanged (${comparison.total} cases; ${(comparison.classifier_accuracy * 100).toFixed(1)}% vs ${(comparison.baseline_accuracy * 100).toFixed(1)}%).\n`,
    );
  }
  for (const result of report.results.filter((item) => !item.passed)) process.stderr.write(`FAIL ${formatMismatch(result)}\n`);
  if (report.failed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Invalid routing evaluation dataset: ${error.message}\n`);
  process.exitCode = 2;
}
