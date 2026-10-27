# ADR 0007: User-configured MCP tool servers

- Status: accepted for the initial implementation
- Date: 2026-10-20

## Decision

Support MCP stdio and Streamable HTTP servers configured by the user. Launch stdio commands directly with argv (`shell: false`), from a resolved working directory, and only when both the MCP feature and individual server are enabled. HTTP endpoints are explicit configuration only; remote endpoints require HTTPS, while HTTP is permitted only for loopback development endpoints. Never let project configuration launch an executable or declare a network server. Do not add remote package installation or automatic server discovery.

The client negotiates modern `server/discover` metadata and supports the legacy `initialize` handshake for older servers. It lists tools, resources, and prompts when the server advertises those capabilities. Each item is namespaced and exposed through an approval-policy mediated AgentRuntime tool; prompt arguments and tool schemas are bounded, and resource/prompt results remain untrusted observations.

Credentials are resolved only from named process environment variables or the operating-system vault. Configuration stores references, not secret values. HTTP redirects are rejected to keep credentials bound to the configured endpoint. Lifecycle events are audited without arguments, endpoint URLs, headers, environment values, or tool content.

## Safety and limits

- Servers are trusted local executable code and inherit the Xyst AI Assistant process account's OS permissions. In unrestricted mode, application approvals and restrictions are intentionally bypassed as they are for other tools.
- `sandbox.mode = "workspace-write"` or `"workspace-read"` supports Linux stdio servers under Bubblewrap with no network and read-only signed-package mounts. The workspace is writable only in `workspace-write`. These modes refuse MCP environment references, Streamable HTTP, legacy HTTP+SSE, and persistent MCP processes on Windows. Global `read-only` mode skips MCP startup.
- Startup is opt-in. Assisted mode requires shell/process capability for stdio; HTTP connections use the configured network capability. Each server tool is individually mediated by approval policy.
- Framing, HTTP response size, pagination, tool count, schema depth, schema size, and call duration are bounded. HTTP requests honor runtime cancellation and current-protocol `x-mcp-header` annotations with encoded argument values. Streamable HTTP revisions from `2025-03-26` through `2025-11-25` and legacy `2024-11-05` HTTP+SSE resume interrupted event streams with bounded GET requests carrying the last safe event ID. Legacy SSE resumes only against its configured stream URL, preserves the negotiated message endpoint, never repeats a pending POST, and fails closed when the server has not sent a usable cursor. The current `2026-07-28` protocol does not use this resumption flow.
- Resource templates, richer JSON Schema, signed MCP package activation, updates, revocation, and lifecycle hooks remain deferred.

## Consequences

Local and remote models can use tools exposed by a configured local MCP server, with results and approvals flowing through the shared runtime. Users must configure and trust the executable themselves. The implementation is not a security sandbox and does not elevate operating-system privileges.
