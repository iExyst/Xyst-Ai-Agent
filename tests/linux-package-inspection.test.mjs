import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  debianPackageName,
  findDebPackage,
  findLauncher,
  findPackagedResources,
  isRegularFile,
} from '../scripts/linux-package-inspection.mjs';
import { parseSmokeJson } from '../scripts/smoke-linux-package.mjs';
import { createSymlinkOrSkip, createTempDirectory } from './helpers.mjs';

const linuxOnly = process.platform === 'linux' ? false : 'Linux package filesystem semantics are tested on Linux CI';

test('DEB artifact discovery derives the filename and package ID from the product name', async (t) => {
  const root = await createTempDirectory('xyst-deb-artifact-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageFile = path.join(root, 'Xyst AI Assistant_0.1.0_amd64.deb');
  await fs.writeFile(packageFile, 'package fixture');

  const options = { productName: 'Xyst AI Assistant', version: '0.1.0', architecture: 'amd64' };
  assert.equal(debianPackageName(options.productName), 'xyst-ai-assistant');
  assert.equal(await findDebPackage(root, options), packageFile);
  await assert.rejects(findDebPackage(root, { ...options, productName: '../outside' }), /valid Debian product name/);
  await assert.rejects(findDebPackage(root, { ...options, version: '0.2.0' }), /found 0/);
  await assert.rejects(findDebPackage(root, { ...options, version: '../outside' }), /valid Debian package version/);
  await assert.rejects(findDebPackage(root, { ...options, architecture: 'x86_64' }), /supported Debian package architecture/);
});

test('installed desktop smoke ignores bus diagnostics and parses its final JSON result', () => {
  const expected = { title: 'Xyst AI Assistant', window: { width: 1440, height: 920 } };
  assert.deepEqual(parseSmokeJson(`SpiRegistry daemon is running\n${JSON.stringify(expected)}\n`), expected);
  assert.throws(() => parseSmokeJson('desktop window failed'), /returned no JSON result/);
  assert.deepEqual(parseSmokeJson(`prior log\n${JSON.stringify(expected)}\n{status: diagnostic}`), expected);
  assert.throws(() => parseSmokeJson('prior log\n{invalid json}'), /valid JSON result/);
});

test('DEB payload inspection finds resources and requires an executable bundled Node runtime', { skip: linuxOnly }, async (t) => {
  const root = await createTempDirectory('xyst-deb-inspection-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'usr', 'lib', 'xyst');
  const cli = path.join(packageRoot, 'xyst', 'src', 'cli.mjs');
  const node = path.join(packageRoot, 'xyst', 'runtime', 'node');
  await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.mkdir(path.dirname(node), { recursive: true });
  await fs.writeFile(cli, 'export {};\n');
  await fs.writeFile(node, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  assert.equal(await isRegularFile(cli), true);
  assert.deepEqual(await findPackagedResources(root), { cli, node });

  await fs.chmod(node, 0o644);
  await assert.rejects(findPackagedResources(root), /missing xyst\/src\/cli\.mjs or executable xyst\/runtime\/node/);
});

test('DEB resource discovery stops at its configured depth limit', { skip: linuxOnly }, async (t) => {
  const root = await createTempDirectory('xyst-deb-depth-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let directory = root;
  for (let depth = 0; depth < 13; depth += 1) {
    directory = path.join(directory, `level-${depth}`);
    await fs.mkdir(directory);
  }

  const cli = path.join(directory, 'xyst', 'src', 'cli.mjs');
  const node = path.join(directory, 'xyst', 'runtime', 'node');
  await fs.mkdir(path.dirname(cli), { recursive: true });
  await fs.mkdir(path.dirname(node), { recursive: true });
  await fs.writeFile(cli, 'export {};\n');
  await fs.writeFile(node, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  await assert.rejects(findPackagedResources(root), /missing xyst\/src\/cli\.mjs/);
});

test('DEB resource discovery does not follow symlinked directories', { skip: linuxOnly }, async (t) => {
  const root = await createTempDirectory('xyst-deb-link-discovery-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const external = path.join(root, 'external');
  const linked = path.join(root, 'payload', 'linked');
  await fs.mkdir(path.join(external, 'xyst', 'src'), { recursive: true });
  await fs.mkdir(path.join(external, 'xyst', 'runtime'));
  await fs.writeFile(path.join(external, 'xyst', 'src', 'cli.mjs'), 'export {};\n');
  await fs.writeFile(path.join(external, 'xyst', 'runtime', 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.mkdir(path.dirname(linked), { recursive: true });
  if (!(await createSymlinkOrSkip(t, external, linked))) return;

  await assert.rejects(findPackagedResources(path.join(root, 'payload')), /missing xyst\/src\/cli\.mjs/);
});

test('DEB launcher inspection accepts only executables resolved inside the extracted payload', { skip: linuxOnly }, async (t) => {
  const root = await createTempDirectory('xyst-deb-launcher-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'usr', 'bin');
  const actual = path.join(root, 'usr', 'lib', 'xyst', 'launcher');
  const link = path.join(bin, 'xyst');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.dirname(actual), { recursive: true });
  await fs.writeFile(actual, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.symlink(actual, link);

  assert.equal(await isRegularFile(actual), true);
  assert.equal(await isRegularFile(link), false);
  assert.equal(await findLauncher(root), link);

  const outsideRoot = await fs.mkdtemp(path.join(path.dirname(root), 'xyst-deb-outside-'));
  t.after(() => fs.rm(outsideRoot, { recursive: true, force: true }));
  const outside = path.join(outsideRoot, 'launcher');
  await fs.writeFile(outside, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fs.rm(link);
  await fs.symlink(outside, link);
  await assert.rejects(findLauncher(root), /Package launcher escapes extracted payload: xyst/);
});

test('DEB launcher inspection rejects a linked /usr/bin and reports a missing launcher directory', { skip: linuxOnly }, async (t) => {
  const root = await createTempDirectory('xyst-deb-launcher-directory-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside-bin');
  const linkedBin = path.join(root, 'usr', 'bin');
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(path.dirname(linkedBin), { recursive: true });
  if (!(await createSymlinkOrSkip(t, outside, linkedBin))) return;

  await assert.rejects(findLauncher(root), /\/usr\/bin must be a real directory/);
  await fs.rm(linkedBin);
  await assert.rejects(findLauncher(root), /DEB payload is missing \/usr\/bin/);
});
