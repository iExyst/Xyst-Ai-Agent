# Extension threat model

## Scope

This model covers instruction skills, signed skill/MCP packages, configured MCP stdio, Streamable HTTP, and legacy HTTP+SSE servers, signed package and revocation feeds, lifecycle hooks, and their interaction with the agent runtime. It describes current implementation and the capability-manifest contract. It is not an independent security assessment.

## Assets

- User and project files, including credential files readable by the current OS account.
- Provider credentials, OS-vault entries, environment variables, and MCP authentication values.
- Session transcripts, project memory and goals, audit records, and usage records.
- Tool execution authority: filesystem, process, network, and interactive desktop access.
- Publisher signing keys, configured trust roots, revocation state, and update-feed sequence state.
- Integrity and availability of installed packages, runtime configuration, and the agent process.

## Trust boundaries

1. **Model boundary:** model output is untrusted. A model may propose tool calls, but the runtime validates schemas, applies the selected autonomy/approval policy, and dispatches only registered tools.
2. **Workspace boundary:** repository files, `AGENTS.md`, memory, goals, retrieval results, and tool output are untrusted reference data. Instructions found in them do not grant permissions or replace system policy.
3. **Skill boundary:** skill Markdown is data, not executable code. It is loaded only from configured roots or a verified active signed package and is passed to the model as untrusted context.
4. **MCP boundary:** server descriptions, schemas, resources, prompts, and results are untrusted. Configured MCP servers execute as child processes or receive HTTPS requests with the current user's OS authority and configured credentials. SSE message endpoints are required to share the configured origin before credentials are sent. Required mode supports Linux stdio processes in Bubblewrap with no network and a read-only package mount; it refuses environment references, both HTTP transports, and Windows persistent MCP startup. Outside that boundary, MCP code runs with the current OS account's permissions.
5. **Package boundary:** an Ed25519 signature authenticates a publisher's statement, optional launch entry point, declared capabilities, and file digests under a user-configured trust key. It does not prove the publisher is benign or make payloads safe. Installation remains inert; an MCP package launches only after explicit registry activation and separate user MCP configuration. Launch rechecks signatures, file digests, trust roots, and configured revocations.
6. **Feed boundary:** signed update and revocation metadata is verified against user-configured keys, expiry, sequence, and package digests. Feed signatures do not grant activation authority.
7. **Local API boundary:** browser/service clients use an authenticated loopback API. Any same-user process that can obtain the ephemeral bearer token can act through the API with the configured autonomy mode.
8. **OS boundary:** disabled sandbox and Unrestricted autonomy run with the agent process's current account. Xyst AI Assistant approval policy cannot grant administrator/root privileges or exceed OS ACLs, Linux namespaces, container policy, or host resource availability.

## Adversaries and assumptions

Consider malicious or compromised repository content, a hostile web/MCP response, a malicious skill author, a compromised publisher signing key, a malicious configured MCP server or hook, an untrusted same-user local process, and a network attacker. The model assumes the operating system, Node.js runtime, cryptographic primitives, configured trust-key distribution channel, and user's initial machine account are not already compromised. A user who chooses Unrestricted mode accepts that trusted model/provider requests can include sensitive machine-readable content and can request actions using the current account's privileges.

## Principal scenarios and current controls

| Scenario | Current control | Residual risk |
| --- | --- | --- |
| Prompt injection arrives through a skill, repository file, MCP result, or retrieved text | Sources are labeled untrusted; tool schemas and permissions are enforced outside model text; skills cannot execute code | The model may still be persuaded to request an action allowed by its active autonomy mode |
| Package contains an undeclared, replaced, linked, or traversal file | Exact file-set verification, Ed25519 signature, per-file SHA-256, path normalization, symlink rejection, and staged installation | A trusted publisher can sign harmful content; trust-root compromise requires out-of-band key recovery |
| Signed update feed replays older package or revocation state | HTTPS, signature, expiry, monotonic sequence and digest checks, cross-process commit lock and latest-cache revalidation | A signing-key compromise or a sufficiently prolonged inability to refresh revocation data needs operator response |
| MCP tool schema or result attempts to override policy or exhaust resources | Namespacing, schema normalization, bounded transport/pagination/output, cancellation, approval routing, and untrusted observation envelopes | MCP processes and remote requests lack verified required-sandbox isolation; a configured server can use its own OS access |
| MCP package is installed and unexpectedly executes | Installation does not activate or execute MCP payloads; both explicit package activation and an enabled user MCP server referencing that package are required | Workspace-isolated Linux mode constrains stdio package execution with Bubblewrap, no network, and a read-only package mount; outside it publisher code runs with the agent's current account permissions |
| Skill content attempts filesystem or process access | Skills are Markdown data; they do not register tools or execute code | Prompt injection can influence tools already available to the agent |
| Same-user process steals the local API token | Token is random, per-process, printed for the trusted parent, and held in memory by supported clients; loopback and Host/peer checks apply | Same-user malware, process inspection, or compromised UI can still recover or use the token |
| Unrestricted task reads credentials or performs destructive actions | No Xyst AI Assistant approval or sensitive-file block is applied in Unrestricted mode; OS account permissions remain effective | This is an intentional product mode. Use a dedicated OS account or an explicitly enforced sandbox when containment is required |
| Extension update lock is abandoned after a crash | Commit fails closed; recovery requires checking that no writer is active and removing the exact stale lock | Manual recovery can delay updates until an operator intervenes |
| Extension or tool action consumes excessive resources | Package, request, output, concurrency, and storage limits bound several parser and transport surfaces | Not every host resource is quota-controlled; context windows, CPU, memory, disk, and provider limits still apply |

## Capability-manifest contract

Signed packages need a declarative capability manifest before package-driven MCP activation or any executable extension registration is added. The manifest must be covered by the publisher signature and use stable, versioned fields such as:

```json
{
  "capability_schema": 1,
  "capabilities": [
    {
      "name": "filesystem.read",
      "scope": "workspace",
      "reason": "Read release metadata"
    },
    {
      "name": "network.connect",
      "scope": "https://releases.example.invalid",
      "reason": "Check the configured release endpoint"
    }
  ]
}
```

Schema 1 distinguishes `filesystem.read`, `filesystem.write`, `process.execute`, `network.connect`, `desktop.control`, `secrets.use`, `mcp.tools`, `mcp.resources`, and `mcp.prompts`. Filesystem scope is `workspace` or `machine`; process scope is `configured`; network scope is a canonical HTTPS origin or an HTTP loopback origin; desktop scope is `interactive-session`; secrets scope is `configured-reference`; and MCP scopes are `configured-server`. Reasons are printable text bounded to 240 characters. At most 32 entries are allowed. The verifier rejects unknown schema versions, duplicate name/scope pairs, malformed or wildcard scopes, excessive entries, and non-empty executable capability declarations on skill packages. Older signed version-1 manifests may omit both capability fields and are interpreted as having no declaration.

These entries are **publisher declarations, not grants**. A valid signature proves only that the trusted key signed the declaration. The verifier returns the normalized declarations, and CLI verify/install output displays them. An optional MCP `entry_point` is included in that signed statement and must name a listed `.mjs` payload with a `process.execute: configured` declaration. This binds launch to publisher-signed bytes but does not authorize execution by itself. Activation requires an explicit registry action and an enabled user MCP server reference; startup rechecks installed bytes and trust. For explicitly activated signed MCP packages, the runtime requires `mcp.tools`, `mcp.resources`, or `mcp.prompts` declarations for the matching advertised features. These declarations do not constrain direct process APIs such as filesystem, network, or desktop access. User configuration, the selected autonomy/approval policy, and OS sandbox enforcement remain authoritative. A manifest cannot elevate the process, disable approval, widen a user-selected filesystem scope, or convert Unrestricted mode into a sandbox. Instruction skills remain non-executable. An independently configured MCP command is governed only by the user MCP configuration and runtime policy; it does not inherit declarations from an installed package.

## Release gates

- Add review/approval presentation and fine-grained OS/runtime enforcement for filesystem, network, desktop, and secret capabilities before adding executable skill entry points or claiming capability isolation for MCP packages.
- Add adversarial tests for forged manifests, overbroad scopes, key revocation, stale feed state, injection through every untrusted extension source, and secret canaries across prompts, sessions, logs, and errors.
- Prove required-sandbox denial and containment on each supported OS; a successful tool test without an OS boundary is not containment evidence.
- Obtain independent Windows and Linux review of sandbox enforcement, extension loading, key distribution/rotation, and recovery procedures before making production containment claims.
- Revisit this model whenever extension capabilities, activation, network access, persistence, or update behavior changes.
