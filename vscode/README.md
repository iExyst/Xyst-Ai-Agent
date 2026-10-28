# Xyst AI Assistant for VS Code

This extension is a client of the shared Xyst AI Assistant runtime. It does not contain a model loop or execute tools itself. The extension host starts `src/cli.mjs serve` for the first workspace folder by default, captures the one-time loopback URL and bearer token through the child process stdout pipe, holds the token only in memory, and stops or switches the service as the selected project changes. After an unexpected service exit it retries connection with bounded backoff and reloads the previously selected session when available.

## Development

1. Install Node.js 22 or later.
2. Run `npm run build` from this directory to package the shared API client module into `dist/`.
3. In VS Code, open this repository and launch an Extension Development Host with `vscode/` as the extension directory.
4. Set `xyst.cliPath` in the Extension Development Host settings to the absolute path of this repository's `src/cli.mjs`.
5. Run **Xyst AI Assistant: Open Agent Chat**. Use **Xyst AI Assistant: Attach Active Editor Selection** to attach selected text, or **Xyst AI Assistant: Attach Active File Content** to attach the full current editor contents, including unsaved edits. Attachments are bounded, shown in chat, and included only when you send the next prompt.

The command palette also includes **Switch Project Workspace**, **Start Review**, **Start Plan**, **Cancel Run**, and **Open Settings**. In a multi-root VS Code window, switch projects to bind the shared API, session list, and tool workspace to a selected folder. Switching is blocked during a run and asks for confirmation; conversations stay with their original workspace. The status bar reports whether the shared service is connected or running and shows the selected model plus its local/remote profile. Its tooltip shows the active workspace, automation mode, and configured sandbox mode; it reports aggregate daily/monthly budget use in Assisted mode and makes clear that configured usage caps are ignored in Unrestricted mode.

Use **Run in** above the composer to choose the main workspace or a managed Git worktree for a new session. **Create worktree** prompts for a branch and checks it out under Xyst AI Assistant's managed worktree directory. Once a session's first run begins, it stays bound to that checkout; reopening the session restores the selection and prevents switching it. If its worktree has been removed, the panel reports that instead of silently running in another checkout. A session without a worktree binding can be assigned one on its next run.

Saved implementation plans appear in the conversation. Edit and reorder steps, save or clear the plan, and choose **Implement this plan** when ready; saving alone never starts a run.

Saved Review findings appear in the conversation with their evidence. Choose **Open finding location** to reveal the cited line in a workspace-contained file, or draft a read-only follow-up question.

Expand **MCP servers** above the conversation to choose all configured servers or a specific set for that session. The choice is restored with the session and saved when you send your next message; new sessions start with all configured servers selected.

The extension requires a configured model in the Xyst AI Assistant project or user configuration. All tool permission decisions and approvals remain in the shared runtime. The chat webview has no network access and renders conversation and approval data as text. It displays full proposed tool arguments before offering explicit approve-once or deny buttons. The session bar can list, resume, rename, archive, delete, export, and import sessions through the shared API. For a saved conversation, choose **Goals** to select existing project goals; the selection is saved with the session and included in its portable export. Create goals in the browser Goals panel or CLI first. Goal notes are untrusted context. Reopening a session restores its saved Agent, Review, or Plan mode and its configured model profile. Import and destructive actions require confirmation. While a run is active, you can pause at a safe model-turn boundary, resume, stop, or send a bounded direction that is added to the active session before the next model request.

`xyst.nodePath` selects the Node executable (default `node`). `xyst.maxAttachedSelectionCharacters` bounds editor selections and full-file attachments. Neither the bearer token nor chat contents are written to extension settings or global state.

If the VS Code extension host restarts, the selected workspace and conversation are restored from VS Code workspace state. A run interrupted because its local service process stopped is not restarted automatically; reopen the restored conversation to continue it.

This is an early functional VS Code client, not a signed Marketplace release. Approval cards can open proposed text changes in VS Code's side-by-side diff editor, including newly created files; selected hunks are applied through the shared API and checked against the reviewed file snapshot before replacement. Offline pairing and Windows/Linux GUI accessibility testing remain open.
