# ADR 0009: Initial platform and data-location contract

- Status: Superseded for OS/architecture targeting by [ADR 0011](0011-support-matrix.md); the data-location contract remains in effect.
- Date: 2026-10-20

## Decision

Target Windows and Linux, x86-64 and ARM64, with no macOS support commitment. CI's moving Windows and Ubuntu runner labels define a development smoke matrix only; release support must pin named OS versions and exercise each promised architecture.

Keep project-specific sessions, memory, goals, audit state, usage state, semantic index, and managed worktrees under `<workspace>/.agent`. Keep user configuration under the platform configuration directory, optional global user memory under the platform user data directory, and provider secrets in the operating system credential service. Global memory is disabled by default and is never migrated from project memory.

## Rationale

Project-local state follows the workspace and can be backed up or removed with it. User configuration and credentials have different scope and access expectations, so they remain outside the workspace. Optional global memory is a separate user-level store; it uses the same versioned record and locking protections as project memory and is included in model context only after explicit user opt-in.

## Consequences

- Users should review `.agent` contents before sharing a workspace and should export or back up records before deleting it.
- Linux Secret Service availability is a runtime requirement for vault-backed credentials, not for all CLI operations.
- Required process sandboxing uses a packaged Windows AppContainer helper and Linux Bubblewrap. Both still need broader platform-specific escape and recovery validation.
- Windows/Linux CI does not establish ARM64 or distribution-wide support by itself.
- This ADR closes only the current contract decision. It does not close the roadmap's production support, migration, sandbox, or release gates.

## References

- [Platform support and data locations](../PLATFORM_SUPPORT.md)
- [Configuration](../CONFIGURATION.md)
- [Security model](../SECURITY.md)
