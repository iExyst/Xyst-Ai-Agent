import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { approveInTerminal } from '../src/cli/approval-prompt.mjs';
import { ApprovalRuleStore } from '../src/tools/approval-rule-store.mjs';
import { evaluateApprovalRules } from '../src/tools/approval-rules.mjs';
import { createBuiltinTools } from '../src/tools/builtins.mjs';
import { createTempDirectory } from './helpers.mjs';

function fakeTerminal(answer) {
  let prompt = '';
  return {
    terminal: {
      question: async (text) => {
        prompt = text;
        return answer;
      },
      close() {},
    },
    get prompt() {
      return prompt;
    },
  };
}

const io = { stdin: { isTTY: true }, stdout: { isTTY: true }, stderr: { write() {} } };

test('approval prompt can create a one-hour rule for only the canonical target path', async (t) => {
  const root = await createTempDirectory('xyst-approval-prompt-path-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const answer = fakeTerminal('p');
  const tool = createBuiltinTools({ workspaceRoot: root }).metadata('write_file');
  const approved = await approveInTerminal(
    { permission: { summary: 'Write generated/out.txt' }, tool, args: { path: 'generated/out.txt', content: 'private' } },
    false,
    answer.terminal,
    root,
    io,
  );
  assert.equal(approved, true);
  assert.match(answer.prompt, /this exact workspace path for 1 hour/);
  const rules = new ApprovalRuleStore(root);
  const created = await rules.list();
  assert.equal(created.length, 1);
  assert.equal(created[0].pattern, 'generated/out.txt');
  const allowed = await evaluateApprovalRules({
    workspaceRoot: root,
    tool,
    args: { path: 'generated/out.txt', content: 'next' },
    ruleStore: rules,
  });
  assert.equal(allowed.decision, 'allow');
  const other = await evaluateApprovalRules({
    workspaceRoot: root,
    tool,
    args: { path: 'generated/other.txt', content: 'next' },
    ruleStore: rules,
  });
  assert.equal(other, null);
});

test('approval prompt can create an exact argv rule and hides that choice for wildcard arguments', async (t) => {
  const root = await createTempDirectory('xyst-approval-prompt-command-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = createBuiltinTools({ workspaceRoot: root, config: { tools: { shell_enabled: true } } });
  const ruleStore = new ApprovalRuleStore(root);
  const answer = fakeTerminal('c');
  const args = { command: 'npm', args: ['test', '--', 'focused suite'] };
  const approved = await approveInTerminal(
    { permission: { summary: 'Run npm tests' }, tool: tools.metadata('run_process'), args },
    false,
    answer.terminal,
    root,
    io,
  );
  assert.equal(approved, true);
  assert.match(answer.prompt, /this exact command for 1 hour/);
  const allow = await evaluateApprovalRules({ workspaceRoot: root, tool: tools.metadata('run_process'), args, ruleStore });
  assert.equal(allow.decision, 'allow');
  const mismatch = await evaluateApprovalRules({
    workspaceRoot: root,
    tool: tools.metadata('run_process'),
    args: { command: 'npm', args: ['test', 'all'] },
    ruleStore,
  });
  assert.equal(mismatch, null);

  const wildcardAnswer = fakeTerminal('c');
  const wildcardArgs = { command: 'grep', args: ['--glob', '*.js'] };
  const wildcardResult = await approveInTerminal(
    { permission: { summary: 'Run grep' }, tool: tools.metadata('run_process'), args: wildcardArgs },
    false,
    wildcardAnswer.terminal,
    root,
    io,
  );
  assert.equal(wildcardResult, false);
  assert.doesNotMatch(wildcardAnswer.prompt, /this exact command for 1 hour/);
  assert.equal((await ruleStore.list()).length, 1);
});

test('approval prompt keeps one-time and session grants, and denies when there is no TTY', async () => {
  const tool = { name: 'write_file' };
  const once = fakeTerminal('y');
  assert.equal(
    await approveInTerminal({ permission: { summary: 'Write file' }, tool, args: { path: 'a' } }, false, once.terminal, process.cwd(), io),
    true,
  );
  const session = fakeTerminal('s');
  assert.deepEqual(
    await approveInTerminal(
      { permission: { summary: 'Write file' }, tool, args: { path: 'a' } },
      false,
      session.terminal,
      process.cwd(),
      io,
    ),
    { approved: true, grant_scope: 'session', grant_duration_ms: 60 * 60 * 1000 },
  );
  const errors = [];
  assert.equal(
    await approveInTerminal({ permission: { summary: 'Write file' }, tool, args: { path: 'a' } }, false, null, process.cwd(), {
      stdin: { isTTY: false },
      stdout: { isTTY: false },
      stderr: { write: (text) => errors.push(text) },
    }),
    false,
  );
  assert.match(errors.join(''), /denied because no interactive terminal/);
});

test('file approval shows the proposed diff and removes terminal control characters from workspace text', async () => {
  const answer = fakeTerminal('y');
  const output = [];
  const diff = '--- a/notes.txt\n+++ b/notes.txt\n-old\n+new\u001b[2Jtext\n';
  const approved = await approveInTerminal(
    {
      permission: { summary: 'Edit notes.txt' },
      tool: { name: 'edit_file' },
      args: { path: 'notes.txt', old_string: 'old', new_string: 'new text' },
      fileChange: { operation: 'update', path: 'notes.txt', diff },
    },
    false,
    answer.terminal,
    process.cwd(),
    { ...io, stdout: { isTTY: true, write: (text) => output.push(text) }, environment: { NO_COLOR: '' } },
  );
  assert.equal(approved, true);
  assert.match(output.join(''), /\[update\] notes\.txt/);
  assert.match(output.join(''), /\+new\[2Jtext/);
  assert.doesNotMatch(output.join(''), /\u001b/);
});

test('approval question receives the run signal and closes cleanly when cancelled', async () => {
  const controller = new AbortController();
  let receivedSignal;
  const terminal = {
    question: async (_text, options) => {
      receivedSignal = options.signal;
      return new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }),
      );
    },
  };
  const approval = approveInTerminal(
    { permission: { summary: 'Write file' }, tool: { name: 'write_file' }, args: { path: 'a' }, signal: controller.signal },
    false,
    terminal,
    process.cwd(),
    io,
  );
  controller.abort();
  assert.equal(await approval, false);
  assert.equal(receivedSignal, controller.signal);
});
