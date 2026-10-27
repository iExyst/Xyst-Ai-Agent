import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { formatSkippedTests, parseSkippedTests } from './tap-summary.mjs';

const root = path.resolve(import.meta.dirname, '..');
const GENERATED_DIRECTORIES = new Set(['.git', '.test-tmp', 'coverage', 'dist', 'node_modules', 'target']);
const testConcurrency = process.platform === 'win32' ? '1' : '2';
await run(process.execPath, ['scripts/build-vscode.mjs'], root);
const modules = [];
for (const directory of ['src', 'tests', 'scripts', 'gui', 'vscode']) await collect(path.join(root, directory));
for (const file of modules) await run(process.execPath, ['--check', file], root);
const testOutput = await runCapture(process.execPath, ['--test', `--test-concurrency=${testConcurrency}`, '--test-reporter=tap'], root);
const skipped = parseSkippedTests(testOutput);
console.log(formatSkippedTests(skipped));
console.log(`Checked syntax for ${modules.length} JavaScript modules.`);

async function collect(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory() && !GENERATED_DIRECTORIES.has(entry.name)) await collect(fullPath);
    else if (entry.isFile() && (entry.name.endsWith('.mjs') || entry.name.endsWith('.js'))) modules.push(fullPath);
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(command)} ${args.join(' ')} exited with ${code}`)),
    );
  });
}

function runCapture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    child.stdout.on('data', (chunk) => {
      stdout.push(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.pipe(process.stderr);
    child.once('error', reject);
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      if (code === 0) resolve(output);
      else reject(new Error(`${path.basename(command)} ${args.join(' ')} exited with ${code}`));
    });
  });
}
