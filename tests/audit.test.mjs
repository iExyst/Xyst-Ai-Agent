import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ToolAuditStore } from '../src/tools/audit.mjs';
import { createSymlinkOrSkip, createTempDirectory } from './helpers.mjs';

test('tool audit is append-only, redacts credentials, and omits file contents', async (t) => {
  const root = await createTempDirectory('xyst-audit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audit = new ToolAuditStore(root);
  await audit.record({
    sessionId: 'session-id',
    toolCallId: 'call-1',
    tool: 'write_file',
    args: {
      path: 'src/config.js',
      content: 'source with token=super-secret-value',
      nested: { new_text: 'private diff', mode: 'write', api_key: 'audit-field-canary' },
      serialized: JSON.stringify({ clientSecret: 'audit-json-field-canary' }),
      api_key_secret: 'vault-reference-name',
    },
    decision: 'require_approval',
    policyRuleId: 'API_KEY=rule-secret-canary',
    approvalResult: true,
    approvedHunks: ['token=hunk-secret-canary'],
    outcome: 'started',
  });
  await audit.record({
    sessionId: 'session-id',
    toolCallId: 'call-1',
    tool: 'write_file',
    args: { path: 'src/config.js', content: 'source with token=super-secret-value' },
    decision: 'require_approval',
    approvalResult: true,
    outcome: 'succeeded',
    durationMs: 12,
  });
  const lines = (await fs.readFile(path.join(root, '.agent', 'audit', 'tool-events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
  const records = lines.map((line) => JSON.parse(line));
  assert.equal(records[0].arguments.content, '[OMITTED]');
  assert.equal(records[0].arguments.nested.new_text, '[OMITTED]');
  assert.equal(records[0].arguments.nested.api_key, '[REDACTED]');
  assert.equal(JSON.parse(records[0].arguments.serialized).clientSecret, '[REDACTED]');
  assert.equal(records[0].arguments.api_key_secret, 'vault-reference-name');
  assert.equal(records[0].arguments.path, 'src/config.js');
  assert.equal(records[0].policy_rule_id, 'API_KEY=[REDACTED]');
  assert.deepEqual(records[0].approved_hunks, ['token=[REDACTED]']);
  assert.equal(records[1].outcome, 'succeeded');
  assert.equal(records[1].result_summary, 'Tool completed successfully');
  assert.equal(records[1].duration_ms, 12);
  assert.doesNotMatch(
    lines.join('\n'),
    /source with|private diff|super-secret-value|rule-secret-canary|hunk-secret-canary|audit-field-canary|audit-json-field-canary/,
  );
});

test('MCP audit history is bounded, newest-first, and omits arbitrary arguments', async (t) => {
  const root = await createTempDirectory('xyst-mcp-audit-history-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audit = new ToolAuditStore(root);
  assert.deepEqual(await audit.listMcpHistory(), { entries: [], truncated: false });
  for (const [index, tool] of ['mcp_server', 'read_file', 'manage_mcp_server', 'test_mcp_server', 'mcp__docs__search'].entries()) {
    await audit.record({
      sessionId: `session-${index}`,
      toolCallId: `call-${index}`,
      tool,
      args: { server: 'docs', action: 'test', query: 'private user search', command: 'sensitive executable' },
      decision: 'allow',
      outcome: index === 3 ? 'failed' : 'succeeded',
      errorCode: index === 3 ? 'MCP_SERVER_UNAVAILABLE' : null,
    });
  }
  const history = await audit.listMcpHistory({ limit: 2 });
  assert.equal(history.entries.length, 2);
  assert.equal(history.entries[0].tool, 'mcp__docs__search');
  assert.equal(history.entries[1].tool, 'test_mcp_server');
  assert.equal(history.entries[1].error_code, 'MCP_SERVER_UNAVAILABLE');
  assert.equal(history.entries[1].server, 'docs');
  assert.equal(history.entries[1].action, 'test');
  assert.equal(history.truncated, true);
  assert.equal(Object.hasOwn(history.entries[0], 'arguments'), false);
  assert.doesNotMatch(JSON.stringify(history), /private user search|sensitive executable/);
  await assert.rejects(audit.listMcpHistory({ limit: 201 }), /1 to 200/);
});

test('MCP audit history refuses a symlinked audit log', async (t) => {
  const root = await createTempDirectory('xyst-mcp-audit-link-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audit = new ToolAuditStore(root);
  await fs.mkdir(audit.directory, { recursive: true });
  const target = path.join(root, 'outside.jsonl');
  await fs.writeFile(target, '');
  if (!(await createSymlinkOrSkip(t, target, audit.file, 'file'))) return;
  await assert.rejects(audit.listMcpHistory(), /non-symlink/);
  assert.equal(await fs.readFile(target, 'utf8'), '');
});

test('tool audit rejects a symlink destination', async (t) => {
  const root = await createTempDirectory('xyst-audit-link-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audit = new ToolAuditStore(root);
  await fs.mkdir(audit.directory, { recursive: true });
  const target = path.join(root, 'outside.jsonl');
  await fs.writeFile(target, '');
  if (!(await createSymlinkOrSkip(t, target, audit.file, 'file'))) return;
  await assert.rejects(audit.record({ sessionId: 's', toolCallId: 'c', tool: 'read_file', args: {}, decision: 'allow' }), /non-symlink/);
  assert.equal(await fs.readFile(target, 'utf8'), '');
});

test('tool audit refuses symlinked state directories', async (t) => {
  const root = await createTempDirectory('xyst-audit-directory-link-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audit = new ToolAuditStore(root);
  const external = path.join(root, 'external');
  await fs.mkdir(external);

  const agentDirectory = path.join(root, '.agent');
  if (!(await createSymlinkOrSkip(t, external, agentDirectory))) return;
  await assert.rejects(
    audit.record({ sessionId: 's', toolCallId: 'c', tool: 'read_file', args: {}, decision: 'allow' }),
    /Audit directory components must be non-symlink directories/,
  );
  await fs.rm(agentDirectory, { force: true });

  await fs.mkdir(agentDirectory);
  const auditDirectory = path.join(agentDirectory, 'audit');
  if (!(await createSymlinkOrSkip(t, external, auditDirectory))) return;
  await assert.rejects(
    audit.record({ sessionId: 's', toolCallId: 'c', tool: 'read_file', args: {}, decision: 'allow' }),
    /Audit directory components must be non-symlink directories/,
  );
  assert.deepEqual(await fs.readdir(external), []);
});

test('tool audit refuses a directory swap during file open', async (t) => {
  const root = await createTempDirectory('xyst-audit-swap-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audit = new ToolAuditStore(root);
  await fs.mkdir(audit.directory, { recursive: true });
  const linkTarget = path.join(root, 'link-target');
  const linkProbe = path.join(root, 'link-probe');
  await fs.mkdir(linkTarget);
  if (!(await createSymlinkOrSkip(t, linkTarget, linkProbe))) return;
  await fs.unlink(linkProbe);
  const renameProbe = path.join(root, 'rename-probe');
  try {
    await fs.rename(audit.directory, renameProbe);
    await fs.rename(renameProbe, audit.directory);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) throw error;
    const reason = `Audit directory rename is unavailable: ${error.code}`;
    if (process.env.XYST_REQUIRE_LINK_TESTS === 'true') throw new Error(reason, { cause: error });
    return t.skip(reason);
  }
  const originalOpen = fs.open;
  let movedDirectory;
  let swapped = false;

  fs.open = async (...args) => {
    if (swapped || args[0] !== audit.file) return originalOpen(...args);
    swapped = true;
    movedDirectory = path.join(root, 'moved-audit');
    await fs.rename(audit.directory, movedDirectory);
    await fs.symlink(movedDirectory, audit.directory, process.platform === 'win32' ? 'junction' : 'dir');
    return originalOpen(...args);
  };
  t.after(() => {
    fs.open = originalOpen;
  });

  await assert.rejects(
    audit.record({ sessionId: 's', toolCallId: 'c', tool: 'read_file', args: {}, decision: 'allow' }),
    /Audit directory components must be non-symlink directories/,
  );
  assert.equal(swapped, true);
  assert.equal(await fs.readFile(path.join(movedDirectory, 'tool-events.jsonl'), 'utf8'), '');
});

test('tool audit refuses a hard-linked audit destination', async (t) => {
  const root = await createTempDirectory('xyst-audit-hardlink-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const audit = new ToolAuditStore(root);
  await audit.record({ sessionId: 's', toolCallId: 'c', tool: 'read_file', args: {}, decision: 'allow' });
  const linkedPath = path.join(root, 'external-audit.jsonl');
  try {
    await fs.link(audit.file, linkedPath);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) {
      const reason = `Hard-link creation is unavailable: ${error.code}`;
      if (process.env.XYST_REQUIRE_LINK_TESTS === 'true') throw new Error(reason, { cause: error });
      return t.skip(reason);
    }
    throw error;
  }
  const before = await fs.readFile(linkedPath, 'utf8');
  await assert.rejects(
    audit.record({ sessionId: 's', toolCallId: 'c', tool: 'read_file', args: {}, decision: 'allow' }),
    /regular single-link non-symlink file/,
  );
  assert.equal(await fs.readFile(linkedPath, 'utf8'), before);
});
