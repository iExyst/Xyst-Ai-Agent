# ADR 0001: Node.js runtime for the first vertical slice

Status: Accepted for the first vertical slice; revisit before desktop packaging.

## Context

The workspace has Node.js 24 available but no Rust toolchain or npm package manager. The initial application must be runnable and testable in the current environment and portable to Windows and Linux.

## Decision

Implement the first shared runtime in dependency-free ECMAScript modules on Node.js 22+. Use Node built-ins for HTTP, child processes, filesystem, and tests. Keep providers, platform behavior, tools, persistence, and runtime contracts in separate modules so a later Tauri desktop shell can call the same runtime or a future Rust core can replace it behind a stable API.

## Consequences

- Zero dependency installation is required for the CLI and unit tests.
- Rust-native sandboxing and packaging integrations are deferred and require a later architecture decision.
- Node process isolation is not treated as a security sandbox.
- Cross-platform behavior must be exercised on actual Windows and Linux CI before release.
