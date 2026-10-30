# Local acceptance — October 30, 2026

This records observed results, not a claim that every feature or setting combination works.

## Repairs

- HTTP 400 responses describing a temporary inference-engine failure now enter provider retry/fallback recovery. Ordinary invalid requests remain nonretryable; context overflow retains its own recovery code. The provider suite passed 54 tests.
- Review evidence now includes absolute source line numbers. A real local model previously reported a planted defect at line 4; after the change it correctly reported line 3. Eight focused review regressions passed.
- Existing uncommitted changes for unavailable automatic model selection and session-specific plan controls were retained and included in validation.

## Executed workflows

- Isolated browser acceptance passed against the actual local service with a deterministic model fixture. This exercised four window sizes, light/dark themes, keyboard shortcuts, custom/default user-data locations, local-model discovery/loading/selection, settings persistence, signed skill/MCP packages, activation/rollback/disable, MCP editing and audit controls, approved file edits, active-run model and budget changes, project goal association, and browser-to-CLI conversation continuation. See `.test-tmp/browser-acceptance.log`.
- Real LM Studio 4B model: read two source files, calculate values, write two outputs, reread and verify both. Passed.
- Real model: run a Node process and a native shell command, verify both output markers. Passed after a temporary engine failure and an earlier failed shell attempt. Results are in `.test-tmp/live-acceptance-final.log`.
- Real model pause/resume: session preserved, pause/resume events received, new direction persisted, resumed answer verified. Passed (`.test-tmp/resume-acceptance.log`).
- Real model review: planted retry-boundary defect found at the correct line and medium severity after the line-number repair. Passed (`.test-tmp/review-acceptance-fixed.log`).
- Actual internet search returned ten results using DuckDuckGo and Google News when Wikipedia was unavailable (`.test-tmp/internet-acceptance.log`). This checks the search adapter; it does not prove every arbitrary agent question triggers the right search.
- Real CLI tool workflows passed in Windows PowerShell and cmd.exe. Assisted native-shell execution also returned the expected marker.
- Native Windows Rust suite: 41 passed, two privilege-dependent checks ignored.
- Native desktop window lifecycle passed: launch, resize, minimum size, persisted bounds, and last-workspace restoration.
- Full Node suite with Windows concurrency set to one: 1,061 tests; 1,030 passed, two failed, 29 skipped. Both failures were timed descendant-process cleanup marker checks. The complete process-adapter suite subsequently passed 19 tests with one platform skip. The intermittent broad-run failures remain recorded; no process-termination implementation change was made.
- Biome checked 250 files without warnings. `git diff --check` passed.
- After the repairs, the combined agent/provider/review-plan regression run passed all 182 tests. The final debug desktop build succeeded and was launched; its UI reported Connected to local runtime.
- Expanded browser acceptance changed and restored routing selection, global memory, maximum turns, autonomy, sandbox mode, and live-search availability; each saved value was checked through the service API. The full browser workflow passed afterward (`.test-tmp/browser-settings-acceptance.log`).
- Real-agent internet acceptance passed: the local model retrieved three current public search results and cited one of their exact URLs in its completed answer (`.test-tmp/agent-internet-acceptance.log`).
- Windows cleanup verification observed ten actual descendant PIDs disappear after timeout handling returned. The two cleanup regressions now check actual PID absence rather than a marker that could be written before slow Windows termination completed. Both revised checks passed on Windows and Linux; the complete Windows process suite passed 19 tests with one platform skip.
- Current-source Ubuntu 24.04 WSL suite: 1,061 tests, 1,053 passed, seven skipped, one setup failure because the isolated copy lacked the generated VS Code client. After running `node scripts/build-vscode.mjs`, all five release/package tests passed. The Linux Rust suite passed 13/13. Real Linux Secret Service storage/retrieval/deletion passed under the existing unprivileged user with a disposable D-Bus/keyring session, resolving that optional skip.
- The real Bash CLI tool workflow passed in Ubuntu WSL. Review evidence numbering was additionally checked with a partial file read beginning at line 2.
- Final Windows full suite after the cleanup regression repair: **1,061 tests; 1,032 passed, zero failed, 29 documented skips** (`.test-tmp/full-acceptance-fixed.log`). Biome subsequently checked all 251 JavaScript files without warnings, and `git diff --check` passed. The live internet check is reusable with `pnpm smoke:live-internet` after setting `XYST_LIVE_MODEL` to an installed local model.

## Remaining coverage and limitations

- Linux execution was performed in Ubuntu 24.04 WSL, including the current-source Node and native Rust tests. A standalone Linux desktop/Wayland session was not exercised. Windows privilege-dependent symlink checks remain platform skips.
- Every individual setting combination, model, microphone/image input, external provider, and optional extension has not been tested. Browser fixture success and real-model success are separate evidence.
- LM Studio sometimes advertised models as loaded while requests failed or subsequent catalog checks disagreed. Temporary engine responses now recover through Xyst's existing retry mechanism, but persistent model-host failures still need a healthy loaded model.
- Public signing, feed hosting, and independent review remain outside the user-approved immediate local-use scope.

Raw logs are local ignored test artifacts under `.test-tmp`; this report preserves the results if those artifacts are later cleaned.
