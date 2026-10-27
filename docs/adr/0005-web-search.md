# ADR 0005: Approved, bounded web search

## Status

Accepted for the first web-search backend.

## Decision

Add a runtime web-search tool with a keyless Automatic backend enabled by default. It combines recent global news from GDELT DOC with keyless Wikipedia references and keeps results from the surviving source if either backend is unavailable. Users may select Wikipedia alone or optional Brave Search for broader web coverage. Brave credentials are resolved from an environment variable or OS credential vault only when the selected search is approved. If the optional Brave credential is missing or unavailable, the request falls back to Automatic keyless search. In Assisted mode, the approval prompt displays the exact query before any network request. Tool rules may deny or explicitly allow the tool.

The adapter accepts at most 500 printable query characters, 10 results, 10 requests per minute, a 10-second default timeout, and a 2 MiB provider response. It returns only bounded title/snippet text and HTTPS URLs without credentials. Results use the same untrusted-observation envelope as other tool output. The adapter does not visit result URLs.

Providers are injected behind a `search(query, { signal })` interface so they can change without changing the runtime tool contract. Provider selection is explicit in configuration and Runtime settings; fallback is from Brave to Automatic when its credential is unavailable and between Automatic's sources when one is unavailable.

## Consequences

- Recent news and reference search work without an account or API key. Broader Brave coverage requires a key; if it is not configured, keyless Automatic search remains available.
- A user can see and deny every query before data leaves the machine.
- Search results remain untrusted, bounded model context.
- Automatic combines recent news and Wikipedia references, not full-page web search. Select Brave or configure an MCP API for broader web coverage.
- Search queries and returned snippets may be retained in the local session and audit record under the workspace's protected `.agent` state. Do not search for secrets.
