import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../src/core/agent.mjs';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.mjs';
import { discoverLocalServers } from '../src/providers/discovery.mjs';
import { SubagentTaskStore } from '../src/subagents/task-store.mjs';
import { redactSecrets } from '../src/platform/redaction.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { liveModelContextLength, preflightLmStudioModel, validateLiveModelEndpoint, validateLiveModelId } from './smoke-live-model.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const expectedFile = 'delegated-result.txt';
const expectedContents = 'XYST_AGENT_DELEGATION_OK';

export function isAllowedDelegationWrite(toolName, args) {
  return (
    toolName === 'write_file' &&
    args?.path === expectedFile &&
    typeof args.content === 'string' &&
    args.content.trimEnd() === expectedContents &&
    Object.keys(args).every((key) => key === 'path' || key === 'content')
  );
}

export function isExpectedDelegationRequest(toolName, args, task) {
  return toolName === 'delegate_task' && args?.task === task && Object.keys(args).length === 1;
}

function safePreview(value) {
  if (typeof value !== 'string') return null;
  return redactSecrets(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function runGit(args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8').trim());
      else reject(new Error(`git ${args[0]} failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 1000)}`));
    });
  });
}

async function main() {
  const model = validateLiveModelId(process.env.XYST_LIVE_MODEL);
  const baseUrl = validateLiveModelEndpoint(process.env.XYST_LIVE_MODEL_BASE_URL);
  await preflightLmStudioModel(baseUrl, model);
  const provider = new OpenAICompatibleProvider({ baseUrl, model, timeoutMs: 300_000 });
  const availableModels = await provider.listModels();
  if (!availableModels.some((item) => item.id === model))
    throw new Error(`Selected model '${model}' is not currently listed by the loopback endpoint`);
  const [discoveredServer] = await discoverLocalServers({
    config: { local_servers: { 'live-delegation-smoke': { base_url: baseUrl } }, discovery: { enabled: false } },
  });
  const contextLength = liveModelContextLength(discoveredServer, model);
  const tempRoot = path.join(repositoryRoot, '.test-tmp');
  await fs.mkdir(tempRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(path.join(tempRoot, 'live-delegation-smoke-'));
  const task = `Create ${expectedFile} with exactly this content: ${expectedContents}. Read the file back and report CHILD_VERIFIED only if it matches. Do not change any other file or run commands.`;
  const taskStore = new SubagentTaskStore(workspaceRoot, { maxConcurrent: 1 });
  const events = [];
  const runtimes = [];
  let approvedDelegations = 0;
  let approvedWrites = 0;
  let refusedApprovals = 0;

  try {
    await fs.writeFile(path.join(workspaceRoot, 'baseline.txt'), 'This file is the isolated smoke-test baseline.\n', { flag: 'wx' });
    const emptyGitConfig = path.join(workspaceRoot, 'empty-global-gitconfig');
    await fs.writeFile(emptyGitConfig, '', { flag: 'wx' });
    const gitEnv = {
      PATH: process.env.PATH || '',
      HOME: workspaceRoot,
      USERPROFILE: workspaceRoot,
      GIT_CONFIG_GLOBAL: emptyGitConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...(process.platform === 'win32'
        ? {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.WINDIR,
            TEMP: workspaceRoot,
            TMP: workspaceRoot,
            COMSPEC: process.env.COMSPEC,
            PATHEXT: process.env.PATHEXT,
          }
        : { TMPDIR: workspaceRoot }),
    };
    await runGit(['init', '--quiet'], workspaceRoot, gitEnv);
    await runGit(['add', '--', 'baseline.txt'], workspaceRoot, gitEnv);

    const config = {
      default_model: 'live-delegation-smoke',
      models: {
        'live-delegation-smoke': {
          provider: 'openai-compatible',
          base_url: baseUrl,
          model,
          local: true,
          supports_tools: true,
          context_length: contextLength,
          input_cost_per_million: 0,
          output_cost_per_million: 0,
          timeout_ms: 300_000,
        },
      },
      tools: { autonomy: 'assisted', filesystem_scope: 'workspace', shell_enabled: false },
      subagents: { enabled: true, max_concurrent: 1, max_turns: 8, timeout_ms: 300_000 },
      budgets: { max_turns: 10, max_input_tokens: 32_000, max_output_tokens: 4_000, max_tool_output_bytes: 8_000 },
    };
    const runtime = new AgentRuntime({
      config,
      workspaceRoot,
      sessionStore: new SessionStore(workspaceRoot),
      subagentTaskStore: taskStore,
      onEvent: (event) => {
        if (
          [
            'model_call_finished',
            'tool_finished',
            'tool_denied',
            'subagent_task_started',
            'subagent_task_finished',
            'run_finished',
          ].includes(event.type) ||
          event.type.startsWith('subagent_')
        )
          events.push(event);
        if (process.env.XYST_LIVE_MODEL_PROGRESS === '1') {
          if (event.type === 'model_call_finished')
            process.stderr.write(`[live-delegation] model call ${event.turn} finished in ${event.duration_ms} ms\n`);
          else if (event.type === 'tool_finished')
            process.stderr.write(`[live-delegation] tool ${event.tool} finished in ${event.duration_ms} ms\n`);
          else if (event.type === 'subagent_task_finished')
            process.stderr.write(`[live-delegation] child task ended with status ${event.status}\n`);
        }
      },
    });
    runtimes.push(runtime);

    const result = await runtime.run({
      prompt: `Delegate exactly one task using delegate_task with this exact task text: ${JSON.stringify(task)}. Do not create or change files yourself. After the child returns, inspect its recorded status, result, and changed paths. If it completed, reported CHILD_VERIFIED, and changed_paths includes ${expectedFile}, answer with DELEGATION_VERIFIED. Otherwise explain what failed.`,
      signal: AbortSignal.timeout(900_000),
      approveTool: async ({ tool, args }) => {
        if (isExpectedDelegationRequest(tool.name, args, task) && approvedDelegations === 0) {
          approvedDelegations += 1;
          return true;
        }
        if (isAllowedDelegationWrite(tool.name, args) && approvedWrites === 0) {
          approvedWrites += 1;
          return true;
        }
        refusedApprovals += 1;
        return false;
      },
    });

    const records = await taskStore.list({ limit: 10 });
    const record = records.find((item) => item.task === task) || null;
    let fileVerified = false;
    if (record?.worktree_path) {
      const content = await fs.readFile(path.join(record.worktree_path, expectedFile), 'utf8').catch(() => null);
      fileVerified = content?.trimEnd() === expectedContents;
    }
    const taskCompleted = record?.status === 'complete';
    const childVerified = typeof record?.result === 'string' && record.result.includes('CHILD_VERIFIED');
    const changedPathVerified = Array.isArray(record?.changed_paths) && record.changed_paths.includes(expectedFile);
    const parentVerified = result.content?.trim().endsWith('DELEGATION_VERIFIED') === true;
    const failures = [];
    if (result.status !== 'complete') failures.push(`parent run ended with status '${result.status}'`);
    if (approvedDelegations !== 1) failures.push(`expected one approved delegation, got ${approvedDelegations}`);
    if (approvedWrites !== 1) failures.push(`expected one approved child write, got ${approvedWrites}`);
    if (refusedApprovals) failures.push(`refused ${refusedApprovals} unexpected approval request(s)`);
    if (!taskCompleted) failures.push(`child task status was '${record?.status || 'missing'}'`);
    if (!childVerified) failures.push('child result did not verify its read-back');
    if (!changedPathVerified) failures.push(`child changed_paths did not include ${expectedFile}`);
    if (!fileVerified) failures.push('delegated worktree file content did not match');
    if (!parentVerified) failures.push('parent response did not report DELEGATION_VERIFIED');

    const report = {
      status: failures.length ? 'failed' : 'passed',
      model,
      context_length: contextLength,
      failure_reasons: failures,
      parent_status: result.status,
      parent_model_calls: events.filter((event) => event.type === 'model_call_finished').length,
      child_model_calls: events.filter((event) => event.type === 'subagent_model_call_finished').length,
      child_tools: events.filter((event) => event.type === 'subagent_tool_finished').map((event) => event.tool),
      approved_delegations: approvedDelegations,
      approved_child_writes: approvedWrites,
      refused_approvals: refusedApprovals,
      child_status: record?.status || null,
      child_result_preview: safePreview(record?.result),
      child_result_verified: childVerified,
      changed_paths: record?.changed_paths || [],
      child_worktree_file_verified: fileVerified,
      parent_result_verified: parentVerified,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (failures.length) process.exitCode = 1;
  } finally {
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    const code = typeof error.code === 'string' ? ` (${error.code})` : '';
    process.stderr.write(`Live delegation smoke failed${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
