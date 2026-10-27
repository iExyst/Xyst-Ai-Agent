import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadProjectInstructions } from '../src/core/project-instructions.mjs';
import { createTempDirectory } from './helpers.mjs';

test('project instructions load root-to-target hierarchy with bounded, redacted content', async (t) => {
  const root = await createTempDirectory('xyst-project-guidance-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'AGENTS.md'), 'Use clear names.\napi_key = "root-canary-value"\n');
  await fs.writeFile(path.join(root, 'src', 'AGENTS.md'), 'Keep modules small.\n');
  await fs.writeFile(path.join(root, 'src', 'nested', 'AGENTS.md'), 'Preserve local conventions.\n');
  const rootOnly = await loadProjectInstructions(root);
  assert.deepEqual(
    rootOnly.map((item) => item.path),
    ['AGENTS.md'],
  );
  assert.doesNotMatch(rootOnly[0].content, /root-canary-value/);
  const scoped = await loadProjectInstructions(root, ['src/nested/example.mjs']);
  assert.deepEqual(
    scoped.map((item) => item.path),
    ['AGENTS.md', 'src/AGENTS.md', 'src/nested/AGENTS.md'],
  );
});

test('project instructions refuse workspace traversal and ignore .agent guidance', async (t) => {
  const root = await createTempDirectory('xyst-project-guidance-boundary-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.agent'), { recursive: true });
  await fs.writeFile(path.join(root, '.agent', 'AGENTS.md'), 'internal app state');
  assert.deepEqual(await loadProjectInstructions(root, ['.agent']), []);
  await assert.rejects(loadProjectInstructions(root, ['../outside/file.js']), /escapes workspace/);
});
