# Project review — 2026-10-29

Baseline: `1e5459c` on `codex/xyst-ai-assistant-v0.1.2` in `iExyst/Xyst-Ai-Agent`.

## Scope

Project-wide JavaScript syntax, lint, and automated tests; Windows Rust compilation; browser integration checks; and manual inspection across the agent loop, provider adapters, API request/event contracts, configuration, session/context persistence, process/path handling, desktop navigation, and extension integration. Vendored dependencies were not edited. This is a code and regression review, not a claim that every possible execution path has been exercised.

## Repairs

- Search fallback now handles provider outages and rate limits as well as missing/rejected credentials. Invalid queries and explicit user cancellation do not launch a fallback request.
- Search deduplication preserves case-sensitive URL paths and query values, while still deduplicating fragments of the same page.
- Weather lookup asks for clarification when same-name cities occur in different states within one country, rather than silently choosing the first city.
- Internet guidance is only included when the relevant tools are available, and duplicated weather instructions are removed. This restores a delegated-task retry that previously exhausted its shared input budget before reaching the model.
- Switching from Settings to a conversation clears the previous sidebar category highlight.
- Workspace tool controls remain in the document and visible during conversations instead of being detached with the home dashboard. They return to the dashboard on a new conversation.
- The recent-conversation list keeps a minimum usable height when sidebar navigation occupies most of a short window.
- Browser and API checks now follow the current sidebar navigation, inline settings editor, collapsed model discovery, and theme, instead of expecting the removed Advanced Settings dialog and obsolete labels.

## Verification

- Initial project-wide run: 1,040 cases, 1,008 passed, 29 skipped, 3 failed. All three failures were diagnosed and repaired; the failing cases then passed in focused reruns.
- Complete agent suite after the runtime repair: 118 passed, zero failed.
- Search/weather regression suites: 24 passed, zero failed.
- API authentication/streaming and settings privacy cases: 2 passed, zero failed after updating obsolete UI-label expectations.
- Repository lint: 245 files checked successfully.
- Windows desktop `cargo check --locked`: passed.
- Browser integration covers four viewport sizes, dark/light themes, discovery/loading, settings persistence, package/MCP controls, approval and file-write flow, runtime model/budget changes, goals, interrupted/failed sessions, scrolling, and browser-to-CLI conversation continuity.

The Windows development installer is rebuilt for these repairs. Native Linux builds and Linux desktop acceptance were not rerun on this Windows host; skipped platform/permission-specific tests are not treated as passed.
