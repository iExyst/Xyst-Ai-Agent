# Architecture decisions

This page records the choices that shape Xyst's runtime and release boundaries. It complements the operational guides in [README](../README.md) and [BUILD_STATUS](../BUILD_STATUS.md).

## Shared runtime, platform shells

The TypeScript runtime owns inference orchestration, tool policy, settings, persistence, missions, and evidence checks. The CLI and Electron desktop call that runtime instead of implementing separate agent loops. This keeps behavior and authorization consistent; the tradeoff is that platform-specific behavior must be behind tested adapters rather than hidden in UI code.

Windows and Linux differences live in platform adapters for paths, processes, credentials, desktop automation, notifications, services, and packaging. Desktop-automation status reports detected host capabilities; remaining platform boundaries are recorded in the support matrix. A WSL check is useful Linux evidence but does not certify a native distribution, Wayland session, clean host, or lingering user service.

## Local persistence and bundled runtime

Xyst stores sessions, tool journals, missions, settings, jobs, and local model measurements in a versioned SQLite database under the operating system's user-data directory. This supports offline work and durable resume without requiring a hosted control plane. It also makes backups and cross-device synchronization the operator's responsibility.

Packaged CLI actions use the Node executable shipped with the desktop package. This keeps native SQLite and other modules on the same Node ABI on hosts that do not have Node installed. It increases package size and requires rebuilding each platform package for its target architecture.

## Access and external actions

The full profile uses the current account's existing operating-system permissions; it does not elevate privileges. Restricted profiles apply explicit filesystem, executable, network, integration, background-job, and external-action limits. Tool results, files, webpages, model cards, and MCP instructions are untrusted data and cannot expand authorization.

For restricted filesystem access, the controller resolves a candidate through its nearest existing ancestor, follows symlinks or Windows junctions to a canonical target, checks that target against the allowed roots, and returns the checked canonical path for the operation. Nested profiles consume their parent's resolved path before applying their own limits. This avoids validating one link target and then performing the operation through the original link path.

Xyst-managed tools pass through the runtime access controller and external-action journal. Uncertain side-effect outcomes require inspection and reconciliation rather than an automatic replay. Completed `run_process` results are reused across recovery while the Xyst-managed workspace revision is unchanged; a later Xyst file or office edit advances that revision so the agent can rerun tests or builds against the new contents. Legacy journal entries continue to deduplicate until a later recorded workspace edit follows the process call. LM Studio's direct native MCP integrations are a separate execution path: tools execute inside LM Studio outside Xyst's per-tool approval loop, so Xyst requires explicit integration/network/external-action capability and rejects that path when per-action approval is enabled.

## Local models and network fallback

LM Studio is the primary inference backend. Model discovery and downloads are governed by separate settings and resource checks. Remote fallback is opt-in and requires per-run approval before task context is sent; local content is never silently transmitted to another provider.

## Evidence and verification

The runtime, rather than the model, owns completion criteria. A completion request must cite successful persisted tool results from the current execution scope. A valid completion ends the run immediately so a later model-requested tool cannot run after the task is already verified. Evidence verifies that the required operation was recorded and returned the checked result; it is not an independent semantic audit of arbitrary outputs.

Release support is claimed per platform package and environment in the [platform support matrix](./platform-support.md). Windows installation and mission checks, Linux package checks under WSL, and native Linux host certification are recorded separately.
