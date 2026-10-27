import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentRuntime } from '../src/core/agent.mjs';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.mjs';
import { discoverLocalServers } from '../src/providers/discovery.mjs';
import { readBoundedJsonResponse } from '../src/providers/http-json.mjs';
import { SessionStore } from '../src/session/store.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..');
const expectedResults = new Map([
  ['result.txt', 'kestrel: 38'],
  ['second-result.txt', 'sparrow: 25'],
]);

const progress = (message) => {
  if (process.env.XYST_LIVE_MODEL_PROGRESS === '1') process.stderr.write(`[live-model] ${message}\n`);
};

export function validateLiveModelEndpoint(value = 'http://127.0.0.1:1234/v1') {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Live model endpoint must be a valid loopback URL');
  }
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/+$/, '') !== '/v1'
  )
    throw new TypeError('Live model smoke accepts only an unauthenticated HTTP loopback /v1 endpoint');
  return url.toString().replace(/\/+$/, '');
}

export function validateLiveModelId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f]/.test(value))
    throw new TypeError('XYST_LIVE_MODEL must be a non-empty model ID of at most 256 characters');
  return value.trim();
}

export function liveModelContextLength(server, model) {
  const contextLength = server?.model_context_lengths?.[model];
  return Number.isSafeInteger(contextLength) && contextLength > 0 && contextLength <= 10_000_000 ? contextLength : 32_768;
}

export async function preflightLmStudioModel(baseUrl, model, fetchImpl = fetch) {
  const statusUrl = new URL('/api/v1/models', baseUrl);
  let response;
  try {
    response = await fetchImpl(statusUrl, { redirect: 'error', signal: AbortSignal.timeout(3_000) });
  } catch {
    return { supported: false, loaded: null, contextLength: null };
  }
  if (!response.ok) return { supported: false, loaded: null, contextLength: null };

  let payload;
  try {
    payload = await readBoundedJsonResponse(response, 1024 * 1024, 'LM Studio model status');
  } catch {
    return { supported: false, loaded: null, contextLength: null };
  }
  if (!Array.isArray(payload?.models)) return { supported: false, loaded: null, contextLength: null };
  const selectedModels = payload.models.filter((entry) => entry && typeof entry === 'object' && entry.key === model);
  const modelWithInstances = selectedModels.find((entry) => Array.isArray(entry.loaded_instances));
  if (!modelWithInstances) {
    return { supported: true, loaded: null, contextLength: null };
  }
  const selectedModel = selectedModels.find((entry) => Array.isArray(entry.loaded_instances) && entry.loaded_instances.length > 0);
  if (!selectedModel) {
    throw Object.assign(
      new Error(`Selected LM Studio model '${model}' is installed but not loaded. Load it in LM Studio, then rerun the smoke.`),
      { code: 'MODEL_NOT_LOADED' },
    );
  }
  const contextLength = selectedModel.loaded_instances[0]?.config?.context_length;
  return {
    supported: true,
    loaded: true,
    contextLength: Number.isSafeInteger(contextLength) && contextLength > 0 && contextLength <= 10_000_000 ? contextLength : null,
  };
}

export function isAllowedSmokeWrite(workspaceRoot, toolName, args, allowedPaths = ['result.txt']) {
  if (!['write_file', 'edit_file'].includes(toolName) || typeof args?.path !== 'string' || !args.path.trim()) return false;
  const requestedPath = path.resolve(workspaceRoot, args.path);
  return allowedPaths.some((filePath) => {
    const expectedPath = path.resolve(workspaceRoot, filePath);
    return process.platform === 'win32' ? requestedPath.toLowerCase() === expectedPath.toLowerCase() : requestedPath === expectedPath;
  });
}

export function isAllowedSmokeProcess(workspaceRoot, toolName, args, command, processArgs) {
  if (
    toolName !== 'run_process' ||
    args?.command !== command ||
    !Array.isArray(args.args) ||
    args.args.length !== processArgs.length ||
    !args.args.every((value, index) => value === processArgs[index]) ||
    typeof args.cwd !== 'string' ||
    path.resolve(workspaceRoot, args.cwd) !== path.resolve(workspaceRoot) ||
    args.timeout_seconds !== 20 ||
    Object.keys(args).some((key) => !['command', 'args', 'cwd', 'timeout_seconds'].includes(key))
  )
    return false;
  return true;
}

export function isAllowedSmokeShell(workspaceRoot, toolName, args, script) {
  if (
    toolName !== 'run_shell_script' ||
    args?.script !== script ||
    typeof args.cwd !== 'string' ||
    path.resolve(workspaceRoot, args.cwd) !== path.resolve(workspaceRoot) ||
    args.timeout_seconds !== 20 ||
    Object.keys(args).some((key) => !['script', 'cwd', 'timeout_seconds'].includes(key))
  )
    return false;
  return true;
}

export function createFileSmokePrompt() {
  return 'Read source.txt and second-source.txt exactly once each before writing. Use their actual Code, Count, and Operation lines to calculate Count multiplied by its stated factor; do not guess or derive values from this instruction. After reading both sources, make exactly two successful writes: result.txt and second-result.txt, once each, with one line in the format <Code>: <product>. Do not change other files or repeat a successful write. After both writes, read each result file exactly once and compare it with the value calculated from its source. On success, the entire final response must be the single token VERIFIED, with no explanation or punctuation. If a check fails, report which result is wrong.';
}

async function main() {
  const model = validateLiveModelId(process.env.XYST_LIVE_MODEL);
  const baseUrl = validateLiveModelEndpoint(process.env.XYST_LIVE_MODEL_BASE_URL);
  const lmStudio = await preflightLmStudioModel(baseUrl, model);
  const provider = new OpenAICompatibleProvider({ baseUrl, model, timeoutMs: 10_000 });
  const availableModels = await provider.listModels();
  if (!availableModels.some((item) => item.id === model))
    throw new Error(`Selected model '${model}' is not currently listed by the loopback endpoint`);
  const [discoveredServer] = await discoverLocalServers({
    config: { local_servers: { 'live-smoke': { base_url: baseUrl } }, discovery: { enabled: false } },
  });
  const contextLength = lmStudio.contextLength ?? liveModelContextLength(discoveredServer, model);

  const tempRoot = path.join(repositoryRoot, '.test-tmp');
  await fs.mkdir(tempRoot, { recursive: true });
  const workspaceRoot = await fs.mkdtemp(path.join(tempRoot, 'live-model-smoke-'));
  const processOutput = 'XYST_PROCESS_SMOKE_OK';
  const processArgs = ['-e', `process.stdout.write(${JSON.stringify(processOutput)})`];
  const shellOutput = 'XYST_SHELL_SMOKE_OK';
  const shellScript = process.platform === 'win32' ? `Write-Output '${shellOutput}'` : `printf '%s\\n' '${shellOutput}'`;
  const runtimes = [];
  try {
    await fs.writeFile(path.join(workspaceRoot, 'source.txt'), 'Code: kestrel\nCount: 19\nOperation: multiply Count by 2.\n', {
      flag: 'wx',
    });
    await fs.writeFile(path.join(workspaceRoot, 'second-source.txt'), 'Code: sparrow\nCount: 5\nOperation: multiply Count by 5.\n', {
      flag: 'wx',
    });
    for (const outputPath of expectedResults.keys()) await fs.writeFile(path.join(workspaceRoot, outputPath), 'pending\n', { flag: 'wx' });

    const config = {
      default_model: 'live-smoke',
      models: {
        'live-smoke': {
          provider: 'openai-compatible',
          base_url: baseUrl,
          model,
          local: true,
          supports_tools: true,
          context_length: contextLength,
          input_cost_per_million: 0,
          output_cost_per_million: 0,
          timeout_ms: 300_000,
          temperature: 0,
        },
      },
      tools: { autonomy: 'assisted', filesystem_scope: 'workspace', shell_enabled: false },
      budgets: { max_turns: 6, max_input_tokens: 16_000, max_output_tokens: 1_800, max_tool_output_bytes: 8_000 },
    };
    const makeRuntime = (shellEnabled, events, maxTurns = 6) => {
      const runtime = new AgentRuntime({
        config: {
          ...config,
          budgets: { ...config.budgets, max_turns: maxTurns },
          tools: { ...config.tools, shell_enabled: shellEnabled },
        },
        workspaceRoot,
        sessionStore: new SessionStore(workspaceRoot),
        onEvent: (event) => {
          if (['model_call_finished', 'tool_finished', 'tool_denied', 'run_finished'].includes(event.type)) events.push(event);
          if (process.env.XYST_LIVE_MODEL_PROGRESS === '1') {
            if (event.type === 'run_started') progress('agent run started');
            else if (event.type === 'model_call_started') progress(`model call ${event.turn} started`);
            else if (event.type === 'model_call_finished') progress(`model call ${event.turn} finished in ${event.duration_ms} ms`);
            else if (event.type === 'tool_finished') progress(`tool ${event.tool} finished in ${event.duration_ms} ms`);
            else if (event.type === 'run_finished') progress(`agent run ended with status ${event.status}`);
          }
        },
      });
      runtimes.push(runtime);
      return runtime;
    };

    const fileEvents = [];
    const approvedWritePaths = new Set();
    let refusedFileApprovals = 0;
    const fileResult = await makeRuntime(false, fileEvents, 12).run({
      prompt: createFileSmokePrompt(),
      signal: AbortSignal.timeout(900_000),
      approveTool: async ({ tool, args }) => {
        if (isAllowedSmokeWrite(workspaceRoot, tool.name, args, [...expectedResults.keys()])) {
          approvedWritePaths.add(path.basename(path.resolve(workspaceRoot, args.path)));
          return true;
        }
        refusedFileApprovals += 1;
        return false;
      },
    });
    const fileContents = new Map(
      await Promise.all(
        [...expectedResults.keys()].map(async (filePath) => [filePath, await fs.readFile(path.join(workspaceRoot, filePath), 'utf8')]),
      ),
    );
    const fileTools = fileEvents.filter((event) => event.type === 'tool_finished').map((event) => event.tool);
    const fileReads = fileTools.flatMap((tool, index) => (tool === 'read_file' ? [index] : []));
    const fileWriteIndexes = fileTools.flatMap((tool, index) => (['write_file', 'edit_file'].includes(tool) ? [index] : []));
    const expectedFilePaths = [...expectedResults.keys()];
    const verifiedFiles = Object.fromEntries(
      [...expectedResults].map(([filePath, expectedContent]) => [filePath, fileContents.get(filePath).trimEnd() === expectedContent]),
    );
    const fileFinalAnswerVerified = fileResult.content?.trim() === 'VERIFIED';
    const fileFailureReasons = [];
    if (fileResult.status !== 'complete') fileFailureReasons.push(`file run ended with status '${fileResult.status}'`);
    const incorrectFiles = Object.entries(verifiedFiles)
      .filter(([, verified]) => !verified)
      .map(([filePath]) => filePath);
    if (incorrectFiles.length) fileFailureReasons.push(`output contents did not match: ${incorrectFiles.join(', ')}`);
    if (fileReads.length < expectedFilePaths.length * 2)
      fileFailureReasons.push(`expected at least ${expectedFilePaths.length * 2} source/read-back calls, got ${fileReads.length}`);
    if (fileWriteIndexes.length !== expectedFilePaths.length)
      fileFailureReasons.push(`expected ${expectedFilePaths.length} approved writes, got ${fileWriteIndexes.length}`);
    if (fileWriteIndexes.length && fileReads[expectedFilePaths.length - 1] >= fileWriteIndexes[0])
      fileFailureReasons.push('both source files were not read before the first write');
    if (fileWriteIndexes.length && fileReads.at(-expectedFilePaths.length) <= fileWriteIndexes.at(-1))
      fileFailureReasons.push('both output files were not read after the last write');
    const unapprovedPaths = expectedFilePaths.filter((filePath) => !approvedWritePaths.has(filePath));
    if (unapprovedPaths.length) fileFailureReasons.push(`expected paths were not approved: ${unapprovedPaths.join(', ')}`);
    if (refusedFileApprovals) fileFailureReasons.push(`refused ${refusedFileApprovals} unexpected file-tool approval request(s)`);
    if (!fileFinalAnswerVerified) fileFailureReasons.push('final response was not exactly VERIFIED');
    const filePassed = fileFailureReasons.length === 0;

    let approvedProcesses = 0;
    let approvedShellScripts = 0;
    let refusedCommandApprovals = 0;
    const commandEvents = [];
    const commandResult = await makeRuntime(true, commandEvents).run({
      prompt: `Call run_process exactly once with command ${JSON.stringify(process.execPath)}, args ${JSON.stringify(processArgs)}, cwd ".", timeout_seconds 20. Then call run_shell_script exactly once with script ${JSON.stringify(shellScript)}, cwd ".", timeout_seconds 20. Both only print their marker. If both outputs match, the entire final response must be the single token COMMANDS_VERIFIED, with no explanation or punctuation.`,
      signal: AbortSignal.timeout(900_000),
      approveTool: async ({ tool, args }) => {
        if (isAllowedSmokeProcess(workspaceRoot, tool.name, args, process.execPath, processArgs)) {
          approvedProcesses += 1;
          return true;
        }
        if (isAllowedSmokeShell(workspaceRoot, tool.name, args, shellScript)) {
          approvedShellScripts += 1;
          return true;
        }
        refusedCommandApprovals += 1;
        return false;
      },
    });
    const commandTools = commandEvents.filter((event) => event.type === 'tool_finished').map((event) => event.tool);
    const commandOutput = commandResult.session.messages
      .filter((message) => message.role === 'tool')
      .map((message) => JSON.stringify(message.content))
      .join('\n');
    const processOutputVerified = commandOutput.includes(processOutput);
    const shellOutputVerified = commandOutput.includes(shellOutput);
    const processIndex = commandTools.indexOf('run_process');
    const shellIndex = commandTools.indexOf('run_shell_script');
    const commandFinalAnswerVerified = commandResult.content?.trim() === 'COMMANDS_VERIFIED';
    const commandFailureReasons = [];
    if (commandResult.status !== 'complete') commandFailureReasons.push(`command run ended with status '${commandResult.status}'`);
    if (processIndex < 0 || shellIndex <= processIndex)
      commandFailureReasons.push('required process and shell tools did not run once in order');
    if (approvedProcesses !== 1) commandFailureReasons.push(`expected one approved process command, got ${approvedProcesses}`);
    if (approvedShellScripts !== 1) commandFailureReasons.push(`expected one approved shell script, got ${approvedShellScripts}`);
    if (refusedCommandApprovals)
      commandFailureReasons.push(`refused ${refusedCommandApprovals} unexpected process/shell approval request(s)`);
    if (!processOutputVerified) commandFailureReasons.push('process marker output was not verified');
    if (!shellOutputVerified) commandFailureReasons.push('shell marker output was not verified');
    if (!commandFinalAnswerVerified) commandFailureReasons.push('final response was not exactly COMMANDS_VERIFIED');
    const commandPassed = commandFailureReasons.length === 0;

    const report = {
      status: filePassed && commandPassed ? 'passed' : 'failed',
      model,
      context_length: contextLength,
      ...(process.env.XYST_LIVE_MODEL_DEBUG_FINAL === '1'
        ? {
            final_response_diagnostics: {
              file: String(fileResult.content ?? '').slice(0, 400),
              command: String(commandResult.content ?? '').slice(0, 400),
            },
          }
        : {}),
      failure_reasons: [
        ...fileFailureReasons.map((reason) => `file workflow: ${reason}`),
        ...commandFailureReasons.map((reason) => `command workflow: ${reason}`),
      ],
      file_workflow: {
        result_status: fileResult.status,
        model_calls: fileEvents.filter((event) => event.type === 'model_call_finished').length,
        tools: fileTools,
        approved_writes: approvedWritePaths.size,
        refused_approvals: refusedFileApprovals,
        read_calls: fileReads.length,
        write_calls: fileWriteIndexes.length,
        final_answer_verified: fileFinalAnswerVerified,
        verified_files: verifiedFiles,
      },
      command_workflow: {
        result_status: commandResult.status,
        model_calls: commandEvents.filter((event) => event.type === 'model_call_finished').length,
        tools: commandTools,
        approved_processes: approvedProcesses,
        approved_shell_scripts: approvedShellScripts,
        refused_approvals: refusedCommandApprovals,
        final_answer_verified: commandFinalAnswerVerified,
        process_output_verified: processOutputVerified,
        shell_output_verified: shellOutputVerified,
      },
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!filePassed || !commandPassed) process.exitCode = 1;
  } finally {
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main().catch((error) => {
    const code = typeof error.code === 'string' ? ` (${error.code})` : '';
    process.stderr.write(`Live model smoke failed${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
