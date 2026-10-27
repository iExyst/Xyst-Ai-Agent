# Hello World MCP package

This small signed-package example demonstrates Xyst AI Assistant's MCP stdio package contract. It provides one deterministic `echo` tool and performs no filesystem, network, shell, or desktop operations. The declaration in `manifest.json` is a publisher claim; it does not constrain arbitrary code in other MCP packages.

## Build a signed package

Use a publisher-owned Ed25519 private key and keep it outside the repository and output package. The builder copies only `server.mjs` and writes a signed `manifest.json`. It refuses to replace an existing output directory.

```powershell
node scripts/build-example-mcp-package.mjs `
  --key-id my-publisher-2026 `
  --private-key C:\keys\my-publisher-ed25519-private.pem `
  --output C:\packages\hello-world-mcp-1.0.0 `
  --version 1.0.0
```

Then distribute the generated package directory and the publisher's public key through separate trusted channels. Compare its fingerprint with the package publisher before adding that key to `[extensions.trusted_keys]`. Do not distribute the private key with the package.

## Verify, install, and enable

With the public key configured as `my-publisher-2026`, verify and install the generated directory:

```powershell
node src/cli.mjs extensions verify C:\packages\hello-world-mcp-1.0.0
node src/cli.mjs extensions install C:\packages\hello-world-mcp-1.0.0
node src/cli.mjs extensions enable mcp hello-world-mcp 1.0.0
```

Add this to the user's Xyst AI Assistant configuration. Replace the example key ID with the key ID actually used to sign the package:

```toml
[mcp]
enabled = true

[mcp.servers.hello_world]
enabled = true
package_id = "hello-world-mcp"
```

Restart Xyst AI Assistant or reconnect the MCP server. Its `echo` tool will appear as `mcp__hello_world__echo`. Calls still pass through Xyst AI Assistant's normal tool policy. Required Linux sandbox mode can run signed MCP stdio packages with no network access; on other configurations, the child process has the OS permissions of the Xyst AI Assistant user. Review code before trusting a publisher.

See [Extension packages](../../../docs/EXTENSIONS.md) for revocation, updates, activation, and platform limitations.
