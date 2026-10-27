import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBuiltinTools } from '../src/tools/builtins.mjs';
import { evaluateApprovalRules, matchesGlob } from '../src/tools/approval-rules.mjs';
import { createTempDirectory } from './helpers.mjs';

test('path globs support single and recursive segments without crossing a single-star boundary', () => {
  assert.equal(matchesGlob('src/*.js', 'src/app.js', { pathMode: true }), true);
  assert.equal(matchesGlob('src/*.js', 'src/lib/app.js', { pathMode: true }), false);
  assert.equal(matchesGlob('src/**/*.js', 'src/app.js', { pathMode: true }), true);
  assert.equal(matchesGlob('src/**/*.js', 'src/lib/app.js', { pathMode: true }), true);
  assert.equal(matchesGlob('src/**/*.js', 'src-old/app.js', { pathMode: true }), false);
});

test('configured write path denies override allows and use canonical workspace-relative paths', async (t) => {
  const root = await createTempDirectory('xyst-approval-rules-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'generated'), { recursive: true });
  const tools = createBuiltinTools({ workspaceRoot: root });
  const tool = tools.metadata('write_file');
  const args = { path: 'generated/out.txt', content: 'hello' };
  const allow = await evaluateApprovalRules({
    workspaceRoot: root,
    config: { approvals: { auto_approve_write_paths: ['generated/**'] } },
    tool,
    args,
  });
  assert.equal(allow.decision, 'allow');
  assert.equal(allow.source, 'configuration');
  const deny = await evaluateApprovalRules({
    workspaceRoot: root,
    config: { approvals: { auto_approve_write_paths: ['generated/**'], deny_write_paths: ['generated/private/**'] } },
    tool,
    args: { ...args, path: 'generated/private/out.txt' },
  });
  assert.equal(deny.decision, 'deny');
  const traversal = await evaluateApprovalRules({
    workspaceRoot: root,
    config: { approvals: { auto_approve_write_paths: ['**'] } },
    tool,
    args: { ...args, path: '../outside.txt' },
  });
  assert.equal(traversal.decision, 'deny');
  const agentState = await evaluateApprovalRules({
    workspaceRoot: root,
    config: { approvals: { auto_approve_write_paths: ['**'] } },
    tool,
    args: { ...args, path: '.agent/audit/tool-events.jsonl' },
  });
  assert.equal(agentState.decision, 'deny');
});

test('configured process rules match argv patterns and explicit tool denials win', async () => {
  const tool = createBuiltinTools({ workspaceRoot: process.cwd(), config: { tools: { shell_enabled: true } } }).metadata('run_process');
  const args = { command: 'npm', args: ['test', '--', 'focused suite'] };
  const allowed = await evaluateApprovalRules({
    workspaceRoot: process.cwd(),
    config: { approvals: { auto_approve_process_commands: ['npm test -- "focused suite"'] } },
    tool,
    args,
  });
  assert.equal(allowed.decision, 'allow');
  const denied = await evaluateApprovalRules({
    workspaceRoot: process.cwd(),
    config: {
      approvals: { auto_approve_process_commands: ['npm *'], deny_process_commands: ['npm test *'], auto_approve_tools: ['run_process'] },
    },
    tool,
    args,
  });
  assert.equal(denied.decision, 'deny');
  const toolDeny = await evaluateApprovalRules({
    workspaceRoot: process.cwd(),
    config: { approvals: { auto_approve_tools: ['run_process'], deny_tools: ['run_process'] } },
    tool,
    args,
  });
  assert.equal(toolDeny.decision, 'deny');
});
