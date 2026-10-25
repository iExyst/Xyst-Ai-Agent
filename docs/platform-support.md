# Platform support

Xyst publishes platform packages for the architectures below. A package target describes what the build produces; it does not certify every distribution or desktop environment that can run it.

| Platform target | Package | Build and verification evidence | Support boundary |
| --- | --- | --- | --- |
| Windows x64 | NSIS installer | Current local release: [`Xyst Setup 0.1.0.exe`](../release/Xyst%20Setup%200.1.0.exe), 265,546,076 bytes; SHA-512 `T/XuEuEf4g1bEIqSCzu9wrEJvqsDmuxNCcKlNV1Efakz5lc5hMkVze1VxIPudA1q89II2BeCE/Gm2V4+tH/x4Q==`; `latest.yml` matches. Built from a clean npm install on Windows with Node 24.20.0; embedded `app.asar` SHA-256 `B9F41F83623280F12EAB92634B7D339A4156A3D6B1D7943799C178058B0A2446`. Package is unsigned. | Windows ARM64 is not built. A clean install of this exact local artifact and native keyboard/accessibility-tree acceptance remain open; the current commit is being checked by hosted Windows CI. |
| Linux x64 | AppImage | Current local release: [`Xyst-0.1.0.AppImage`](../release/Xyst-0.1.0.AppImage), 338,729,992 bytes; SHA-512 `AbWyLJ1rIZu0408NEyhZm8VC33HX+ZAvjGSOa8sKoGuoVmKcxLwnKujqyr0IrvO2sykc57JjYCfKOzIZL0JiJQ==`; `latest-linux.yml` matches. Built in Ubuntu 24.04 WSL with Node 22.12.0; typecheck, runtime (130 passed, 3 skips), CLI (14 passed), and package build passed. Extracted `app.asar` SHA-256 `9957c8e2a2e5ef36d3d66d7d8d624da0ca0f7aa4e3e66290cbf9459214850f02`. Exact AppImage rendered under WSL/Xvfb with runtime ready, full access, and 25 buttons. Package is unsigned. | Linux ARM64 is not built. Physical/bare-metal Linux, native service behavior, and supported-distribution acceptance remain open. |

## Current GNOME Shell/X11 smoke

The exact current AppImage also launched as unprivileged `qa` under GNOME Shell 46 (`--x11 --sm-disable`) and its D-Bus session on Xvfb in an Ubuntu 24.04.5 KVM guest. Electron DevTools reported `Xyst Control Room`, 25 visible labeled buttons, and a 1280×804 viewport; the Overview screenshot was visually inspected and the app reported `RUNTIME READY`. This GNOME Shell run lacked the full session and some core/optional services, so it does not establish physical desktop or bare-metal support. The isolated profile used an unreachable LM Studio endpoint; no model was loaded or queried. See [verification history](verification-history.md#current-appimage-under-gnome-shellx11).

## Credential vault checks

- Windows (prior package): extracted an earlier NSIS archive without running Setup; its compiled `CredentialStore` passed set/get/delete under the bundled Electron/Node runtime with isolated app-data/workspace paths and a unique dummy Credential Manager entry removed in a `finally` cleanup path. LM Studio was pointed at unused loopback port 9; no model was queried. This API check has not been repeated for the current archive digest and does not verify installation behavior.
- Linux (prior package): the compiled `CredentialStore` passed set/get/delete against a private D-Bus/GNOME Keyring session in Ubuntu 24.04 WSL; a nonexistent private D-Bus socket produced the actionable missing-Secret-Service error. This check has not been repeated for the current AppImage digest. Native desktop keyring unlock/prompt behavior remains open.

## Current package rebuild (2026-10-25)

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

Xvfb is needed only for headless smoke checks, not ordinary desktop use. This dependency set allowed the exact current AppImage to launch and render in a fresh Ubuntu 24.04 KVM guest. Other distributions may use different package names and have not been verified.
- LibreOffice is optional and not bundled. Install it separately to render DOCX, XLSX, and PPTX previews; PDF previews do not need it. Linux users who configure the Xyst credential vault also need an unlocked Secret Service on the current user's D-Bus session.
- Native application automation is opt-in (`desktop automation on`). Windows uses Microsoft UI Automation for visible windows and accessible controls. Linux uses `xdotool` for X11/Xwayland window listing, geometry, clicks, text, and keys; it cannot control native Wayland surfaces or read a Linux accessibility tree. Run `xyst desktop status` to inspect detected Wayland/X11 signals and available capabilities. This workspace verified Windows UI Automation against the live desktop and live Xwayland interaction against a disposable test window under Ubuntu 24.04 WSLg. In a clean Ubuntu 24.04 KVM guest, the current package detected X11/xdotool and the opt-in toggle persisted; no desktop action was issued. Verification on a physical native Linux session remains open.
- Updates require a user-configured HTTPS feed. Xyst does not host or publish release files.

The current release checks and known platform gaps are tracked in [build status](../BUILD_STATUS.md). Do not treat an untested distribution or architecture as supported based only on its ability to open an AppImage or run the CLI.

## Current package mission lifecycle

The current Windows packaged CLI payload and exact Linux AppImage payload each passed isolated mission create, rename, portable export, fork, list, and delete operations. Both package databases ended empty and passed SQLite integrity checks. Export preserved schedule/GitHub-trigger metadata without a local ID; forks received a fresh ID and disabled unattended triggers. Neither mission ran. LM Studio was unreachable at loopback port 9. See [verification history](verification-history.md#current-windows-and-linux-package-mission-lifecycle-smoke-2026-10-25).

## Current GNOME desktop session smoke

The exact current AppImage also ran in Ubuntu 24.04.5 under the GNOME Session Manager, GNOME Shell, and GNOME Settings Daemon, with X11 and a session D-Bus. The session ran on Xvfb in a disposable KVM guest. DevTools reported `Xyst Control Room`, runtime ready, 25 visible buttons, and a 1280×802 renderer; the Overview was visually inspected. No model or mission ran. This verifies the packaged app in a full GNOME X11 software session, not a physical display/GPU or bare-metal installation. See [verification history](verification-history.md#current-appimage-in-a-full-gnome-x11-session-2026-10-25).

## Current Linux packaged desktop/CLI state sharing

The exact current AppImage's bundled CLI created a mission in an isolated XDG profile. Launching the same AppImage in a GNOME X11 session with the same profile displayed that mission and its objective in the Missions view. The footer showed the shared Xyst data directory; the mission remained unrun. LM Studio was unreachable at port 9. See [verification history](verification-history.md#current-linux-package-desktop-and-cli-mission-sharing-2026-10-25).

## Current Windows packaged snapshot state sharing

The current packaged Windows CLI created a mission that the same package's `desktop snapshot` command returned from the same isolated SQLite database. After CLI deletion, the snapshot reported zero missions. The exact package `app.asar` digest, isolation, and limits are in [verification history](verification-history.md#current-windows-packaged-desktop-snapshot-sharing-2026-10-25). The installed Windows GUI was not launched.

## Current Linux packaged bidirectional mission updates

The exact current AppImage shared one isolated XDG/Xyst profile between its packaged CLI and GNOME X11 desktop. The CLI created a mission, the desktop displayed and renamed it, and the CLI then read the new name and timestamp from SQLite before deleting the fixture. No mission ran or model was queried. See [verification history](verification-history.md#current-linux-packaged-bidirectional-mission-state-sharing-2026-10-25).


## Current PR head hosted verification (2026-10-25)

- PR head f93333bab9b8e0700decf1f5995efbe49367934 passed hosted Cross-platform CI run [40231290931](https://github.com/iExyst/Xyst-Ai-Agent/actions/runs/40231290931) and Desktop packages run [40231290932](https://github.com/iExyst/Xyst-Ai-Agent/actions/runs/40231290932). The Windows package job performed a clean install and renderer smoke; Ubuntu package build passed.
- A second push-triggered copy of these workflows was also observed completing successfully. Current packaged model mission evidence from prior commits is version-specific and recorded in verification history; the current-source Qwen mission acceptance is also listed in BUILD_STATUS.md.
