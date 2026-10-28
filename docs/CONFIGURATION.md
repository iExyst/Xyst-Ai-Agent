# Configuration reference

Configuration merges in this order, from lowest to highest precedence:

| Order | Source | Scope |
| --- | --- | --- |
| 1 | Built-in defaults | Always present; includes the first-run Unrestricted automation profile. |
| 2 | User TOML | User-wide model, tool, security, and product settings. |
| 3 | Workspace `.xyst.toml` | Project defaults, subject to user-policy checks; it cannot add user-trusted integrations or weaken an explicitly configured user sandbox/Assisted profile. |
| 4 | User runtime sidecar at `<config.toml>.runtime.json` | Allowlisted settings explicitly saved through the authenticated local API. Most settings apply to new runs; autonomy and sandbox changes can also be queued for active runs while every run is paused, then take effect at the next safe checkpoint after resume. |
| 5 | `XYST__...` environment variables | Final configuration layer; nested names use `__` separators, for example `XYST__BUDGETS__MAX_TURNS=12`. |
| 6 | Invocation-specific CLI options | Override only the corresponding run/command input and only for that invocation. They do not rewrite configuration. A CLI option cannot weaken a user-required sandbox or runtime hard denial. |

The runtime sidecar schema is separate from TOML and accepts `default_model`, optional `review_model` and `plan_model` role overrides; `routing.selection` and `routing.prefer_local`; allowlisted `budgets`; `tools.autonomy`; `ui.sidebar_collapsed`, `ui.theme`, `ui.shortcuts_enabled`, and per-action `ui.shortcuts`; user model-profile overrides; `sandbox.mode` and per-process-tool `sandbox.tools` overrides; signed `app_updates` preferences and trust metadata; `memory.global_enabled`; `app_data.directory` for cross-project global memory; and per-server `mcp.servers` overrides. To change autonomy or sandbox settings while a run is active, pause every active run first; the settings event announces when the new policy is queued and when it becomes active. A policy update is not applied in the middle of a model request or tool action. Data directory changes require an absolute path on the current platform; setting the directory to `null` restores the platform default. When the location changes, Xyst AI Assistant merges validated global-memory records into the selected directory, keeps the old copy as a backup, and refuses conflicting record IDs rather than overwriting either copy. Data-directory changes are blocked while API runs or global-memory requests are active. Finish CLI runs and close other Xyst AI Assistant instances first; they retain the data-directory setting loaded at process start. Workspace `.agent` state such as sessions and project memory stays with each workspace. This setting does not relocate configuration, credentials, or extension packages. The sidecar accepts credential references but never credential values. `null` removes an optional model, budget, or MCP server override; for review and plan roles, this restores the default-model fallback, and for a key binding it restores that action's built-in shortcut. Shortcut bindings accept `Ctrl+letter/number`, `Alt+letter/number`, optionally followed by `+Shift`, or `/`; active bindings must be unique. The sidecar is validated, bounded, and written atomically with user-only file permissions. Config paths are:

- Windows: `%APPDATA%\Xyst AI Assistant\config.toml`
- Linux: `$XDG_CONFIG_HOME/xyst-ai-assistant/config.toml`, falling back to `~/.config/xyst-ai-assistant/config.toml`

The dependency-free parser supports bare/basic/literal quoted keys, dotted keys/table names, single-line and multiline value strings, booleans, decimal and based integers, floats, date/time tokens (preserved as strings), comments, nested and multiline arrays, inline tables, and arrays of tables. It rejects unsupported TOML constructs instead of guessing. The parser has not yet passed the full TOML 1.0 conformance suite.

When no user config is present, the runtime defaults to unrestricted autonomy: machine-wide file scope, shell and process tools enabled, and recursive directory listing enabled. This is the product's default automation profile; set `tools.autonomy = "assisted"` explicitly in user config to require Xyst AI Assistant approvals and use the configured workspace/file policies. Unrestricted mode still has hard operational ceilings: file reads/edits/writes are limited to 32 MiB, directory listing returns at most 5,000 entries after scanning 50,000 names, JSON tool results are limited to 1 MB, and screenshots to 8 MiB decoded. Directory listing honors run cancellation. Project config cannot raise an explicitly Assisted user profile, remove a user-configured denied tool/path/command, or weaken a user-required sandbox. It may add denials and narrow access. The OS account still controls what the process can access.

## Example

```toml
default_model = "local"
workspace = "."
review_model = "review"
compact_model = "local"

[models.local]
provider = "openai-compatible"
base_url = "http://127.0.0.1:1234/v1"
model = "my-local-model"
context_length = 32768
local = true
supports_tools = true
supports_vision = false # Enable only when this endpoint/model accepts image_url content.
input_cost_per_million = 0
output_cost_per_million = 0

[models.review]
provider = "openai-compatible"
base_url = "https://model.example/v1"
model = "review-model"
api_key_env = "REVIEW_API_KEY"
context_length = 128000
supports_tools = true

[routing]
prefer_local = true
minimum_context_tokens = 4096
selection = "balanced"

[memory]
# Off by default. When enabled, cross-project user memory is included as bounded,
# explicitly untrusted model context and can be managed with `memory global`.
global_enabled = false
max_context_chars = 8000

[budgets]
max_turns = 8
max_input_tokens = 100000
max_output_tokens = 16000
max_tool_output_bytes = 100000
# Optional cumulative conversation ceilings
# max_session_input_tokens = 200000
# max_session_output_tokens = 40000
# max_session_cost = 2.00

[observability]
# Disabled by default. When enabled, allowlisted run lifecycle metadata is
# written under <workspace>/.agent/observability with one rotated backup.
enabled = false
# Optionally emit the same sanitized JSON Lines records to service stderr.
console_enabled = false
max_file_bytes = 10485760

[retrieval]
max_files = 3000
max_file_bytes = 500000
max_results = 25

[retrieval.semantic]
enabled = false
base_url = "http://127.0.0.1:1234/v1"
model = "your-local-embedding-model"
allow_remote = false
timeout_ms = 60000
# input_cost_per_million = 0.0 # set a known USD input price; use 0 for a local free model

[tools]
shell_enabled = true
filesystem_scope = "machine"
autonomy = "unrestricted"
recursive_listing = true

[web_search]
enabled = false
provider = "brave"
api_key_secret = "brave.search" # or api_key_env = "BRAVE_SEARCH_API_KEY"
max_results = 5
timeout_ms = 10000

[approvals]
deny_tools = []
auto_approve_tools = []
deny_write_paths = []
auto_approve_write_paths = []
deny_process_commands = []
auto_approve_process_commands = []

[sandbox]
mode = "disabled"

[discovery]
enabled = true

[local_servers.lm_studio]
base_url = "http://127.0.0.1:1234/v1"
```

The OTLP exporter sends OTLP/HTTP JSON traces to the exact `traces_endpoint`. HTTP is allowed only for loopback collectors; other endpoints must use HTTPS. Redirects are rejected. Collector headers may reference `env:VARIABLE` or `secret:vault.key`; literal credential values and URL-embedded credentials are rejected. The exporter defaults to batches of up to 64 spans and queues at most 512, limits requests and parsed responses to 1 MiB, uses a five-second default request timeout, and retries transient HTTP/connection errors with bounded exponential backoff and jitter. It does not retry OTLP partial-success responses. Exported attributes are limited to lifecycle event names, correlation/run/session IDs, model/tool labels, statuses/error codes, token counts, durations, and estimated cost. Prompts, file paths, tool arguments/results, response text, and raw provider/collector error messages are never included. Project `.xyst.toml` files cannot enable telemetry exporters; configure this in user TOML.

## Lifecycle hooks

User configuration may define one argv-only executable hook for each lifecycle event. Hooks are opt-in, bounded to 10 seconds and 8 KiB of combined process output, and receive a bounded JSON record on stdin. The record contains event/session identifiers and limited action metadata; it does not contain prompts, model responses, tool arguments, or process output. Hook output is never passed to the model. In assisted mode, environment variables associated with secrets are removed. `workspace-write` and `workspace-read` run hooks through the configured OS process sandbox and refuse execution if that sandbox is unavailable; global `read-only` mode skips hooks.

`pre_model` and `pre_tool` are fail-closed: nonzero exit, timeout, output overflow, or process failure blocks the associated action. `post_model`, `post_tool`, and `on_error` are advisory; their failures are recorded as `hook_failed` events and do not undo completed work. Hooks run with the user's configured process authorization, so only define commands you trust. Workspace `.xyst.toml` files cannot define hooks.

```toml
[tools]
shell_enabled = true

[hooks.pre_tool]
command = "node"
args = ["./automation/check-tool.js"]
timeout_ms = 3000
```

Supported event tables: `hooks.pre_model`, `hooks.post_model`, `hooks.pre_tool`, `hooks.post_tool`, and `hooks.on_error`. Each accepts `command` (required), `args` (optional string array, at most 64 items), and `timeout_ms` (optional integer from 1 through 10000). Commands are launched directly without shell interpretation.

## Signed extension packages

The package verifier accepts directory packages containing `manifest.json` plus the exact payload files listed in that manifest. The Ed25519 signature covers a canonical statement with package type, ID, semantic version, signer key ID, and every relative file path, byte length, and SHA-256 digest. The verifier rejects undeclared files, symlinks, traversal, portable path collisions, oversized content, unknown keys, and locally revoked keys or package revisions. Package content is staged from already verified bytes into a version-addressed directory. Installation does not enable or execute the package; skill/MCP activation still requires explicit configuration.

Trust roots and revocation settings are user-config-only. Add publisher public keys by key ID; obtain and verify the fingerprint through a trusted out-of-band channel before trusting a publisher. Optional signed revocation feeds update only when explicitly refreshed; runtime uses the verified cache and fails closed when active skills exist but the cache is missing or expired.

```toml
[extensions]
revoked_key_ids = []
revoked_packages = []
# Optional. The key ID must exist in trusted_keys below.
# revocation_url = "https://updates.example.com/xyst/revocations.json"
# revocation_key_id = "xyst-revocations-2026"
# revocation_max_age_hours = 72
# update_feed_url = "https://updates.example.com/xyst/packages.json"
# update_key_id = "xyst-revocations-2026"
# update_max_age_hours = 72
# Optional; default is a sibling `extensions/` directory beside config.toml.
# install_directory = "C:/Users/me/AppData/Roaming/Xyst AI Assistant/extensions"

[extensions.trusted_keys]
publisher-2026 = """-----BEGIN PUBLIC KEY-----
REPLACE_WITH_A_VERIFIED_ED25519_PUBLIC_KEY
-----END PUBLIC KEY-----"""
```

Use `node src/cli.mjs extensions fingerprint <public-key-file>` to compute the SPKI SHA-256 fingerprint for out-of-band comparison, `extensions verify <package-directory>` to inspect a package signature, and `extensions install <package-directory>` to stage it. `extensions list` shows package activations; `extensions enable skill|mcp <id> <version>`, `disable skill|mcp <id>`, and `rollback skill|mcp <id>` manage signed package activation. Run `extensions refresh-revocations` and `extensions check-updates` to fetch and verify the configured signed feeds; `extensions list-updates` reads the unexpired update cache offline. Signed package feeds can stage rollouts with an optional percentage and stable local cohort; `extensions install-update <type> <id>` enforces the same cohort gate, verifies the metadata digest and full package signature before writing payload files, then stages it inactive. The runtime rechecks signatures and revocations whenever it discovers active packages; skill instructions remain untrusted, and signed MCP entry points launch only when explicitly activated and referenced by enabled user MCP configuration. Background polling, automatic activation, and fine-grained OS capability enforcement remain under development.

Local-server discovery probes configured aliases first, de-duplicates matching base URLs, and optionally checks the built-in loopback defaults for Ollama, LM Studio, and llama.cpp. It accepts at most 16 lowercase aliases. Probes are limited to four concurrent requests with an 800 ms default timeout; redirects are rejected, `/models` responses are capped at 1 MiB, and results include at most 500 model IDs of up to 256 characters. Positive and negative results are cached in memory for 15 seconds. For LM Studio on loopback port 1234, discovery also reads the native model API to identify installed models that are not loaded and report loaded context sizes. Settings lets you explicitly load an installed LLM before adding it; this can use substantial system memory, does not download model files, and is never triggered by discovery or app startup. Model loading is authenticated through Xyst's local control API and forwards only a selected, catalog-verified LLM ID to LM Studio's fixed loopback endpoint. Discovery does not scan process names, other hosts, or remote network ranges.

The shared OpenAI-compatible provider also caps `/models` responses at 1 MiB and returns up to 500 sanitized model records with bounded identifiers. Non-streaming chat responses are capped at 8 MiB and streamed responses at 16 MiB total. Oversized or invalid responses fail with a safe provider error instead of being partially consumed.

Semantic retrieval is opt-in. When enabled, the configured OpenAI-compatible `/embeddings` endpoint receives redacted workspace chunks and the search query. Local endpoints (`localhost`, `127.0.0.1`, or `::1`) are accepted by default. Sending workspace text to a non-local service requires `allow_remote = true` and HTTPS; optionally configure `api_key_env` or `api_key_secret`. The persistent index under `.agent/retrieval` contains vectors, source paths, hashes, and line ranges, but no source text. `.gitignore`, built-in generated-directory exclusions, user exclusion globs, binary checks, file-size limits, and sensitive-path exclusions apply. Workspace scanning is capped at 64 MiB and the vector cache at 32 MiB/5,000 chunks. The scanner rechecks canonical workspace paths and opens regular files with no-follow semantics where supported before reading bounded contents. The `semantic_search` tool requires approval because it transmits workspace excerpts to the configured embedding service. Results combine embedding similarity and exact lexical evidence using reciprocal-rank fusion. Embedding requests reserve a conservative UTF-8 byte count against configured daily/monthly shared token limits before sending, then settle from provider usage or an estimate of `ceil(characters / 4)` (at least one token per input). Set `input_cost_per_million` to the provider's USD input rate (including `0` for a local free model) to include embedding cost in shared cost limits; if cost caps are enabled and the rate is unknown, a request is blocked before sending. Use `node src/cli.mjs index status|reindex|clear` and `node src/cli.mjs index exclude list|add <glob>|remove <glob>`; changed files are incrementally embedded on semantic search. Exclusion globs are relative to the workspace root and persisted separately under `.agent/retrieval`.

Automatic retrieval context is disabled by default. Set `[retrieval].auto_context = true` only if you want each agent run to send its redacted request and bounded workspace chunks to the configured embedding endpoint and attach the top results as transient, untrusted context. It requires `retrieval.semantic.enabled = true`; remote embedding endpoints must also pass the explicit HTTPS/`allow_remote` validation. The runtime records a content-minimized audit event, caps the injected excerpt size, and drops retrieval before the active user request if the context window is tight. Use `auto_context_max_results` (1–10, default 4) and `auto_context_max_chars` (512–20000, default 8000) to set stricter bounds. Retrieved excerpts are not persisted in session messages.

`autonomy` accepts `assisted` or `unrestricted`; a missing setting defaults to `unrestricted`. Set `[tools].autonomy = "assisted"` in user configuration or select it in authenticated browser Runtime settings to require Xyst AI Assistant approvals and restore configured workspace/file policies. The runtime setting is saved in the user-level `.runtime.json` sidecar and can be switched back to Unrestricted there. Unrestricted mode enables absolute paths across the machine, recursive listing, foreground and background processes, interactive process input, desktop interaction, inherits the full OS-user environment, bypasses app-level approval and deny rules (including configured web search), ignores configured file read/write, directory-list, tool-output, and Xyst AI Assistant token/cost limits, and allows access to credential files and unredacted tool output. Foreground and background processes run without an automatic timeout unless `timeout_seconds` is explicitly supplied; they can still be cancelled or stopped. Provider context/output limits, host resources, and OS permissions still apply. `computer_control` uses the Windows accessibility API or Linux AT-SPI, offers transient screenshots for vision-capable profiles, and supports accessible controls, coordinate click/drag/scroll, text entry, and key combinations; Windows resolves coordinates through accessibility patterns, Linux X11 uses xdotool, and Linux Wayland uses ydotool for pointer actions and wtype for keyboard actions. Wayland pointer input requires the user-session ydotool daemon and OS permission to access `/dev/uinput`. The packaged Windows desktop uses its native host for screenshot capture; standalone Windows CLI capture uses PowerShell and may be blocked by Defender AMSI. The tool requires process access and cannot operate when required process sandboxing is active. Linux additionally needs an interactive graphical session and pyatspi; screenshots need grim on Wayland or ImageMagick `import` on X11. `run_process` passes argv directly; `run_shell_script` explicitly invokes PowerShell on Windows or Bash on Linux. The shell tool is exposed when process execution is enabled; assisted mode requires approval and applies its configured environment and sandbox policies. This profile runs with the permissions of the Xyst AI Assistant OS account; it cannot elevate privileges beyond that account. It cannot be combined with `workspace-write` or `workspace-read`. Project `.xyst.toml` files cannot elevate a user-selected Assisted profile or weaken a required user-level sandbox. The browser settings display the active mode.

MCP servers are opt-in in user configuration. Set `[mcp].enabled = true` and enable each named server; project config cannot declare MCP servers. Stdio servers use `command` and `args` and require process capability (`tools.shell_enabled = true` in assisted mode). With `workspace-write` or `workspace-read`, Linux stdio servers run under Bubblewrap with no network, a read-only signed package mount (for activated MCP packages), and the selected workspace mounted according to the configured mode. Configured MCP environment references are rejected in these modes. Global `read-only` mode does not start MCP servers. HTTP transports remain unavailable under process isolation because network exceptions are not implemented; persistent MCP sandboxing is also unavailable on Windows. An activated signed MCP package may be selected with `package_id` instead of `command`; the runtime launches its signed `.mjs` `entry_point` with configured `args` and revalidates its signature and payload at startup. The package must first be explicitly activated with `extensions enable mcp <id> <version>`. If it advertises tools, resources, or prompts, it must declare the matching `mcp.tools`, `mcp.resources`, or `mcp.prompts` capability. A configured revocation feed must have a current cached signed snapshot before any active package is used. Streamable HTTP servers use `transport = "streamable_http"`; Xyst tries the modern transport first and falls back to legacy HTTP+SSE only when the handshake returns HTTP 404 or 405. Set `transport = "sse"` explicitly for a server that exposes only the deprecated 2024-11-05 SSE transport. Both use `url`; remote endpoints require HTTPS and development endpoints may use loopback HTTP. Optional `headers` map names to `env:VARIABLE_NAME` or `secret:vault-entry` references; redirects are rejected, and the message endpoint advertised by an SSE server must share the configured origin so credentials are not sent elsewhere. Never put credential values in TOML. Advertised tools, listed resources, and listed prompts are exposed as namespaced, approval-policy mediated tools; their content remains untrusted. Outside workspace-isolated Linux mode, MCP code runs with the agent's OS account privileges; capability declarations do not sandbox direct process access.

Instruction skills are also opt-in and user-configured. Set `[skills].enabled = true` and list up to 16 absolute paths under `directories`. Each root may contain skill folders with a `SKILL.md` whose front matter has exactly `name` and `description`, followed by Markdown instructions. Names must be lowercase hyphenated identifiers matching the folder name. `list_skills` reveals names and descriptions; `load_skill` returns one bounded skill as untrusted reference material. Skill text cannot grant permissions or override runtime policy. Project config cannot add skill roots. The initial loader does not install, execute, sign, update, or revoke packages.

```toml
[skills]
enabled = true
directories = ["C:/Users/me/.config/xyst-ai-assistant/skills"]
```

```text
skills/
└── release-check/
    └── SKILL.md
```

The repository includes a sample in `examples/skills/release-check/SKILL.md`; copy its directory into a user-owned skill root to enable it.

For machine-wide file access while retaining normal approval controls, set `filesystem_scope = "machine"` and `shell_enabled = true` instead. File tools accept absolute paths anywhere on the current machine, including a `root_path` for `search_files`; relative paths still resolve from the selected workspace. `run_process.cwd` can choose an absolute working directory. Credential path/content filtering remains active in this assisted profile.

`max_input_tokens` and `max_output_tokens` cap one run. Optional `final_response_reserve_tokens` is withheld from tool-capable provider calls for a final response. The agent also reserves up to `recovery_summary_input_tokens` (default `1024`) from run and session input allowances for a concise provider-generated partial summary when an Assisted run stops at a budget or model-turn limit. The input reserve is capped at 10% of the run's available input allowance; set it to `0` to disable recovery summaries. The output reserve defaults to the smaller of 512 tokens or one quarter of the run output cap. If the final summary cannot be reserved against a shared daily/monthly quota or cost ceiling, Xyst AI Assistant uses the saved static stop reason instead. Optional `max_session_input_tokens` and `max_session_output_tokens` are cumulative across resumes and include delegated child usage. `max_session_cost` is a USD ceiling. Before a provider call, Xyst AI Assistant reserves against UTF-8 request bytes as a conservative prompt-token upper bound and the requested output-token ceiling; the model profile must define input and output prices or the call is blocked. After a response, usage is settled from provider token counts when available and estimated counts otherwise. Accuracy depends on the configured model prices matching actual provider billing. Daily and monthly token/cost ceilings are shared across sessions and processes; see `node src/cli.mjs usage status` and browser runtime settings for totals and 45-day daily, per-session, and per-model attribution. Provider-reported and estimated token counts are separate; cached-input counts are reported as a subset of input tokens when the provider returns them. When a separate cached-input rate is configured, valid provider-reported cached tokens use that rate; budget reservations stay conservative at the regular input rate. Unknown prices are counted without presenting them as zero-cost calls. Reporting continues in unrestricted mode without enforcing configured usage caps.

Automatic compaction is disabled by default. Set `[compaction].enabled = true` to summarize old turns when estimated session history reaches `trigger_ratio` of the selected model's context window (default `0.8`). The runtime checks before each model turn, so a large tool result can trigger compaction in the middle of a run. It can also compact once per run when an enforced run, session, daily, or monthly input-token or estimated-cost ceiling reaches `budget_trigger_ratio` (default `0.8`). Output-only ceilings do not trigger compaction because summarizing cannot restore output allowance. `keep_recent_turns` controls how many recent user turns stay verbatim (default `2`). Before summarizing, the runtime checks remaining run, session, and shared token/cost budgets; the compaction call is reserved and settled like other provider calls. The complete pre-compaction transcript is archived before the active history is replaced. If compaction cannot run within budget, the run stops with a budget message; other summarization failures are reported and normal context trimming remains available.

`api_key_env` stores only the environment variable name. Set the variable in the process environment before launching Xyst AI Assistant. Base URLs cannot contain user/password credentials, query strings, or fragments. The config file itself must not contain a credential value.

On Windows and Linux, a model may instead set `api_key_secret = "provider-key"`. This resolves the named entry from Windows Credential Manager or the Linux Secret Service at provider execution time. Use the exported `WindowsCredentialStore` or `LinuxSecretServiceStore` implementation to provision credentials from a trusted setup flow; the CLI does not print vault values. The entry is scoped to the current OS user. If the vault or its service is unavailable, the request fails and Xyst AI Assistant does not fall back to plaintext storage. A model can use only one of `api_key_env` and `api_key_secret`.

To move an existing environment credential into the vault, set it in the process environment and run `node src/cli.mjs secrets set provider-key --from-env PROVIDER_API_KEY`. The command reads the value from the named environment variable, stores it in the OS vault, and never echoes it. `secrets list` shows entry names only on Windows; Linux `secret-tool` does not provide a stable attribute-only listing, so use the configured key and `secrets delete <key>` to manage an entry. Configure the model with the same key using `api_key_secret`.

`sandbox.mode` accepts `none`, `workspace-write`, `workspace-read`, or `read-only`. `none` runs process tools with the current account's OS permissions. The two workspace modes use Bubblewrap on Linux or the packaged Windows AppContainer helper and fail closed when the backend is unavailable; `workspace-write` permits changes only in the selected workspace, while `workspace-read` mounts that workspace read-only. Windows process isolation uses private temporary storage, no network capabilities, standard-stream handles only, bounded output, and a kill-on-close process job. `read-only` exposes local inspection tools and hides process-capable tools. Optional `[sandbox.tools]` entries can tighten policy for `run_process`, `run_shell_script`, or `start_background_process`; a `read-only` entry hides that tool. Per-tool settings cannot weaken the global setting. Persistent background processes and MCP startup remain unavailable under isolation when the platform backend does not support them. Workspace isolation cannot be combined with unrestricted autonomy or machine-wide file scope. For one CLI agent invocation, `--sandbox` accepts the same four modes and cannot weaken the saved policy. The override applies to agent runs, including runs in managed worktrees.

`tools.autonomy = "unrestricted"` opts into machine-wide paths, shell-capable process execution, enabled configured web search without approval prompts, and no Xyst AI Assistant approval, sensitive-path, credential-redaction, deny-rule, or configured token/cost-budget checks. It is intended for a user-controlled local installation. It does not grant Windows/Linux privileges the launching account does not have, bypass OS permissions, or guarantee that every capability exists on every platform. It cannot be combined with `workspace-write` or `workspace-read`; choose assisted autonomy when process isolation is more important than unrestricted access. Hard runtime file, listing, and tool-result ceilings still apply, as do model context/output caps and explicit cancellation. For an Assisted CLI run, `--approval-policy approve-all` is a run-scoped alias for `--yes`; it accepts interactive approval prompts but does not override hard policy denials, configured deny rules, or sandbox constraints. Omit it or use `--approval-policy prompt` to keep the normal prompt behavior.

`approvals` supports explicit `deny_tools`, `auto_approve_tools`, `deny_write_paths`, `auto_approve_write_paths`, `deny_process_commands`, and `auto_approve_process_commands` string arrays. Denials win over allow rules and grants. Write path patterns are relative to the canonical workspace root and support `*`, `?`, and recursive `**`; they are checked after symlink-aware workspace resolution. Process patterns match the executable and argv rendered as a space-separated command, with arguments containing spaces quoted as JSON strings. Keep process patterns specific: a broad wildcard can auto-approve more commands than intended. Session grants remain exact-action grants with their own expiry.

Time-bounded workspace rules can be managed with `node src/cli.mjs approvals list|add|revoke` or the authenticated `/v1/approval-rules` API. A rule targets one named tool and has a `tool`, `path_glob`, or `command_glob` scope, an `allow` or `deny` decision, and a duration from 60 seconds to 30 days. Rules are stored under `.agent/approvals`; both creation and revocation are audited. Denials take precedence over all allows and the sensitive-data boundary.

Interactive approval prompts offer one-time approval, an exact-action session grant, and a one-hour exact-path rule for file writes or a one-hour exact-argv rule for process calls. Saved choices are workspace rules, write audit records, and can be reviewed or revoked with the commands above. Commands containing `*` or `?` arguments do not offer the exact-command option.

Automatic keyless search is enabled by default for current-information questions. It combines recent global news from GDELT DOC with Wikipedia reference results; if one source is temporarily unavailable, results from the other are still returned. Choose **Automatic**, **Wikipedia**, or optional **Brave Search** in **Settings → All runtime settings → Live web search** or `[web_search]` in the user TOML file. Brave's API key is optional and stored only in the OS credential vault, while settings snapshots expose only whether a credential is configured. If Brave is selected but its key is missing or rejected, Xyst falls back to Automatic keyless search. Model API credentials are separate from web search; LM Studio normally needs no model credential. In Assisted mode the agent asks approval before sending a bounded query; the approval prompt shows it. Requests are limited to 10 per minute per provider, 10 results, 500 query characters, 10 seconds by default, and 2 MiB of response data. Results accept HTTPS URLs only and remain untrusted model context. Other data providers can be connected through configured HTTP MCP servers.

Current weather and today's forecast use Open-Meteo directly and require no API key. Name a city or place; Xyst does not infer location. Assisted mode asks before sending the location to the weather service. Open-Meteo's free endpoint is for non-commercial use; commercial deployments need an appropriately licensed provider.

## Subagents

Subagents are disabled in a fresh configuration. The browser/desktop **Settings → All runtime settings → Agent orchestration** controls enablement and maximum concurrency; changes are saved in user runtime settings and apply to new runs. When enabled, `delegate_task` can run a child in a new Git worktree and session. In Assisted autonomy, the user approves each delegation, and the child separately asks before using write or process tools. Unrestricted autonomy bypasses Xyst approval prompts; the operating-system account and any selected OS sandbox still apply. Each child receives only its delegated task and shared read-only project memory, with no parent transcript or session grants. Child changes remain in the worktree for review and are never merged automatically. In Assisted mode, child token ceilings use at most 40% of the remaining parent run budgets, and the configured `max_turns` and `timeout_ms` apply. Unrestricted mode skips those budgets and timeout; `max_concurrent` continues to cap simultaneous children across processes.

The parent can explicitly call `retry_subagent_task` for a `stopped`, `failed`, `cancelled`, or `timed-out` attempt from the same parent session. Assisted mode asks for approval. A retry starts a fresh child session and worktree, increments the attempt number, and keeps earlier task records and worktrees for review. It does not copy or merge changes from a previous attempt; the parent must review and decide what to carry forward. Successful or active tasks cannot be retried, and overlapping attempts in one retry lineage are refused.

```toml
[subagents]
enabled = true
max_concurrent = 2 # 1–8 concurrent children across processes
max_turns = 4
timeout_ms = 300000
```

Active slots and task-store mutations use owner-only lock files and fail closed if a process crashes while holding one; inspect task records under `.agent/subagents` before manually recovering stale locks. Use `node src/cli.mjs subagents list|read <task-id>` or authenticated `GET /v1/subagents` endpoints to inspect recorded tasks and worktree paths, including each attempt's `attempt` number and optional `retry_of` task ID. An authenticated `POST /v1/subagents/{task_id}/cancel` requests cancellation of a live child without cancelling the parent run. It works only while that child is active in the current API process; after a restart, use the interrupted-task recovery report instead of signaling an unverifiable process. Cancelled worktrees remain for review. Repositories with a valid `HEAD` start children from that commit. An unborn repository starts from a private snapshot of its Git-visible files; snapshot creation leaves the parent index and `HEAD` unchanged and excludes Xyst `.agent` state. Git filters do not run during snapshot creation or change inspection.

## Environment overrides

Use two underscores between nested keys. Examples:

```text
XYST__DEFAULT_MODEL=local
XYST__BUDGETS__MAX_TURNS=5
XYST__MODELS__LOCAL__BASE_URL=http://127.0.0.1:1234/v1
```

Numeric and boolean values are parsed; other values remain strings. Environment variable overrides are intended for non-secret settings. Provider credentials should use separate variables referenced by `api_key_env`.

## Application updates

The Runtime settings screen lets you choose `disabled` (default), `manual`, or `notify` (check at application startup). The `stable` or `preview` channel can be selected there. A release feed URL, key ID, and Ed25519 public key are user-level settings; project configuration cannot set them. The UI displays the signing-key fingerprint for out-of-band verification. After a check, you can explicitly download the selected release; Xyst AI Assistant verifies its signed size and SHA-256 before offering a one-time local download link. Installing it remains your decision. See [Application updates](APP_UPDATES.md) for the feed contract and signing workflow.

## Model fields

Each model profile may set `temperature` from 0 to 2. Xyst forwards the value to both streaming and non-streaming OpenAI-compatible chat calls. A value of 0 requests deterministic sampling where the provider supports it; provider behavior may differ. Profiles may also set `reasoning_effort` to `none`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Xyst omits this field unless explicitly configured because support varies by server and model. For LM Studio reasoning models that spend the whole output budget on hidden reasoning, select `none` in Runtime settings to request a direct response; the setting is saved per profile and can be changed later.

Architect can run bounded, read-only code reviews while the local control API is running. Configure `[architect]` in the user config; project `.xyst.toml` files cannot enable it. It is disabled by default. Set `enabled = true` to turn on scheduling, set it back to `false` to stop scheduling, and restart the API for the change to take effect. Choose `interval_hours` from 1 to 168. `run_on_start = true` starts a review when the API starts. Automatic reviews use at most six model turns, 40,000 input tokens, 4,000 bytes per tool result, and an output allowance capped to the selected model's context window. Reviews rotate through 28 source/test pairs spanning the core, API, providers, configuration, sessions, platform security, tools, extensions, goals, and backups. A report is marked insufficient unless the reviewer successfully reads the exact source file and paired test assigned for that review pass. Reviews disable shell execution, web search, MCP, skills, subagents, and semantic retrieval, and review mode omits destructive tools. By default, Architect uses only a configured local model. Set `allow_remote = true` to permit configured remote models, which may receive repository source. Reports are redacted, stored under `.agent/architect/reports`, and limited to the latest 30. Use `node src/cli.mjs architect status|run` to inspect reports or start one review. Architect does not apply code changes; repair automation requires an isolated snapshot and a separate promotion policy.

`provider` currently accepts `openai-compatible`; `base_url` is the API root, usually ending in `/v1`; `model` is the server's model ID. `context_length`, `supports_tools`, `supports_vision`, `local`, input/output cost, and timeout values guide routing or request limits. Set `supports_vision = true` only when the configured endpoint/model accepts OpenAI-compatible image content. Optional `coding_strength`, `tool_calling_quality`, and `speed_score` values range from 1 to 10; `priority` ranges from 0 to 1000, with lower values preferred. Prices are supplied by the user and are estimates. The browser and desktop Runtime settings let you edit each profile's regular input, cached-input, and output rates; blank prices remain unknown. The browser and desktop Runtime settings also let you update context length, locality, tool-call support, vision support, coding/tool/speed scores, and routing priority, then record when and where those capabilities were checked. When a new model is added from LM Studio, Xyst AI Assistant uses its loopback API's explicit tool-use and vision capability flags when available; it does not infer coding quality from model names, parameter counts, or vendor claims. Other providers may not expose equivalent metadata, so review their profiles yourself. Record `pricing_updated_at` as the UTC date you checked the rates and add a brief `pricing_source` note. Rates older than 90 days or without a review date are marked stale or unreviewed in settings but remain estimates. Set `cached_input_cost_per_million` when the provider documents a separate cached-prompt rate; Xyst AI Assistant applies it only to a valid cached-token count reported by the provider. Without that count or cached price, cost accounting uses the regular input rate. Missing input/output prices remain unknown rather than being reported as zero. Xyst AI Assistant does not fetch provider pricing automatically; update the profile yourself after checking the source. Record capabilities_updated_at and capabilities_source after checking model documentation or testing an endpoint. Capability reviews older than 180 days are marked stale; routing continues to use configured values and includes their freshness status in persisted routing decisions. Xyst AI Assistant does not fetch capability metadata for remote providers.

Prompt-cache request controls are opt-in per model profile: set `prompt_cache_enabled = true` only after confirming that the configured endpoint supports the OpenAI-compatible `prompt_cache_key` and/or `prompt_cache_retention` fields. When enabled, the browser and desktop Runtime settings can set a non-sensitive cache key (letters, numbers, `.`, `_`, `:`, and `-`, up to 64 characters) and select the provider default or 24-hour retention. Leave the feature off for LM Studio or other servers unless their documentation confirms support; Xyst never probes by sending an extra field. These controls do not cache prompt text locally. Cache hit/miss summaries use only provider-reported cached-token counts, and prompt contents and cache keys are not included in telemetry. OpenAI documents `prompt_cache_key` and the optional `24h` retention value in its [Chat Completions API reference](https://platform.openai.com/docs/api-reference/chat).

The router always honors an explicit model pin. With no pin, it selects among configured profiles that meet context, tool, and vision requirements. Agent implementation requests are identified from the bounded recent user prompts and require tool support; ordinary text questions can still use a text-only profile. For Agent implementation routing, the balanced quality score combines coding strength and tool-call reliability, then uses the configured default as a tie-breaker. Set `routing.enabled = false` to disable automatic model scoring; Xyst then uses the configured default profile, or the first configured profile when no default is set, and still rejects it if it cannot satisfy the request. An explicit model pin still works. A configured strict fallback chain remains the only alternate order in this mode. The desktop/browser composer defaults to Auto when automatic routing is enabled; selecting a named profile pins it for that run. The browser/desktop Runtime settings also expose an “Enable automatic model routing” switch. `routing.prefer_local` determines whether capable local profiles lead fallback selection. `routing.selection` chooses a deterministic strategy: `balanced` (default), `quality`, `speed`, or `cost`. Cost selection estimates a request using the input estimate and configured output budget; profiles without both prices sort after profiles with known prices. Unreviewed or stale prices remain estimates and their freshness state is included in routing decisions and the run inspector. Prompt-aware routing is enabled by default for unpinned `agent` runs using the `balanced` strategy without a strict fallback chain. Disable it with `[routing.classifier] enabled = false`. This bounded local heuristic examines at most 12,000 characters total, sampling the beginning and end of longer prompts; it sends nothing to a classifier model. Clear requests for brief answers can use speed scores; substantial implementation, testing, or security work can use coding/tool quality scores. Ambiguous prompts stay balanced. Explicit model choices, review/plan roles, configured non-balanced strategies, and strict fallback chains take precedence. Decisions record the resulting intent and signal counts, not prompt text. Automatic selection depends on the configured profile metadata; Xyst does not infer model capability or quality from model IDs. Keep coding, tool, speed, context, vision, and locality values current in model settings, or pin a model when you want a fixed choice. The offline score compares profile selection against curated labels; it does not measure generated answer quality, response time, or actual request cost.

With automatic routing enabled and no model pin, a provider failure considered safe to fail over can move to another eligible local profile in routing order. Before sending the prompt, Xyst checks the alternate endpoint through `/models` and requires it to advertise the configured model ID. An empty assistant response that exhausts its output limit without visible text or a tool call is treated as a provider failure so Xyst does not report a blank response as success. Automatic failover never sends project context to a remote profile unless the user explicitly places that profile in `routing.fallback_chain`.

For a strict ordered list, set `routing.fallback_chain = ["strong-local", "remote"]`; the default is tried first, followed by this list, and profiles omitted from the list are not selected. For automatic selection with a configured chain, each capable endpoint is checked through `/models` with a short timeout and must advertise the configured model ID; an unavailable endpoint or model is skipped before sending the prompt. If the chain includes a remote profile, a request may be sent there when earlier profiles are unavailable. Configure `routing.health_check_timeout_ms` (100–30000, default 2500) for slower servers. If a provider fails before any streamed text is delivered due to a connection refusal/name-resolution error, a request timeout, HTTP 429, HTTP 500/502/503/504, or model-not-found response, the runtime may check the next eligible local profile or next chain entry and retry. When a rate limit, timeout, or transient server error leaves provider acceptance uncertain, input usage and configured input cost are charged conservatively; failed output allowance is released. Other provider errors are not retried. Explicit `--model`, review, and plan model choices never silently switch and are not probed. Routing decisions record selection factors, availability checks, alternatives, and capability/provider rejection reasons for status and review. Mid-run model changes after a turn has been accepted remain unimplemented.

Each model profile supports `retry_attempts` from 0 to 2 (default 1). Before trying another profile, the runtime retries one retryable HTTP 429 or 500/502/503/504 response, or a known connection refusal/name-resolution failure, if no streamed text has been emitted. Backoff starts at 250 ms and doubles, capped at 5 seconds; a valid `Retry-After` response header is honored up to 5 seconds. Cancellation interrupts the delay. Timed-out requests are not replayed because the provider may already have accepted them; they may still use the configured fallback chain. Uncertain failed attempts are charged conservatively.
