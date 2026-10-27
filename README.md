# Xyst AI Assistant

Xyst AI Assistant is a cross-platform computer automation agent for Windows and Linux. It is being built around one shared runtime for the CLI, desktop app, and IDE extension. The current executable foundation provides configuration, OpenAI-compatible local/remote providers, model routing, a tool-calling agent loop, configurable workspace or machine-wide file tools, session persistence, project memory, and keyword retrieval.

Xyst AI Assistant project source is licensed under Apache-2.0; see [LICENSE](LICENSE). Third-party dependencies and bundled runtimes retain their own licenses. CI checks the complete Cargo dependency inventory against [`licenses/rust-policy.json`](licenses/rust-policy.json) and retains the reviewed inventory as an artifact. The policy fails closed on missing metadata and unapproved expressions; see [the dependency license process](docs/THIRD_PARTY_LICENSES.md). Packaged third-party notice collection remains a release requirement.

## Requirements

- Node.js 22 or later
- Windows or Linux
- A local OpenAI-compatible server or a remote OpenAI-compatible endpoint

The agent core, one-shot CLI, and service use Node.js built-in modules. The opt-in `--tui` interactive composer uses Ink and React, loaded only when that terminal UI is requested; install project dependencies with `pnpm install --frozen-lockfile` to use it. The bundled desktop service does not load the terminal UI. The optional native desktop host has Rust/Tauri build dependencies and uses the platform WebView.

On first launch with no model profiles configured, the browser UI offers a local model finder. It checks only `127.0.0.1` ports `11434`, `1234`, and `8080` by requesting each server's `/v1/models` endpoint after you select **Find local models**. For LM Studio on local HTTP port `1234`, it also reads `/api/v1/models` to show which installed models are loaded and the smallest active context length. Select **Load & use** for an installed model that is not loaded; loading uses LM Studio memory but does not download model files. Discovery and loading send no prompts or workspace files. Choose a listed model to add it as the default, or configure a provider in Runtime settings.

The composer starts with **Auto · best match for this task** when automatic routing is enabled. Implementation requests require a tool-capable profile and balanced routing compares coding strength with tool-call reliability. Select a named profile in the composer to pin that model for the run; the configured default remains the router's preferred profile.

For development checks, install the pinned formatter/linter with `pnpm install --frozen-lockfile`, then run `pnpm lint` and `pnpm check`. Apply the configured formatting with `pnpm format`; `pnpm format:check` verifies it without writing files.

On Ubuntu 24.04, run `pnpm check:linux` as a non-root user to exercise the required Bubblewrap, pidfd, filesystem-link, and Secret Service integrations. The command refuses to run as root because that does not test the intended unprivileged process boundary.

## Quick start

1. Copy `config.example.toml` to your user config directory (`%APPDATA%\\Xyst AI Assistant\\config.toml` on Windows, or `$XDG_CONFIG_HOME/xyst-ai-assistant/config.toml` on Linux; defaults to `~/.config/xyst-ai-assistant/config.toml`).
2. Set the environment variable referenced by the selected model's `api_key_env`, if it requires a key.
3. Set the provider `base_url` and `model` to values served by your local server or endpoint.
4. Run `node src/cli.mjs --workspace . "Inspect the project and summarize its structure."`.
5. Use `node src/cli.mjs --help` for options. Run `node --test` for the test suite.

For the browser/desktop interface, autonomy modes, sessions, backups, extension setup, and the opt-in update flow, see the [user guide](docs/USER_GUIDE.md).


Fresh installs and the shipped `config.example.toml` enable unrestricted local autonomy: machine-wide file tools, process execution, credential-file access, inherited user environment, no app-level approval prompts, no configured token/cost caps, and no configured file, listing, or tool-output size caps. The process cannot exceed the permissions of its OS account or a model provider's context/output limits. Configure `tools.autonomy = "assisted"` to retain workspace boundaries, secret filtering, approvals, and configured usage caps. Signed extension packages support explicit install, activation, rollback, revocation refresh, authenticated update checks, and candidate-manifest verification; package downloads and activation remain explicit. Required process isolation is available through Linux Bubblewrap and the packaged Windows AppContainer helper in assisted mode; both fail closed when unavailable and still need broader escape testing and independent security review before they should be treated as production security boundaries.

Useful CLI entry points:

```text
node src/cli.mjs models
node src/cli.mjs serve --port 0
node src/cli.mjs --mode review "Review the workspace for correctness issues."
node src/cli.mjs --json "Inspect the workspace and summarize its current state."
node src/cli.mjs --image ./diagram.png "Explain this architecture diagram."
node src/cli.mjs --mode plan "Plan a migration to the new API."
node src/cli.mjs sessions list
node src/cli.mjs sessions inspect
node src/cli.mjs --resume latest "Continue the most recently updated conversation."
node src/cli.mjs --tui --workspace .
node src/cli.mjs sessions export <session-id> ./session.json
node src/cli.mjs sessions import ./session.json
node src/cli.mjs backup export ./xyst-project-backup.json
node src/cli.mjs backup restore ./xyst-project-backup.json
node src/cli.mjs sessions compact <session-id>
node src/cli.mjs sessions inspect-compactions
node src/cli.mjs sessions grants <session-id>
node src/cli.mjs sessions revoke-grant <session-id> <grant-id>
node src/cli.mjs permissions
node src/cli.mjs permissions list <session-id>
node src/cli.mjs permissions revoke <session-id> <grant-id>
node src/cli.mjs approvals list
node src/cli.mjs approvals add write_file path_glob allow 3600000 generated/**
node src/cli.mjs memory add conventions "Prefer small ESM modules."
node src/cli.mjs goals add "Ship the cross-platform CLI"
node src/cli.mjs goals progress <goal-id> "Linux sandbox integration passes in CI."
node src/cli.mjs goals update-progress <goal-id> <entry-id> "Revised verification result."
node src/cli.mjs architect status
node src/cli.mjs architect run
node src/cli.mjs goals delete-progress <goal-id> <entry-id>
node src/cli.mjs worktrees create agent/feature
node src/cli.mjs worktrees list
node src/cli.mjs worktrees locks
node src/cli.mjs worktrees recover-lock <worktree-id>
node src/cli.mjs subagents inspect-interrupted
node src/cli.mjs subagents inspect-worktrees
node src/cli.mjs subagents recover-interrupted <task-id>
node src/cli.mjs processes list
node src/cli.mjs processes input <process-id> "continue"
node src/cli.mjs usage status
node src/cli.mjs --worktree-id <worktree-id> "Implement the change in this worktree."
node src/cli.mjs search "AgentRuntime"
node scripts/check.mjs
node scripts/evaluate-routing.mjs
node scripts/evaluate-agent.mjs
pnpm bench:retrieval -- --files 1500 --file-bytes 2048
node scripts/build-release.mjs
```

`npm run build:release` creates a deterministic cross-platform source archive in `dist/release/`. The archive includes the CLI, browser UI, VS Code client, tests, documentation, dependency-free build scripts, and canonical desktop artwork, with a SHA-256 manifest. Target-generated Tauri icon variants and platform schemas are rebuilt by the desktop build. It requires Node.js 22 or later. This is a source bundle, not a signed installer or native executable.

Session exports use a versioned JSON envelope, include compacted transcript archives, and are written with owner-only permissions where supported. The local browser UI can also import and export sessions. Import creates a new active session ID and drops session approval grants, worktree paths, and prior budget state. Secret redaction uses patterns and cannot identify every secret, so review an export before sharing it.

Project backups package sessions and compaction archives, project memory, and goals in a bounded versioned file. Restore first validates every component in a staging workspace, then installs the staged `.agent` directory only if the destination workspace has no existing `.agent` state; it never merges or overwrites project state. Goal IDs are preserved so imported sessions keep goal references; session IDs are regenerated. Configuration, credentials, approval rules/grants, audit and usage ledgers, processes, worktrees, semantic indexes, and observability records are excluded. Treat backup files as sensitive conversation data and store them accordingly.

Image input supports PNG, JPEG, and WebP through repeated CLI `--image` flags or the local browser UI. Configure the selected model with `supports_vision = true`; images are bounded, large images are resized/compressed, and binary image data is not saved in session transcripts.

Keyless automatic search is enabled by default and runs for current-information questions. It combines recent global news from GDELT DOC with Wikipedia references, continuing with either source if the other is unavailable. For broader web coverage, select Brave Search in Runtime settings and optionally provision its API key through the OS credential vault or an environment variable reference. If the key is missing or rejected, Xyst falls back to automatic keyless search. In Assisted mode, each query requires approval and is shown verbatim before it is sent; returned pages are treated as untrusted context. Model-provider API credentials are separate; LM Studio normally needs no credential, and web lookups do not use the model credential.

The offline routing regression set is stored in `eval/routing-cases.json`. Run it with `npm run eval:routing`, or pass a JSON dataset path to `node scripts/evaluate-routing.mjs`. It reports overall and per-category selection accuracy and exits nonzero for invalid data or a labeled mismatch. Cases contain only synthetic profiles and never make provider calls. The versioned end-to-end agent scenarios are in `eval/agent-scenarios.json`; run them with `npm run eval:agent`. They use deterministic response fixtures, exercise the shared runtime and workspace tools without network access, and report aggregate task checks, tool sequence/denials, expected workspace-file checks, latency, token usage, and estimated cost without printing prompts or model responses. The fixtures include an approved edit and a denied edit whose file must stay unchanged. Use `node scripts/evaluate-agent.mjs eval/agent-scenarios.json --json` for structured output. Live model checks are separate and opt-in.

`pnpm bench:retrieval` measures synthetic workspace generation, initial semantic indexing, warm search, embedding batch counts, index size, and process RSS delta without contacting a model server. Defaults are 1,500 files at 2 KiB each; `--files`, `--file-bytes`, and `--scan-bytes` adjust the bounded fixture. Results are local measurements, not cross-platform performance claims.

An opt-in live smoke is available for a model running on the same computer. Set `XYST_LIVE_MODEL` to an exact ID returned by the server, then run `pnpm smoke:live-model`; optionally set `XYST_LIVE_MODEL_BASE_URL` (default `http://127.0.0.1:1234/v1`). The runner accepts only unauthenticated HTTP loopback endpoints, uses an isolated temporary workspace and Assisted mode, exposes no shell or desktop tools, and approves writes only to its single expected fixture file. It verifies a read/edit/read-back flow and deletes the workspace. It sends only the synthetic task and fixture to the local model. This opt-in smoke is not a substitute for the deterministic suite or Linux CI.

To verify live pause/resume handling, run `pnpm smoke:live-resume` with the same environment variables. It holds the first model request while it queues a pause and revised direction, then verifies that the same run and session resume and that the direction is honored. For LM Studio, it checks the read-only model status endpoint first and tells you to load the selected model if it is installed but not currently loaded; it never loads or changes model state.

To exercise LM Studio's real context-overflow recovery, run `pnpm smoke:live-overflow` with the same environment variables and a loaded model whose context is reported by LM Studio. It uses a disposable workspace with synthetic text and read-only calls, then verifies that provider overflow causes tool history to be trimmed and the agent completes. This live acceptance passes against the loaded 8,192-context Qwen3 Coder model. The smoke does not change user files or LM Studio settings.

The Tauri desktop host is in `gui/desktop/`. Build it with Rust and the Tauri prerequisites for the host platform using `pnpm check:desktop` and `pnpm build:desktop`; then launch it with `cargo run --manifest-path gui/desktop/src-tauri/Cargo.toml -- --workspace .`. The build verifies and packages a pinned Node.js runtime for x64/ARM64 Windows and Linux, and shares the CLI service, sessions, and browser UI. Set `XYST_NODE` to override the bundled runtime during development. To create a Windows NSIS installer, run `pnpm build:desktop:windows-installer` on Windows; `pnpm smoke:desktop:windows-installer` installs it into isolated temporary app-data folders, verifies the native app and AppContainer helper, launches the packaged service and UI, then shuts it down and uninstalls the app. To create Linux DEB and AppImage packages, run `pnpm build:desktop:linux` on Ubuntu with Tauri's Linux prerequisites installed; the AppImage smoke requires `dbus-run-session` and `xvfb-run`, and runs as `pnpm smoke:desktop:linux-appimage`. CI is configured to build, smoke, and retain all three platform artifacts, though hosted CI has not yet been observed. The Windows installer and Linux packages are unsigned; native Ubuntu Desktop/Wayland validation and RPM remain open.

Semantic retrieval is optional. Configure `[retrieval.semantic]` with a local OpenAI-compatible embedding endpoint (LM Studio supports `/v1/embeddings` when an embedding model is loaded), then use `node src/cli.mjs search --semantic "query"` or enable the approved `semantic_search` agent tool. The index is incremental and stores vectors plus source metadata, not raw file text. Remote embeddings require explicit HTTPS opt-in. Use `node src/cli.mjs index status|clear` to inspect or clear the index; it rebuilds incrementally on the next query.

To use the bundled local browser interface, run `node src/cli.mjs serve --port 0`, then open the printed origin with `/app` (for example, `http://127.0.0.1:49152/app`). The page stays on the loopback origin and receives the per-process token only for its same-origin API client.

Worktrees are created beneath `.agent/worktrees`. Removal refuses worktrees with tracked or untracked changes; commit or clean those changes before removing the worktree ID shown by `worktrees list`. `worktrees locks` inspects lease ownership without changing files. After confirming a task owner is gone, `worktrees recover-lock <id>` removes a lock only when same-host OS identity checks prove its recorded process is absent or its PID was reused; remote, legacy, malformed, and unverifiable locks are retained for manual review.

Subagent task records identify their owning process without persisting its command line. `subagents inspect-interrupted` is read-only; `subagents recover-interrupted <task-id>` marks a task failed and releases its stale concurrency/worktree leases only after the same-host OS identity checks prove the owner process is gone or its PID was reused. Its worktree contents are retained for inspection. `subagents inspect-worktrees` reports managed worktrees without a task record, their lock state, dirty paths, and a suggested next step; it never removes files. The authenticated `GET /v1/subagents/recovery` endpoint provides the same inventory alongside interrupted tasks.

## Project map

- `src/core/` — agent orchestration, budgets, context trimming, routing, and events
- `src/providers/` — normalized provider interface and OpenAI-compatible HTTP/SSE implementation
- `src/platform/` — path containment, child processes, and native desktop accessibility adapters
- `src/tools/` — tool schemas, assisted approval policy, and workspace/machine file tools
- `src/config/` — TOML subset parser and layered configuration
- `src/session/` — versioned JSON sessions, compaction archives, and recaps
- `src/memory/` and `src/goals/` — project memory and persistent goals
- `src/architect/` — scheduled, bounded, read-only code reviews
- `src/retrieval/` — ignore-aware keyword/path search and opt-in incremental semantic retrieval with bounded, content-free vectors
- `src/cli.mjs` — command-line client
- `src/api/` — authenticated local control API shared by the browser UI and VS Code client
- `gui/` — shared browser UI plus a Tauri desktop host prototype for sessions, streaming, approvals, model selection, and workspace search
- `tests/` — Node built-in test suite
- `.github/workflows/ci.yml` — Windows/Linux syntax and test matrix
- `docs/` — architecture, security, local API, evaluations, and release guidance
- `BUILD_ROADMAP.md` — full ordered product build map

## Current implementation boundary

This is an actively developed product foundation; the full roadmap is not complete. Windows Credential Manager and Linux Secret Service adapters are implemented; both have passed live local integration checks. X11 desktop accessibility, resize, and automation smoke passes on Windows and under Ubuntu 24.04 WSL/Xvfb; Wayland input uses wtype and ydotool and remains unverified. The accessibility tool does not expose every custom control. Linux Bubblewrap and the packaged Windows AppContainer process helper have integration checks, but neither boundary has completed broad escape testing or independent security review. The Windows installer passes isolated install/reinstall/uninstall smoke; Linux DEB and AppImage service/window smoke also pass locally under WSL/Xvfb. Hosted CI and physical Ubuntu Desktop/Wayland validation remain open, along with signed installers, MCP lifecycle UX, automatic update installation/rollback, production update infrastructure, and OpenTelemetry export. Application release checks can be disabled, manual, or startup-notify; a user may request an in-app download that is checked against the signed size and SHA-256, while running the installer remains a separate user action. See [Application updates](docs/APP_UPDATES.md) and the [user guide](docs/USER_GUIDE.md). Signed skills support Ed25519 verification, versioned install, explicit activation, rollback, and optional signed revocation feeds refreshed on demand. The VS Code client and desktop/browser UI share the local API. Semantic retrieval is opt-in. Background processes can be started by the agent in unrestricted mode or with approval in assisted mode; unrestricted mode bypasses Xyst AI Assistant's approvals and configured budgets while remaining subject to the permissions of the Windows or Linux account running it. After a manager restart, control is recovered only when OS process identity can be verified. See `BUILD_ROADMAP.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, and `docs/EXTENSIONS.md` for current contracts and limitations.
