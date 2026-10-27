# Platform support

Xyst produces Windows x64 NSIS and Linux x64 AppImage packages. The current candidate packages were built from the application source at PR head `2f1f547` (subsequent changes are documentation-only) and passed the hosted package workflow, including clean installation/renderer smoke on Windows and clean AppImage/renderer smoke on Ubuntu. They are unsigned CI candidates, not a signed public release.

| Platform target | Package | Current candidate and evidence | Support boundary |
| --- | --- | --- | --- |
| Windows x64 | NSIS installer | [Package workflow run](https://github.com/iExyst/Xyst-Ai-Agent/actions/runs/40452451239), artifact `xyst-windows`. Installer: 264,249,548 bytes; SHA-512 Base64 `MqNQwfFTyWUURt2/jNXYKEj6s7nJd1lL12jofICdKSikazttA2LtAFRbxjEohxFqUqytFlDvcg8TWOLboRLcBA==`. Its manifest matches the size and digest. The exact candidate passed CI install and renderer smoke. | Windows x64 is verified. Windows ARM64 is not built. The package is unsigned; no trusted publisher/update feed is configured. |
| Linux x64 | AppImage | [Package workflow run](https://github.com/iExyst/Xyst-Ai-Agent/actions/runs/40452451239), artifact `xyst-linux`. AppImage: 325,116,251 bytes; SHA-512 Base64 `SWMX4ppc7+27Gt12kmk03yuo5IOe8KzxdgmBVeoUy3ktD/wJ/gwkzTE5y+imnW81FUpeaJXe1RDXaMeGJgNQTA==`. Its manifest matches the size and digest. The exact candidate passed CI AppImage/renderer smoke on Ubuntu. Earlier Ubuntu 24.04.5 KVM and WSL2 checks cover GNOME display behavior and the systemd user-service lifecycle on prior package builds. | Ubuntu 24.04 x64 is the tested target. Linux ARM64 and other distributions are not verified. Physical display/GPU behavior and service lifecycle on this exact candidate were not tested. The package is unsigned. |

The exact CI packages are retained in `release-current-2f1f547/windows/` and `release-current-2f1f547/linux/` in the local workspace. The older `release/` directory is stale (it lacks the Linux AppImage and its Windows installer does not match this candidate); do not distribute its contents as the current build. The GitHub Actions artifacts are available from the linked run and may expire under GitHub's artifact-retention policy.

Production signing and a trusted hosted updater remain release gates. See [verification history](verification-history.md) for older, individually scoped Linux environment checks.
## Current-source candidates with real-time GitHub intake (2026-10-26)

Both candidates were built from the current source into `.xyst-live-acceptance/current-source-webhook-20261026/`; they have not replaced the `release/` artifacts. Windows NSIS: 267,595,121 bytes, SHA-512 hex `001F83E732D55F0E4324DC46C586D0A5030827CE02685687F4EEDFF0C356ED1BE42CF20807C7593D7CAD66FC919F5DA408B2354856E56568CC6D0477292FB57D`, `app.asar` SHA-256 `FCFB032BF204BE461C3C5686517053F07E71B6DBE94E2F2541FCFFB04B093235`. Linux AppImage: 325,882,690 bytes, SHA-512 hex `12B157C20249837455F1651AB2E5E3CAAA4C562ADD9A47D2B239A9DA8C8EA646CA45441E7307FC2781EE980CEF50870740F09C4B99EC8896BA1D21C9F0DE0DCC`, `app.asar` SHA-256 `97E947F1705FE4DB804F4C58AF3AD98B8AA783DE3199ACF879C14E1A91B952F6`. Both update manifests match their artifact hashes and byte sizes.

The exact Windows installer passed a clean-install renderer smoke (`RUNTIME READY`, 25 controls, 1426×877); screenshot: [Windows UI](../.xyst-live-acceptance/current-source-webhook-20261026/windows-gui-smoke.png). The exact Linux AppImage passed its WSL renderer smoke (25 controls, 1440×913); screenshot: [Linux UI](../.xyst-live-acceptance/current-source-webhook-20261026/linux-gui-smoke.png). The packaged service renderer preserves webhook flags for both systemd and Task Scheduler. The Linux CLI listener returned 404 on an unmatched route and 503 on the configured route while its secret was intentionally absent, then drained cleanly on SIGTERM. Its bundled `web_fetch` retrieved live Open-Meteo current conditions (HTTP 200, timestamped JSON); earlier packaged Windows/Linux agent acceptance fetched GitHub REST data. Public JSON APIs require no provider credential; authenticated/private APIs and web search require their respective configured credentials. WSL verification does not establish bare-metal Linux support. Final release promotion remains outstanding.

## Earlier AppImage GNOME Shell/X11 smoke (2026-10-25)

An earlier AppImage was launched as unprivileged `qa` under GNOME Shell 46 (`--x11 --sm-disable`) and its D-Bus session on Xvfb in an Ubuntu 24.04.5 KVM guest. Electron DevTools reported `Xyst Control Room`, 25 visible labeled buttons, and a 1280×804 viewport; the Overview screenshot was visually inspected and the app reported `RUNTIME READY`. This GNOME Shell run lacked the full session and some core/optional services, so it does not establish physical desktop or bare-metal support. The isolated profile used an unreachable LM Studio endpoint; no model was loaded or queried. It is historical evidence and does not test the current AppImage. See [verification history](verification-history.md#current-appimage-under-gnome-shellx11).

## Credential vault checks

- Windows (prior package): extracted an earlier NSIS archive without running Setup; its compiled `CredentialStore` passed set/get/delete under the bundled Electron/Node runtime with isolated app-data/workspace paths and a unique dummy Credential Manager entry removed in a `finally` cleanup path. LM Studio was pointed at unused loopback port 9; no model was queried. The current installer’s clean-install smoke is documented above; current-digest Windows vault CRUD is not yet repeated.
- Linux (current AppImage above): the exact compiled `CredentialStore` and bundled Node passed set/get/delete/absent against a private D-Bus/GNOME Keyring session in Ubuntu 24.04 WSL, using an unprivileged account plus isolated HOME/XDG directories and a temporary random dummy value. The secret was not printed and the temporary keyring was removed. A separate nonexistent private D-Bus socket produced the actionable missing-Secret-Service error on a prior package. Native desktop keyring unlock/prompt behavior and bare-metal distribution acceptance remain open.

## Earlier package rebuild (2026-10-25)

- Windows x64 NSIS: 267,530,771 bytes; SHA-512 Base64 `YHkL1H4R95uWtTZYPN1dvLqvFPOJ73qK1BjHwwThZigTZ9vDt/H3R7+16SoKNpNeBZf8Yv0UTcTPNjw5PKhMnw==`; embedded `app.asar` SHA-256 `7DE83DACB82ADD5475B29C0CF0584020B13E347842D47B6C38C2A6A2EC42C060`. `latest.yml` matches the installer size and hash.
- Ubuntu x64 AppImage: 338,717,698 bytes; SHA-512 Base64 `jLxz586RrYdqQra/58jxwU7oAi8pcV4b0UXCw1EDWx2IWlnkV13uKbtet2aafZ8aVqhfvbgSMtBOo8Bo1A/Xpg==`; embedded `app.asar` SHA-256 `136759adcedafdb86c0b0c5e62e4a80cc483fb3e4ca45c4034276c2ee1aee9df`. `latest-linux.yml` matches the AppImage size and hash, and the embedded archive matches the extracted payload.
- A prior Windows/Linux package pair passed isolated mission create, rename, export, fork, list, and delete checks; its Linux AppImage (323,075,196 bytes; SHA-512 `IVhwQy4Bts/JKtoLknHqQZm8fJ6Yuw9BEMEkm3KPoGIivQrBhgW5eeMYzlFdKhLeopUZyeHAJfGVFL+rgkyLAw==`) rendered the Missions page under Weston/Wayland with `full` and `restricted` profiles. No task or model ran. Export omitted the local ID and preserved schedule/trigger metadata; forks disabled unattended triggers. The current package digest has not repeated these checks.
## Runtime dependencies and integrations

- `.github/workflows/ci.yml` defines Windows and Ubuntu 24.04 CI on pushes and pull requests. It installs the committed npm lockfile, runs the deterministic runtime and CLI suites, and builds each platform package. Hosted run [40215780945](https://github.com/iExyst/Xyst-Ai-Agent/actions/runs/40215780945) passed on Windows and Ubuntu 24.04; hosted package run [40215781008](https://github.com/iExyst/Xyst-Ai-Agent/actions/runs/40215781008) passed on both systems, including the clean Windows installer/renderer smoke.
- Packaged CLI actions use the Node runtime bundled with the application. Source development requires Node.js 22 or newer and npm 10 or newer.
- Build Linux packages with Linux platform dependencies installed. A WSL build using the Windows node_modules tree omitted the Linux keyring binding and failed at app startup; the current AppImage was rebuilt from a Linux install of the committed lockfile.
- Packaged desktop builds use ASAR for Electron code. The CLI, runtime modules, bundled Node executable, and native modules are unpacked so the external CLI process can load them. Packaged desktop builds create an `Xyst` workspace beneath Electron's OS-reported Documents directory (on Linux this may fall back to the home directory when no separate Documents folder is configured).
- LM Studio is installed separately. Its desktop server or supported headless `llmster` daemon supplies local inference.
- Ubuntu 24.04 x64 AppImage launch requires `libfuse2t64` and access to `/dev/fuse` to mount the image. Electron's host runtime libraries are also required on minimal installations; the current Ubuntu 24.04 guest exposed missing libraries when only FUSE and Xvfb were installed. Install the verified set with:

```sh
sudo apt-get install libfuse2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcups2t64 libcairo2 libgtk-3-0t64 libpango-1.0-0 libxcomposite1 libxdamage1 libxfixes3 libasound2t64 libxss1
```

Xvfb is needed only for headless smoke checks, not ordinary desktop use. This dependency set allowed an earlier AppImage to launch and render in a fresh Ubuntu 24.04 KVM guest. The current AppImage was verified under Ubuntu 24.04 WSL/Xvfb; other distributions may use different package names and have not been verified.
- LibreOffice is optional and not bundled. Install it separately to render DOCX, XLSX, and PPTX previews; PDF previews do not need it. Linux users who configure the Xyst credential vault also need an unlocked Secret Service on the current user's D-Bus session.
- Native application automation is opt-in (`desktop automation on`). Windows uses Microsoft UI Automation for visible windows and accessible controls. Linux uses `xdotool` for X11/Xwayland window listing, geometry, clicks, text, and keys; it cannot control native Wayland surfaces or read a Linux accessibility tree. Run `xyst desktop status` to inspect detected Wayland/X11 signals and available capabilities. This workspace verified Windows UI Automation against the live desktop and live Xwayland interaction against a disposable test window under Ubuntu 24.04 WSLg. An earlier package in a clean Ubuntu 24.04 KVM guest detected X11/xdotool and persisted the opt-in toggle; no desktop action was issued. Verification on a physical native Linux session remains open.
- Updates require a user-configured HTTPS feed. Xyst does not host or publish release files.

The current release checks and known platform gaps are tracked in [build status](../BUILD_STATUS.md). Do not treat an untested distribution or architecture as supported based only on its ability to open an AppImage or run the CLI.

## Earlier package mission lifecycle (2026-10-25)

Earlier Windows and Linux packaged CLI payloads each passed isolated mission create, rename, portable export, fork, list, and delete operations. Both package databases ended empty and passed SQLite integrity checks. Export preserved schedule/GitHub-trigger metadata without a local ID; forks received a fresh ID and disabled unattended triggers. Neither mission ran. LM Studio was unreachable at loopback port 9. This lifecycle evidence has not been repeated for the current package digests. See [verification history](verification-history.md#current-windows-and-linux-package-mission-lifecycle-smoke-2026-10-25).

## Earlier GNOME desktop session smoke (2026-10-25)

An earlier AppImage ran in Ubuntu 24.04.5 under the GNOME Session Manager, GNOME Shell, and GNOME Settings Daemon, with X11 and a session D-Bus. The session ran on Xvfb in a disposable KVM guest. DevTools reported `Xyst Control Room`, runtime ready, 25 visible buttons, and a 1280×802 renderer; the Overview was visually inspected. No model or mission ran. This verifies that earlier package in a full GNOME X11 software session, not a physical display/GPU or bare-metal installation, and does not cover the current AppImage. See [verification history](verification-history.md#current-appimage-in-a-full-gnome-x11-session-2026-10-25).

## Earlier Linux packaged desktop/CLI state sharing (2026-10-25)

An earlier AppImage's bundled CLI created a mission in an isolated XDG profile. Launching that AppImage in a GNOME X11 session with the same profile displayed the mission and objective in the Missions view. The footer showed the shared Xyst data directory; the mission remained unrun. LM Studio was unreachable at port 9. This state-sharing check has not been repeated for the current package digest. See [verification history](verification-history.md#current-linux-package-desktop-and-cli-mission-sharing-2026-10-25).

## Earlier Windows packaged snapshot state sharing (2026-10-25)

An earlier packaged Windows CLI created a mission that the same package's `desktop snapshot` command returned from the same isolated SQLite database. After CLI deletion, the snapshot reported zero missions. The exact package `app.asar` digest, isolation, and limits are in [verification history](verification-history.md#current-windows-packaged-desktop-snapshot-sharing-2026-10-25). The installed Windows GUI was not launched for that check; the current Windows installer has separate clean-install and renderer evidence above.

## Earlier Linux packaged bidirectional mission updates (2026-10-25)

An earlier AppImage shared one isolated XDG/Xyst profile between its packaged CLI and GNOME X11 desktop. The CLI created a mission, the desktop displayed and renamed it, and the CLI then read the new name and timestamp from SQLite before deleting the fixture. No mission ran or model was queried. This bidirectional check has not been repeated for the current AppImage digest. See [verification history](verification-history.md#current-linux-packaged-bidirectional-mission-state-sharing-2026-10-25).
