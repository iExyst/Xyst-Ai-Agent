import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRustLicenseInventory, evaluateSpdxExpression } from '../scripts/check-rust-licenses.mjs';
import { createTempDirectory } from './helpers.mjs';

const policy = {
  schema_version: 1,
  allowed_licenses: ['Apache-2.0', 'MIT', 'BSD-3-Clause'],
  allowed_exceptions: ['LLVM-exception'],
};
const allow = new Set(policy.allowed_licenses);
const exceptions = new Set(policy.allowed_exceptions);

test('SPDX license policy honors AND, OR, parentheses, and WITH semantics', () => {
  assert.equal(evaluateSpdxExpression('MIT OR GPL-3.0-only', allow, exceptions), true);
  assert.equal(evaluateSpdxExpression('MIT AND Apache-2.0', allow, exceptions), true);
  assert.equal(evaluateSpdxExpression('MIT AND GPL-3.0-only', allow, exceptions), false);
  assert.equal(evaluateSpdxExpression('MIT OR (GPL-3.0-only AND AGPL-3.0-only)', allow, exceptions), true);
  assert.equal(evaluateSpdxExpression('Apache-2.0 WITH LLVM-exception', allow, exceptions), true);
  assert.equal(evaluateSpdxExpression('Apache-2.0 WITH Classpath-exception-2.0', allow, exceptions), false);
  assert.equal(evaluateSpdxExpression(' MIT OR GPL-3.0-only  ', allow, exceptions), true);
  assert.throws(
    () => evaluateSpdxExpression('(MIT OR Apache-2.0) WITH LLVM-exception', allow, exceptions),
    /single SPDX license identifier/,
  );
  assert.throws(() => evaluateSpdxExpression('MIT / Apache-2.0', allow, exceptions), /unsupported token/);
});

test('Rust inventory rejects missing, disallowed, malformed, and unparseable licenses', () => {
  const result = checkRustLicenseInventory(
    [
      { name: 'allowed', version: '1.0.0', license: 'MIT OR GPL-3.0-only' },
      { name: 'missing', version: '1.0.0', license: null },
      { name: 'restricted', version: '1.0.0', license: 'GPL-3.0-only' },
      { name: 'malformed', version: '1.0.0', license: 'MIT OR' },
    ],
    policy,
  );
  assert.equal(result.checked, 4);
  assert.deepEqual(
    result.rejected.map(({ name }) => name),
    ['missing', 'restricted', 'malformed'],
  );
  assert.throws(() => checkRustLicenseInventory([], policy), /non-empty JSON array/);
  assert.throws(() => checkRustLicenseInventory([{ name: 'missing-version', license: 'MIT' }], policy), /name and version/);
});

test('Rust license policy CLI validates the cargo-license JSON inventory', async () => {
  const directory = await createTempDirectory('xyst-rust-licenses-');
  const inventoryPath = path.join(directory, 'inventory.json');
  await fs.writeFile(inventoryPath, JSON.stringify([{ name: 'permissive-crate', version: '1.0.0', license: 'MIT OR GPL-3.0-only' }]));
  const script = fileURLToPath(new URL('../scripts/check-rust-licenses.mjs', import.meta.url));
  const allowed = spawnSync(process.execPath, [script, inventoryPath], { encoding: 'utf8', windowsHide: true });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /approved all 1 packages/);

  await fs.writeFile(inventoryPath, JSON.stringify([{ name: 'restricted-crate', version: '1.0.0', license: 'GPL-3.0-only' }]));
  const rejected = spawnSync(process.execPath, [script, inventoryPath], { encoding: 'utf8', windowsHide: true });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /restricted-crate@1\.0\.0: GPL-3\.0-only/);
});
