# Xyst AI Assistant Desktop

This Tauri host runs the existing Node agent service and opens its shared local control UI in a native WebView. The desktop client does not have a second agent loop or a second session store.

## Development

Requirements: Rust, the Tauri system prerequisites for the host OS, and network access for the first build. Build-time Node.js 22 or newer is needed to run the preparation scripts; the desktop app bundles its pinned Node runtime.

```powershell
npm run check:desktop
npm run build:desktop
cargo run --manifest-path gui/desktop/src-tauri/Cargo.toml -- --workspace .
```

Pass `--config <path>` to select a user config file. When `--workspace` is omitted, the desktop reopens the last valid workspace saved in the platform app-config directory; the native folder picker appears on first launch or when that folder is no longer available. Passing `--workspace` selects and saves the supplied project for the next launch. Node is launched with argv directly; the service chooses a loopback port, writes its one-time bootstrap record through a private pipe, and serves the existing UI at `/app`. The token is never written to disk or logged. Closing the window sends the private shutdown command and waits for the service to close; a bounded timeout terminates a stuck service.

The build downloads Node.js v24.22.0 for the current Windows/Linux architecture, verifies the archive against its pinned SHA-256, and stages the executable and upstream `LICENSE` for Tauri resource packaging. The supported bundled architectures are x64 and ARM64. The archive is cached under `.toolchains/desktop-runtime-cache`; subsequent builds can run offline when the cache is present. Set `XYST_NODE` to an absolute executable path to override the bundled runtime for development.

The Windows host and NSIS installer build locally. `pnpm smoke:desktop:windows-installer` verifies the installed executable, AppContainer helper, and bundled source/runtime; launches the packaged API and UI; checks graceful shutdown; reinstalls the same package over the existing install while verifying user configuration retention and service restart; then uninstalls from isolated temporary app-data folders. On Ubuntu, `pnpm smoke:desktop:linux-package` extracts the DEB without installing system files, checks its metadata, launcher and bundled runtime, then launches the packaged API/UI and verifies graceful shutdown. CI runs both native package smoke tests. `pnpm smoke:browser` opens the real loopback app in headless Chrome, checks rendered landmarks and accessible names, and traverses keyboard focus; CI runs it on Windows and Linux. This does not replace interactive desktop, screen-reader, high-DPI, or multi-monitor validation. Installers are unsigned; cross-version upgrade and packaged desktop accessibility remain release work.

The native window uses only the service's loopback URL. It exposes no shell plugin or privileged Tauri commands to the page. Runtime policy, access mode, tool approvals, sessions, and process management remain in the shared Xyst AI Assistant service.
