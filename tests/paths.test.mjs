import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPathInside, resolveWorkspacePath, resolveToolPath, displayPath } from '../src/platform/paths.mjs';
import { createSymlinkOrSkip, createTempDirectory } from './helpers.mjs';

test('lexical workspace checks handle POSIX and Windows separators and traversal', () => {
  assert.equal(isPathInside('/work/project', '/work/project/src/main.js', 'posix'), true);
  assert.equal(isPathInside('/work/project', '/work/project-other/file', 'posix'), false);
  assert.equal(isPathInside('/work/project', '/work/project/../secret', 'posix'), false);
  assert.equal(isPathInside('C:\\Work\\Repo', 'c:\\work\\repo\\src\\a.js', 'win32'), true);
  assert.equal(isPathInside('C:\\Work\\Repo', 'C:\\Work\\Repo-old\\a.js', 'win32'), false);
  assert.equal(isPathInside('\\\\server\\share\\repo', '\\\\server\\share\\repo\\file', 'win32'), true);
  assert.equal(isPathInside('\\\\?\\C:\\Repo', '\\\\?\\C:\\Repo\\folder with spaces\\café.txt', 'win32'), true);
  assert.equal(isPathInside('\\\\?\\UNC\\server\\share\\Repo', '\\\\server\\share\\repo\\src\\file.txt', 'win32'), true);
  assert.equal(isPathInside('\\\\?\\UNC\\server\\share\\Repo', '\\\\?\\UNC\\server\\share\\Repo-old\\file.txt', 'win32'), false);
  assert.equal(isPathInside('C:\\', 'D:\\repo\\file.txt', 'win32'), false);
  assert.equal(isPathInside('C:\\Repo', 'C:\\Repo\\..\\outside.txt', 'win32'), false);
  assert.equal(isPathInside('/work/project', '/work/project/café space/file.txt', 'posix'), true);
});

test('displayPath makes Windows extended-length drive and UNC paths workspace-relative', () => {
  assert.equal(displayPath('C:\\Repo', '\\\\?\\C:\\Repo\\folder\\file.txt', 'win32'), path.win32.join('folder', 'file.txt'));
  assert.equal(
    displayPath('\\\\?\\UNC\\server\\share\\Repo', '\\\\server\\share\\Repo\\src\\file.txt', 'win32'),
    path.win32.join('src', 'file.txt'),
  );
  assert.equal(displayPath('/work/repo', '/work/repo/src/file.txt', 'posix'), path.posix.join('src', 'file.txt'));
});

test('workspace resolver reads and writes paths longer than the traditional Windows MAX_PATH limit', async (t) => {
  const root = await createTempDirectory('xyst-long-path-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const relativePath = path.join(...Array.from({ length: 12 }, (_, index) => `segment-${index}-${'x'.repeat(18)}`), 'file.txt');
  const absolutePath = path.join(root, relativePath);
  assert.ok(absolutePath.length > 260, `fixture path must exceed 260 characters (got ${absolutePath.length})`);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, 'long path works');
  assert.equal(await resolveWorkspacePath(root, relativePath, { mustExist: true }), await fs.realpath(absolutePath));
  assert.equal(await fs.readFile(await resolveWorkspacePath(root, relativePath, { mustExist: true }), 'utf8'), 'long path works');
});

test('workspace resolver accepts contained paths and rejects traversal', async (t) => {
  const root = await createTempDirectory('xyst-path-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'hello');
  assert.equal(await resolveWorkspacePath(root, 'src/a.txt', { mustExist: true }), await fs.realpath(path.join(root, 'src', 'a.txt')));
  assert.equal(await resolveWorkspacePath(root, 'src/new.txt'), path.join(await fs.realpath(root), 'src', 'new.txt'));
  await assert.rejects(resolveWorkspacePath(root, '../outside.txt'), /escapes workspace/);
  assert.equal(displayPath(await fs.realpath(root), path.join(await fs.realpath(root), 'src', 'a.txt')), path.join('src', 'a.txt'));
});

test('workspace file tools map the sandbox /workspace alias back into the selected workspace', async (t) => {
  const root = await createTempDirectory('xyst-sandbox-workspace-alias-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'a.txt'), 'hello');
  assert.equal(
    await resolveToolPath(root, '/workspace/src/a.txt', { mustExist: true }),
    await fs.realpath(path.join(root, 'src', 'a.txt')),
  );
  assert.equal(await resolveToolPath(root, '/workspace'), await fs.realpath(root));
  await assert.rejects(resolveToolPath(root, '/workspace/../outside.txt'), /escapes workspace/);
  await assert.rejects(resolveToolPath(root, '/workspace-other/src/a.txt'), /escapes workspace/);
});

test('workspace resolver rejects symlink escapes when the platform permits symlink creation', async (t) => {
  const parent = await createTempDirectory('xyst-link-');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'workspace');
  const outside = path.join(parent, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
  if (!(await createSymlinkOrSkip(t, outside, path.join(root, 'link')))) return;
  await assert.rejects(resolveWorkspacePath(root, 'link/secret.txt', { mustExist: true }), /symbolic link/);
  await assert.rejects(resolveWorkspacePath(root, 'link/new.txt'), /symbolic link/);
});

test('machine scope accepts absolute paths outside the workspace', async (t) => {
  const root = await createTempDirectory('xyst-machine-path-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'shared.txt'), 'shared');
  await assert.rejects(resolveToolPath(workspace, path.join(outside, 'shared.txt'), { mustExist: true }), /escapes workspace/);
  assert.equal(
    await resolveToolPath(workspace, path.join(outside, 'shared.txt'), { mustExist: true, machineScope: true }),
    await fs.realpath(path.join(outside, 'shared.txt')),
  );
});
