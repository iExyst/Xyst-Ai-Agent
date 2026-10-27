# Sessions

The CLI, desktop, and agent runtime use the same SQLite session history. `session list` shows saved sessions, `session show <id>` prints messages, and `session calls <id>` inspects the tool-call journal. Continue work with `agent resume <id> <message>` or select a session in the desktop Sessions view.

While an agent task is running in the desktop, **Stop task** sends a cancellation request to the shared CLI/runtime process. Cancellation propagates to LM Studio generation, web and GitHub API requests, browser operations, MCP calls, and cancellable child processes such as Git and `run_process`. The session is saved with a cancelled status and can be resumed. If cancellation happens while an external side effect has an uncertain outcome, inspect and reconcile that action before retrying it.

The desktop can also send additional text guidance while a task is running. The CLI confirms that the message entered its bounded in-memory queue before the desktop clears the input. Messages are saved as normal user turns between model/tool cycles, after any pending tool results, so they appear in session history and are included in the next inference request. The queue accepts at most 20 pending messages per run and 64 KiB per message. Messages sent after a run exits are rejected; attach files before starting or resuming a run.

An assistant's final message alone does not complete a task. The runtime keeps the required criteria from the user's request, mission acceptance rules, and saved session goals; the model cannot replace or omit them in its verification call. Before completion, the agent must call `task_complete` with a successful evidence index for each criterion, in the order shown to the model. Indexes are one-based and refer to the current system message's list of successful persisted tool results; the runtime resolves each index to its exact saved tool-call ID and validates its output. If one successful result supports every criterion, the model may provide that index once; the runtime records the evidence mapping for each criterion. A successful verification ends the run immediately; any other tool calls in the same response are recorded as failed and are not executed. If the model supplied no final text with its verification call, Xyst records a concise runtime completion summary. The runtime rejects missing, invalid, failed, or verifier-call evidence. A response without a passed evidence check is saved with `unverified` status and remains resumable; `agent run` and `agent resume` return exit code 3 for that state. Missions stop and report an unverified task instead of automatically retrying the same unsupported claim.

Before each model request, Xyst estimates context needs again from the saved conversation. If that estimate grows past the selected model's reported active context, it stops before sending the request, preserves the session, and reports that it should be resumed with a model or context setting that can fit the conversation. This estimate is based on text length and image count and is not an exact tokenizer measurement.

When Xyst loads a local model for an agent task, it requests up to 8,192 tokens of context beyond the current estimate, capped at the model's declared limit. The LM Studio GPU estimate uses the same planned context. This gives ordinary tool results room to accumulate before Xyst needs a larger model instance; very long tasks can still outgrow the reserve.

Use `xyst session compact <id> [--model key]` or enter `/compact [model-key]` in `agent chat` to summarize a completed prefix of a long session. The Sessions view also has a **Compact** action. Xyst uses an installed local LM Studio language model by default; an explicit `--model` or `/compact model-key` selects another local model. Compaction refuses remote LM Studio endpoints, leaves image-containing turns and recent messages intact, and only cuts at an assistant final turn where every tool call has its matching result. A session with no safe completed prefix cannot be compacted yet.

The summary retains the original user goals, decisions, dependencies, completed work, outstanding mission/tool actions, durable facts, and compacted tool-call IDs/results. Incomplete or uncertain external actions remain marked as outstanding. Resuming uses the latest saved summary plus raw messages after its boundary; `session show` and `session export` continue to contain the full original transcript and tool journal. Summaries are historical context and do not grant authority. Inspect the latest summary with `xyst session summary <id>`. Compaction snapshots are stored in SQLite and included in `xyst-session-v1` exports; forking continues to copy the full raw conversation into an independent session.

Session maintenance is available in both the CLI and the desktop:

```sh
xyst session rename <id> "New title"
xyst session compact <id> [--model key]
xyst session summary <id>
xyst session fork <id> [title]
xyst session export <id> [path]
xyst session archive <id>
xyst session delete <id>
```

Forking copies the conversation, including structured attachment messages, into a new session. The new session has its own model decisions and external-action execution scope. Export writes `xyst-session-v1` JSON. When a path is provided, the CLI creates a new file and refuses to overwrite an existing file; without a path it prints the export to stdout. The desktop opens a save-file dialog.

Generated and edited files appear in the session's artifact list with their path and available identity metadata. **Open file** asks the operating system to open the registered artifact with its default application; the desktop verifies that the artifact belongs to the selected session before opening it.

Archiving preserves the session and makes its status visible in the session list. Deleting removes the session and its messages, tool-call journal, model decisions, local usage rows, and database references for jobs and artifacts. Deletion is refused for a session referenced by a mission task so the durable mission history remains inspectable. Artifact files on disk are not deleted; remove those separately after reviewing their paths.
