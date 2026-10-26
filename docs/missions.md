# Missions

Missions are persisted in the runtime SQLite database and can be run from the CLI or a headless process. A mission definition can contain an ordered task graph, an optional model, a workspace, a cron schedule, and GitHub event filters.

```json
{
  "id": "weekly-check",
  "name": "Weekly repository check",
  "objective": "Review this repository for actionable maintenance work.",
  "workspace": "C:/work/project",
  "maxRetries": 1,
  "maxConcurrency": 2,
  "tasks": [
    { "id": "inspect-api", "objective": "Inspect API code for actionable issues.", "workspace": "C:/work/project-api", "dependsOn": [] },
    { "id": "inspect-ui", "objective": "Inspect UI code for actionable issues.", "workspace": "C:/work/project-ui", "dependsOn": [] },
    { "id": "report", "objective": "Write a concise report of findings.", "dependsOn": ["inspect-api", "inspect-ui"] }
  ],
  "schedule": {
    "cron": "0 9 * * 1",
    "timezone": "America/New_York",
    "enabled": true,
    "missedRun": "skip"
  }
}
```

Create and inspect missions with `mission create <file>`, `mission list`, and `mission show <id>`. Use `mission plan <objective> [--name NAME] [--workspace PATH] [--model KEY] [--max-concurrency 1-8]` to ask the configured local LM Studio model for a bounded task graph. Planning checks installed model choices, task dependencies, cycles, and an approximate memory-based concurrency limit. It prints a draft and does not save or run it; review or edit the JSON, then pass it to `mission create`. The desktop mission editor has the same draft planning action. Use `mission run <id>` for a manual run. `mission daemon` maintains schedules and processes queued GitHub webhooks. `mission pause`, `cancel`, `resume`, and `archive` update durable mission state. SIGINT or SIGTERM stops new scheduling and drains active mission work and queued webhook processing before the daemon exits. The installed systemd unit allows the drain to finish without a fixed stop timeout. Task Scheduler may terminate the process when a task is explicitly stopped or the user session ends, so durable runner recovery remains the fallback for interrupted work.

Cron schedules use the supplied, validated IANA timezone. For a nonexistent spring-forward wall time, Croner fires at the equivalent time after the clock jump (02:30 becomes 03:30 local that date); a repeated fall-back wall time runs once, at its first occurrence. On scheduler startup, `missedRun: "skip"` emits a missed event for the last persisted due time; `"run_once"` attempts one catch-up run for that time, even if several intervals elapsed. A firing that overlaps an active mission is rejected by its durable runner lease and reported as a schedule failure; it is not queued for later execution. These rules prevent duplicate concurrent runs and bound catch-up work.

The runner initially admits ready tasks against available system RAM, additional model-loading and per-worker inference estimates, optional NVIDIA VRAM estimates, and distinct-workspace constraints. As admitted tasks finish, it rechecks live RAM and NVIDIA VRAM where available and backfills open slots with other already-ready tasks whose estimates fit. If resources are still occupied, an over-budget fallback waits until the active batch drains. Tasks sharing a workspace remain serialized. After each completion the runner refreshes the persisted DAG state and can admit newly unlocked dependent tasks in a freed slot, estimating their actual bounded prompt with the completed dependency results before selection. When automatic selection is active and a task has no explicit model assignment, the runner prefers an installed model that fits the remaining estimates. An over-budget pinned model is allowed to run alone and is recorded with an over-budget marker; if no automatic model fits, the lowest-footprint eligible local model is admitted alone to avoid a stalled mission. Automatic fallback to another local model after inference failure still requires `models.automaticSwitching` to be enabled. The estimates are approximate: RAM uses model file size, resident-model incremental GPU cost uses a 12% heuristic, and Xyst does not reserve memory from other processes. Mission context estimates use the same bounded task prompt sent to the agent, including GitHub trigger input and completed dependency results, but not future results from dependencies that have not run yet.

On startup and during scheduling, the runner detects expired mission leases and marks active runs interrupted. Tasks without an uncertain external action return to pending state and resume from their saved session. Completed side effects are keyed by mission task and normalized action arguments, so a resumed tool call reuses its recorded result instead of performing the write again. A task whose process died after recording action intent but before recording the outcome becomes `reconciliation_required`; inspect it with `mission show <id>`, check the real destination, then use `mission reconcile <mission-id> <run-id> <task-id> <tool-call-id> completed|retry`. `completed` skips the write and reuses a reconciliation record; `retry` permits the same action to be attempted again. A process-level recovery test now kills a two-task mission runner immediately after a real marker-file write, opens the same SQLite database in a fresh process, recovers the lease, resumes the interrupted task from its saved session, then runs a dependent file-read task and verifies the marker action is journaled once.

Set the global concurrency ceiling with `config set orchestration.maxConcurrency 4 global` (1–8). Set a fixed RAM estimate budget in bytes with `config set orchestration.memoryBudgetBytes 8589934592 global`, or restore automatic budgeting with `config set orchestration.memoryBudgetBytes null global`. The desktop exposes the same global values under **Settings → Resource limits**. A mission's own `maxConcurrency` remains an additional upper bound; project and mission scoped configuration can override the global limits.

## Installing the mission runner

`mission service install` installs and starts the current user's background runner. On Linux it creates a `systemd --user` unit and enables it for the user's default target. To keep the user service running after logout and start it before the next login, enable lingering with `loginctl enable-linger "$USER"` where system policy permits it. On Windows it registers a Task Scheduler task that starts at the current user's logon and retries failures. Add `--webhook` and optional listener flags to persist the webhook receiver in that service; reinstall the service after changing its listener options. Use `mission service status` to inspect the service/task and `mission service uninstall` to stop and remove it. These commands require the `backgroundJobs` access capability; installation does not change global access profiles. The Windows task runs in the user's logon session, so it starts after login rather than before user credentials are available.

Agent delegation is controlled by `orchestration.delegation.enabled` (enabled by default). When disabled, the planner produces only a single-task draft without named agent profiles, and the runner rejects multi-task or named-agent missions. A mission- or project-scoped setting can re-enable delegation for that mission. Disabling delegation does not disable single-task missions, manual task retries, or mission scheduling.

External action approval is controlled by `autonomy.externalActionApproval` (disabled by default). When enabled, interactive agent runs ask once before each external write or browser mutation. A background runner has no interactive channel and fails closed before the action; approval denials and missing approval channels are not automatically retried. See the configuration reference for the CLI JSON approval protocol.

Network use is controlled by `network.enabled` (enabled by default) and the active access profile. Mission or project scope can further limit or allow network use for that work; a scoped value cannot override a restricted profile. A disabled value prevents LM Studio API calls as well as web and integration requests.

Desktop, CLI, and mission-service agent or mission runs can show opt-in system notifications through `notifications.enabled`. Alerts report completion or failure without including task content. Headless notification delivery requires an interactive notification session: Linux needs an active desktop notification service and D-Bus session; Windows delivery follows the scheduled task's logged-on user notification session. Errors are reported without changing mission outcome. A service running without a user notification session cannot display a notification.

## Mission templates

`mission templates` lists executable starter definitions. `mission template <template-id>` prints a definition that can be saved as JSON and passed to the normal `mission create` command. The desktop mission editor can load the same definitions into its editable JSON field. Templates cover issue-to-PR implementation, read-only pull request review, repository maintenance, research reports, document or spreadsheet production, and custom multi-step workflows. Add the concrete issue, pull request, research question, deliverable requirements, or workflow objective before saving, and set `workspace` to the local project directory for repository work. GitHub write access is disabled in the GitHub templates; explicitly enable it in the mission definition only when publishing is intended.

Mission definitions can declare up to eight named agent profiles and assign tasks with `agentId`. A profile can select a model, turn limit, and access profile; a task can override the model and turn limit and record expected outputs and completion criteria. Each task execution persists an agent record with its role, task, workspace, and lifecycle status. The parent runtime access profile is always enforced in addition to the agent profile, so a mission cannot use an agent profile to widen the process's permissions. Inspect agent records with `agent list [mission-id]` or `mission show <id>`.

The desktop agent fleet view and CLI can set task-specific model and turn limits for future executions. Blank/inherit choices use the mission's agent profile and mission defaults. Configure with `mission task configure <mission-id> <task-id> [--model <key>|--inherit-model] [--max-turns <1-50>|--inherit-max-turns]`. These controls are rejected while the mission is running or archived; they do not change an execution already in progress.

Individual running tasks can be paused without cancelling other parallel tasks with `mission task pause <mission-id> <task-id>`. Resume a paused task with `mission task resume <mission-id> <task-id>`; this continues the existing checkpoint and session. Retry a failed task with `mission task retry <mission-id> <task-id>`. The runner refuses a retry if that task still has an uncertain external action; reconcile it first. A paused task remains in the current mission run and its dependents stay queued until it completes.

Example:

```json
{
  "name": "Review and document",
  "objective": "Improve the repository documentation",
  "workspace": ".",
  "maxConcurrency": 2,
  "agents": [
    {
      "id": "reviewer",
      "name": "Read-only reviewer",
      "model": "publisher/reasoner",
      "maxTurns": 8,
      "access": {
        "mode": "restricted",
        "readRoots": ["."],
        "writeRoots": [],
        "allowedExecutables": [],
        "network": false,
        "integrations": false,
        "backgroundJobs": false,
        "externalActions": false
      }
    }
  ],
  "tasks": [
    {
      "id": "review",
      "agentId": "reviewer",
      "objective": "Inspect the documentation and identify gaps.",
      "expectedOutputs": ["A concise list of actionable gaps"],
      "completionCriteria": "Every finding references relevant repository files.",
      "dependsOn": []
    }
  ]
}
```

Tasks remain bounded by the mission's `maxConcurrency` (1–8), have no recursive delegation tool, and use the normal runtime policy, workspace isolation, external-action journal, and cancellation path.

Every run and task attempt is checkpointed in SQLite. Dependency cycles and unknown dependency IDs are rejected before persistence. `maxConcurrency` is bounded to 1–8. Ready tasks can run together only when they use distinct workspace paths; tasks sharing a workspace remain serialized. Define task-level `workspace` paths for isolated clones when parallel edits are needed, or use `workspaceMode: "worktree"` for an automatically created detached checkout. Worktree listing and guarded cleanup are available. If a runner lease is still live, `mission resume` reports its expiry; retry after the prior runner observes pause and releases it.

When `mission daemon` starts, or while it is running, it checks for expired mission leases and resumes interrupted missions from their saved task checkpoints. Completed tasks remain complete and are skipped. A task interrupted during an external action is held for explicit reconciliation; the daemon does not repeat an action whose outcome is uncertain. Recovery attempts emit `mission.recovery.finished` or `mission.recovery.failed` runtime events. A currently live lease is left alone until it expires.

Mission tool calls are journaled with a stable run/task scope and a hash of the normalized tool name and arguments. A completed external action with the same scope and arguments reuses its stored result after a retry or runner restart. If a process stops while an external action is still running, Xyst marks the task `reconciliation_required` and does not repeat that action automatically. `mission show <mission-id>` lists tool-call IDs, arguments, recorded results, and states. Inspect the external system, then resolve each uncertain call with `mission reconcile <mission-id> <run-id> <task-id> <tool-call-id> completed` if it took effect, or `... retry` if it did not. After all uncertain calls are resolved, run `mission resume <mission-id>`. Reconciliation requires the `externalActions` capability.

Tasks can ask Xyst to create a detached worktree by setting `workspaceMode` to `worktree`. The mission must point to an existing Git repository with a commit. Worktrees are stored under Xyst's data directory by default; set mission `worktreeRoot` to choose another directory. The runtime records each task's workspace before executing it so retries and runner recovery can reuse the same checkout. A dependent task can set `workspaceFrom` to one of its direct dependencies to continue in that task's workspace. Distinct worktree tasks can run concurrently; tasks that share one are serialized. A paused mission resumes its interrupted task in the same checkout, including after a new runner instance starts.

Mission tasks can add `requiredToolEvidence` for checks that should be enforced by Xyst instead of inferred from a model's completion claim. Each entry names the required tool and at least one result assertion: `exitCode`, `stdoutEquals`, or `stdoutIncludes`. For example, a process-verification task can require `{ "tool": "run_process", "exitCode": 0, "stdoutEquals": "expected output\n", "normalizeNewlines": true }`. Newline normalization treats CRLF and LF as equivalent for cross-platform output checks; without it, comparisons are byte-for-byte. The task remains unverified unless the selected persisted evidence comes from that tool and satisfies every configured assertion. This is useful for commands, generated reports, and integration results; it does not replace review of whether the assertion itself covers the task.

Worktrees remain available after a run so changes can be reviewed. Inspect them with `mission workspaces [mission-id]` or `mission show <id>`. Remove one with `mission worktree remove <mission-id> <run-id> <task-id>`. Removal refuses dirty worktree changes; pass `--force` only when those changes may be discarded. Worktree creation and removal require the `externalActions` capability and Git execution permission. Restricted profiles must allow read/write access to the repository and write access to `worktreeRoot`.

## GitHub triggers

Set `githubTrigger.events` to one or more of `issues`, `issue_comment`, `pull_request`, or `pull_request_review`. Optional `repositories` entries use `owner/name`. Configure the secret with `credential set github webhook-secret`, then run `mission daemon --webhook`. The receiver listens on `127.0.0.1:8787/github/webhook` by default; `--webhook-host`, `--webhook-port`, and `--webhook-path` override the listener. Put an HTTPS reverse proxy or tunnel in front for GitHub delivery. Add the same `--webhook` options to `mission service install` to persist them in the systemd or Task Scheduler runner. The handler validates the HMAC signature, stores delivery IDs, and queues matching mission jobs. Event content is untrusted task input. The listener is opt-in and requires network and integration capabilities.

`github.enabled`, `github.writeEnabled`, and `github.mergeAuthorized` set mission scoped integration controls for tools in the agent loop. GitHub writes and merges also require the corresponding global/runtime policy settings and access capabilities.

## Managing mission definitions

Use `mission rename <id> <name>` to rename a saved definition, `mission fork <id> [name]` to create a new copy, and `mission export <id> [path]` to print or save a portable JSON definition without its local ID. Forks retain task and access settings but have schedules disabled and GitHub event triggers removed so a copy cannot start duplicate unattended work. Exported definitions keep their configured schedule and trigger settings for intentional re-import; a path export refuses to overwrite an existing file.

`mission delete <id>` permanently removes the definition, mission run/task history, and mission/agent scoped settings. It retains task sessions and saved artifacts, detaches completed job history, and marks queued mission jobs cancelled. Deletion refuses running missions/jobs, active runner leases, unresolved external-action outcomes, or retained worktrees; inspect and resolve those conditions first. The desktop Missions view exposes rename, fork, export, and delete, with confirmation before deletion.
