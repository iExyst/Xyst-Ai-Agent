# Extension package author and operator guide

For the threat model and signed capability-manifest contract, see [Extension threat model](EXTENSION_THREAT_MODEL.md). New package manifests can sign a declarative capability list; legacy version-1 manifests without it remain valid. Declarations are publisher claims, not grants. For activated signed MCP packages, runtime checks that advertised MCP tools, resources, resource templates, and prompts have the corresponding declarations; process-level filesystem, network, desktop, and environment access is not constrained by those declarations. Independently configured MCP commands do not inherit declarations from installed packages.

MCP resources and resource templates are exposed through the normal tool approval path. Resource templates accept required simple URI variables such as `{page}`; each string is percent-encoded before the read request. Templates using RFC 6570 operators or malformed braces are rejected rather than partially expanded. Returned resource content remains untrusted model context.

Xyst AI Assistant accepts signed directory packages for skills and MCP server payloads. It does not download archives, resolve dependencies, or execute package code during installation. The package manager verifies a package, writes the verified payload to a version-addressed directory, and records explicit activation separately.

## Package layout

```text
release-check/
  manifest.json
  SKILL.md
```

Every payload file must be listed exactly once in `manifest.json`. The manifest itself is excluded from the file list and signature statement.

```json
{
  "schema_version": 1,
  "package_id": "release-check",
  "package_type": "skill",
  "version": "1.0.0",
  "key_id": "publisher-2026",
  "capability_schema": 1,
  "capabilities": [],
  "files": [
    {
      "path": "SKILL.md",
      "size": 1234,
      "sha256": "<64 lowercase hexadecimal characters>"
    }
  ],
  "signature": "<base64 Ed25519 signature>"
}
```

Package type is `skill` or `mcp`. IDs are lowercase; skill IDs must match the skill's lowercase hyphenated name. Versions use semantic `major.minor.patch` syntax, optionally with prerelease and build metadata. Each package is limited to 1,024 files, 2 MiB per file, and 20 MiB total. File paths use portable ASCII segments, forward slashes, and no traversal, reserved Windows names, or case-insensitive collisions.

The optional `capability_schema` and `capabilities` fields are both required when either is present. Schema 1 accepts at most 32 `{ "name", "scope", "reason" }` records. Capability names and scope forms are enumerated in the [threat model](EXTENSION_THREAT_MODEL.md); wildcard and duplicate scopes are rejected. Instruction-only skill packages cannot request executable capabilities. The list is authenticated by the package signature and shown by `extensions verify` and `extensions install`. It does not authorize the listed access: user configuration, the autonomy/approval policy, and OS permissions remain authoritative. Older version-1 manifests without these fields verify as having no declarations.

An MCP package may include an optional `entry_point`, currently restricted to a listed `.mjs` payload. It is authenticated by the same package signature and requires a `process.execute` capability declaration with `configured` scope. Installation remains inert and does not grant execution; explicit package activation and a matching enabled user MCP server are both required.

The maintained [Hello World MCP package](../examples/mcp/hello-world/README.md) demonstrates the stdio protocol and signed package layout. Build it with `node scripts/build-example-mcp-package.mjs --key-id <publisher-key-id> --private-key <offline-ed25519-private-key.pem> --output <new-package-directory> [--version <semver>]`. The tool never copies the private key into the package and refuses to replace an existing output directory.

The signature is Ed25519 over the canonical JSON serialization of the manifest without `signature`. Object keys are sorted lexically; file records are sorted by path and capability records by name/scope before signing. File hashes are SHA-256 over their exact bytes. `signPackageManifest` in `src/extensions/signed-packages.mjs` builds the statement and signs it for publisher tooling. Keep private signing keys in an offline release system; Xyst AI Assistant only needs the public key.

## Trust and installation

Add each trusted publisher public key to the user configuration under `[extensions.trusted_keys]`. Compare `node src/cli.mjs extensions fingerprint <public-key-file>` with the publisher's fingerprint through a separate trusted channel before adding the key. Never accept a key and its fingerprint from the same untrusted package source.

Use these commands:

```text
node src/cli.mjs extensions verify <package-directory>
node src/cli.mjs extensions install <package-directory>
node src/cli.mjs extensions list
node src/cli.mjs extensions enable skill <package-id> <version>
node src/cli.mjs extensions disable skill <package-id>
node src/cli.mjs extensions rollback skill <package-id>
node src/cli.mjs extensions enable mcp <package-id> <version>
node src/cli.mjs extensions disable mcp <package-id>
node src/cli.mjs extensions rollback mcp <package-id>
node src/cli.mjs extensions uninstall <skill|mcp> <package-id>
node src/cli.mjs extensions check-updates
node src/cli.mjs extensions list-updates
node src/cli.mjs extensions verify-update <package-directory>
node src/cli.mjs extensions install-update <skill|mcp> <package-id>
```

`install` stores bytes read during verification under `<install-root>/<type>/<id>/<version>`. It fails if that version already exists. `enable`, `disable`, and `rollback` apply to both skills and signed MCP packages. Activation and rollback check the current signature, trust root, revocation settings, entry point, and process capability declaration. A rollback selects the last previously active version and rechecks its signature against the current trust and revocation configuration. A revoked or untrusted version cannot be activated or restored.

`uninstall` permanently removes all installed versions for the named package and its activation history. The package must be disabled first. Uninstall is serialized with installation and activation-record updates. MCP uninstall also refuses while any user MCP server configuration references the package; remove that configuration before retrying. Uninstall does not remove trusted publisher keys, revocation settings, or unrelated packages.

Disabling, listing, fingerprinting, and uninstalling do not require a current revocation-feed cache. Package verification, installation, activation, rollback, and authenticated update-feed operations that can enable code fail closed until the configured signed revocation cache is current.

At runtime, active skills are reverified against the installed files, trust roots, and revocation entries whenever the skill catalog is read. Their content remains untrusted reference material and cannot grant tools or override runtime policy. A duplicate with a user-configured skill name is rejected.

The browser Skills panel lists installed signed skill package versions when extension trust is configured, including packages that have never been activated. It supports first activation, switching to another installed version, disabling an active skill, reactivating a retained version, and rolling back to the most recently previous version. Each action requires confirmation and is audited by the local API. The inventory lists filesystem coordinates only; activation and rollback verify the current signature, trusted key, package contents, and revocation state. Changes affect new runs, while a run already in progress retains the skill content loaded for that run. The browser does not install or download packages.

The browser MCP panel lists installed signed MCP package versions and activation history. It supports activation, disabling, and rollback with confirmation and auditing; each activation and rollback rechecks the package signature and revocation state. If an enabled user server references the package, changing activation reconnects it and may start signed code under the current OS account. Stop active runs before changing package activation.

The browser Packages panel reads verified cached update metadata, explicitly checks the configured feed, and downloads a selected eligible skill or MCP update. It verifies the feed-listed manifest digest, package signature, identity, and payload hashes before staging the version inactive. Use Skills or MCP to activate it when ready. The panel also offers a confirmed revocation refresh; it is blocked during active runs and reloads MCP connections if the verified revocation set changes. Feed URLs and trusted keys remain user configuration, and the browser never performs automatic package polling, downloading, or activation.

The browser MCP panel also provides a read-only catalog of user-configured server connection state and advertised tools, resources, and prompts. Server-provided names and descriptions are untrusted metadata. Commands, arguments, working directories, and environment/credential references are not exposed by the catalog; use user configuration to change server settings.

An optional signed revocation feed can distribute publisher key and package revision revocations. Configure its HTTPS URL and the trusted Ed25519 key ID under `[extensions]`, then run `node src/cli.mjs extensions refresh-revocations` or use **Packages → Refresh revocations**. The signed feed uses monotonically increasing sequence numbers and an expiry; rollback and same-sequence changes are rejected. Runtime reads use the local verified cache and fail closed for active installed packages if the cache is missing or expired. Refresh is explicit, so ordinary startup never makes a network request. The browser refresh requires no active runs because a changed revocation list may disconnect or restart configured MCP servers.

An optional signed package update feed lists the latest version, HTTPS package URL, and exact SHA-256 digest of each signed `manifest.json`. Configure `update_feed_url`, `update_key_id`, and optionally `update_max_age_hours` under `[extensions]`. `extensions check-updates` or **Packages → Check for updates** fetches and authenticates the feed, caches it with replay protection, and reports newer versions for active installed packages; `extensions list-updates` and the browser's initial view use the verified cache without network access. Cache commits use a cross-process lock and recheck the latest signed sequence immediately before writing, so an older concurrent response cannot roll the cache back. A lock left by a crashed writer fails closed and must be removed only after confirming no writer is active. `extensions install-update <type> <package-id>` or the browser's selected **Download & stage** action downloads the listed bundle with redirects disabled and a strict size/time bound, verifies the feed-listed manifest digest, package signature, identity, and every payload hash in memory, then stages only verified bytes. It never activates the package. For a locally obtained package, `extensions verify-update <package-directory>` checks its signature and manifest digest against the cached signed metadata before a separate manual install.

Signed package entries may include `rollout_percentage` (0–100) and a non-empty `rollout_salt`. A local random cohort ID is stored in `update-cohort.json` beside the extension install root; it is not sent to the update service. The client hashes the cohort ID with the signed salt, so increasing a release's percentage gradually adds stable cohorts. `check-updates`, offline `list-updates`, and `install-update` use the same cohort decision. Omit both fields to make a release immediately available to all eligible installations.

Downloaded bundles use a bounded JSON envelope; no archive extraction is performed before verification. `manifest` is the base64 encoding of the exact signed `manifest.json` bytes, and `files` contains one `{ "path", "content_base64" }` entry per declared payload. The package manifest signature authenticates package identity and each payload's digest; the update feed binds the exact manifest bytes. Unsupported fields, duplicate or undeclared paths, oversized data, revoked signers, bad signatures, and digest mismatches are rejected.

The update feed statement uses this version-1 shape; `signature` is an Ed25519 signature over canonical JSON of every other field. `manifest_sha256` hashes the exact UTF-8 bytes of the release's `manifest.json` file, including its whitespace and final newline if present. Package URLs must be HTTPS and contain no credentials or query parameters. Sequence numbers must increase for every changed feed, and the signed expiry is enforced.

```json
{
  "schema_version": 1,
  "sequence": 12,
  "issued_at": "2026-10-21T12:00:00.000Z",
  "expires_at": "2026-10-24T12:00:00.000Z",
  "key_id": "xyst-updates-2026",
  "packages": [
    {
      "package_type": "skill",
      "package_id": "release-check",
      "version": "1.2.0",
      "manifest_sha256": "<64 lowercase hexadecimal characters>",
      "package_url": "https://packages.example.com/release-check-1.2.0"
    }
  ],
  "signature": "<base64 Ed25519 signature>"
}
```

## Offline feed signing

Prepare unsigned statement JSON files outside the client install. Every feed must use a sequence higher than its previous publication whenever any signed statement field changes. Keep private Ed25519 keys on an offline release system; the signer reads the key, never copies it, validates the signed output with the same schema rules used by clients, and refuses to overwrite an existing feed file.

Sign a package update statement or revocation statement with:

```text
node scripts/sign-extension-feed.mjs updates <unsigned-updates.json> <offline-private-key.pem> <new-packages.json>
node scripts/sign-extension-feed.mjs revocations <unsigned-revocations.json> <offline-private-key.pem> <new-revocations.json>
```

An unsigned update statement contains `schema_version`, `sequence`, `issued_at`, `expires_at`, `key_id`, and `packages`; a revocation statement uses the same envelope fields with `revoked_key_ids` and `revoked_packages`. The tool signs canonical JSON with Ed25519 and creates the output exclusively. Review and publish the resulting file through the feed host, then distribute the matching public key through a separate trusted channel. Client cache sequence checks reject rollback and same-sequence equivocation.

MCP packages remain inert after installation. To activate one, run `extensions enable mcp <package-id> <version>` and add a user-level `[mcp.servers.<name>]` entry with `enabled = true` and the matching `package_id`; optional `args`, environment references, and timeout remain user-configurable. Do not set `command` or `cwd`: runtime launches the signed entry point with the current Node.js executable and package directory as its working directory. At startup it rechecks the installed signature, payload digests, trust and configured revocations. If the server advertises tools, resources, or prompts, the corresponding `mcp.tools`, `mcp.resources`, or `mcp.prompts` declaration is required. MCP tools remain subject to Xyst AI Assistant's normal tool policy. Project configuration cannot add trust keys, activate packages, or launch MCP servers.

Signed MCP code runs as a child process under the current Xyst AI Assistant OS account. On Linux, `workspace-write` and `workspace-read` launch stdio servers under Bubblewrap with no network and mount the signed package read-only; the selected workspace is writable only in `workspace-write` mode. Environment references are refused in these modes. Global `read-only` mode skips MCP startup. Streamable HTTP, legacy HTTP+SSE, and persistent-process sandboxing on Windows fail closed. Outside workspace-isolated Linux mode, capability declarations do not constrain direct filesystem, network, or desktop access. Disable package activation and remove or disable its user server entry to stop it from launching. Runtime capability enforcement beyond MCP feature-category checks remains open.

## Current distribution boundary

Trust roots, feed URLs, and local revoked key/revision lists are user settings. Metadata checks and download/install are explicit from both CLI and browser. Background update polling, dependency resolution, automatic activation, and package deletion remain unimplemented.
