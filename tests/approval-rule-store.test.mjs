import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApprovalRuleStore } from '../src/tools/approval-rule-store.mjs';
import { evaluateApprovalRules } from '../src/tools/approval-rules.mjs';
import { createBuiltinTools } from '../src/tools/builtins.mjs';
import { createSymlinkOrSkip, createTempDirectory } from './helpers.mjs';

test('approval rule store refuses linked approval state directories without writing outside the workspace', async (t) => {
  const root = await createTempDirectory('xyst-approval-symlink-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.mkdir(path.join(root, '.agent'));
  const store = new ApprovalRuleStore(root);
  if (!(await createSymlinkOrSkip(t, outside, store.directory))) return;

  await assert.rejects(
    store.add({ tool: 'write_file', scope: 'path_glob', pattern: 'generated/**', decision: 'allow', durationMs: 60_000 }),
    /approval rule state path contains a non-directory or symlink/i,
  );
  await assert.rejects(fs.stat(path.join(outside, 'rules.lock')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(outside, 'rules.json')), { code: 'ENOENT' });
});

test('approval rule store refuses linked rules files without following them', async (t) => {
  const root = await createTempDirectory('xyst-approval-file-link-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ApprovalRuleStore(root);
  await fs.mkdir(store.directory, { recursive: true });
  const outside = path.join(root, 'outside-rules.json');
  const contents = '{"schema_version":1,"rules":[]}\n';
  await fs.writeFile(outside, contents, { flag: 'wx' });
  if (!(await createSymlinkOrSkip(t, outside, store.file, 'file'))) return;

  await assert.rejects(store.list(), { code: 'INVALID_RULE_STORE' });
  assert.equal(await fs.readFile(outside, 'utf8'), contents);
});

test('approval rule update restores an interrupted rules file without dropping saved decisions', async (t) => {
  const root = await createTempDirectory('xyst-approval-recovery-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ApprovalRuleStore(root);
  await store.add({ tool: 'write_file', scope: 'path_glob', pattern: 'generated/**', decision: 'allow', durationMs: 60_000 });
  const backup = `${store.file}.00000000-0000-4000-8000-000000000001.bak`;
  await fs.rename(store.file, backup);
  await assert.rejects(store.list(), { code: 'APPROVAL_RULE_RECOVERY_REQUIRED' });
  await store.add({ tool: 'run_shell_script', scope: 'tool', decision: 'deny', durationMs: 60_000 });
  assert.equal((await store.list()).length, 2);
  await assert.rejects(fs.stat(backup), { code: 'ENOENT' });
});

test('approval rule store refuses hard-linked rules files', async (t) => {
  const root = await createTempDirectory('xyst-approval-file-hardlink-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ApprovalRuleStore(root);
  await fs.mkdir(store.directory, { recursive: true });
  const outside = path.join(root, 'outside-rules.json');
  await fs.writeFile(outside, '{"schema_version":1,"rules":[]}\n', { flag: 'wx' });
  try {
    await fs.link(outside, store.file);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) {
      t.skip(`Hard-link creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(store.list(), { code: 'INVALID_RULE_STORE' });
  assert.equal((await fs.stat(outside)).nlink, 2);
});

test('approval rule store refuses oversized rules files before parsing', async (t) => {
  const root = await createTempDirectory('xyst-approval-file-oversized-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ApprovalRuleStore(root);
  await fs.mkdir(store.directory, { recursive: true });
  await fs.writeFile(store.file, 'x'.repeat(1_000_001), { flag: 'wx' });
  await assert.rejects(store.list(), /approval rule state file exceeds its read limit/i);
});

test('approval rule store refuses a symlinked lock file without touching its target', async (t) => {
  const root = await createTempDirectory('xyst-approval-lock-path-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ApprovalRuleStore(root);
  await fs.mkdir(store.directory, { recursive: true });
  const outside = path.join(root, 'outside-lock');
  await fs.writeFile(outside, 'outside-lock\n', { flag: 'wx' });
  if (!(await createSymlinkOrSkip(t, outside, store.lockFile, 'file'))) return;
  await assert.rejects(
    store.add({ tool: 'write_file', scope: 'path_glob', pattern: 'generated/**', decision: 'allow', durationMs: 60_000 }),
    { code: 'INVALID_RULE_STORE' },
  );
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside-lock\n');
  await fs.unlink(store.lockFile);
});

test('approval rule store refuses hard-linked lock files', async (t) => {
  const root = await createTempDirectory('xyst-approval-lock-hardlink-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ApprovalRuleStore(root);
  await fs.mkdir(store.directory, { recursive: true });
  const outside = path.join(root, 'outside-lock');
  await fs.writeFile(outside, 'outside-lock\n', { flag: 'wx' });
  try {
    await fs.link(outside, store.lockFile);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) {
      t.skip(`Hard-link creation is unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    store.add({ tool: 'write_file', scope: 'path_glob', pattern: 'generated/**', decision: 'allow', durationMs: 60_000 }),
    { code: 'INVALID_RULE_STORE' },
  );
});

test('approval rule store refuses oversized lock files before waiting on them', async (t) => {
  const root = await createTempDirectory('xyst-approval-lock-oversized-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ApprovalRuleStore(root);
  await fs.mkdir(store.directory, { recursive: true });
  await fs.writeFile(store.lockFile, 'x'.repeat(1_025), { flag: 'wx' });
  await assert.rejects(
    store.add({ tool: 'write_file', scope: 'path_glob', pattern: 'generated/**', decision: 'allow', durationMs: 60_000 }),
    /approval rule state file exceeds its read limit/i,
  );
});

test('approval rule store applies scoped allow/deny rules, expiry, and revocation', async (t) => {
  const root = await createTempDirectory('xyst-approval-store-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ApprovalRuleStore(root);
  const tools = createBuiltinTools({ workspaceRoot: root });
  const allow = await store.add({ tool: 'write_file', scope: 'path_glob', pattern: 'generated/**', decision: 'allow', durationMs: 60_000 });
  const deny = await store.add({
    tool: 'write_file',
    scope: 'path_glob',
    pattern: 'generated/private/**',
    decision: 'deny',
    durationMs: 120_000,
  });
  const allowed = await evaluateApprovalRules({
    workspaceRoot: root,
    tool: tools.metadata('write_file'),
    args: { path: 'generated/out.txt', content: 'x' },
    ruleStore: store,
  });
  assert.equal(allowed.decision, 'allow');
  assert.equal(allowed.rule_id, allow.id);
  const denied = await evaluateApprovalRules({
    workspaceRoot: root,
    config: { approvals: { auto_approve_write_paths: ['**'] } },
    tool: tools.metadata('write_file'),
    args: { path: 'generated/private/key.txt', content: 'x' },
    ruleStore: store,
  });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.rule_id, deny.id);
  const command = await store.add({
    tool: 'run_process',
    scope: 'command_glob',
    pattern: 'npm test*',
    decision: 'allow',
    durationMs: 60_000,
  });
  const shellDeny = await store.add({ tool: 'run_shell_script', scope: 'tool', decision: 'deny', durationMs: 60_000 });
  const shellTools = createBuiltinTools({ workspaceRoot: root, config: { tools: { shell_enabled: true } } });
  const deniedShell = await evaluateApprovalRules({
    workspaceRoot: root,
    tool: shellTools.metadata('run_shell_script'),
    args: { script: 'printf unsafe' },
    ruleStore: store,
  });
  assert.equal(deniedShell.decision, 'deny');
  assert.equal(deniedShell.rule_id, shellDeny.id);
  assert.equal((await store.list()).length, 4);

  const file = path.join(root, '.agent', 'approvals', 'rules.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  const expiredRule = state.rules.find((rule) => rule.id === command.id);
  expiredRule.created_at = new Date(Date.now() - 120_000).toISOString();
  expiredRule.expires_at = new Date(Date.now() - 60_000).toISOString();
  await fs.writeFile(file, `${JSON.stringify(state)}\n`);
  assert.equal((await store.list()).find((rule) => rule.id === command.id).status, 'expired');
  assert.equal(await store.revoke(allow.id), true);
  assert.equal(await store.revoke(allow.id), false);
  const audit = (await fs.readFile(path.join(root, '.agent', 'audit', 'tool-events.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(audit.some((entry) => entry.outcome === 'rule_add_requested'));
  assert.ok(audit.some((entry) => entry.outcome === 'revoked'));
  await assert.rejects(
    store.add({ tool: 'write_file', scope: 'path_glob', pattern: '../**', decision: 'allow', durationMs: 60_000 }),
    /invalid fields/,
  );
  await assert.rejects(
    store.add({ tool: 'write_file', scope: 'path_glob', pattern: '**', decision: 'allow', durationMs: 59_999 }),
    /duration/,
  );
});

test('expired approval rules no longer allow or deny tools, paths, or commands', async (t) => {
  const root = await createTempDirectory('xyst-expired-rules-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'generated'), { recursive: true });
  const tools = createBuiltinTools({ workspaceRoot: root, config: { tools: { shell_enabled: true } } });
  const cases = [
    {
      tool: 'write_file',
      scope: 'path_glob',
      pattern: 'generated/**',
      denyPattern: 'generated/private/**',
      args: { path: 'generated/private/out.txt', content: 'x' },
      oppositeArgs: { path: 'generated/out.txt', content: 'x' },
    },
    {
      tool: 'run_process',
      scope: 'command_glob',
      pattern: 'npm test*',
      denyPattern: 'npm test private*',
      args: { command: 'npm', args: ['test', 'private'] },
      oppositeArgs: { command: 'npm', args: ['test'] },
    },
    {
      tool: 'write_file',
      denyTool: 'edit_file',
      scope: 'tool',
      args: { path: 'generated/out.txt', content: 'x' },
      denyArgs: { path: 'generated/out.txt', old_text: 'a', new_text: 'b' },
    },
  ];

  for (const [index, item] of cases.entries()) {
    const directory = path.join(root, String(index));
    await fs.mkdir(directory);
    const scopedStore = new ApprovalRuleStore(directory);
    const allow = await scopedStore.add({ ...item, decision: 'allow', durationMs: 60_000 });
    const deny = await scopedStore.add({
      ...item,
      tool: item.denyTool || item.tool,
      args: item.denyArgs || item.args,
      pattern: item.denyPattern || item.pattern,
      decision: 'deny',
      durationMs: 60_000,
    });
    const tool = tools.metadata(item.tool);
    const activeDecision = item.scope === 'tool' ? 'allow' : 'deny';
    assert.equal(
      (await evaluateApprovalRules({ workspaceRoot: root, tool, args: item.args, ruleStore: scopedStore })).decision,
      activeDecision,
      `${item.scope} active allow/deny rules must apply`,
    );
    if (item.oppositeArgs) {
      assert.equal(
        (await evaluateApprovalRules({ workspaceRoot: root, tool, args: item.oppositeArgs, ruleStore: scopedStore })).decision,
        'allow',
        `${item.scope} allow rule must apply while active`,
      );
    }
    if (item.denyTool) {
      assert.equal(
        (
          await evaluateApprovalRules({
            workspaceRoot: root,
            tool: tools.metadata(item.denyTool),
            args: item.denyArgs,
            ruleStore: scopedStore,
          })
        ).decision,
        'deny',
        'active tool-scope deny rule must apply to its exact tool',
      );
    }

    const state = JSON.parse(await fs.readFile(scopedStore.file, 'utf8'));
    for (const rule of state.rules) {
      rule.created_at = new Date(Date.now() - 120_000).toISOString();
      rule.expires_at = new Date(Date.now() - 60_000).toISOString();
    }
    await fs.writeFile(scopedStore.file, `${JSON.stringify(state)}\n`);
    assert.equal((await scopedStore.list()).filter((rule) => rule.status === 'active').length, 0);
    assert.equal(
      await evaluateApprovalRules({ workspaceRoot: root, tool, args: item.args, ruleStore: scopedStore }),
      null,
      `${item.scope} expired rules must not affect authorization`,
    );
    if (item.denyTool) {
      assert.equal(
        await evaluateApprovalRules({
          workspaceRoot: root,
          tool: tools.metadata(item.denyTool),
          args: item.denyArgs,
          ruleStore: scopedStore,
        }),
        null,
        'expired tool-scope deny rule must not affect authorization',
      );
    }
    assert.ok(allow.id && deny.id);
  }
});

test('concurrent approval rule additions are serialized without losing updates', async (t) => {
  const root = await createTempDirectory('xyst-approval-lock-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stores = Array.from({ length: 8 }, () => new ApprovalRuleStore(root));
  await Promise.all(
    stores.map((store, index) =>
      store.add({
        tool: index % 2 ? 'edit_file' : 'write_file',
        scope: 'path_glob',
        pattern: `scope-${index}/**`,
        decision: index % 2 ? 'deny' : 'allow',
        durationMs: 60_000,
      }),
    ),
  );
  assert.equal((await stores[0].list()).length, stores.length);
});
