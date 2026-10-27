import { runProcess, safeProcessEnvironment } from '../platform/process.mjs';
import { runIsolatedProcess } from '../platform/sandbox.mjs';
import { isReadOnlySandbox, requiresProcessIsolation, resolveSandboxMode } from '../platform/sandbox-modes.mjs';

const EVENTS = new Set(['pre_model', 'post_model', 'pre_tool', 'post_tool', 'on_error']);
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024;

export class LifecycleHookRunner {
  constructor({ config, workspaceRoot, processRunner = runProcess, isolatedRunner = runIsolatedProcess, emit = () => {} }) {
    this.config = config;
    this.workspaceRoot = workspaceRoot;
    this.processRunner = processRunner;
    this.isolatedRunner = isolatedRunner;
    this.emit = emit;
  }

  async run(event, details = {}, { signal, sessionId = null, required = false } = {}) {
    if (!EVENTS.has(event)) throw new TypeError(`Unknown lifecycle hook event: ${event}`);
    const hook = this.config.hooks?.[event];
    if (!hook) return;
    const sandboxMode = resolveSandboxMode(this.config, 'lifecycle_hooks');
    if (isReadOnlySandbox(this.config, 'lifecycle_hooks')) {
      if (required)
        throw Object.assign(new Error('Required lifecycle hooks are disabled by the read-only sandbox policy'), {
          code: 'HOOK_DISABLED_READ_ONLY',
        });
      return;
    }
    const payload = JSON.stringify({ schema_version: 1, event, session_id: sessionId, ...details });
    const unrestricted = this.config.tools?.autonomy === 'unrestricted';
    const options = {
      cwd: this.workspaceRoot,
      env: unrestricted ? process.env : safeProcessEnvironment(process.env),
      timeoutMs: hook.timeout_ms ?? 3000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxInputBytes: MAX_INPUT_BYTES,
      input: payload,
      signal,
    };
    let result;
    try {
      if (Buffer.byteLength(payload) > MAX_INPUT_BYTES)
        throw Object.assign(new Error('Lifecycle hook input exceeded its size limit'), { code: 'HOOK_INPUT_TOO_LARGE' });
      result = requiresProcessIsolation(sandboxMode)
        ? await this.isolatedRunner(hook.command, hook.args || [], {
            ...options,
            workspaceRoot: this.workspaceRoot,
            sandboxMode,
          })
        : await this.processRunner(hook.command, hook.args || [], options);
      if (result.truncated)
        throw Object.assign(new Error('Lifecycle hook output exceeded its size limit'), { code: 'HOOK_OUTPUT_TOO_LARGE' });
      if (result.exitCode !== 0)
        throw Object.assign(new Error(`Lifecycle hook exited with status ${result.exitCode}`), { code: 'HOOK_EXIT_NONZERO' });
      return;
    } catch (error) {
      const code = error.code || 'HOOK_FAILED';
      this.emit({ type: 'hook_failed', session_id: sessionId, hook_event: event, code });
      if (required)
        throw Object.assign(new Error(`Required ${event} lifecycle hook failed (${code})`), {
          code: 'LIFECYCLE_HOOK_FAILED',
          cause: error,
        });
    }
  }

  async onError(error, details = {}, options = {}) {
    await this.run('on_error', { ...details, failure_code: error?.code || error?.name || 'ERROR' }, options);
  }
}
