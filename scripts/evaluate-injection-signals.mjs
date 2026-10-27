import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectUntrustedContent, INJECTION_SIGNAL_VERSION } from '../src/core/injection-signals.mjs';

const root = path.resolve(import.meta.dirname, '..');
const datasetPath = path.join(root, 'eval', 'injection-signal-cases.json');
const MAX_DATASET_BYTES = 256 * 1024;
const SIGNAL_CODES = Object.freeze(['instruction_override', 'role_impersonation', 'credential_exfiltration', 'approval_bypass']);

export function evaluateInjectionSignalDataset(dataset) {
  if (!dataset || typeof dataset !== 'object' || Array.isArray(dataset)) throw new TypeError('Evaluation dataset must be an object');
  if (Object.keys(dataset).some((key) => !['dataset_version', 'cases'].includes(key)))
    throw new TypeError('Evaluation dataset contains unsupported fields');
  if (typeof dataset.dataset_version !== 'string' || !/^\d{4}-\d{2}-\d{2}\.\d+$/.test(dataset.dataset_version))
    throw new TypeError('Evaluation dataset version is invalid');
  if (!Array.isArray(dataset.cases) || dataset.cases.length < 16 || dataset.cases.length > 1000)
    throw new TypeError('Evaluation dataset case count must be between 16 and 1000');

  const seenIds = new Set();
  const counts = Object.fromEntries(
    SIGNAL_CODES.map((code) => [code, { tp: 0, fp: 0, fn: 0, tn: 0, false_positive_ids: [], false_negative_ids: [] }]),
  );
  let exactMatches = 0;
  for (const item of dataset.cases) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !['id', 'text', 'expected'].includes(key))
    )
      throw new TypeError('Evaluation case contains an invalid shape');
    if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.id) || seenIds.has(item.id))
      throw new TypeError('Evaluation case IDs must be unique safe identifiers');
    if (typeof item.text !== 'string' || item.text.length === 0 || item.text.length > 65_536)
      throw new TypeError('Evaluation case text is empty or oversized');
    if (
      !Array.isArray(item.expected) ||
      item.expected.some((code) => !SIGNAL_CODES.includes(code)) ||
      new Set(item.expected).size !== item.expected.length
    )
      throw new TypeError('Evaluation case labels are invalid');
    seenIds.add(item.id);

    const predicted = inspectUntrustedContent(item.text)?.signals || [];
    for (const code of SIGNAL_CODES) {
      const expected = item.expected.includes(code);
      const detected = predicted.includes(code);
      const metric = counts[code];
      if (expected && detected) metric.tp += 1;
      else if (expected) {
        metric.fn += 1;
        metric.false_negative_ids.push(item.id);
      } else if (detected) {
        metric.fp += 1;
        metric.false_positive_ids.push(item.id);
      } else metric.tn += 1;
    }
    if (item.expected.length === predicted.length && item.expected.every((code) => predicted.includes(code))) exactMatches += 1;
  }

  for (const code of SIGNAL_CODES) {
    const metric = counts[code];
    if (metric.tp + metric.fn === 0 || metric.tn + metric.fp === 0)
      throw new TypeError(`Evaluation dataset needs positive and negative cases for ${code}`);
  }

  const perSignal = Object.fromEntries(
    SIGNAL_CODES.map((code) => {
      const { tp, fp, fn, tn, false_positive_ids, false_negative_ids } = counts[code];
      return [
        code,
        {
          true_positive: tp,
          false_positive: fp,
          false_negative: fn,
          true_negative: tn,
          precision: rate(tp, tp + fp),
          recall: rate(tp, tp + fn),
          false_positive_rate: rate(fp, fp + tn),
          false_positive_ids,
          false_negative_ids,
        },
      ];
    }),
  );
  const totals = Object.values(counts).reduce(
    (sum, metric) => ({ tp: sum.tp + metric.tp, fp: sum.fp + metric.fp, fn: sum.fn + metric.fn, tn: sum.tn + metric.tn }),
    { tp: 0, fp: 0, fn: 0, tn: 0 },
  );
  return {
    dataset_version: dataset.dataset_version,
    detector_version: INJECTION_SIGNAL_VERSION,
    case_count: dataset.cases.length,
    exact_matches: exactMatches,
    exact_match_rate: rate(exactMatches, dataset.cases.length),
    micro_precision: rate(totals.tp, totals.tp + totals.fp),
    micro_recall: rate(totals.tp, totals.tp + totals.fn),
    per_signal: perSignal,
  };
}

function rate(numerator, denominator) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}

async function main() {
  const stats = await fs.stat(datasetPath);
  if (stats.size > MAX_DATASET_BYTES) throw new Error('Injection-signal evaluation dataset exceeds its size limit');
  const dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
  process.stdout.write(`${JSON.stringify(evaluateInjectionSignalDataset(dataset), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`Injection-signal evaluation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
