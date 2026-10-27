import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAgentScenarios } from '../src/core/agent-evaluation.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const datasetPath = path.resolve(root, process.argv[2] || 'eval/agent-scenarios.json');
let dataset;
try {
  dataset = JSON.parse(await fs.readFile(datasetPath, 'utf8'));
} catch (error) {
  process.stderr.write(`Could not read agent evaluation dataset '${datasetPath}': ${error.message}\n`);
  process.exitCode = 2;
  process.exit();
}

const tempBase = path.join(root, '.test-tmp');
await fs.mkdir(tempBase, { recursive: true });
const tempRoot = await fs.mkdtemp(path.join(tempBase, 'xyst-eval-'));
try {
  const report = await evaluateAgentScenarios(dataset, {
    workspaceFactory: async (scenario) => {
      const workspaceRoot = path.join(tempRoot, scenario.id);
      await fs.mkdir(workspaceRoot, { recursive: true });
      for (const [relativePath, contents] of Object.entries(scenario.files || {})) {
        const target = path.resolve(workspaceRoot, relativePath);
        if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`))
          throw new Error(`Scenario '${scenario.id}' contains a file path outside its workspace`);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, contents, { flag: 'wx' });
      }
      return { workspaceRoot };
    },
  });
  const display = process.argv.includes('--json')
    ? JSON.stringify(report, null, 2)
    : `Agent evaluation ${report.dataset_version}: ${report.passed}/${report.total} passed; ` +
      `task success ${(report.task_success_rate * 100).toFixed(1)}%; ${report.model_calls} model calls; ` +
      `${report.tool_calls} tool calls (${report.tool_denials} denied); tokens ${report.input_tokens ?? 'n/a'} in/${report.output_tokens ?? 'n/a'} out; ` +
      `estimated cost $${report.estimated_cost_usd?.toFixed(6) ?? 'n/a'} for ${report.scenarios_with_cost_estimate}/${report.total} scenarios; ` +
      `average ${report.average_latency_ms.toFixed(1)} ms\n`;
  process.stdout.write(`${display}\n`);
  for (const [category, metrics] of Object.entries(report.by_category))
    process.stdout.write(`  ${category}: ${metrics.passed}/${metrics.total} (${(metrics.accuracy * 100).toFixed(1)}%)\n`);
  for (const result of report.results.filter((item) => !item.passed)) process.stderr.write(`FAIL ${result.id}: ${result.failure}\n`);
  if (report.failed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Invalid or failed agent evaluation: ${error.message}\n`);
  process.exitCode = 2;
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
