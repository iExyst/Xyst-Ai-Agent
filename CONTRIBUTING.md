# Contributing to Xyst AI Assistant

This guide is for people changing, building, or reviewing Xyst. The current implementation status and remaining acceptance evidence live in [`BUILD_ROADMAP.md`](BUILD_ROADMAP.md); this guide does not replace that checklist.

## Supported development environments

- Windows and Linux are the product targets. The current initial end-user targets are Windows 11 x64 (25H2 or newer) and Ubuntu Desktop 24.04 LTS x86-64; see [`docs/PLATFORM_SUPPORT.md`](docs/PLATFORM_SUPPORT.md) for capabilities and release-validation gaps. CI runners and WSL are useful checks, but do not prove behavior on a physical desktop.
- Install Node.js 22 or newer and pnpm 11.25.0. The desktop host also needs Rust 1.90 or newer and the platform Tauri/WebView build dependencies.
- Install the locked JavaScript dependencies with `pnpm install --frozen-lockfile`.

## Understand the architecture before changing it

The CLI, desktop app, and VS Code extension use the shared runtime in `src/`. `AgentRuntime` owns model/tool orchestration; providers, persistence, policies, and platform adapters sit behind explicit modules. The desktop host starts the same CLI service and renders the shared UI in `gui/`. Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), the relevant ADRs in `docs/adr/`, and the phase checklist in [`BUILD_ROADMAP.md`](BUILD_ROADMAP.md) before changing a cross-surface contract.

Changes to architecture, persisted schemas, provider/tool contracts, or release support must update their ADR or compatibility documentation and add migration or contract coverage where applicable. Keep CLI, API, browser/desktop, and VS Code behavior on the shared runtime path; do not duplicate policy decisions in a client.

## Local checks

Run the checks that cover the files and behavior you changed:

```sh
pnpm lint
pnpm format:check
pnpm check
pnpm eval:agent
pnpm eval:routing
pnpm check:vscode
pnpm smoke:browser
pnpm check:desktop
```

`pnpm check` runs the deterministic Node test suite. The agent and routing evaluations use synthetic fixtures and do not contact a model server. The browser smoke starts isolated local mock services and exercises the UI at several window sizes.

On Ubuntu 24.04, run `pnpm check:linux` as an unprivileged user. The suite requires working Bubblewrap, pidfd, filesystem-link, D-Bus, and Secret Service test support; it fails if required isolation prerequisites are missing. See [`docs/PLATFORM_SUPPORT.md`](docs/PLATFORM_SUPPORT.md) for Tauri's Linux packages and optional desktop automation dependencies.

For native code, also run:

```sh
cargo fmt --manifest-path gui/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path gui/desktop/src-tauri/Cargo.toml --locked -- -D warnings
cargo test --manifest-path gui/desktop/src-tauri/Cargo.toml
```

Windows sandbox tests that alter ACLs or create junctions require the corresponding Windows privileges. Two symbolic-link tests are capability-gated and run in a dedicated CI step. A skip is not evidence that the skipped behavior passed.

## Live-model acceptance

Live tests are opt-in and use only a model server on the same computer. They send synthetic fixtures to the selected model and do not change LM Studio's model state:

```powershell
$env:XYST_LIVE_MODEL = 'exact-model-id-from-the-server'
pnpm smoke:live-model
pnpm smoke:live-resume
pnpm smoke:live-delegation
pnpm smoke:live-overflow
```

The live file smoke uses an isolated temporary workspace, approves only its expected fixture writes, and bounds its process and shell checks. Do not replace a failed live result with a deterministic mock result when documenting model acceptance; report both kinds of evidence separately.

## Desktop builds and package tests

Build on the target operating system and architecture; desktop runtime cross-compilation is not supported:

```sh
pnpm build:desktop:windows-installer
pnpm smoke:desktop:windows-installer
```

On Ubuntu with the listed Tauri prerequisites:

```sh
pnpm build:desktop:linux
pnpm smoke:desktop:linux-package
```

The Windows installer smoke requires the Xyst desktop to be closed. It uses isolated install and app-data paths, snapshots the per-user uninstall registration and shortcuts, verifies service startup/reinstall/config retention/uninstall, and restores the snapshots. Do not bypass its running-app guard to install over an active session. Linux install/upgrade/package tests should run in a disposable supported Ubuntu environment; WSL/Xvfb evidence must be labeled as virtual-desktop evidence.

## Security, privacy, and test data

- Never commit provider credentials, OS-vault values, `.env` files, user configuration, workspace `.agent` data, or live conversation contents. Tests should use synthetic workspace files and mock credentials.
- Avoid logging prompts, file contents, credentials, tool arguments/results, or full provider responses. Add secret-canary assertions when changing serialization, audit, tracing, export, or error paths.
- Keep runtime policy authoritative. A model response or client UI cannot grant itself approval, sandbox access, or a secret. Security-sensitive changes need adversarial tests and an independent review before the roadmap claims the boundary is release-ready.
- Treat model output, workspace instructions, web pages, MCP results, skills, and retrieved text as untrusted input. They do not override runtime policy.
- Do not claim production support or containment from a unit test, WSL run, successful build, or local package smoke alone. Record the exact OS, architecture, package, and test evidence in the roadmap.

## Versions and release notes

Before a release, update the shared product version together in `package.json`, `gui/desktop/src-tauri/Cargo.toml`, `gui/desktop/src-tauri/tauri.conf.json`, and `vscode/package.json`. Add user-visible changes under `Unreleased` in [`CHANGELOG.md`](CHANGELOG.md). Follow [`docs/RELEASE_POLICY.md`](docs/RELEASE_POLICY.md) for versioning, source archives, signatures, and release gates.

Build the deterministic source archive with `pnpm build:release`. Platform installers must be built on native Windows/Linux CI runners, tested on the documented target, and distributed with verified checksums. Unsigned local builds are development artifacts, not production releases.

## Updating the roadmap

Use `[x]` only when its stated behavior and evidence are complete for every claimed platform. Use `[~]` when code exists but an explicitly named test, platform run, review, documentation item, or recovery case remains. Keep the remaining gap in the same checklist item and add concrete evidence to `docs/IMPLEMENTATION_STATUS.md` when a gate changes.
