# ADR 0004: Local control API boundary

## Status

Accepted for the initial shared API. Revisit before exposing the API outside the local machine.

## Context

The desktop application and VS Code extension must share the same agent loop, session records, and runtime-enforced tool policy as the CLI. They need streaming events and a way to return human approval decisions without owning policy or provider logic.

## Decision

- Provide a versioned HTTP API from the existing Node runtime rather than duplicating the agent loop in each UI.
- Bind the service to `127.0.0.1` only; reject non-loopback peers and unrecognized Host headers.
- Create a fresh 256-bit bearer token per service process, hold it in memory, and transfer it to a trusted parent through a one-time stdout bootstrap record.
- Disable browser CORS by default. Allow only exact origins configured by the host application.
- Stream events with bounded replay and IDs; make event-history loss explicit to reconnecting clients.
- Route approvals through the same `AgentRuntime` approval callback and expire unattended requests.
- Keep request bodies bounded, limit concurrent runs, and retain only a bounded number of recent run records.

## Consequences

- A native parent application can launch the service and capture its bootstrap record without persisting the token.
- Browser-based clients require an explicit origin allowlist and still need the bearer token.
- Any holder of the token acts with the current user's agent authority, subject to existing runtime approvals and restrictions; the service is not a multi-user network daemon.
- API version 1 is incomplete: session mutation, settings, memory, retrieval, worktrees, and process management endpoints remain future work.
- The transport must receive security review and cross-platform host tests before production release.
