# Xyst AI Build Plan

Updated: 2026-10-27

## Objective

Move Xyst from a feature-complete development build to a supportable, security-reviewed release. Priorities are ordered by user impact and by what must be true before the next phase can safely begin. The existing `BUILD_ROADMAP.md` remains the detailed feature inventory; this file is the execution plan and source of phase exit criteria.

## Priority order

### 0. Establish a reviewable baseline and release scope

**Why first:** The working tree has extensive staged and untracked work and no commit-backed baseline, so code review, isolated fixes, and reliable rollback are difficult. The supported target matrix and release owner/signing process also need to be explicit before release claims are made.

- Preserve the current workspace as a named snapshot/commit before making broad cleanup or release changes. **Current condition:** `master` has no commit; project source files are staged or untracked. A reproducible development source archive is now available as a provisional source snapshot and includes `BUILD_PLAN.md`; it excludes `.agent` and `dist` so private runtime state and generated packages are not mixed into source. A local initial commit was attempted but the execution sandbox denied creation of `.git/index.lock` because `.git` is read-only here. Create the commit from a normal repository-owner checkout or an approved writable Git environment.
- Record the exact source revision, package hashes, supported Windows/Linux versions and architectures, and required CI jobs. **Current artifact record:** package version 0.1.2; Windows 11 x64 (25H2+) NSIS and Ubuntu 24.04 x86-64 DEB are intended support targets; AppImage is built and smoke-checked but not the primary install/update path. ARM64 is experimental and RPM is not produced.
- Current development artifacts in `dist/dev/` have a regenerated four-file manifest (`dist/dev/SHA256SUMS.txt`). All four current files were rehashed against the manifest; consecutive source builds produced the same size and hash. The source archive includes `BUILD_PLAN.md`. The Windows installer must still be tied to its intended build by Windows installer smoke/CI evidence; a matching checksum proves file identity, not provenance or behavior.
- The required hosted jobs are already declared in `.github/workflows/ci.yml` (Windows/Ubuntu, Node 22/24, security/dependency scans, desktop builds and lifecycle smokes). No hosted run evidence is recorded in the current status, and `git remote -v` returns no configured remote, so this checkout cannot trigger or inspect those jobs.
- Assign owners for hosted CI, independent security review, signing keys, update-feed hosting, and incident/revocation response; these external owners are not recorded yet. No security contact or independent reviewer is named in the current security docs.

**Exit:** reviewable immutable baseline exists; the artifact manifest matches the intended artifacts; target matrix and owners are recorded; all work is traceable to that baseline.

### 1. Close security and data-loss risks

**Why second:** Xyst can execute processes, edit files, load extensions, and use desktop automation. A security defect or recovery/data-loss defect is more consequential than adding features.

- Obtain an independent security review covering sandbox enforcement, approvals/grants, secret handling, prompt injection boundaries, MCP/skills, update/package verification, and unrestricted-mode claims.
- Triage findings by severity; resolve every critical/high finding and document mitigations for accepted lower-severity findings.
- Finish crash/torn-write recovery and safe cleanup for sessions, worktrees, subprocesses, temporary files, and locks; cleanup must remain reviewable and must not delete user work automatically.
- Review data retention, export/import, session redaction limits, telemetry payloads, and update/revocation behavior for privacy and recovery.
- Keep the product language aligned with verified OS boundaries; do not make containment claims beyond the tested platform behavior.

**Exit:** signed review report, no unresolved critical/high findings, recovery behavior and residual risks documented.

### 2. Prove supported-platform acceptance in hosted CI and native environments

**Why third:** Local Windows and WSL/package evidence is useful, but hosted jobs and physical Linux desktop checks are the independent reproducibility gate.

- Run the full required Windows CI matrix, including AppContainer and ConPTY gates, from a clean checkout.
- Run the full Ubuntu CI matrix, including Bubblewrap, pidfd, Secret Service where available, DEB/AppImage build and lifecycle checks.
- Complete native Ubuntu Desktop/Wayland acceptance for startup, resize, accessibility, input/automation, user data paths, and shutdown; distinguish X11/Xvfb evidence from Wayland evidence.
- Complete native Windows and Linux GUI/IDE checks for high DPI, keyboard navigation, screen-reader labels, system proxy, multi-monitor restoration, and user-level paths.
- Confirm cross-surface session/API contracts, extension reconnect, migrations, backup/restore, and failure/cancellation paths.
- Keep ARM64 explicitly unsupported until its build, sandbox, package, and runtime matrix exists.

**Exit:** all required hosted checks pass from clean source; platform acceptance record covers every claimed OS/package target; no unexplained skips in required gates.

### 3. Finish product gaps that block dependable everyday use

**Why fourth:** Add or polish functionality only after the security and platform baseline is stable, so new behavior does not multiply unreviewed risk.

- Close remaining provider protocol/conformance gaps and representative routing evaluation; preserve manual model selection and explain fallback decisions.
- Close agent event ordering, crash checkpoint/resume, giant-result/context boundary, cancellation, and tool backend conformance gaps.
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

The latest implementation status records passing local Windows/Linux checks, package smoke evidence, and a successful live local-model workflow. It also explicitly leaves native Ubuntu Desktop/Wayland acceptance, hosted CI, ARM64, independent security review, and signing/update governance open. Therefore the current project state is **development build; release not qualified**.

**Do next:** create the first commit from a normal repository-owner checkout or an approved writable Git environment; the reproducible source archive now provides a provisional source snapshot including the plan. Confirm the Windows installer artifact with its smoke/CI gate, then arrange a clean hosted CI run and independent security review. Do not begin broad feature expansion until these results identify concrete blockers.
