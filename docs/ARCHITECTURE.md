# Architecture

## Runtime shape

The CLI and local control API are clients of the shared runtime. A run resolves configuration, creates or resumes a versioned session, selects a model, assembles messages, calls the provider, evaluates each proposed tool against policy, executes allowed tools, records observations and usage, and repeats until a final response or a stop condition. The API streams runtime events and routes approval decisions back through the same policy callback, so clients do not implement another agent loop.

```text
CLI / local API / browser GUI / VS Code extension
                 │ request + AgentEvent stream
                 ▼
         AgentRuntime ── Router ── Provider
              │                     │
        ToolRegistry              HTTP/SSE
        ├─ ApprovalPolicy           │
        ├─ Workspace or machine-scoped file tools
        ├─ Approval/autonomy policy
        └─ Process adapter ───── local or remote OpenAI-compatible API
              │
        SessionStore ── MemoryStore ── GoalStore ── WorkspaceSearch
```

`node src/cli.mjs serve` starts an authenticated HTTP control plane bound to `127.0.0.1`. It creates a fresh in-memory bearer token for each process and writes a one-time JSON bootstrap record to stdout; a desktop host should capture that pipe privately. The API rejects non-loopback peers, unexpected Host headers, and browser origins absent from `api.allowed_origins`. It exposes run creation/status/cancel, resumable server-sent events, pending approval responses, and session list/detail. Provider calls, tools, persistence, and permission decisions remain in `AgentRuntime` and its stores.

The user-level `tools.autonomy = "unrestricted"` profile exposes machine-wide files and process execution without app-level approval, deny-rule, or secret-filter checks. It also inherits the full OS-user environment. This profile cannot elevate the process beyond OS account permissions and cannot be enabled by project config. The `assisted` profile retains workspace and secret-safety policy.

## Module contracts

- `AgentRuntime.run(request)` is the only owner of the model/tool loop. It enforces max turns, cancellation, tool policy, per-run token limits, and read-only modes.
- `ModelProvider` in `src/core/contracts.d.ts` defines the shared `listModels`, `chat`, and `stream` operations and their normalized response events. Provider-independent conformance tests exercise the interface. Capability, context, and price data stay on model profiles; transports do not infer them from model names.
- `Provider.chat(messages, options)` returns normalized assistant text, function calls, and usage. `Provider.stream` yields normalized events while retaining the same terminal response contract.
- OpenAI-compatible provider responses use a shared bounded JSON reader. Model lists are sanitized and capped; ordinary JSON completions and aggregate SSE streams have separate fixed byte ceilings. Oversized responses fail with safe provider errors rather than being partially decoded or retained without bound.
- `BraveWebSearchProvider.search(query, { signal })` is an optional, separately configured network adapter. Its tool requires approval by default, resolves credentials only at request time, enforces request/response limits, and returns results through the untrusted observation envelope.
- `StdioMcpManager` connects only to explicitly enabled user-configured MCP stdio and Streamable HTTP servers. It negotiates supported protocol versions, bounds tool/resource/prompt discovery and schemas, rejects HTTP redirects, and registers namespaced tools with AgentRuntime. Legacy handshake servers may receive a session ID that stays in memory, is sent only to that configured endpoint, and is deleted best-effort on close; the current `2026-07-28` protocol stays stateless. Tool results use the normal approval/audit/untrusted-observation path. Workspace isolation supports Linux stdio under Bubblewrap with no network and a read-only signed-package mount; MCP environment references, HTTP transports, and persistent Windows isolation remain unavailable. Global read-only mode does not start MCP servers.
- `SkillLibrary` reads bounded `SKILL.md` packages only from absolute user-configured directories. Its manifest subset supports discovery and on-demand loading as untrusted reference material; it never executes skill code or treats skill text as policy.
- `SkillLibrary` reads `SKILL.md` packages only from absolute user-configured directories. Its bounded manifest subset supports discovery and on-demand loading as untrusted reference material; it never executes skill code or treats skill text as policy.
- `ToolRegistry` exposes schema and metadata separately from execution. In assisted mode, approval and destructive flags are enforced by runtime policy, not taken from model arguments. Unrestricted mode intentionally bypasses these app-level controls.
- `PlatformPaths` canonicalizes workspace paths and rejects lexical traversal and symlink escapes in assisted mode. Machine scope accepts absolute paths; unrestricted autonomy also follows machine-wide symlinks.
- `ProcessRunner` invokes argv directly, captures bounded output, and enforces timeout/cancellation across descendants (POSIX process group; Windows `taskkill /T /F` with direct-child fallback). Shell execution is an explicitly enabled high-risk tool. `workspace-write` and `workspace-read` route process tools through Bubblewrap on Linux or the packaged AppContainer helper on Windows; workspace-read mode denies writes to the selected workspace. Missing backends fail closed, and `read-only` hides process-capable tools.
- `DesktopAutomation` inspects the interactive desktop through Windows UI Automation or Linux AT-SPI, returning a bounded tree of accessible controls. Actions target a path from the latest inspection and verify the control name before clicking or typing; key input accepts validated CTRL/ALT/SHIFT combinations with letters, digits, navigation keys, and F1-F16. It is exposed with process access, requires approval in Assisted mode, and is disabled when process sandboxing is required because desktop control must reach the host session. Linux requires a graphical session and `pyatspi`; X11 input uses `xdotool`, while Wayland keyboard input uses `wtype` and pointer input uses `ydotool` plus its user-session daemon.
- `SessionStore` writes versioned JSON through same-directory temporary files and validates IDs before resolving storage paths. Compaction archives the full older transcript before reducing active history.
- `MemoryStore` is project-local and separate from session history. It rejects linked `.agent` directories and memory files. Reads are capped at 4 MiB, entries at 10,000 characters, and documents at 1,000 entries; entry timestamps and provenance are validated before context assembly. Mutations use an exclusive cross-process lock and atomic replacement to avoid lost updates; cleanup removes only the lock file whose identity still matches the writer's open handle. A timed-out or stale lock fails closed and requires the user to verify the writer is gone before removing it. Lock contents are not copied into errors or logs. Memory is user-visible data, not trusted system policy.
- `VersionedSchemaRegistry` owns the current versions and contiguous migration functions for sessions, compaction archives, project/global memory, goals, and their exports. Memory v1 migrates to v2 with creator provenance derived from its prior source field; when v1 has an update timestamp but no editor metadata, the editor is recorded as `unknown`. Before writing the upgraded record, `MemoryStore` creates and verifies an exact-byte sibling backup while holding its cross-process lock; failed writes restore the original bytes. Newer schemas and backup conflicts fail closed. Sessions and goals remain at v1 and reject unsupported versions.
- `ProjectInstructions` loads bounded `AGENTS.md` files from the workspace root through directories targeted by file tools. New nested guidance is labeled as untrusted and the first action on that path is deferred so the model can read the guidance before trying the action again. These files cannot grant tool permissions or override runtime policy.
- `GoalStore` keeps project goals separate from session history and compaction.
- `SubagentManager` asks for approval in assisted mode and runs without app-level approval in unrestricted mode. It allocates a cross-process concurrency slot, creates a fresh child session and managed Git worktree, propagates cancellation, applies a share of the parent token budget, and records typed status/results. Repositories with a valid `HEAD` use that commit. An unborn repository gets a private baseline commit built from its current Git-visible files with a temporary index; this does not stage or commit changes in the parent checkout, and Xyst `.agent` state is excluded. External Git filters are disabled while creating the snapshot and inspecting changes. Child changes are retained for review and never merged automatically; task history is visible from CLI and the authenticated API.
- `WorkspaceSearch` scans workspace files on demand. In assisted mode it observes `.gitignore` and sensitive-path exclusions and returns bounded redacted excerpts. Unrestricted mode can search an absolute root and includes ignored/sensitive files. `SemanticWorkspaceIndex` adds opt-in incremental embeddings, a content-free bounded vector cache, cosine ranking, source line ranges, and explicit approval in assisted mode. Only loopback embedding endpoints are accepted unless remote HTTPS transmission is explicitly enabled. Use `search --semantic <query>` or `index status|clear`; the next semantic query incrementally builds or refreshes the index.

## Data flow and trust

System policy, user messages, project guidance, tool output, retrieved files, and model output remain distinguishable. Tool output and retrieved content are observations; they never change the approval policy. Tool schemas are sent to the model as affordances, but the runtime independently validates names, arguments, workspace paths, and permissions before execution.

Sessions are stored under `<workspace>/.agent/sessions`. Project memory and goals are stored separately under `<workspace>/.agent`. Both locations are ignored by Git by default. Versioned exports support explicit local backup and import flows; shared sessions and cloud synchronization are outside the current design.

Managed Git worktrees live under `<workspace>/.agent/worktrees`; the CLI and API create, list, and remove them. Removal checks tracked, untracked, and ignored changes and refuses destructive cleanup. CLI and API runs can select a worktree, saved sessions remain associated with it, and root project memory/goals/policies are shared. Interactive switching remains open; crashed worktree leases fail closed and require verified manual recovery.

## Failure behavior

Provider failures, invalid tool arguments, denied approvals, tool timeouts, budget stops, and user cancellations are distinct outcomes. The runtime preserves completed work in the session before stopping. It does not retry tools or provider calls automatically in this version.

## Platform strategy

Shared interfaces use Node APIs and explicit path/process adapters. Platform-specific security is not approximated with prompt rules. Required isolation uses Linux Bubblewrap or the packaged Windows AppContainer helper and fails closed when the selected backend is unavailable. Linux validates workspace mounts and checks the bound root device/inode inside the sandbox before starting the requested process. Both backends remain prototypes pending complete native escape/recovery testing and independent review; the product does not claim a production-validated sandbox boundary.
