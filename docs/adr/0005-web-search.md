# ADR 0005: Approved, bounded web search

## Status

Accepted for the first web-search backend.

## Decision

Add a runtime web-search tool with a keyless Automatic backend enabled by default. It combines general DuckDuckGo web results, recent news from GDELT DOC and Google News, and Wikipedia references, retaining results when individual sources are unavailable. Lookup schemas are always retained in normal chat contexts rather than removed by keyword-based context trimming. Users may select Wikipedia alone or optional Brave Search for broader web coverage. Brave credentials are resolved from an environment variable or OS credential vault only when the selected search is approved. If the optional Brave credential is missing or unavailable, the request falls back to Automatic keyless search. In Assisted mode, the approval prompt displays the exact query before any network request. Tool rules may deny or explicitly allow the tool.

The adapter accepts at most 500 printable query characters, 10 results, 10 requests per minute, a 10-second default timeout, and a 2 MiB provider response. It returns only bounded title/snippet text and HTTPS URLs without credentials. Results use the same untrusted-observation envelope as other tool output. The search adapter does not visit result URLs. A separate `web_fetch` tool reads HTTPS pages and JSON APIs with a shared 10-second deadline, at most three validated redirects, a 1 MiB response bound, and 12,000 output characters. It sends no model credentials, executes no page JavaScript, and retains normal tool approval and sandbox policies.

Providers are injected behind a `search(query, { signal })` interface so they can change without changing the runtime tool contract. Provider selection is explicit in configuration and Runtime settings; fallback is from Brave to Automatic when its credential is unavailable and between Automatic's sources when one is unavailable.

## Consequences

- General web, news, and reference search work without an account or API key. Optional Brave search requires a key; if it is not configured, keyless Automatic search remains available.
- Assisted mode asks before queries and page requests; unrestricted mode permits them without an application approval prompt.
- Search results remain untrusted, bounded model context.
- Source pages can be read to check details beyond snippets. Login-protected pages, binary documents, and pages requiring JavaScript may need other tools; provider outages and browser verification challenges are reported rather than bypassed.
- Search queries and returned snippets may be retained in the local session and audit record under the workspace's protected `.agent` state. Do not search for secrets.
