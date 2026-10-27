# ADR 0003: Runtime-enforced tool policy

Status: Accepted.

## Context

Model output and tool schemas are untrusted. Prompt instructions alone cannot authorize file or process access.

## Decision

The runtime validates tool names and arguments against registered schemas, filters destructive tools from review/plan modes, checks workspace paths at execution time, and applies an approval decision before writes or process execution. Process execution is disabled by default. Credentials and common credential files are filtered before model context or persisted tool-call data.

Each registered definition carries the Xyst AI Assistant tool-schema revision and execution metadata describing timeout source/bounds and sandbox requirements. Built-in and normalized MCP definitions are recursively frozen after construction, and the runtime fails closed when a registered definition uses an unsupported revision. The MCP adapter translates a server's input schema into this local registry contract; MCP protocol negotiation/versioning remains independent. Process, desktop, semantic, and web timeout behavior is derived from the metadata. Some filesystem operations still have no hard timeout; a required process sandbox is implemented only where the platform backend supports it.

Runtime-only `maxBytes` constraints are omitted when translating tool parameters to provider-facing JSON Schema, because the keyword is not part of the schema dialect supported by OpenAI-compatible APIs. The local validator enforces those UTF-8 byte ceilings before execution.

An approval may be one-time or may create a session-scoped grant for the exact tool name and canonical argument object. Persist only a SHA-256 action fingerprint, issue time, and expiry; never persist raw grant arguments. Grant duration is capped at 24 hours, forks do not inherit grants, and revocation is audited. A general glob or command-pattern grant engine is deferred until its scope semantics and canonicalization rules are specified.

Workspace managed rules are separate from session grants. They target one named tool with tool, canonical relative path-glob, or argv command-glob scope; allow/deny decisions; and a stored 60-second to 30-day expiry. Denials run before every allow, including static configuration allows. Rules are lock-serialized, stored outside session documents, and audited on creation and revocation. Revocation applies before future tool decisions and does not cancel a tool action already approved and executing.

## Consequences

- The same policy code applies to every future client.
- Approval does not provide process isolation. OS sandbox implementations remain a release gate before claiming safe execution for untrusted repositories.
- Path checks can still have time-of-check/time-of-use races; stronger platform-specific handle-relative filesystem access is needed for a hardened sandbox.
