# Product requirements

## Product definition

Xyst AI Assistant is a local-first coding and computer-use agent for Windows and Linux. One shared runtime serves the CLI, desktop application, and VS Code extension. It connects to local OpenAI-compatible servers such as LM Studio and Ollama, and to configured remote providers. Users can inspect and control its work through persistent sessions, tool results, approvals, logs, and project data.

Xyst AI Assistant offers two autonomy postures. **Assisted** applies Xyst AI Assistant's approval, path, and sandbox policies. **Unrestricted** removes Xyst AI Assistant's app-level approval and workspace scoping so automation can use the current operating-system account's accessible files, applications, and processes. Windows, Linux, provider, and service permissions still apply; Xyst AI Assistant cannot confer administrator/root rights or defeat an OS security boundary. A model response, project instruction, retrieved document, skill, or MCP server cannot switch the user's autonomy setting.

## Terminology

| Term | User-facing meaning |
| --- | --- |
| **Provider** | A configured service or local server that supplies model responses. |
| **Model** | A specific model identifier served by a provider. |
| **Profile** | Xyst AI Assistant's capability and preference record for a model, such as context size, tool quality, vision, locality, and cost. |
| **Session** | A persisted conversation and its runtime events, tool calls, results, usage, and selected worktree. |
| **Thread** | A user-facing conversation. In the current product, one thread maps to one session; use “session” in storage and API contracts. |
| **Tool** | A named runtime operation the model may request, such as reading a file, running a process, searching, or controlling the desktop. The runtime validates every request before execution. |
| **Approval** | A user's decision to allow or deny a specific proposed action, optionally under a bounded, expiring grant. |
| **Autonomy** | The user's choice between Assisted and Unrestricted app-level policy. Fresh installs default to Unrestricted; this does not change OS account privileges. |
| **Sandbox** | An OS-enforced process boundary that limits filesystem, network, and process access. A requested sandbox is available only when its backend is implemented and verified on that platform. |
| **Memory** | User-editable, project-scoped notes stored separately from conversation history. Memory is data, never policy. |
| **Worktree** | A Git-managed checkout used to isolate a task's source changes. It is not a security sandbox. |

## Requirements

1. **Platforms and surfaces.** Windows and Linux are first-class targets. The CLI, Tauri desktop app, and VS Code extension share the same agent runtime, API, configuration semantics, and versioned session format. macOS is outside the product scope.
2. **Models and routing.** Users can connect to local OpenAI-compatible services and configured remote providers. Manual model choice is respected; automatic routing explains its choice and records fallbacks.
3. **Automation.** The runtime can read and change files, run and manage processes, search project content, use configured extensions, and control an interactive desktop where the platform supports it. Unrestricted mode avoids Xyst AI Assistant approval prompts while respecting OS security boundaries.
4. **Policy and isolation.** Assisted mode enforces tool schemas, grants, approvals, configured path scope, and available OS sandboxing at runtime. Workspace sandbox modes fail closed if their required platform controls are unavailable; read-only mode hides process-capable tools. Sandbox availability must be reported per platform and cannot be inferred from a configuration value alone.
5. **User control and recovery.** Users can inspect proposed and completed actions, stop runs and child processes, review changes, manage sessions and project memory, and recover or diagnose interrupted work. Destructive cleanup requires explicit user intent or an existing exact-action grant.
6. **Persistence and privacy.** Sessions, memory, goals, usage, and audit records have documented schemas and locations. Vault credentials are resolved only when needed and are not serialized into sessions or ordinary logs. Session persistence applies structured and recognizable-string redaction to a clone in every autonomy mode, leaving the active model context untouched; this is best-effort pattern matching and does not protect against arbitrary unmarked or unsupported secret encodings. Retrieved content and tool output remain untrusted observations.
7. **Reliability.** Cancellation, timeouts, budgets, output limits, provider errors, and policy denials have defined runtime behavior. Completed work is preserved when a run stops.
8. **Distribution.** Builds and tests cover supported Windows and Linux targets. Release artifacts identify versions, include applicable notices, and can be checked for integrity.

## Non-goals and explicit limits

- macOS support.
- Granting administrator/root privileges, bypassing OS permissions, escaping another security boundary, or guaranteeing access to hardware or services the OS does not expose.
- Treating prompt wording, a model's confidence, project files, or extensions as permission grants.
- Merging agent changes or installing/updating third-party extensions without the configured user action.
- Claiming required sandbox protection on a platform until isolation and cleanup tests prove its controls.
- Sending local project content to a remote model, embedding service, web service, or MCP server without the applicable configuration and user policy.

## Acceptance evidence

The detailed phase gates and cross-platform test matrix live in [BUILD_ROADMAP.md](../BUILD_ROADMAP.md). Product completion requires those gates to pass on Windows and Linux; a mocked backend or a passing unit test alone does not establish OS isolation, GUI behavior, or release readiness. Current platform limitations are tracked in [PLATFORM_SUPPORT.md](PLATFORM_SUPPORT.md), and security claims belong in [SECURITY.md](SECURITY.md).
