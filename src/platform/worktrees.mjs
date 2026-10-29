import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runProcess, safeProcessEnvironment } from './process.mjs';
import { isPathInside, resolveWorkspacePath } from './paths.mjs';
import { captureProcessIdentity, verifyProcessIdentity } from './process-identity.mjs';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_SNAPSHOT_PATHS_BYTES = 32 * 1024 * 1024;

/** Create a checked-out Git worktree under the workspace's protected .agent directory. */
export async function createWorktree(workspaceRoot, branch, { signal, sandboxable = false, destinationRoot } = {}) {
  validateBranch(branch);
  const workspace = await fs.realpath(workspaceRoot);
  const repository = await getRepositoryRoot(workspace, signal);
  const checkedBranch = await git(repository, ['check-ref-format', '--branch', branch], { signal });
  if (checkedBranch.exitCode !== 0) throw new TypeError('Branch must be a valid Git branch name');
  const baseCommit = await resolveWorktreeBase(repository, signal);
  const id = randomUUID();
  const worktreeRoot = sandboxable ? '.xyst-worktrees' : path.join('.agent', 'worktrees');
  const destinationBase = destinationRoot ? await fs.realpath(destinationRoot) : workspace;
  if (!isPathInside(repository, destinationBase)) throw new Error('Worktree destination must be inside the Git repository');
  const managedRoot = await resolveWorkspacePath(destinationBase, worktreeRoot);
  await fs.mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const managedRootInfo = await fs.lstat(managedRoot);
  if (managedRootInfo.isSymbolicLink() || !managedRootInfo.isDirectory())
    throw new Error('Managed worktree directory must be a real directory');
  const destination = await resolveWorkspacePath(managedRoot, id);
  const hooksPath = await createEmptyHooksDirectory();
  try {
    await fs.mkdir(destination);
    try {
      const disabledFilters = await getGitFilterOverrides(repository, signal);
      const result = await git(repository, ['worktree', 'add', '-b', branch, destination, baseCommit], {
        signal,
        hooksPath,
        extraConfig: disabledFilters,
      });
      if (result.exitCode !== 0) throw gitFailure('create worktree', result);
    } catch (error) {
      await fs.rmdir(destination).catch(() => {});
      throw error;
    }
    return { id, branch, path: await fs.realpath(destination) };
  } finally {
    await fs.rm(hooksPath, { recursive: true, force: true });
  }
}

/** List worktrees whose canonical paths are beneath a managed worktree directory. */
export async function listWorktrees(workspaceRoot, { signal } = {}) {
  const workspace = await fs.realpath(workspaceRoot);
  const repository = await getRepositoryRoot(workspace, signal);
  const roots = [path.join(repository, '.agent', 'worktrees'), path.join(repository, '.xyst-worktrees')];
  const result = await git(repository, ['worktree', 'list', '--porcelain', '-z'], { signal });
  if (result.exitCode !== 0) throw gitFailure('list worktrees', result);
  const entries = parseWorktreePorcelain(result.stdout);
  const managed = [];
  for (const entry of entries) {
    if (!roots.some((root) => isPathInside(root, entry.path))) continue;
    const resolved = await fs.realpath(entry.path).catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (!resolved || !roots.some((root) => isPathInside(root, resolved))) continue;
    managed.push({ id: path.basename(resolved), branch: entry.branch, path: resolved, head: entry.head });
  }
  return managed.sort((a, b) => (a.branch || '').localeCompare(b.branch || '') || a.id.localeCompare(b.id));
}

/** Remove a managed worktree only after confirming it has no tracked or untracked changes. */
export async function removeWorktree(workspaceRoot, id, { signal } = {}) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError('Invalid worktree ID');
  const workspace = await fs.realpath(workspaceRoot);
  const release = await acquireWorktreeLease(workspace, id);
  try {
    const repository = await getRepositoryRoot(workspace, signal);
    const known = await listWorktrees(workspace, { signal });
    const entry = known.find((item) => item.id === id);
    if (!entry) throw Object.assign(new Error('Worktree is not registered with this repository'), { code: 'NOT_FOUND' });
    const worktreePath = entry.path;
    if (path.basename(worktreePath) !== id) throw new Error('Worktree path is outside the managed worktree directory');
    const disabledFilters = await getGitFilterOverrides(repository, signal);
    const status = await git(worktreePath, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching'], {
      signal,
      extraConfig: disabledFilters,
    });
    if (status.exitCode !== 0) throw gitFailure('inspect worktree changes', status);
    if (status.stdout.trim())
      throw Object.assign(new Error('Worktree has tracked, untracked, or ignored files; preserve or remove them before deleting it'), {
        code: 'WORKTREE_DIRTY',
      });
    const result = await git(repository, ['worktree', 'remove', '--', worktreePath], { signal, extraConfig: disabledFilters });
    if (result.exitCode !== 0) throw gitFailure('remove worktree', result);
    return { id, path: worktreePath, removed: true };
  } finally {
    await release();
  }
}

/** Acquire an exclusive cross-process lease for a registered worktree ID. */
export async function acquireWorktreeLease(workspaceRoot, id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError('Invalid worktree ID');
  const workspace = await fs.realpath(workspaceRoot);
  const repository = await getStateRoot(workspace);
  const lockPath = await resolveWorkspacePath(repository, path.join('.agent', 'worktree-locks', `${id}.lock`));
  const lockDirectory = path.dirname(lockPath);
  await fs.mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw Object.assign(
        new Error(`Worktree ${id} is in use. If its process crashed, verify that and remove ${lockPath} before retrying.`),
        { code: 'WORKTREE_IN_USE' },
      );
    }
    throw error;
  }
  const lockToken = randomUUID();
  try {
    await handle.writeFile(
      JSON.stringify({
        schema_version: 1,
        lock_token: lockToken,
        pid: process.pid,
        hostname: os.hostname(),
        started_at: new Date().toISOString(),
        process_identity: await captureProcessIdentity(process.pid),
      }),
    );
    await handle.sync();
  } catch (error) {
    const openedInfo = await handle.stat().catch(() => null);
    await handle.close().catch(() => {});
    if (openedInfo) {
      const currentInfo = await fs.lstat(lockPath).catch(() => null);
      if (currentInfo?.isFile() && !currentInfo.isSymbolicLink() && sameFileIdentity(openedInfo, currentInfo)) {
        try {
          const currentRecord = JSON.parse(await fs.readFile(lockPath, 'utf8'));
          if (currentRecord.lock_token === lockToken) await fs.rm(lockPath).catch(() => {});
        } catch {
          // Keep the path when ownership cannot be confirmed.
        }
      }
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const openedInfo = await handle.stat().catch(() => null);
    await handle.close().catch(() => {});
    if (!openedInfo) return;
    const currentInfo = await fs.lstat(lockPath).catch(() => null);
    if (!currentInfo?.isFile() || currentInfo.isSymbolicLink() || !sameFileIdentity(openedInfo, currentInfo)) return;
    let currentRecord;
    try {
      currentRecord = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    } catch {
      return;
    }
    if (currentRecord.lock_token === lockToken) await fs.rm(lockPath).catch(() => {});
  };
}

/** Inspect stale worktree leases without changing them. Unknown and remote owners require manual investigation. */
export async function inspectWorktreeLocks(workspaceRoot, { verifyIdentity = verifyProcessIdentity } = {}) {
  const workspace = await fs.realpath(workspaceRoot);
  const repository = await getStateRoot(workspace);
  const directory = await resolveWorkspacePath(repository, path.join('.agent', 'worktree-locks'));
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const locks = [];
  for (const name of names.filter((entry) => entry.endsWith('.lock')).sort()) {
    const id = name.slice(0, -'.lock'.length);
    if (!ID_PATTERN.test(id)) {
      locks.push({ id, state: 'invalid_name' });
      continue;
    }
    const lockPath = path.join(directory, name);
    let info;
    try {
      info = await fs.lstat(lockPath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile() || info.size > 4_096) {
      locks.push({ id, state: 'unsafe_record' });
      continue;
    }
    let record;
    try {
      record = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    } catch {
      locks.push({ id, state: 'invalid_record' });
      continue;
    }
    if (!isValidLockRecord(record)) {
      locks.push({ id, state: 'unverifiable_record', started_at: safeTimestamp(record?.started_at) });
      continue;
    }
    if (record.hostname !== os.hostname()) {
      locks.push({ id, state: 'remote_owner', pid: record.pid, hostname: record.hostname, started_at: record.started_at });
      continue;
    }
    if (record.process_identity.platform !== process.platform) {
      locks.push({ id, state: 'identity_platform_mismatch', pid: record.pid, hostname: record.hostname, started_at: record.started_at });
      continue;
    }
    const identityState = await verifyIdentity(record.process_identity);
    locks.push({
      id,
      pid: record.pid,
      hostname: record.hostname,
      started_at: record.started_at,
      state:
        identityState === 'match'
          ? 'active'
          : identityState === 'absent'
            ? 'stale'
            : identityState === 'mismatch'
              ? 'pid_reused'
              : 'unavailable',
    });
  }
  return locks;
}

/** Reclaim one lock only when a same-host OS identity check proves its owner is no longer the recorded process. */
export async function recoverWorktreeLock(workspaceRoot, id, { verifyIdentity = verifyProcessIdentity } = {}) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new TypeError('Invalid worktree ID');
  const workspace = await fs.realpath(workspaceRoot);
  const repository = await getStateRoot(workspace);
  const lockPath = await resolveWorkspacePath(repository, path.join('.agent', 'worktree-locks', `${id}.lock`), { mustExist: true });
  const info = await fs.lstat(lockPath);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 4_096)
    throw Object.assign(new Error('Worktree lock is not a safe regular file'), { code: 'WORKTREE_LOCK_UNSAFE' });
  const record = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  if (!isValidLockRecord(record) || record.hostname !== os.hostname() || record.process_identity.platform !== process.platform)
    throw Object.assign(new Error('Worktree lock owner cannot be verified on this host'), { code: 'WORKTREE_LOCK_UNVERIFIABLE' });
  const state = await verifyIdentity(record.process_identity);
  if (!['absent', 'mismatch'].includes(state))
    throw Object.assign(new Error(`Worktree lock owner is ${state}; refusing to remove the lock`), { code: 'WORKTREE_LOCK_ACTIVE' });
  const currentInfo = await fs.lstat(lockPath);
  if (!currentInfo.isFile() || currentInfo.isSymbolicLink() || !sameFileIdentity(info, currentInfo))
    throw Object.assign(new Error('Worktree lock changed during recovery; retry inspection'), { code: 'WORKTREE_LOCK_CHANGED' });
  const currentRecord = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  if (currentRecord.lock_token !== record.lock_token)
    throw Object.assign(new Error('Worktree lock owner changed during recovery; retry inspection'), { code: 'WORKTREE_LOCK_CHANGED' });
  await fs.rm(lockPath);
  return { id, removed: true, owner_state: state };
}

function isValidLockRecord(record) {
  return Boolean(
    record &&
      record.schema_version === 1 &&
      typeof record.lock_token === 'string' &&
      /^[0-9a-f-]{36}$/i.test(record.lock_token) &&
      Number.isInteger(record.pid) &&
      record.pid > 0 &&
      typeof record.hostname === 'string' &&
      isValidProcessIdentity(record.process_identity, record.pid) &&
      Number.isFinite(Date.parse(record.started_at)),
  );
}

function isValidProcessIdentity(identity, pid) {
  if (!identity || identity.pid !== pid) return false;
  if (identity.platform === 'linux')
    return (
      /^[0-9a-f-]{16,64}$/i.test(identity.boot_id || '') &&
      /^\d+$/.test(identity.start_ticks || '') &&
      /^[0-9a-f]{64}$/i.test(identity.command_hash || '')
    );
  if (identity.platform === 'win32') return /^\d+$/.test(identity.creation_time || '') && /^[0-9a-f]{64}$/i.test(identity.image_hash || '');
  return false;
}

function safeTimestamp(value) {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function sameFileIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino;
}

async function getRepositoryRoot(workspace, signal) {
  const result = await git(workspace, ['rev-parse', '--show-toplevel'], { signal });
  if (result.exitCode !== 0)
    throw Object.assign(new Error('Worktrees require a Git repository at or above the workspace'), { code: 'WORKTREE_UNAVAILABLE' });
  return fs.realpath(result.stdout.trim());
}

async function getStateRoot(workspace) {
  const gitEntry = await fs.lstat(path.join(workspace, '.git')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!gitEntry) return workspace;
  try {
    return await getRepositoryRoot(workspace);
  } catch (error) {
    if (error.code !== 'WORKTREE_UNAVAILABLE') throw error;
    return workspace;
  }
}

async function resolveWorktreeBase(repository, signal) {
  const head = await git(repository, ['rev-parse', '--verify', 'HEAD'], { signal });
  if (head.exitCode === 0) return head.stdout.trim();
  if (signal?.aborted) throw signal.reason || new Error('Worktree creation was cancelled');

  const symbolicHead = await git(repository, ['symbolic-ref', '--quiet', 'HEAD'], { signal });
  if (symbolicHead.exitCode !== 0)
    throw Object.assign(gitFailure('resolve a worktree base commit', head), { code: 'WORKTREE_UNAVAILABLE' });

  return createUnbornRepositorySnapshot(repository, signal);
}

async function createUnbornRepositorySnapshot(repository, signal) {
  const snapshotDirectory = await resolveWorkspacePath(repository, path.join('.agent', 'worktree-snapshots'));
  await fs.mkdir(snapshotDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await fs.mkdtemp(path.join(snapshotDirectory, 'snapshot-'));
  const indexPath = path.join(temporaryDirectory, 'index');
  const environment = isolatedGitEnvironment();
  const indexEnvironment = isolatedGitEnvironment({ GIT_INDEX_FILE: indexPath });
  const hooksPath = await createEmptyHooksDirectory();
  try {
    const disabledFilters = await getGitFilterOverrides(repository, signal);
    await runGit(repository, ['read-tree', '--empty'], { signal, hooksPath, extraConfig: disabledFilters, environment: indexEnvironment });
    const agentStatePath = '.agent';
    if (!agentStatePath || agentStatePath === '..' || agentStatePath.startsWith('../') || path.posix.isAbsolute(agentStatePath))
      throw Object.assign(new Error('Workspace state directory is outside the Git repository'), { code: 'WORKTREE_UNAVAILABLE' });
    const files = await runGit(repository, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      signal,
      hooksPath,
      extraConfig: disabledFilters,
      environment,
      maxOutputBytes: MAX_SNAPSHOT_PATHS_BYTES,
    });
    if (files.truncated)
      throw new Error('Could not create isolated workspace snapshot: repository contains too many paths to enumerate safely');
    const paths = [];
    for (const relativePath of new Set(files.stdout.split('\0').filter(Boolean))) {
      if (isWorkspaceStatePath(relativePath, agentStatePath) || isSandboxWorktreePath(relativePath)) continue;
      const absolutePath = path.resolve(repository, relativePath);
      if (!isPathInside(repository, absolutePath))
        throw new Error('Could not create isolated workspace snapshot: Git returned a path outside the repository');
      const fileInfo = await fs.lstat(absolutePath).catch((error) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
      });
      if (!fileInfo || (!fileInfo.isFile() && !fileInfo.isSymbolicLink())) continue;
      paths.push(relativePath.replaceAll('\\', '/'));
    }
    if (paths.length) {
      const pathspecPath = path.join(temporaryDirectory, 'pathspecs');
      await fs.writeFile(pathspecPath, `${paths.map((relativePath) => `:(top,literal)${relativePath}`).join('\0')}\0`);
      await runGit(repository, ['add', '-f', '--pathspec-from-file', pathspecPath, '--pathspec-file-nul'], {
        signal,
        hooksPath,
        extraConfig: disabledFilters,
        environment: indexEnvironment,
      });
    }
    const tree = await runGit(repository, ['write-tree'], {
      signal,
      hooksPath,
      extraConfig: disabledFilters,
      environment: indexEnvironment,
    });
    const commit = await runGit(
      repository,
      [
        '-c',
        'user.name=Xyst AI Assistant',
        '-c',
        'user.email=snapshot@xyst.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit-tree',
        tree.stdout.trim(),
        '-m',
        'Xyst isolated workspace baseline',
      ],
      { signal, hooksPath, extraConfig: disabledFilters, environment: indexEnvironment },
    );
    return commit.stdout.trim();
  } finally {
    await fs.rm(hooksPath, { recursive: true, force: true });
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function isolatedGitEnvironment(overrides = {}) {
  const environment = safeProcessEnvironment(process.env);
  for (const key of Object.keys(environment)) {
    if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|NAMESPACE)$/i.test(key))
      delete environment[key];
  }
  return { ...environment, ...overrides };
}

function isWorkspaceStatePath(relativePath, agentStatePath) {
  const candidate = relativePath.replaceAll('\\', '/').replace(/\/$/, '');
  const state = agentStatePath.replace(/\/$/, '');
  const normalizedCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const normalizedState = process.platform === 'win32' ? state.toLowerCase() : state;
  return normalizedCandidate === normalizedState || normalizedCandidate.startsWith(`${normalizedState}/`);
}

function isSandboxWorktreePath(relativePath) {
  const candidate = relativePath.replaceAll('\\', '/').replace(/\/$/, '');
  return candidate === '.xyst-worktrees' || candidate.startsWith('.xyst-worktrees/');
}

async function runGit(cwd, args, { signal, hooksPath, extraConfig = [], environment, maxOutputBytes } = {}) {
  const result = await git(cwd, args, { signal, hooksPath, extraConfig, environment });
  if (maxOutputBytes && result.truncated) throw new Error(`Could not run Git ${args[0]}: output exceeded ${maxOutputBytes} bytes`);
  if (result.exitCode !== 0) throw gitFailure(`run Git ${args[0]}`, result);
  return result;
}

async function git(cwd, args, { signal, hooksPath, extraConfig = [], environment, maxOutputBytes = 64_000 } = {}) {
  return runProcess(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      ...(hooksPath ? ['-c', `core.hooksPath=${hooksPath}`] : []),
      ...extraConfig.flatMap((value) => ['-c', value]),
      '-C',
      cwd,
      ...args,
    ],
    { cwd, signal, timeoutMs: 60_000, maxOutputBytes, ...(environment ? { env: environment } : {}) },
  );
}

export async function getGitFilterOverrides(repository, signal) {
  const result = await runProcess(
    'git',
    ['-C', repository, 'config', '--null', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'],
    {
      signal,
      timeoutMs: 15_000,
      maxOutputBytes: 32_000,
    },
  );
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) throw gitFailure('inspect Git filters', result);
  if (result.truncated) throw new Error('Could not safely inspect Git filters: configuration output exceeded 32000 bytes');
  const drivers = new Set();
  const records = result.stdout.split('\0').filter(Boolean);
  for (const record of records) {
    const separator = record.indexOf('\n');
    if (separator <= 0) throw new Error('Could not safely inspect Git filters: malformed configuration output');
    const key = record.slice(0, separator).toLowerCase();
    const match = key.match(/^filter\.(.+)\.(?:clean|smudge|process|required)$/);
    if (match) drivers.add(match[1]);
  }
  return [...drivers].flatMap((driver) => [
    `filter.${driver}.clean=`,
    `filter.${driver}.smudge=`,
    `filter.${driver}.process=`,
    `filter.${driver}.required=false`,
  ]);
}

async function createEmptyHooksDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'xyst-empty-hooks-'));
}

function validateBranch(branch) {
  if (typeof branch !== 'string' || branch.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch))
    throw new TypeError('Branch must be a valid Git branch name');
  if (
    branch.includes('..') ||
    branch.includes('//') ||
    branch.endsWith('/') ||
    branch.endsWith('.') ||
    branch.endsWith('.lock') ||
    branch.includes('@{')
  )
    throw new TypeError('Branch must be a valid Git branch name');
}

function parseWorktreePorcelain(source) {
  const entries = [];
  for (const record of source.split('\0\0')) {
    let entry = null;
    for (const line of record.split('\0')) {
      if (line.startsWith('worktree ')) entry = { path: line.slice(9), branch: null, head: null };
      else if (entry && line.startsWith('branch refs/heads/')) entry.branch = line.slice('branch refs/heads/'.length);
      else if (entry && line.startsWith('HEAD ')) entry.head = line.slice(5);
    }
    if (entry?.path) entries.push(entry);
  }
  return entries;
}

function gitFailure(operation, result) {
  const detail = (result.stderr || result.stdout || `exit code ${result.exitCode}`).trim();
  return new Error(`Could not ${operation}: ${detail}`);
}
