# ADR 0006: Isolated, approval-gated subagents

## Status

Accepted for the first delegated-task implementation.

## Decision

Subagent delegation is opt-in and requires approval at the parent. A child receives only the delegated task, not the parent transcript or session grants. It uses a fresh session and a dedicated Git worktree. Repositories with a valid `HEAD` use that commit. Unborn repositories use a private baseline commit built from Git-visible files through a temporary index; it leaves the parent index and `HEAD` untouched and excludes Xyst `.agent` state. Git filters are disabled while building this snapshot and inspecting child changes. The child can read shared project memory, but changes only its own worktree. Child writes/process operations use the normal runtime approval callback. Changes are not merged automatically.

The manager reserves one of a bounded number of cross-process slots, enforces a timeout and a child token allocation capped to 40% of remaining parent input/output budgets, propagates cancellation, and returns child status, session ID, usage, and changed paths. Child usage is included in the parent session totals. Task state is persisted under `.agent/subagents` and exposed through authenticated API and CLI read commands.

## Consequences

- The parent can inspect and manually integrate child changes without sharing a mutable checkout.
- In repositories with a valid `HEAD`, parent uncommitted changes are not present in the child worktree. An unborn repository snapshots its current Git-visible files so the first child can work before an initial commit exists.
- Each child write still requires its own approval; parent approval grants no child capability.
- A crashed child may leave a task marked starting/running and a slot lock behind. Recovery and cancellation by task ID require a future lifecycle API; locks fail closed in the meantime.
- Parallel child model/tool actions are not available in one runtime loop; each `delegate_task` call waits for its child result.
