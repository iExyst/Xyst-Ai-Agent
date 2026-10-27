import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBuiltinTools } from '../src/tools/builtins.mjs';
import { decideToolPermission } from '../src/tools/approval.mjs';
import {
  resolveToolTimeoutMs,
  resolveToolTimeoutSeconds,
  TOOL_DEFINITIONS,
  TOOL_SCHEMA_VERSION,
  validateArguments,
} from '../src/tools/schemas.mjs';
import { createSymlinkOrSkip, createTempDirectory } from './helpers.mjs';
import { isSensitivePath, redactSecrets } from '../src/platform/redaction.mjs';
import { prepareFileChange } from '../src/tools/file-change-preview.mjs';
import { GlobalMemoryStore, MemoryStore } from '../src/memory/store.mjs';

test('tool schemas reject unknown fields and malformed values', () => {
  assert.ok(Object.values(TOOL_DEFINITIONS).every((definition) => definition.schema_version === TOOL_SCHEMA_VERSION));
  assert.ok(
    Object.values(TOOL_DEFINITIONS).every(
      (definition) =>
        definition.execution &&
        ['platform_operation', 'fixed_ms', 'argument_seconds', 'config_ms'].includes(definition.execution.timeout.kind) &&
        ['not_applicable', 'process', 'unsupported'].includes(definition.execution.sandbox),
    ),
  );
  assert.ok(Object.isFrozen(TOOL_DEFINITIONS.read_file.parameters.properties.path));
  assert.throws(() => {
    TOOL_DEFINITIONS.read_file.parameters.properties.path.type = 'integer';
  }, TypeError);
  assert.equal(
    TOOL_DEFINITIONS.run_process.execution.timeout.max_seconds,
    TOOL_DEFINITIONS.run_process.parameters.properties.timeout_seconds.maximum,
  );
  assert.equal(resolveToolTimeoutSeconds(TOOL_DEFINITIONS.run_process), 30);
  assert.equal(resolveToolTimeoutSeconds(TOOL_DEFINITIONS.run_process, { timeout_seconds: 45 }), 45);
  assert.throws(() => resolveToolTimeoutSeconds(TOOL_DEFINITIONS.run_process, { timeout_seconds: 301 }), /between 1 and 300/);
  assert.equal(resolveToolTimeoutMs(TOOL_DEFINITIONS.computer_control), 20_000);
  assert.equal(resolveToolTimeoutMs(TOOL_DEFINITIONS.web_search), 10_000);
  assert.equal(resolveToolTimeoutMs(TOOL_DEFINITIONS.web_search, { web_search: { timeout_ms: 20_000 } }), 20_000);
  assert.throws(() => resolveToolTimeoutMs(TOOL_DEFINITIONS.web_search, { web_search: { timeout_ms: 100_000 } }), /between 1000 and 60000/);
  assert.equal(resolveToolTimeoutMs(TOOL_DEFINITIONS.semantic_search, { retrieval: { semantic: { timeout_ms: 45_000 } } }), 45_000);
  assert.deepEqual(validateArguments(TOOL_DEFINITIONS.read_file.parameters, '{"path":"a.txt"}'), { path: 'a.txt' });
  assert.deepEqual(
    validateArguments(TOOL_DEFINITIONS.retry_subagent_task.parameters, { task_id: '00000000-0000-4000-8000-000000000001' }),
    {
      task_id: '00000000-0000-4000-8000-000000000001',
    },
  );
  assert.throws(() => validateArguments(TOOL_DEFINITIONS.retry_subagent_task.parameters, { task_id: '../other-session' }), /valid UUID/);
  assert.deepEqual(validateArguments(TOOL_DEFINITIONS.computer_control.parameters, { action: 'press_key', key: 'CTRL+SHIFT+ESC' }), {
    action: 'press_key',
    key: 'CTRL+SHIFT+ESC',
  });
  assert.throws(() => validateArguments(TOOL_DEFINITIONS.read_file.parameters, '{"path":"a","extra":true}'), /not allowed/);
  assert.throws(() => validateArguments(TOOL_DEFINITIONS.write_file.parameters, '{"path":"a"}'), /content is required/);
  assert.throws(
    () => validateArguments(TOOL_DEFINITIONS.send_background_input.parameters, { id: 'job', input: '😀'.repeat(20_000) }),
    /UTF-8 bytes/,
  );
  const disabled = createBuiltinTools({ workspaceRoot: process.cwd(), config: { subagents: { enabled: true } } });
  assert.equal(disabled.has('delegate_task'), false);
  const enabled = createBuiltinTools({
    workspaceRoot: process.cwd(),
    config: { subagents: { enabled: true } },
    subagentManager: { delegate: async () => ({}) },
  });
  assert.equal(enabled.has('delegate_task'), true);
  assert.equal(enabled.has('retry_subagent_task'), true);
  assert.equal(TOOL_DEFINITIONS.delegate_task.destructive, true);
  assert.equal(
    decideToolPermission(TOOL_DEFINITIONS.retry_subagent_task, { task_id: '00000000-0000-4000-8000-000000000001' }).decision,
    'require_approval',
  );
  const semanticDisabled = createBuiltinTools({ workspaceRoot: process.cwd(), config: { retrieval: { semantic: { enabled: true } } } });
  assert.equal(semanticDisabled.has('semantic_search'), false);
  const semantic = createBuiltinTools({
    workspaceRoot: process.cwd(),
    config: { retrieval: { semantic: { enabled: true } } },
    semanticIndex: { search: async () => ({ matches: [] }) },
  });
  assert.equal(semantic.has('semantic_search'), true);
  assert.equal(decideToolPermission(TOOL_DEFINITIONS.semantic_search, { query: 'query' }).decision, 'require_approval');
  assert.match(decideToolPermission(TOOL_DEFINITIONS.semantic_search, { query: 'query' }).summary, /redacted workspace text/);
});

test('propose_memory saves a redacted project-memory item and requires Assisted approval', async (t) => {
  const root = await createTempDirectory('xyst-propose-memory-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tool = TOOL_DEFINITIONS.propose_memory;
  const args = { section: 'conventions', text: 'Use stable APIs; API_KEY=memory-canary' };
  assert.equal(decideToolPermission(tool, args).decision, 'require_approval');
  assert.match(decideToolPermission(tool, args).summary, /Use stable APIs/);
  assert.doesNotMatch(decideToolPermission(tool, args).summary, /memory-canary/);
  assert.equal(decideToolPermission(tool, args, { unrestricted: true }).decision, 'allow');
  assert.throws(() => validateArguments(tool.parameters, { ...args, section: 'system_policy' }), /section/);
  const tools = createBuiltinTools({ workspaceRoot: root, config: { tools: { autonomy: 'assisted' } } });
  const result = JSON.parse(await tools.call('propose_memory', args, {}));
  assert.equal(result.section, 'conventions');
  assert.equal(result.source, 'agent-proposal');
  assert.equal(result.text, 'Use stable APIs; API_KEY=[REDACTED]');
  const memory = await new MemoryStore(root).read();
  assert.equal(memory.sections.conventions.length, 1);
  assert.equal(memory.sections.conventions[0].text, result.text);
  assert.doesNotMatch(JSON.stringify(memory), /memory-canary/);
});

test('global memory proposals are exposed only when global memory is explicitly enabled', async (t) => {
  const root = await createTempDirectory('xyst-propose-global-memory-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const disabled = createBuiltinTools({ workspaceRoot: root, config: { memory: { global_enabled: false } } });
  assert.equal(disabled.has('propose_global_memory'), false);
  await assert.rejects(
    disabled.call('propose_global_memory', { section: 'user_preferences', text: 'Prefer concise notes' }),
    /Unknown or disabled/,
  );

  const userData = path.join(root, 'user-data');
  const globalMemoryStore = new GlobalMemoryStore(userData);
  const enabled = createBuiltinTools({
    workspaceRoot: root,
    config: { memory: { global_enabled: true } },
    globalMemoryStore,
  });
  assert.equal(enabled.has('propose_global_memory'), true);
  assert.equal(
    decideToolPermission(TOOL_DEFINITIONS.propose_global_memory, { section: 'user_preferences', text: 'Prefer concise notes' }).decision,
    'require_approval',
  );
  const result = JSON.parse(await enabled.call('propose_global_memory', { section: 'user_preferences', text: 'Prefer concise notes' }, {}));
  assert.equal(result.scope, 'global');
  assert.equal(result.source, 'agent-proposal');
  assert.equal((await globalMemoryStore.read()).sections.user_preferences[0].text, 'Prefer concise notes');
  assert.equal((await new MemoryStore(root).read()).sections.user_preferences.length, 0);
});

test('background process timeout defaults and bounds come from the tool execution contract', async () => {
  const requests = [];
  const tools = createBuiltinTools({
    workspaceRoot: process.cwd(),
    config: { tools: { shell_enabled: true } },
    processManager: {
      start: async (request) => {
        requests.push(request);
        return { id: 'process-id' };
      },
    },
  });
  await tools.call('start_background_process', { command: 'node' }, { sessionId: 'session-id' });
  await tools.call('start_background_process', { command: 'node', timeout_seconds: 90 }, { sessionId: 'session-id' });
  assert.equal(requests[0].timeout_seconds, TOOL_DEFINITIONS.start_background_process.execution.timeout.default_seconds);
  assert.equal(requests[1].timeout_seconds, 90);
  await assert.rejects(
    tools.call('start_background_process', { command: 'node', timeout_seconds: 86_401 }, { sessionId: 'session-id' }),
    /between 1 and 86400/,
  );
});

test('unrestricted process tools default to no automatic timeout while allowing explicit timeouts', async () => {
  const requests = [];
  const tools = createBuiltinTools({
    workspaceRoot: process.cwd(),
    config: { tools: { autonomy: 'unrestricted' } },
    processManager: {
      start: async (request) => {
        requests.push(request);
        return { id: 'process-id' };
      },
    },
  });
  await tools.call('start_background_process', { command: 'node' }, { sessionId: 'session-id' });
  await tools.call('start_background_process', { command: 'node', timeout_seconds: 90 }, { sessionId: 'session-id' });
  assert.equal(requests[0].timeout_seconds, null);
  assert.equal(requests[1].timeout_seconds, 90);
});

test('computer control is exposed only with process access and remains approval-gated in assisted mode', () => {
  const disabled = createBuiltinTools({ workspaceRoot: process.cwd(), config: { tools: { autonomy: 'assisted' } } });
  assert.equal(disabled.has('computer_control'), false);
  const assisted = createBuiltinTools({ workspaceRoot: process.cwd(), config: { tools: { shell_enabled: true } } });
  assert.equal(assisted.has('computer_control'), true);
  assert.equal(
    decideToolPermission(TOOL_DEFINITIONS.computer_control, { action: 'click', expected_name: 'Save' }, { shellEnabled: true }).decision,
    'require_approval',
  );
  assert.match(
    decideToolPermission(TOOL_DEFINITIONS.computer_control, { action: 'click_at', x: 250, y: 400, button: 'right' }, { shellEnabled: true })
      .summary,
    /\(250, 400\).*right/,
  );
  const unrestricted = createBuiltinTools({ workspaceRoot: process.cwd(), config: { tools: { autonomy: 'unrestricted' } } });
  assert.equal(unrestricted.has('computer_control'), true);
  const sandboxed = createBuiltinTools({
    workspaceRoot: process.cwd(),
    config: { tools: { shell_enabled: true }, sandbox: { mode: 'required' } },
  });
  assert.equal(sandboxed.has('computer_control'), false);
});

test('approval policy auto-allows reads, requires confirmation for changes, and denies disabled processes', () => {
  assert.equal(decideToolPermission(TOOL_DEFINITIONS.read_file, { path: 'a' }).decision, 'allow');
  assert.equal(decideToolPermission(TOOL_DEFINITIONS.write_file, { path: 'a' }).decision, 'require_approval');
  const webApproval = decideToolPermission(TOOL_DEFINITIONS.web_search, { query: 'current release notes' });
  assert.equal(webApproval.decision, 'require_approval');
  assert.match(webApproval.summary, /current release notes/);
  const delegationApproval = decideToolPermission(TOOL_DEFINITIONS.delegate_task, { task: 'Inspect parser' });
  assert.equal(delegationApproval.decision, 'require_approval');
  assert.match(delegationApproval.summary, /separate Git worktree/);
  assert.equal(decideToolPermission(TOOL_DEFINITIONS.run_process, { command: 'whoami' }).decision, 'deny');
  assert.equal(
    decideToolPermission(TOOL_DEFINITIONS.run_process, { command: 'whoami' }, { shellEnabled: true }).decision,
    'require_approval',
  );
  assert.equal(decideToolPermission(TOOL_DEFINITIONS.run_process, { command: 'whoami' }, { unrestricted: true }).decision, 'allow');
  assert.equal(
    decideToolPermission(TOOL_DEFINITIONS.run_shell_script, { script: 'whoami' }, { shellEnabled: true }).decision,
    'require_approval',
  );
  assert.equal(decideToolPermission(TOOL_DEFINITIONS.run_shell_script, { script: 'whoami' }, { unrestricted: true }).decision, 'allow');
  assert.match(
    decideToolPermission(TOOL_DEFINITIONS.run_shell_script, { script: 'whoami' }, { shellEnabled: true }).summary,
    /native shell script.*whoami/,
  );
});

test('credential path and content filters block common secret sources without hiding source modules', () => {
  assert.equal(isSensitivePath('.env'), true);
  assert.equal(isSensitivePath('.env.example'), false);
  assert.equal(isSensitivePath('C:\\Users\\me\\.aws\\credentials'), true);
  assert.equal(isSensitivePath('.agent/sessions/current.json'), true);
  assert.equal(isSensitivePath('src/secrets.mjs'), false);
  assert.equal(redactSecrets('AWS_SECRET_ACCESS_KEY="sensitive-value"'), 'AWS_SECRET_ACCESS_KEY=[REDACTED]');
  assert.equal(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz123456'), '[REDACTED TOKEN]');
});

test('assisted file tools enforce sensitive-path rules after resolving symlink aliases', async (t) => {
  const root = await createTempDirectory('xyst-sensitive-link-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const protectedDir = path.join(root, '.ssh');
  await fs.mkdir(protectedDir);
  await fs.writeFile(path.join(protectedDir, 'id_ed25519'), 'private material');
  if (!(await createSymlinkOrSkip(t, protectedDir, path.join(root, 'alias')))) return;
  const tools = createBuiltinTools({ workspaceRoot: root, config: { tools: { autonomy: 'assisted' } } });
  const preview = await prepareFileChange(
    root,
    'edit_file',
    { path: 'alias/id_ed25519', old_string: 'private', new_string: 'public' },
    { tools: { autonomy: 'assisted' } },
  );
  assert.equal(preview.snapshot, null);
  assert.match(preview.preview.unavailable_reason, /secret-safety policy/);
  assert.doesNotMatch(JSON.stringify(preview.preview), /private material/);
  await assert.rejects(tools.call('read_file', { path: 'alias/id_ed25519' }), /credential or key material/);
  await assert.rejects(tools.call('write_file', { path: 'alias/id_ed25519', content: 'replacement' }), /credential or key files/);
});

test('workspace tools read, search, list, write atomically, and apply only unique edits', async (t) => {
  const root = await createTempDirectory('xyst-tools-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'code.js'), 'alpha\nbeta\n');
  await fs.writeFile(path.join(root, '.env'), 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789');
  await fs.writeFile(path.join(root, 'src', 'settings.js'), 'api_key = "sk-abcdefghijklmnopqrstuvwxyz0123456789"');
  await fs.writeFile(path.join(root, '.gitignore'), '*.secret\nignored/\n');
  await fs.writeFile(path.join(root, 'key.secret'), 'needle should be ignored');
  await fs.mkdir(path.join(root, 'ignored'));
  await fs.writeFile(path.join(root, 'ignored', 'x.txt'), 'needle ignored');
  const tools = createBuiltinTools({ workspaceRoot: root, config: {} });

  assert.match(await tools.call('read_file', { path: 'src/code.js' }), /alpha\\nbeta/);
  await assert.rejects(tools.call('read_file', { path: '.env' }), /secret-safety policy/);
  assert.doesNotMatch(await tools.call('read_file', { path: 'src/settings.js' }), /abcdefghijklmnopqrstuvwxyz/);
  assert.match(await tools.call('list_dir', { path: '.', recursive: false }), /src/);
  await fs.mkdir(path.join(root, '.agent'), { recursive: true });
  await assert.rejects(tools.call('list_dir', { path: '.agent' }), /protected paths/);
  const results = JSON.parse(await tools.call('search_files', { query: 'needle' }));
  assert.deepEqual(results.matches, []);
  assert.match(await tools.call('write_file', { path: 'src/new.txt', content: 'before before' }), /written/);
  await assert.rejects(tools.call('edit_file', { path: 'src/new.txt', old_string: 'before', new_string: 'after' }), /multiple places/);
  await tools.call('edit_file', { path: 'src/new.txt', old_string: 'before before', new_string: 'done' });
  assert.equal(await fs.readFile(path.join(root, 'src', 'new.txt'), 'utf8'), 'done');
  await assert.rejects(tools.call('write_file', { path: '../escape.txt', content: 'no' }), /escapes workspace/);
  await assert.rejects(tools.call('write_file', { path: 'large.txt', content: 'x'.repeat(1_000_001) }), /write limit/);
  assert.equal(tools.has('run_process'), false);
  assert.equal(createBuiltinTools({ workspaceRoot: root, config: { tools: { shell_enabled: true } } }).has('run_process'), true);
  assert.equal(createBuiltinTools({ workspaceRoot: root, config: { tools: { shell_enabled: true } } }).has('run_shell_script'), true);
});

test('file replacement and edits preserve existing POSIX permissions', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows file permissions use ACLs rather than POSIX mode bits');
  const root = await createTempDirectory('xyst-tool-file-mode-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'script.sh');
  await fs.writeFile(executable, '#!/bin/sh\necho old\n');
  await fs.chmod(executable, 0o751);
  const tools = createBuiltinTools({ workspaceRoot: root, config: { tools: { autonomy: 'unrestricted' } } });

  await tools.call('edit_file', { path: 'script.sh', old_string: 'echo old', new_string: 'echo edited' });
  assert.equal((await fs.stat(executable)).mode & 0o777, 0o751, 'editing must retain execute and group permissions');

  await tools.call('write_file', { path: 'script.sh', content: '#!/bin/sh\necho replaced\n' });
  assert.equal((await fs.stat(executable)).mode & 0o777, 0o751, 'overwriting must retain execute and group permissions');

  await tools.call('write_file', { path: 'new.txt', content: 'private by default' });
  assert.equal((await fs.stat(path.join(root, 'new.txt'))).mode & 0o777, 0o600, 'new files must keep the private default');
});

test('file writes refuse a target that resolves differently immediately before replacement', async (t) => {
  const root = await createTempDirectory('xyst-tool-path-recheck-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.txt');
  const alternate = path.join(root, 'alternate.txt');
  await fs.writeFile(target, 'original target');
  await fs.writeFile(alternate, 'alternate target');
  const tools = createBuiltinTools({ workspaceRoot: root, config: { tools: { autonomy: 'unrestricted' } } });
  const realpath = fs.realpath;
  let targetResolutions = 0;
  fs.realpath = async (requested, ...options) => {
    if (path.resolve(requested) === target && ++targetResolutions === 2) return alternate;
    return realpath(requested, ...options);
  };
  t.after(() => {
    fs.realpath = realpath;
  });

  await assert.rejects(
    tools.call('write_file', { path: target, content: 'must not be written' }),
    /File target changed while preparing the write/,
  );
  assert.equal(targetResolutions, 2);
  assert.equal(await fs.readFile(target, 'utf8'), 'original target');
  assert.equal(await fs.readFile(alternate, 'utf8'), 'alternate target');
});

test('file writes revalidate the destination before writing content to the temporary file', async (t) => {
  const root = await createTempDirectory('xyst-tool-write-parent-swap-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'source');
  const redirect = path.join(root, 'redirect');
  await fs.mkdir(parent);
  await fs.mkdir(redirect);

  const tools = createBuiltinTools({ workspaceRoot: root, config: { tools: { autonomy: 'unrestricted' } } });
  const open = fs.open;
  const realpath = fs.realpath;
  let swapped = false;
  let temporary;
  fs.open = async (requestedPath, ...options) => {
    const handle = await open(requestedPath, ...options);
    if (!swapped && requestedPath.endsWith('.tmp') && path.dirname(path.resolve(requestedPath)) === parent) {
      temporary = requestedPath;
      swapped = true;
    }
    return handle;
  };
  fs.realpath = async (requestedPath, ...options) => {
    if (swapped && path.resolve(requestedPath) === parent) return redirect;
    return realpath(requestedPath, ...options);
  };
  t.after(() => {
    fs.open = open;
    fs.realpath = realpath;
  });

  await assert.rejects(
    tools.call('write_file', { path: 'source/secret.txt', content: 'sensitive proposed content' }),
    /escapes workspace|target changed while preparing/,
  );
  assert.equal(swapped, true);
  await assert.rejects(fs.stat(temporary), { code: 'ENOENT' });
  assert.equal(await fs.readdir(parent).then((entries) => entries.length), 0);
  assert.deepEqual(await fs.readdir(redirect), []);
});

test('file edits refuse content changed after the opened source was read', async (t) => {
  const root = await createTempDirectory('xyst-edit-stale-source-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target.txt');
  await fs.writeFile(target, 'original text');
  const tools = createBuiltinTools({ workspaceRoot: root, config: { tools: { autonomy: 'unrestricted' } } });
  const realpath = fs.realpath;
  let targetResolutions = 0;
  fs.realpath = async (requested, ...options) => {
    const resolved = await realpath(requested, ...options);
    if (path.resolve(requested) === target && ++targetResolutions === 3) await fs.writeFile(target, 'external update');
    return resolved;
  };
  t.after(() => {
    fs.realpath = realpath;
  });

  await assert.rejects(
    tools.call('edit_file', { path: target, old_string: 'original', new_string: 'replacement' }),
    (error) => error.code === 'STALE_FILE' && /no changes were applied/.test(error.message),
  );
  assert.equal(await fs.readFile(target, 'utf8'), 'external update');
});

test('edit_file enforces its read limit if a file grows after the initial size check', async (t) => {
  const root = await createTempDirectory('xyst-edit-growth-limit-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'growing.txt');
  await fs.writeFile(target, 'original text');
  const limit = 128;
  const tools = createBuiltinTools({ workspaceRoot: root, config: { tools: { max_file_bytes: limit } } });
  const stat = fs.stat;
  let grew = false;
  fs.stat = async (requestedPath, ...options) => {
    if (!grew && path.resolve(requestedPath) === target) {
      grew = true;
      await fs.writeFile(target, Buffer.alloc(4 * 1024 * 1024, 0x61));
    }
    return stat(requestedPath, ...options);
  };
  t.after(() => {
    fs.stat = stat;
  });

  await assert.rejects(
    tools.call('edit_file', { path: 'growing.txt', old_string: 'original', new_string: 'replacement' }),
    /File is too large to edit through this tool/,
  );
  assert.equal(grew, true);
  assert.equal((await stat(target)).size, 4 * 1024 * 1024, 'the concurrent file change must remain untouched');
});

test('read_file streams large CRLF files while returning only the requested line range', async (t) => {
  const root = await createTempDirectory('xyst-streaming-read-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const largeFile = path.join(root, 'large.log');
  const lines = Array.from({ length: 90_000 }, (_, index) => `line-${String(index).padStart(6, '0')}`);
  await fs.writeFile(largeFile, `${lines.join('\r\n')}\r\n`);
  assert.ok((await fs.stat(largeFile)).size > 1_000_000);
  const tools = createBuiltinTools({
    workspaceRoot: root,
    config: { tools: { max_file_bytes: 2_000_000 }, budgets: { max_tool_output_bytes: 200_000 } },
  });

  const result = JSON.parse(await tools.call('read_file', { path: 'large.log', start_line: 89_999, end_line: 90_000 }));
  assert.equal(result.start_line, 89_999);
  assert.equal(result.end_line, 90_000);
  assert.equal(result.content, 'line-089998\nline-089999');
  await assert.rejects(tools.call('read_file', { path: 'large.log', start_line: 3, end_line: 2 }), /end_line must be greater/);

  await fs.writeFile(path.join(root, 'binary.log'), Buffer.from('visible\n\0hidden'));
  await assert.rejects(tools.call('read_file', { path: 'binary.log', start_line: 1, end_line: 1 }), /Binary file content/);

  const boundaryLine = `${'a'.repeat(65_535)}💡`;
  await fs.writeFile(path.join(root, 'unicode.txt'), `${boundaryLine}\r\n終わり`);
  const unicode = JSON.parse(await tools.call('read_file', { path: 'unicode.txt', start_line: 1, end_line: 2 }));
  assert.equal(unicode.content, `${boundaryLine}\n終わり`);

  await fs.writeFile(path.join(root, 'invalid-utf8.txt'), Buffer.from([0x66, 0x80, 0x6f]));
  await assert.rejects(tools.call('read_file', { path: 'invalid-utf8.txt' }), /not valid UTF-8 text/);
  await assert.rejects(
    tools.call('edit_file', { path: 'invalid-utf8.txt', old_string: 'f', new_string: 'repaired' }),
    /not valid UTF-8 text/,
  );
  assert.deepEqual(await fs.readFile(path.join(root, 'invalid-utf8.txt')), Buffer.from([0x66, 0x80, 0x6f]));
});

test('unrestricted shell script tool executes through the native shell and returns its result', async (t) => {
  const root = await createTempDirectory('xyst-shell-script-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = createBuiltinTools({ workspaceRoot: root, config: { tools: { autonomy: 'unrestricted' } } });
  assert.equal(tools.has('run_shell_script'), true);
  const script = process.platform === 'win32' ? "Write-Output 'native-shell-ok'" : 'printf native-shell-ok';
  const result = JSON.parse(await tools.call('run_shell_script', { script, cwd: root }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'native-shell-ok');
});

test('machine filesystem scope enables approved absolute-path automation without changing relative path behavior', async (t) => {
  const root = await createTempDirectory('xyst-machine-tools-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const machine = path.join(root, 'machine');
  await fs.mkdir(workspace);
  await fs.mkdir(machine);
  await fs.writeFile(path.join(machine, 'notes.txt'), 'automation-marker');
  await fs.mkdir(path.join(machine, '.aws'));
  await fs.writeFile(path.join(machine, '.aws', 'credentials'), 'aws_access_key_id=AKIAEXAMPLE automation-marker');
  const bounded = createBuiltinTools({ workspaceRoot: workspace, config: {} });
  const broad = createBuiltinTools({ workspaceRoot: workspace, config: { tools: { filesystem_scope: 'machine', shell_enabled: true } } });
  await assert.rejects(bounded.call('read_file', { path: path.join(machine, 'notes.txt') }), /escapes workspace/);
  assert.match(await broad.call('read_file', { path: path.join(machine, 'notes.txt') }), /automation-marker/);
  const search = JSON.parse(await broad.call('search_files', { root_path: machine, query: 'automation-marker' }));
  assert.equal(search.matches[0].text, 'automation-marker');
  assert.equal(search.matches[0].path, path.join(machine, 'notes.txt'));
  assert.equal(
    search.matches.length,
    1,
    'search must filter credential files even when the selected root is the credential directory parent',
  );
  const protectedSearch = JSON.parse(
    await broad.call('search_files', { root_path: path.join(machine, '.aws'), query: 'automation-marker' }),
  );
  assert.deepEqual(protectedSearch.matches, []);
  await broad.call('write_file', { path: path.join(machine, 'created.txt'), content: 'created' });
  assert.equal(await fs.readFile(path.join(machine, 'created.txt'), 'utf8'), 'created');
  const processResult = JSON.parse(
    await broad.call('run_process', { command: process.execPath, args: ['-p', 'process.cwd()'], cwd: machine }),
  );
  assert.equal(processResult.stdout.trim(), machine);
  await assert.rejects(broad.call('read_file', { path: '.env' }), /secret-safety policy/);
});

test('unrestricted autonomy exposes all machine paths and returns unredacted file content', async (t) => {
  const root = await createTempDirectory('xyst-unrestricted-tools-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  const envFile = path.join(root, '.env');
  await fs.writeFile(envFile, 'API_KEY=local-test-canary-1234567890');
  const largeFile = path.join(root, 'large.txt');
  await fs.writeFile(largeFile, 'x'.repeat(150_000));
  await Promise.all(Array.from({ length: 501 }, (_, index) => fs.writeFile(path.join(root, `item-${index}.txt`), 'x')));
  const tools = createBuiltinTools({
    workspaceRoot: workspace,
    config: {
      tools: { autonomy: 'unrestricted', max_file_bytes: 1, max_write_bytes: 1, max_list_entries: 1 },
      budgets: { max_tool_output_bytes: 64 },
    },
  });
  assert.equal(tools.has('run_process'), true);
  assert.equal(tools.has('start_background_process'), false);
  assert.match(await tools.call('read_file', { path: envFile }), /local-test-canary-1234567890/);
  assert.equal(JSON.parse(await tools.call('read_file', { path: largeFile })).content.length, 150_000);
  const listing = JSON.parse(await tools.call('list_dir', { path: root }));
  assert.equal(listing.entries.length, 504);
  assert.equal(listing.truncated, false);
  const processResult = JSON.parse(
    await tools.call('run_process', {
      command: process.execPath,
      args: ['-e', "process.stdout.write('y'.repeat(150_000))"],
      timeout_seconds: 30,
    }),
  );
  assert.equal(processResult.stdout.length, 150_000);
  await tools.call('write_file', { path: path.join(root, 'large-write.txt'), content: 'unrestricted-write' });
  assert.equal(await fs.readFile(path.join(root, 'large-write.txt'), 'utf8'), 'unrestricted-write');
  await tools.call('edit_file', { path: path.join(root, 'large-write.txt'), old_string: 'unrestricted', new_string: 'expanded' });
  assert.equal(await fs.readFile(path.join(root, 'large-write.txt'), 'utf8'), 'expanded-write');
});

test('unrestricted tool output remains bounded by the runtime transport limit', async (t) => {
  const root = await createTempDirectory('xyst-unrestricted-output-cap-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = createBuiltinTools({
    workspaceRoot: root,
    config: { tools: { autonomy: 'unrestricted' }, budgets: { max_tool_output_bytes: 64 } },
  });
  const output = await tools.call('run_process', {
    command: process.execPath,
    args: ['-e', "process.stdout.write('x'.repeat(1_200_000))"],
    timeout_seconds: 30,
  });
  assert.ok(Buffer.byteLength(output) <= 1_000_000);
  assert.match(output, /tool output truncated at 1000000 bytes/);

  await fs.writeFile(path.join(root, 'large-read.txt'), 'r'.repeat(1_200_000));
  const fileOutput = await tools.call('read_file', { path: 'large-read.txt' });
  assert.ok(Buffer.byteLength(fileOutput) <= 1_000_000);
  assert.match(fileOutput, /tool output truncated at 1000000 bytes/);
});
