# ADR 0008: Native desktop host

## Status

Accepted for the desktop prototype; packaging and release validation remain open.

## Decision

Use Tauri 2 as the native Windows and Linux window host. Reuse the existing browser UI and authenticated loopback API rather than introducing a second runtime, session store, or privileged desktop IPC surface. The desktop host starts the Node CLI with argv (never through a shell), captures the one-time API bootstrap record over a private pipe, loads the authenticated `/app` route, and requests service shutdown over stdin when the window closes.

The service binds IPv4 loopback and generates a fresh in-memory bearer token. The desktop host validates the API version, token shape, and loopback origin before navigating. The token is not persisted or logged. The Tauri page receives no shell plugin or application commands.

## Consequences

- Desktop and browser clients share agent runs, approvals, sessions, audit records, and policy behavior.
- The build stages Node.js v24.22.0 for x64 or ARM64 Windows/Linux from the official Node.js release archive and verifies its pinned SHA-256 before packaging the executable and upstream license. `XYST_NODE` remains an explicit development override.
- The desktop executable and user-level installer still need packaging smoke tests, signing, and upgrade behavior validation.
- The native Windows host compiles and links locally; a Windows and Ubuntu build check is also defined in CI. Packaged launch and Linux runtime validation remain outstanding.
- This architecture keeps application permissions aligned with the desktop process account. It does not grant elevation or override operating-system access controls.
