# Changelog

Product changes are recorded here for each release. Entries are grouped by release version and date, with user-visible changes first. Security fixes that require coordinated disclosure are described only after the advisory is public.

## Unreleased

### Added

- Added a keyless Google News RSS fallback to Automatic live search, alongside GDELT and Wikipedia, so current-news results remain available when an upstream source is down. Local LM Studio, automatic search, Wikipedia, Google News RSS, and Open-Meteo weather do not require an API key; hosted model credentials remain provider-specific.
- Added a complete standalone `pnpm speak` command and safe platform speech adapter, plus Runtime Settings controls to enable child-agent delegation and set its concurrency limit.
- Enabled proactive delegation for clearly independent workstreams and made Git worktrees usable in projects before their first commit. Unborn-project snapshots use a temporary index, exclude Xyst state, avoid Git filters, and preserve the parent index and `HEAD`.
- Added paused-run budget editing in the browser and VS Code. Updates apply after resume at a safe checkpoint and the session records bounded adjustment history; blank fields restore the run-start value. Browser model switching remains available at the same checkpoint.
- Added first-run local model discovery in the browser UI. After a user requests it, the authenticated local API probes only `127.0.0.1` ports 11434, 1234, and 8080 for OpenAI-compatible `/models` lists; choosing a result saves it as the default without sending prompts or workspace files.
- Fixed the local and packaged desktop UI module allowlists so the first-run onboarding module and all imported GUI modules load in the installed Windows application. Expanded the packaged-service smoke test to request every GUI module before shutdown.
- Added signed percentage rollouts for extension package updates. Each installation gets a persistent local cohort ID that is never sent to the update feed; online checks, cached checks, and update staging use the same deterministic cohort gate.
- Added validated coordinate dragging to desktop automation across Windows, Linux X11, and Linux Wayland. X11 and Wayland release the mouse button after drag failures and preserve the original movement error if release also fails.

### Changed

- Improved report-only prompt-injection detection so common intensified negations such as “do not ever” and “never, under any circumstances” do not trigger directive signals. Advanced the detector event version to `xyst-patterns-3` and expanded its synthetic evaluation corpus to 58 cases.
- Unrestricted process tools no longer apply an automatic timeout when `timeout_seconds` is omitted.
- Native process results now include monotonic `elapsed_ms`, including Linux sandbox runs and Windows AppContainer helper results.
- Desktop packaging now provides Windows NSIS and Linux DEB build commands with native CI artifact jobs; Windows CI installs its package into an isolated profile, verifies the packaged executable, helper, runtime and local API/UI, then shuts down and uninstalls it.

### Fixed

- Hardened approval-rule persistence against unsafe state paths and replaced lock files, and added a Linux symlink regression test.
- Local API shutdown closes remaining connections after cancelling active runs so local listeners do not linger.
- Fixed Windows desktop window-state saves so resizing replaces existing bounds reliably, and persist/restore maximized status while continuing to read older state files. Aligned the VS Code package version with the 0.1.2 application release.

- Windows AppContainer helper discovery now rejects helpers contained in the active writable workspace; CLI and API capability checks use the same workspace-specific rule.
- Updated configuration tests to match the current project-permission rejection message.
- Fixed cancellation handling when a tool approval callback remains pending.

