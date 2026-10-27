# Xyst

Xyst is a Windows and Linux local-first agent runtime. LM Studio is the primary inference backend, with GitHub and Hugging Face integrations. The desktop and command line share one runtime and saved state.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Start

```sh
npm install
npm run build
npm run xyst -- status
```

Use `npm run dev -- --help` to run the CLI from source. By default, state is stored in `%APPDATA%/xyst` on Windows and `$XDG_DATA_HOME/xyst` (or `~/.local/share/xyst`) on Linux. Set `XDG_DATA_HOME`/`APPDATA` to choose a different data root. `xyst lm daemon-status` reports whether the installed LM Studio CLI sees headless `llmster` or the desktop server.

## Desktop

Run `npm run desktop:dev` during development or `npm run desktop:package` to create a platform-native package in `release/`. `npm run icons:build` regenerates the alien-robot SVG-derived PNG and multi-resolution ICO assets. The desktop uses the same runtime, CLI, database, sessions, missions, and editable memory. Its Changes view lets you choose a local repository and inspect Git status, staged or unstaged diffs, and recent commit history. The Terminal view opens a native PTY shell with keyboard input, terminal control sequences, and resize support; sessions remain inspectable in Jobs. Packaged CLI actions use a bundled Node runtime matching the native SQLite module, so target machines need no separate Node installation. Windows NSIS and Linux AppImage packages are built on their respective native platforms; the CI workflow builds the desktop production renderer and runs deterministic runtime/CLI tests on Windows and Ubuntu; hosted execution requires a configured Git remote; see the [platform support matrix](./docs/platform-support.md) and [build status and known limitations](./BUILD_STATUS.md).

## CLI commands

Run `npm run dev -- --help` for the command list. Add `--json` for newline-delimited structured results. `agent chat` opens an interactive, saved chat; use `--session <id>` to continue one and enter `/exit` to leave. `run` executes an executable with argv directly. `shell` explicitly invokes PowerShell on Windows or `/bin/sh` on Linux. `process start [--interactive] -- <executable> [args...]` starts a detached process job (also available in the desktop Jobs view); inspect it with `process list|show`, send stdin with `process input`, close stdin with `process end-input`, and request process-tree cancellation with `process stop <job-id>`. `jobs list` and `jobs show <job-id>` inspect all persisted job kinds. `lm models` lists local LM Studio models, while `lm ask`, `lm stream`, and `lm json` send prompts through its REST APIs. Direct native `lm ask` and `lm stream` use configured global inference defaults, with per-request flags such as `--min-p`, `--reasoning`, `--top-k`, and `--repeat-penalty` overriding those defaults. Pass `--integration-file lm-integrations.json` to override saved LM Studio plugins or per-request MCP servers for one direct chat. Saved definitions can be enabled in desktop Settings → Direct chat integrations or with `integrations.lmStudio.nativeChat.enabled`; the file format and vault-backed headers are in [LM Studio support](./docs/lm-studio-support.md). Begin a stateful chat with `--stateful`, then continue it with `--previous-response-id ID`; use `lm count-tokens` or `lm tokenize` against an already loaded model. `lm json` accepts a local JSON Schema file. Agent tasks accept repeated `--attach path` options for bounded UTF-8 text, selectable-text PDFs, and PNG, JPEG, or WebP images; the desktop has a native picker for new and resumed tasks, and attachments persist when sessions resume. Agent tasks can search the public web with Brave Search and retrieve public pages with bounded `web_fetch`; configure search with `credential set brave search-api-key`. Persistent Chromium automation is optional: install it with `browser install`, enable it with `browser on`, and inspect settings with `browser status`. Native application automation is separately opt-in with `desktop automation on|off|status`. On Linux, `desktop status` reports the detected Wayland/X11 session and which UI automation backends are available. MCP servers can be configured with `mcp set servers.json`, discovered with `mcp discover`, and enabled for tasks with `mcp enable on`. Store an LM Studio token with `credential set lmstudio api-token`; token input is hidden in an interactive terminal or read from stdin. Hugging Face discovery and downloads are independently opt-in with `model discovery on` and `model downloads on`; configure an optional Hub token with `hf auth set`. Check completed downloads with `hf download-status <job-id>`, then use `hf verify-download <job-id>` to run a small inference probe when no other model is active. Draft a mission graph from an objective with `mission plan`; review its JSON before saving with `mission create`, then run it with `mission run` or keep schedules and GitHub triggers active with `mission daemon`. Mission memory/concurrency limits are configurable with `config set orchestration.memoryBudgetBytes <bytes-or-null> global` and `config set orchestration.maxConcurrency <1-8> global`. Local model inference and task outcome measurements can be controlled with `telemetry on|off|status` and inspected with `lm stats [model-key]`. Run `lm resources` to inspect measured host RAM and NVIDIA VRAM when `nvidia-smi` is available; remote and non-NVIDIA GPU memory are not reported. Manage saved context with `memory list|search|add|edit|delete`; optional LM Studio semantic retrieval is enabled with `memory semantic on <embedding-model>` and existing entries can be indexed with `memory index`. The desktop shares these entries and exposes semantic retrieval settings. See [GitHub integration setup](./docs/github-support.md) for personal tokens, App credentials, permission requirements, and integration toggles.

For an interactive pseudoterminal process, run `process start --pty --cols 100 --rows 30 --cwd <directory> -- <shell> [args...]`; use `process resize <job-id> <columns> <rows>` when the display changes. The desktop Terminal view starts the platform shell in a PTY and keeps its job/output available in Jobs.

See the [architecture decisions](./docs/architecture.md), [configuration reference](./docs/configuration.md), [recovery guide](./docs/recovery.md), [desktop update feed setup](./docs/updates.md), [saved session management](./docs/sessions.md), [job inspection](./docs/jobs.md), [mission definitions and runner behavior](./docs/missions.md), [Hugging Face model acquisition](./docs/model-acquisition.md), [general agent tools](./docs/general-tools.md), and the [LM Studio support matrix](./docs/lm-studio-support.md) for current capabilities and limitations.

## Build sequence

See [BUILD_STATUS.md](./BUILD_STATUS.md) for milestone scope and implementation status.

Long saved sessions can be compacted with `xyst session compact <id> [--model key]` or `/compact` in `agent chat`. Xyst keeps the full transcript for export and uses the summary plus recent messages to resume. Use `xyst session summary <id>` to inspect the saved summary.
