# Xyst AI Assistant user guide

Xyst AI Assistant is a local-first coding assistant with one runtime shared by its CLI, browser interface, desktop app, and VS Code extension. This guide covers setup and everyday use. See the [configuration reference](CONFIGURATION.md), [security model](SECURITY.md), [API guide](API.md), and [implementation status](IMPLEMENTATION_STATUS.md) for full details and current platform limits.

## Requirements and setup

The CLI and local service require Node.js 22 or newer on Windows or Linux. The desktop host bundles its own Node runtime. Xyst AI Assistant sends model requests only to the provider you configure; it has no built-in model account.

The user config file is `%APPDATA%\Xyst AI Assistant\config.toml` on Windows and `$XDG_CONFIG_HOME/xyst-ai-assistant/config.toml` on Linux, defaulting to `~/.config/xyst-ai-assistant/config.toml`. You can create it from `config.example.toml` or use the browser interface to discover and configure a local model. Runtime settings saved in the app are stored in a separate user-level sidecar. Project settings belong in `.xyst.toml`, and environment overrides use the `XYST__` prefix.

### Optional global memory

Project memory is stored with the workspace. To opt into cross-project user memory, enable **Use global user memory across projects** in Runtime settings, or set `[memory] global_enabled = true` in your **user** config file. The browser setting applies immediately; TOML changes take effect on restart. Project `.xyst.toml` files cannot enable this feature. Global memory is included in model context as untrusted reference data, with its own share of the configured memory context limit. Manage entries in the Memory panel or from the CLI with `node src/cli.mjs memory global list`, `add <section> <text>`, `update <section> <id> <text>`, and `delete <section> <id>`. The browser panel and authenticated local API also support export/import. Set `global_enabled = false` to stop including it; entries remain on disk until explicitly deleted. By default, Windows stores it under `%LOCALAPPDATA%\Xyst AI Assistant\.agent`, and Linux under `$XDG_DATA_HOME/xyst/.agent` or `~/.local/share/xyst/.agent`. Runtime settings can change its data directory. Xyst AI Assistant merges existing entries into the selected directory, retains the source copy as a backup, refuses conflicting record IDs, and blocks the change while API runs or global-memory requests are active. Finish CLI runs and close other Xyst AI Assistant instances first because they keep the location loaded at process start. This setting does not move project sessions, project memory, credentials, or extension packages.

### Configure a local model

On a fresh run, the browser interface can search the fixed local model endpoints at `127.0.0.1` ports `11434`, `1234`, and `8080`. Choose **Find local models** after starting the model server. Discovery requests each server's `/v1/models` endpoint; it does not send prompts or workspace files. Select a model to add it as the default.

You can configure the same connection in the user TOML file:

```toml
default_model = "local"

[models.local]
provider = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"
model = "the-model-id-reported-by-your-server"
local = true
supports_tools = true
context_length = 32768
```

Use the actual model ID reported by your server. The `1234` endpoint is the common LM Studio default; Ollama commonly uses `11434`. Xyst AI Assistant does not download model weights.

### Configure a remote model

Add an OpenAI-compatible profile with the provider's API root and model ID. Refer to an environment variable for its key rather than pasting the secret into project files:

```toml
[models.remote]
provider = "openai-compatible"
base_url = "https://provider.example/v1"
model = "provider-model-id"
api_key_env = "XYST_PROVIDER_KEY"
supports_tools = true
context_length = 128000
```

Set `XYST_PROVIDER_KEY` in the environment of the Xyst AI Assistant process. In PowerShell, use `$env:XYST_PROVIDER_KEY = 'your-key'`; in a Linux shell, use `export XYST_PROVIDER_KEY='your-key'`. For a persistent credential, use the supported OS credential store with `api_key_secret`; see [Configuration](CONFIGURATION.md#model-fields). Provider billing, rate limits, and data handling are set by the provider.

## Start a task

From the project directory, run:

```sh
node src/cli.mjs --workspace . "Inspect the project and summarize its structure."
```

The CLI also supports an interactive prompt loop:

```sh
node src/cli.mjs --workspace .
```

For the responsive Ink composer, install project dependencies once and start it with `node src/cli.mjs --tui --workspace .`. The composer displays recent conversation context and the current mode/model, follows terminal dimensions, and supports Enter to submit, Ctrl+J (or Shift+Enter when the terminal reports it) for a new line, Up/Down to recall prompts, and Ctrl+C to cancel a run or exit. Run progress, streamed responses, tool activity, and approval choices remain in the terminal UI. The TUI is opt-in and the desktop service does not load its dependencies.

In an interactive session, use the Up and Down arrow keys to recall recent prompts from that session, and press Tab to complete slash commands, configured model profiles, and run modes. The CLI keeps up to 100 prompts in memory for the current process; it does not write a separate shell-history file.

Use `/status` to inspect the selected model profile and local/remote classification, the last routing explanation, autonomy mode, configured sandbox mode and backend availability, and session plus shared daily/monthly budget usage. Backend availability describes whether the isolation helper is present; it does not claim that the current run is isolated.

Use `node src/cli.mjs --help` to see available options. Common examples:

```sh
node src/cli.mjs --mode review "Review the workspace for correctness issues."
node src/cli.mjs --mode plan "Plan a migration to the new API."
node src/cli.mjs --resume latest "Continue the most recent conversation."
node src/cli.mjs --mcp-server docs --mcp-server calendar "Use only these MCP servers for this conversation."
node src/cli.mjs --no-mcp-servers --resume latest "Continue without MCP tools."
node src/cli.mjs --image ./diagram.png "Explain this architecture diagram."
node src/cli.mjs --json "Summarize the current workspace state."
```

Review and Plan modes are read-only. Review findings must form a complete valid report with workspace-relative file paths and concrete evidence; malformed or unsupported items invalidate the report rather than being silently dropped. Image input accepts PNG, JPEG, and WebP; the selected model must support vision. Image bytes are transient and are not written into the session transcript.

When you resume a session in the CLI, it defaults to that session's saved Agent, Review, or Plan mode. Pass `--mode` to choose a different mode for this run. Resuming a Review or Plan session stays read-only unless you explicitly switch to Agent mode.

During a browser or VS Code run, choose **Pause** to stop at a safe model-turn boundary. While paused in Assisted autonomy, open **Adjust budgets for this run** to change token and cost caps, model turns, tool-output size, or recovery reserves. Clear a field to restore its start-of-run value. Resume to apply the edit before the next provider request; Xyst AI Assistant saves the adjustment in the session before confirming it. Unrestricted autonomy has no Xyst AI Assistant usage caps to adjust.

In the browser, select another configured model in the header and choose **Use selected model** while paused. Resume the run to apply it at the next model turn. Xyst AI Assistant saves the new model and routing choice in the session before confirming the switch. Profiles that cannot support the run mode or attached images are refused; if the active context does not fit, the run keeps its previous model.

Saved review findings include an **Open finding location** action in the browser/desktop interface and VS Code. It opens the cited file at its reported line when that location is still within the active workspace. In the browser/desktop view, the preview shows the surrounding lines; VS Code reveals the line in the editor.

Saved plans appear in the conversation. In the browser/desktop and VS Code interfaces, edit each step, move steps up or down, add or remove steps, then save. Saving does not start work; choose **Implement this plan** separately when you are ready. The saved plan is untrusted reference context, and the normal approval policy still applies.

## Choose how much autonomy to use

Fresh installations default to **Unrestricted**. Xyst AI Assistant skips its own approval prompts and configured limits, can use shell/process tools, and can read or write across paths available to the current operating-system account. This setting does not grant administrator/root privileges. The provider's context and output limits still apply.

Unrestricted mode sends raw task and tool content to the selected model during the active run. When a session is saved, Xyst AI Assistant redacts recognizable credential patterns in the persisted copy without changing the active run's in-memory context. This is best-effort pattern matching: arbitrary or encoded secrets can be missed, and legacy session files are not rewritten until a later save. Use a local model or review sensitive content before allowing it to reach a remote provider.

To keep Xyst AI Assistant's application-level approvals and workspace policy, set this in the user config:

```toml
[tools]
autonomy = "assisted"
```

In Assisted mode, proposed file writes and process actions use Xyst AI Assistant's approval policy, configured file scope and deny rules apply, and configured usage caps are enforced. Project configuration cannot raise a user-selected Assisted profile to Unrestricted.

Process isolation is a separate setting. `sandbox.mode` supports `none`, `workspace-write`, `workspace-read`, and `read-only`. The workspace modes ask the Linux Bubblewrap or Windows AppContainer backend to isolate supported child processes; a missing backend causes the action to fail closed. `workspace-read` also mounts the selected workspace read-only. `read-only` keeps local inspection tools available and hides process-capable tools. Isolation does not cover every Xyst AI Assistant feature, and both platform boundaries still need broader independent validation. `none` runs child processes with the current account's OS permissions. Read the [security model](SECURITY.md) before using an untrusted repository, enabling extensions, or relying on sandbox claims.

For one CLI run, `--approval-policy prompt` asks before proposed actions and `--approval-policy approve-all` approves them for that invocation. `--yes` is the shorthand. The per-run option does not change saved user settings or configured hard denials.

## Use the browser interface or desktop app

Start the local service from a terminal:

```sh
node src/cli.mjs serve --port 0
```

Open the printed loopback origin with `/app`, for example `http://127.0.0.1:49152/app`. The service binds to loopback and uses a fresh in-memory access token for that process. Keep the service terminal open while using the browser interface; stop it with Ctrl+C when finished.

The browser interface provides sessions, streaming runs, approvals, settings, memory, goals, search, background-process controls, worktree actions, and signed package updates. Runtime settings cover model profiles, default/review/plan model roles, routing, autonomy, sandbox mode, usage caps, appearance, navigation shortcuts, the global-memory data directory, web search, and application updates. Xyst automatically uses keyless Automatic search for current information. It combines recent news from GDELT DOC and Google News RSS with Wikipedia references, and keeps results from sources that respond when another is unavailable. In **Settings → All runtime settings → Live web search**, choose Automatic, Wikipedia alone, or optional Brave Search for broader web results. Brave's API key is optional; without a key or if it is rejected, Xyst falls back to Automatic. Model-provider credentials are separate from web search; LM Studio normally needs no model credential. For current weather, ask for conditions and name a city or place; Xyst uses a live Open-Meteo source without an API key and will ask for the location if it is missing. In Assisted mode the agent asks approval before sending a search or location; queries are shared with the selected provider, and results are treated as untrusted model context. The free Open-Meteo endpoint is for non-commercial use. For other current data sources and APIs, configure an HTTP MCP server under **MCP servers** and select it for the conversation. Choose **System**, **Dark**, or **Light** under appearance; the theme follows the Xyst alien artwork in both dark and light modes, with the alien mark shown in the workspace identity and assistant replies. The desktop host uses the same service and browser interface. The VS Code extension connects to that local service; see the [extension setup notes](../vscode/README.md). The palette tokens and update points are documented in the [Xyst brand theme guide](BRAND_THEME.md).

Review and plan roles can each use a configured profile or fall back to the default model. Navigation shortcuts can be remapped in Runtime settings; supported bindings are Ctrl or Alt plus a letter/number, optionally with Shift, or `/`. Bindings must be unique and are inactive while editing text. You can edit each model profile's regular input, cached-input, and output price estimates there, then record the date and source you checked. Prices older than 90 days are marked stale; Xyst AI Assistant does not fetch prices automatically. Blank prices stay unknown.

Use **MCP tools** in the message composer to choose all configured servers or a specific set for that conversation. The choice is saved with the session when you send a message and carries over when you resume or fork it. The CLI supports repeatable `--mcp-server <name>`, `--no-mcp-servers`, and `--mcp-all-servers`; if omitted, a resumed session keeps its saved selection.

In VS Code, expand **MCP servers** above the conversation to choose the servers available to that conversation. The selection is saved with your next message and restored when you reopen the session. New sessions start with all configured servers selected; use **Use all configured servers** to reset a custom selection.

## Continue and organize work

- `node src/cli.mjs sessions list` shows saved sessions. Use `--resume <id>` or `--resume latest` to continue one.
- Use `node src/cli.mjs sessions goals <session-id> <goal-id> [...]` to choose the project goals included with a session's context and portable export. The command replaces the full reference list; run it with only the session ID to clear references. Find IDs with `node src/cli.mjs goals list`. Deleting a project goal removes its references from saved sessions.
- In VS Code, select a saved conversation and use **Goals** in the session bar to choose existing project goals for its context and portable export. The picker shows the selection when reopened. Create goals in the browser Goals panel or CLI first; goal notes remain untrusted context.
- Edit a plan in your preferred text editor, then use `node src/cli.mjs sessions plan <session-id> ./plan.md` to save it. Read it with `sessions plan <session-id>`, supply `-` to read a plan from standard input, and clear it with `sessions clear-plan <session-id>`. Plan input is bounded and saved through the same versioned session store as the other interfaces.
- When ready to start work from the saved plan in the CLI, run `node src/cli.mjs sessions implement-plan <session-id>`. This is an explicit handoff into Agent mode; the plan is treated as untrusted context and normal runtime approvals still apply.
- `node src/cli.mjs sessions export <session-id> ./session.json` and `sessions import ./session.json` move a conversation and any persistent project goals it references. Import adds those goal records without replacing project state, and rejects conflicting goal IDs. Review exported data before sharing; it can contain prompts, tool observations, and referenced goal notes.
- `node src/cli.mjs backup export ./xyst-project-backup.json` creates a project-data backup. Restore only into a workspace without existing `.agent` state; restore will not merge or overwrite it.
- `node src/cli.mjs memory list` and `memory add <section> <text>` manage project memory. Treat memory as project data and review it for sensitive content.
- During a task, the agent can propose a durable project fact or preference with `propose_memory`. If global memory is enabled in settings, it can also propose a user-wide fact with `propose_global_memory`. Assisted mode shows the scope, section, and a secret-redacted preview for approval; Unrestricted mode saves the proposal automatically. Saved entries are marked `agent-proposal` and remain untrusted reference data, not instructions or permissions.
- `node src/cli.mjs goals list` and `goals add <title>` track persistent project goals.
- `node src/cli.mjs usage status` shows recorded usage. Estimated cost depends on prices configured for each model; unknown prices are not reported as zero.
- `node src/cli.mjs worktrees create <branch>` creates a managed Git worktree. Xyst AI Assistant refuses to remove a worktree with tracked or untracked changes.

Sessions, project memory, goals, usage records, and other project state live beneath `<workspace>/.agent`. User configuration is stored separately under the OS configuration directory. See the [data locations](PLATFORM_SUPPORT.md#persistent-data-map) before moving or deleting a workspace.

## Update Xyst AI Assistant when you choose

Application updates are disabled by default. In **Runtime settings → Application updates**, select **Only when I check** or **Check when Xyst AI Assistant starts and notify me**, then choose **Stable** or **Preview**. A trusted release feed URL, signer key ID, and Ed25519 public key must be configured by a Xyst AI Assistant release maintainer; compare the displayed key fingerprint with a trusted source.

After a check finds a release, choose **Download and verify update**. Xyst AI Assistant rechecks the signed release, downloads the package, and verifies its complete size and SHA-256 before offering a short-lived, one-time local download link. The app does not run the installer or package manager. You choose whether and when to install the file. If there is no trusted feed configured, no in-app release is available yet. See [Application updates](APP_UPDATES.md) for the signed feed and release process.

## Optional capabilities

- **Web search** is enabled by default with keyless Automatic search, which combines recent GDELT and Google News RSS results with Wikipedia references and keeps results from sources that respond when another is unavailable. Select Brave in Runtime settings for broader web results; its API key is optional because a missing or rejected credential falls back to Automatic. In Assisted mode, each query is shown for approval; returned pages are untrusted input.
- **Semantic search** is disabled by default. It needs an embedding model and stores vectors plus source metadata under `.agent/retrieval`; it does not store indexed source text.
- **Signed extensions** are installed, enabled, updated, and rolled back through explicit actions. Package content is checked against configured trust roots. Skills remain untrusted instructions, and MCP packages do not receive fine-grained OS enforcement.
- **Desktop automation** depends on the local graphical session and platform tools. Linux automation requires an interactive desktop and the appropriate accessibility/input utilities. See [Platform support](PLATFORM_SUPPORT.md).

## Text-to-speech command

Speak a phrase from the project directory with `pnpm speak "Hello world"`. Choose a locale with `pnpm speak --lang fr-FR "Bonjour"`. The command uses Windows Speech on Windows, an installed matching system voice on macOS, and Speech Dispatcher or Festival on Linux. A missing speech engine returns an error. This is a standalone utility; Agent and Architect narration is not wired up yet.

## Subagents

Subagents are disabled in a fresh configuration. Enable them in **Settings → All runtime settings → Agent orchestration**, then choose the maximum number of concurrent agents. The preference is saved in your user runtime settings and applies to new runs. When enabled, `delegate_task` can run a child in a new Git worktree and session. Repositories with a valid `HEAD` start from that commit; a repository with no initial commit starts from a private snapshot of its Git-visible files without changing the parent index or `HEAD`. Xyst `.agent` data is excluded, and custom Git filters do not run during snapshot creation or change inspection. In Assisted autonomy, the user approves each delegation, and the child separately asks before using write or process tools. Unrestricted autonomy bypasses Xyst approval prompts; the operating-system account and any selected OS sandbox still apply. Each child receives only its delegated task and shared read-only project memory, with no parent transcript or session grants. Child changes remain in the worktree for review and are never merged automatically. In Assisted mode, child token ceilings use at most 40% of the remaining parent run budgets, and the configured `max_turns` and `timeout_ms` apply. Unrestricted mode skips those budgets and timeout; `max_concurrent` continues to cap simultaneous children across processes.

For signed package updates, configure `update_feed_url` and `update_key_id` under `[extensions]`. Use **Packages → Check for updates** to fetch a signed feed, then choose **Download & stage** for an eligible skill or MCP version. Xyst AI Assistant verifies the bundle and leaves it inactive until you activate it in Skills or MCP. If a revocation feed is configured, refresh its cache first; revocation refresh is explicit and can disconnect or restart MCP processes, so active runs must be stopped. See the [extension guide](EXTENSIONS.md) for feed formats and trust configuration.

## Troubleshooting

### No model appears

Start the model server, load a model, and use its reported model ID. If discovery does not find the server, enter its OpenAI-compatible base URL and model ID in Runtime settings. For remote profiles, verify that the key environment variable is set in the process environment.

### A required sandbox action fails

Check **Runtime settings → Sandbox** and the reported backend availability. Linux requires a trusted Bubblewrap installation and compatible user namespaces. Windows uses the packaged AppContainer helper. Workspace modes refuse process actions if the backend is unavailable; choose another policy only if it matches your intended trust boundary.

### An update is not offered

Update checks must be enabled and a trusted signer/feed configured. The signed feed must be current, on the selected channel, and contain a newer release for the current OS and architecture. A publisher must have built and published a matching signed package. Xyst AI Assistant does not ship a default update server in this repository.

### Find local diagnostic data

Run `node src/cli.mjs sessions inspect` to locate unreadable session records without displaying their contents. Project-local audit and usage data live under `.agent`. Optional observability recording is disabled unless `observability.enabled = true` in user configuration. Set `observability.console_enabled = true` to also write the same sanitized lifecycle records to the API service's standard error stream. A remote collector receives data only when its OTLP exporter is separately enabled with a user-configured endpoint. Review the destination before enabling it; no prompts, file paths, tool payloads, or raw errors are exported. Do not share logs or session exports until you have reviewed them.

## Current support boundary

The project targets Windows and Linux on x64 and ARM64, but native validation is uneven. The Windows NSIS installer has passed an isolated install, packaged service/UI startup, reinstall, configuration-retention, and uninstall smoke. Ubuntu CI has a DEB build/install smoke configured; Linux desktop interaction, package-manager update/rollback, and several sandbox integrations still need native validation. Windows and Linux sandbox implementations require broader escape testing and independent security review. Check the [implementation status](IMPLEMENTATION_STATUS.md) before relying on a platform feature.
