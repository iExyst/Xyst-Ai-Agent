# Xyst AI Build Plan

Updated: 2026-10-27

## Objective

Move Xyst from a feature-complete development build to a supportable, security-reviewed release. Priorities are ordered by user impact and by what must be true before the next phase can safely begin. The existing `BUILD_ROADMAP.md` remains the detailed feature inventory; this file is the execution plan and source of phase exit criteria.

## Priority order

### Execution timing

Start hosted CI and independent security review in parallel as soon as the repository remote and reviewer are available; neither should be postponed until release packaging. Use early CI failures and review findings to guide the remaining code work. Schedule native Ubuntu/Wayland and supported-client acceptance against a stable release candidate, before making support claims. Keep signing, revocation operations, and final installer lifecycle checks at the release stage after the source is approved.

### 0. Establish a reviewable baseline and release scope

**Why first:** Without a commit-backed baseline, code review, isolated fixes, and reliable rollback are difficult. The supported target matrix and release owner/signing process also need to be explicit before release claims are made.

- Preserve the current workspace as a named snapshot/commit before making broad cleanup or release changes. **Current condition:** the commit-backed source and documentation baseline is pushed to `iExyst/Xyst-Ai-Agent` on `codex/xyst-ai-assistant-v0.1.2`; existing `main` and `codex/resume-full-build` branches remain untouched. The local development installer and status evidence are recorded below. The reproducible development source archive includes `BUILD_PLAN.md` and excludes `.agent` and `dist` so private runtime state and generated packages are not mixed into source.
- Record the exact source revision, package hashes, supported Windows/Linux versions and architectures, and required CI jobs. **Current artifact record:** package version 0.1.2; Windows 11 x64 (25H2+) NSIS and Ubuntu 24.04 x86-64 DEB are intended support targets; AppImage is built and smoke-checked but not the primary install/update path. ARM64 is experimental and RPM is not produced.
- `dist/dev/SHA256SUMS.txt` identifies the four local development artifacts. The source archive has been refreshed for the current code and includes `BUILD_PLAN.md`; the Windows NSIS, Ubuntu DEB, and AppImage hashes identify the last locally verified package build, which predates the current CI follow-up fix and must be rebuilt before reuse. The recorded Windows NSIS hash is `e7bd3e7def2acbf577e7f872b608b0235dfb2b3decd32063c588f8eaf489c574`; that installer includes Windows manual-proxy discovery, passed focused Windows Rust proxy tests (2/2) and the isolated install/runtime/reinstall/uninstall smoke, and remains `NotSigned`. Hosted CI is still required; a matching checksum proves file identity, not provenance or behavior.
- The required hosted jobs are declared in `.github/workflows/ci.yml` (Windows/Ubuntu, Node 22/24, security/dependency scans, desktop builds and lifecycle smokes). First hosted run `40565900395` is recorded below; its security job passed, but platform checks and both desktop jobs failed, so no hosted platform gate is complete yet.
- Assign owners for hosted CI, independent security review, signing keys, update-feed hosting, and incident/revocation response; these external owners are not recorded yet. No security contact or independent reviewer is named in the current security docs.

**Exit:** reviewable immutable baseline exists; the artifact manifest matches the intended artifacts; target matrix and owners are recorded; all work is traceable to that baseline.

### 1. Close security and data-loss risks

**Why second:** Xyst can execute processes, edit files, load extensions, and use desktop automation. A security defect or recovery/data-loss defect is more consequential than adding features.

- Obtain an independent security review covering sandbox enforcement, approvals/grants, secret handling, prompt injection boundaries, MCP/skills, update/package verification, and unrestricted-mode claims.
- In parallel, run the required clean hosted CI matrix as soon as the Git remote and workflow permissions are available; use failures to identify reproducible fixes rather than waiting for security review completion.
- Hosted CI run `40565900395` (2026-10-27) reached the security job successfully, but Windows test jobs failed on ConPTY initialization (`0xC0000142`), and Windows secret-redaction and file-preview cases exposed fixable issues. Ubuntu and Windows desktop jobs also found non-canonical license-notice line endings. Ubuntu's Bubblewrap checks could not configure loopback (`RTM_NEWADDR: Operation not permitted`), blocking the signed MCP package connection test. Fixes were pushed in `3d93c37204490f9a08147736eaf46c820ff99574`. Run `40567793902` passed security and normalized notice checks, but retained the ConPTY and Ubuntu namespace limitations; it exposed a cross-volume runtime-cache rename (`EXDEV`). Commit `d482fab403551598494a8a6c64a9257a87af4915` staged the archive in the cache volume, which run `40568965028` confirmed by completing Windows NSIS and Linux DEB/AppImage builds. That run also exposed Linux `unused_mut` lints, a Windows proxy parser Clippy lint, and a Windows installed-window smoke failure at its exact minimum size. Commit `9ecde3487687c737da730eb452bafb64b3de793b` fixed those; run `40571140458` passed Windows installer smoke, Clippy, formatting, and Ubuntu DEB/AppImage lifecycle smokes. Its Windows native Rust suite found an AppContainer fixture permission failure under the system temp path; the test uses the repository's controlled `.test-tmp` path and passed locally with the required capability. Run `40574078025` rebuilt packages and passed Ubuntu package smokes but again failed the Windows bounds persistence smoke at 800×600, although that exact path passed in run 4. Commit `00b9c6a696d3e0dc29a8a07532b539b72260697d` added initial/exit bounds checkpoints; run `40576162644` confirmed Windows installer smoke and completed Ubuntu desktop/package validation. That run's Windows native suite still denied a root-level workspace fixture. Commit `aa8bca55cb7faa6479fce3189f0962ba68fabf49` aligned it to the helper integration's nested layout, but run `40578381187` still denied that direct read while the packaged integration passed; the native unit test now leaves read/private-temp behavior to the integration and focuses on its remaining direct assertions. The focused local test passes; hosted verification is pending. Windows ConPTY and Ubuntu network-namespace gates remain open.
- Triage findings by severity; resolve every critical/high finding and document mitigations for accepted lower-severity findings.
- Finish crash/torn-write recovery and safe cleanup for sessions, worktrees, subprocesses, temporary files, and locks; cleanup must remain reviewable and must not delete user work automatically.
- Session persistence now treats an atomic rename followed by a directory-flush error as committed: it advances the in-memory revision and reports a durability warning so retries and active runtime policy do not conflict with the visible record. A Linux-only fault-injection regression verifies reload and retry; hosted confirmation is pending.
- 2026-10-27: session load now recovers the interrupted Windows atomic-replacement state where the primary record is missing and the previous record remains in one UUID-named `.bak`. Recovery runs under the session lock and validates the candidate with the normal no-follow, single-link, size, schema, and session-ID checks before rename. Missing, ambiguous, or invalid backups are preserved for manual recovery. Focused valid-recovery and ambiguity regressions pass; hosted verification is pending.
- 2026-10-27: background-process startup now restores one validated interrupted-replacement backup when its primary record is absent. A same-directory hard link makes the restore no-overwrite; startup also finishes cleanup if it finds the known interrupted link-and-unlink state. Unsafe, ambiguous, or unsupported recovery states preserve their files. Three focused Windows regressions pass with the required hard-link capability; hosted verification is pending.
- 2026-10-27: hosted run `40599777689` exposed that a missing primary with no backup must remain an ordinary `ENOENT`, not a backup-recovery error. That caused session deletion, stale-writer, and VS Code lifecycle regressions on Windows and Ubuntu. The empty-backup path now preserves `ENOENT`; three focused regressions pass locally and exact-source hosted confirmation is pending. The same run passed security and formatting/lint; its platform suites also show the previously documented ConPTY and network-namespace runner limits.
- 2026-10-27: atomic replacement-backup recovery now protects shared usage totals/reservations, project/global memory, project goals, and subagent task history. Each store validates one bounded backup under its cross-process lock; ambiguous or invalid candidates remain preserved and fail explicitly. Focused local recovery tests pass with the required Windows hard-link capability.
- Review data retention, export/import, session redaction limits, telemetry payloads, and update/revocation behavior for privacy and recovery.
- Keep the product language aligned with verified OS boundaries; do not make containment claims beyond the tested platform behavior.

**Exit:** signed review report, no unresolved critical/high findings, recovery behavior and residual risks documented.

### 2. Prove supported-platform acceptance in hosted CI and native environments

**Why third:** Local Windows and WSL/package evidence is useful, but physical Linux desktop checks and final cross-surface acceptance are required before claiming supported platforms. Hosted CI begins earlier in parallel with the security review and is confirmed here from the approved candidate.

- Run the full required Windows CI matrix, including AppContainer and ConPTY gates, from a clean checkout.
- Run the full Ubuntu CI matrix, including Bubblewrap, pidfd, Secret Service where available, DEB/AppImage build and lifecycle checks. The first hosted Ubuntu run could not create/configure its network namespace; if this repeats, obtain a runner with the required network-namespace capability rather than marking the required test as skipped.
- Complete native Ubuntu Desktop/Wayland acceptance for startup, resize, accessibility, input/automation, user data paths, and shutdown; distinguish X11/Xvfb evidence from Wayland evidence.
- Complete native Windows and Linux GUI/IDE checks for high DPI, keyboard navigation, screen-reader labels, system proxy, multi-monitor restoration, and user-level paths.
- Confirm cross-surface session/API contracts, extension reconnect, migrations, backup/restore, and failure/cancellation paths.
- Keep ARM64 explicitly unsupported until its build, sandbox, package, and runtime matrix exists.

**Exit:** all required hosted checks pass from clean source; platform acceptance record covers every claimed OS/package target; no unexplained skips in required gates.

### 3. Finish product gaps that block dependable everyday use

**Why fourth:** Add or polish functionality only after the security and platform baseline is stable, so new behavior does not multiply unreviewed risk.

- Close remaining provider protocol/conformance gaps and representative routing evaluation; preserve manual model selection and explain fallback decisions.
- 2026-10-27: modern MCP `resultType` handling now fails closed for unsupported `input_required`, task, and unknown control-flow results on stdio and Streamable HTTP. Focused transport and validator regressions pass; full MCP capability, content-block, and method-result schemas are still open.
- 2026-10-27: MCP `tools/call` results now require the modern `resultType`, require a content array, and validate standard text, image, audio, resource-link, and embedded-resource block shapes plus `isError`. Legacy protocol calls retain the schema's omitted-`resultType` compatibility. Focused MCP suite passes 32 tests with one Windows-only sandbox skip; exact-source hosted CI is pending. Validation follows the [official MCP 2026-07-28 schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.json).
- 2026-10-27: resuming a session with missing tool results now inserts bounded, untrusted “outcome unknown” observations before the next user request. Existing results are preserved, recovery is idempotent, and proposed actions are not replayed automatically. Focused recovery/AgentRuntime regressions pass; crash injection across every persistence boundary remains open.
- Close agent event ordering, remaining crash injection across persistence boundaries, giant-result/context boundary, cancellation, and tool backend conformance gaps.
- Finish provider onboarding and extension author documentation with runnable examples and clear credential/network requirements.
- Review remaining retrieval scale/overflow recovery, representative evaluations, VS Code reconnect, and native desktop resume gaps against actual user workflows.
- Add only high-value fixes found by security review, acceptance runs, or reproducible user failures; avoid expanding scope with speculative features.

**Exit:** the documented common workflows pass on each supported surface and user-facing setup/troubleshooting docs match the shipped behavior.

### 4. Sign, package, and release with recovery controls

**Why last:** signing and publishing should happen only after the exact release source has passed security and platform gates.

- Build reproducible versioned artifacts from the approved source revision and verify manifests/hashes.
- Establish protected signing-key custody, signed application/package feeds, revocation ownership, sequence/anti-replay handling, and a documented compromise response. The current development Windows NSIS installer is `NotSigned`; do not confuse signed update metadata with a signed installer.
- Complete clean install, upgrade, rollback, uninstall/data-retention, and migration checks for each supported package target.
- Validate staged update UX and user-controlled installer/package-manager handoff end to end; test offline and expired-feed behavior.
- Publish release notes, support matrix, known limitations, security contact, and rollback instructions.

**Exit:** approved revision is reproducible, signed, lifecycle-verified, documented, and has an operational rollback/revocation owner.

## Working rules

- Keep changes small and attributable to one phase; record evidence and unresolved risks in `docs/IMPLEMENTATION_STATUS.md`.
- Do not run the full test suite by default for planning work. Run only a focused check when a code change or an ambiguity requires it; run full platform gates at phase exits.
- Never treat WSL/Xvfb as evidence of native Ubuntu Desktop/Wayland behavior.
- Do not mark a gate complete from roadmap text alone; link the actual CI run, review report, package hash, or acceptance record.
- No production release while security review, required CI, or supported-target lifecycle gates remain open.

## Current state and next action

Hosted run `40595818168` for `7f6cffac7fc7fc8172c0835040af94f72709e909` verified committed-session-write recovery. The security audit and both Windows/Ubuntu desktop package, lifecycle, and native checks passed. Ubuntu Node 22/24 each passed 926/934 tests, including the directory-flush fault injection; the remaining failures are Bubblewrap loopback setup (`RTM_NEWADDR: Operation not permitted`) and dependent signed-MCP isolation. Windows Node 22/24 each passed 912/934 with 21 skips and one failure, only ConPTY initialization (`0xC0000142`); the Linux-only durability test was skipped as intended. Formatting and lint passed on all four matrices. Required hosted isolation still needs capable runners. Native Ubuntu Desktop/Wayland acceptance, ARM64, independent security review, and signing/update governance remain open. Therefore the current project state is **development build; release not qualified**.

**Do next:** obtain exact-source hosted CI for the persistence and feed-cache recovery commits, retaining the documented ConPTY and network-namespace capability gaps. Continue phase 3 with the remaining persistence crash boundaries, giant-result/context behavior, and tool backend conformance. Close provider conformance and runnable onboarding docs after those. In parallel, obtain a hosted runner with ConPTY and network-namespace capabilities, independent security review, and native Ubuntu Desktop/Wayland acceptance. Finish signing/update governance and release gates only after these checks; no production release is authorized. `main` and `codex/resume-full-build` remain unchanged. Local package installers predate the current source and are unsigned; use hosted artifacts only as development packages. Keep claims limited to verified evidence.

- 2026-10-27: application update, package update, and revocation refresh now restore one validated atomic-write backup while holding their feed-cache lock before enforcing the signed sequence. This prevents a crash that leaves only the prior cache backup from resetting anti-replay protection. Focused feed suites pass 27/27; exact-source hosted verification is pending.
- 2026-10-27: package-registry readers now fail closed if only a replacement backup remains; mutations restore one bounded, schema-validated backup under the registry lock before changing activation state. A crash during registry replacement can no longer make readers silently report an empty registry or discard activation state on a later change. Focused recovery regression passes; exact-source hosted verification is pending.
- 2026-10-27: runtime settings now report `SETTINGS_RECOVERY_REQUIRED` instead of returning empty defaults when the primary is missing but a replacement backup exists. The next settings update restores one bounded, validated backup under the settings lock before merging the requested change. Focused runtime-settings suite passes 10/10; exact-source hosted verification is pending.
- 2026-10-27: approval-rule reads fail closed if only a replacement backup remains; rule mutations restore one bounded, schema-validated backup under the rule lock before adding or revoking decisions. This prevents a later rule change from discarding an existing deny/allow policy after a crash. Focused approval-rule suite passes 9/9 with two platform symlink skips; exact-source hosted verification is pending.
- 2026-10-27: retrieval exclusion reads now fail closed if only an atomic-write backup remains; exclusion mutations restore one bounded, validated file under the retrieval lock before changing privacy filters. The focused interrupted-exclusion regression passes; exact-source hosted verification is pending.
