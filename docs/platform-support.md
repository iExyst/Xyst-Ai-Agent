# Platform support

## Combined PR #72 exact-head Windows/Linux artifacts · 2026-10-28

The combined integration head `697493013b7e9365126a7efb999f9e17fceee3e8` passed all eight hosted Windows/Linux CI and package checks (push/PR Cross-platform CI runs `40733237432` and `40733257866`; push/PR Desktop packages runs `40733237575` and `40733258222`). The Windows package checks passed manifest validation, clean installation, renderer smoke, and live mission-service lifecycle. The Linux package checks verified the AppImage manifest.

The local Windows NSIS installer `Xyst Setup 0.1.0.exe` is 262,669,327 bytes; its update manifest matches SHA-512 Base64 `d40eUXozUKvOOuLz4jhbWpNR1QQn00ZuPLhV2gj4360mBrVTy3/fwx9uZFX7YgL9SjvVl0nD0elejAAzTQd4Vg==`. It passed `scripts/smoke-packaged-windows-gui.mjs`: clean install, runtime ready, 25 controls at 1426×877, keyboard skip-link traversal, larger text (1.15×), high-contrast colors, and reduced-motion suppression.

The Linux x64 AppImage came from PR workflow artifact `xyst-linux` (artifact `12836600909`, PR package run `40733258222`, exact head above). It is 321,160,095 bytes; its update manifest matches SHA-512 Base64 `a2uoxBVNEYZUAG9sZcX1MLxZCvWsHjeHXDwAG2iG1EKntnmxDQ0b8kDnWy/wFOCnQ7tbWRa1mPhS+vBRffOEcQ==`, and its SHA-256 is `50F495F4EEB0E98D7810E8819ED33D7B560418983BEE656EA7699F055BC6A89E`. The exact artifact passed `scripts/smoke-packaged-linux-gui.mjs` under Ubuntu 24.04.5 WSLg: runtime ready, 25 controls at 1440×913, keyboard skip-link traversal, larger text, high contrast, and reduced motion. The clean profiles intentionally used LM Studio port 9; no model-backed inference is claimed. Visually inspected Windows and Linux screenshots are retained in the local `.xyst-live-acceptance/combined-pr72-linux` and `release` folders and are not tracked source files.

These are unsigned pre-release candidates. WSLg is not bare-metal Linux; native Linux desktop, distribution, screen-reader, physical input, signing, production update hosting, and release promotion remain unverified.

## Final 0.1.0 package candidates · 2026-10-27

The final Windows x64 NSIS installer is Xyst Setup 0.1.0.exe, 264,530,541 bytes, SHA-512 Base64 `QvaQ081/pprlXOP0E5WilJkUSzp9fmUs7XaX0Wzg3inbdG8Sw8Jcsi8eYhvkCYphG258Z7ebmUW3X0ZT+ZMzWg==`. Its generated update manifest matches the artifact. The exact installer passed a clean install and desktop smoke with 25 controls at 1426×877 (screenshot).

The matching-source Linux x64 AppImage is Xyst-0.1.0.AppImage, 335,630,363 bytes, SHA-512 Base64 `2uZ/iQzmIesPgSl2FdUjfX6DVNcmW/MoZMfmJkxwDMSQy/8+Swslym1bruTJvrfLogAThVpoRcqZE7PuPhw+CA==`. Its generated update manifest matches the artifact. The exact AppImage passed a clean-profile UI smoke under Ubuntu 24.04 WSLg with 25 controls at 1440×913 (screenshot). This is WSLg evidence, not bare-metal Linux.

The exact same final payloads also passed CLI-to-desktop mission sharing: the packaged CLI created a mission, `desktop snapshot` returned its ID, and the desktop Missions view displayed that mission and objective while it remained unrun. Windows SQLite integrity was healthy; the Linux check ran under WSLg and SQLite was healthy. See the linked package proofs and screenshots below. Both candidates remain unsigned and unpublished. The Windows package proof and Linux package proof contain machine-readable build, manifest, and acceptance details. Physical Linux/distribution coverage and trusted production signing/update hosting remain open.

## Current packaged renderer accessibility check · 2026-10-27

The exact current-source Windows package and Linux AppImage build payload both passed isolated renderer checks. All 11 primary views had zero unnamed interactive controls; DevTools Tab sequences traversed every detected stop with no focus-ring failures (25 stops on Overview and 99 on Settings). Windows used the current `win-unpacked/Xyst.exe`; Linux used the payload from the AppImage build under Ubuntu 24.04 WSLg. Windows proof, Linux proof.

The checks cover Chromium renderer trees on the primary views and a DevTools-dispatched Tab sequence on Overview. They do not prove OS-native screen-reader integration or physical-keyboard behavior. Those checks remain open.

## Fresh current-source package pair · automatic model-role selection · 2026-10-27

The current-source Windows x64 installer NSIS candidate is 264,527,074 bytes; its generated `latest.yml` matches SHA-512 Base64 `FTYl/4eWFlL5Y7y9tWznLluApKvccjtlqINNfERoPOK0T4gsXB6YAiqeT/z3hJFKlGojRVlV1wtw6jU/5yMxWg==`. The exact package passed a clean-profile installer and UI smoke with 25 controls at 1426×877 (screenshot).

The matching-source Ubuntu x64 AppImage candidate is 321,877,790 bytes; `latest-linux.yml` matches SHA-512 Base64 `0NscDTp2FuBpaft3qTh9Rz0aQerIpj341GSgDe0pcVj9yjhWriUpcb+Z7XGhPma6pDnw3tU1LnHu+PoJFcwohA==`. It was built from a clean npm install under Ubuntu 24.04 WSL using Node 24.22.1. The exact AppImage UI smoke passed with 25 controls at 1440×913 (screenshot). This verifies the WSL environment only. Both metadata manifests passed the release verifier. These candidates remain unsigned and unpromoted; native/bare-metal Linux support is still an external acceptance gate.

The exact Windows package and exact Linux AppImage payload each used bundled Xyst CLI/Node with automatic model selection to fetch GitHub REST through `web_fetch`. Both received HTTP 200 and persisted `task_complete verified=true`. Retrieval timestamps were `2026-10-27T16:45:07.066Z` (Windows) and `2026-10-27T16:46:58.522Z` (Ubuntu WSL). Evidence: Windows, Linux.
The exact AppImage was additionally launched in a clean Ubuntu 24.04.5 LTS QEMU/KVM guest (guest kernel 6.8.0-147-generic) under Xvfb/Openbox. It rendered `Xyst Control Room`, runtime ready, with 25 controls at 1438×848 (proof, screenshot). This guest check does not establish physical bare-metal Linux or native accessibility-tree/service behavior. Separately, the exact packaged CLI installed the systemd user service in this guest, reported `active/running`, survived the installer SSH login ending with `loginctl Linger=yes`, restarted successfully, survived a full guest reboot with `Linger=yes` and returned `loaded/active/running`, then uninstalled cleanly; SQLite integrity remained healthy (service proof, logout log, reboot log). This verifies reboot recovery in the Ubuntu KVM guest, not a physical host. A separate current-source packaged Qwen 3.5 9B guest agent attempt timed out without tool calls and is unverified (attempt record).


## Final current-source Linux candidate · 2026-10-27

The final Linux x64 AppImage local acceptance evidence (kept outside the repository) is 335,662,892 bytes; its `latest-linux.yml` matches SHA-512 Base64 `k1HiOIfuCHAJIvsGbHpKBIY62YnaKz4zpAEmfWenHKJ5XNzm192jqqufYTX/on3FyHGGlGrJhzpM7OmT0IcEWA==`. It includes the completion evidence freshness correction and expanded invalidation for office writes, browser downloads, repository clones, preview output, and desktop actions. Exact package checks passed: healthy isolated CLI startup, live GitHub API fetch (HTTP 200, `2026-10-27T16:06:48.025Z`, verified completion evidence), and WSLg UI smoke with 25 controls at 1280×913 (proof, screenshot). Current Linux source verification passed all workspace typechecks, 157 runtime tests with 3 host-specific skips, 19 CLI tests, 5 release checks, and AppImage packaging. This remains WSL verification; native bare-metal Linux and additional distribution coverage remain open.

## Current-source Linux candidate with fresh completion evidence · 2026-10-27

The current Linux x64 candidate local acceptance evidence (kept outside the repository) is 335,658,866 bytes; its `latest-linux.yml` matches SHA-512 Base64 `gzNUICXZKFWtp1aZ7olnys88GuVlh9bF6CHsf4FpmRf1GQQpUOixB19eYlgn9ktuhSOVPqlddX70YsTLZNBVhQ==`. The package was built from the source with the completion-evidence freshness correction. The exact packaged CLI started with healthy SQLite and full access. Qwen3 4B resumed a model-backed coding fixture, corrected a failed zero-delay test, passed all 4 tests, read the final file, and completed with persisted `task_complete verified=true` (proof, tool-call history). Source checks: runtime 157 passed/3 host-specific skips, CLI 19 passed, release checks 5 passed, all workspace typechecks and AppImage packaging passed. This is Ubuntu 24.04 WSL verification; native bare-metal Linux and additional distribution coverage remain open.

## Current live-data candidates with exact file verification · 2026-10-27

These candidates include machine-checked exact file content for literal `exactly` and `single line` output requirements. Both are isolated, unsigned candidates and have not been promoted to `release/`.

- Windows x64 NSIS: installer, 264,518,578 bytes; SHA-512 Base64 `Yp3+P21loqkZNrX26hA3/DNTvoaT74qeCuAsIJYJrNAId40St2BsdZCzfXsi3/IsqJmACYlOONfgStyN1PGvIg==`; `latest.yml` matches. The exact package passed clean install UI smoke at 1426×877 with 25 controls. Its model-backed CLI fetched the live GitHub API (HTTP 200, 2026-10-27T15:01:48.813Z) and completed with exact-URL and exact file-content evidence (proof).
- Linux x64 AppImage: package, 335,658,825 bytes; SHA-512 Base64 `KrQ7reAAvwycYodWgXbjgnrWddxRSxMAOIkKZl1w2EG/caWTP/m/3fL7gSUJSIn28eDi7PnpgPSol084JifZDw==`; `latest-linux.yml` matches. It passed WSLg UI smoke at 1440×913 with 25 controls. The exact packaged Qwen3 agent fetched the live GitHub API at 2026-10-27T15:04:40.378Z and completed with verified evidence (proof). WSL does not establish native bare-metal Linux support.
- Live data uses on-demand `web_fetch` for public HTTPS APIs, optional Brave `web_search`, and dedicated GitHub, Hugging Face, or configured MCP integrations. The current run requires `network.enabled` plus the active profile's network capability; private services require credentials in the OS vault or an authenticated MCP integration. `web_fetch` records the source URL and UTC retrieval time. Periodic polling uses mission schedules; change push depends on an MCP resource subscription when offered by the source. See [web retrieval details](./general-tools.md#web-retrieval).

## Latest process-replay candidates (2026-10-27)

These isolated candidates include task-aware model selection and workspace-aware process replay with backward-compatible journal deduplication. They are not promoted into `release/`.

- Windows x64 NSIS: installer, 264,513,551 bytes, SHA-512 Base64 `WNc3iJTgjX9wXiVjPUc5sSIh7SY0DtNM/zSntlWm8wwgEA9Z+1AfhswWUot4gQX+Wq0lxuIaWl9eaznzKtWbiQ==`. Manifest matches. The exact candidate passed a clean install UI smoke with 25 controls at 1426×877 (screenshot). Packaged CLI live GitHub response: JSON evidence.
- Linux x64 AppImage: package, 319,143,526 bytes, SHA-512 Base64 `vMiQuuXMy1uLRZnsXKVKV6grkwgkYLvofPObm/Nw3+rjdCxXL6XaIO00jxohKil8gdZFHHEO3omPw0LBXsx5cA==`. Manifest matches. The exact AppImage passed WSL GUI smoke with 25 controls at 1280×913 (screenshot). Packaged CLI live GitHub response: JSON evidence.
- The exact Linux AppImage's bundled Node and CLI also ran a model-backed task in Ubuntu 24.04 WSL against an already-installed `llmster` model (`qwen/qwen3-0.6b`, 16,384 context). With isolated XDG data and the LM Studio server bound to WSL loopback, the CLI reported a ready runtime, healthy SQLite, and full access profile. Its agent fetched the live repository API (HTTP 200, `retrieved_at=2026-10-27T13:11:59.309Z`) and persisted `task_complete verified=true` in session `4bd9d4b9-5adb-46db-8362-b877f8db6f21`. Exported session: linux-live-model-session.json.
- Both candidates returned live repository `iExyst/Xyst-Ai-Agent` and its current `pushed_at` value. WSL validation does not establish physical Linux/distribution coverage; both candidates remain unsigned and unpromoted.


## Latest task-aware candidate packages (2026-10-27)

These isolated candidates include task-specific automatic model selection. They are not promoted into `release/`.

- Windows x64 NSIS: candidate installer, 264,510,357 bytes, SHA-512 Base64 `l1kIfvk0zWNmvRmao1MEMab1R/3lllLWSPLHeLnnLYgQbBYLxg0KekGty1ynO5E0pIFxF7VW0mXk8W/At2ZBJg==`. Its manifest matches. It passed an isolated clean-install UI smoke with 25 controls at 1426×877 (screenshot). The bundled CLI starts with healthy SQLite and full profile; a live GitHub repository request succeeded.
- Linux x64 AppImage: candidate AppImage, 319,143,556 bytes, SHA-512 Base64 `aEA3dZ+GanqBs5f8sT+pLqb3NlUom6LmuvC+znqvDbETCDx13XF1OOqqGabhk7pv8xjBwEHN3mr2NIGwLpKa1A==`. Its manifest matches. The exact AppImage passed a WSL GUI smoke with 25 controls at 1280×913 (screenshot); its bundled CLI starts with healthy SQLite and full profile. A live GitHub repository request returned the public repo's `pushed_at` value.
- The Linux package was built under Ubuntu 24.04 WSL using Node 22.12.0. WSL package verification does not establish physical Linux or distribution coverage. Both packages are unsigned, and neither has been promoted to a release.


Xyst publishes platform packages for the architectures below. A package target describes what the build produces; it does not certify every distribution or desktop environment that can run it.

| Platform target | Package | Build and verification evidence | Support boundary |
| --- | --- | --- | --- |
| Windows x64 | NSIS installer | Current local release: [`Xyst Setup 0.1.0.exe`](../release/Xyst%20Setup%200.1.0.exe), 267,580,404 bytes; SHA-512 `zr1axFa3D5AtF7AZo+8kjTRrzlIjJnq5ZlQ3k/yWADEO1ns1fAyvTGdN0Unr4aXEhcIlXWXSYmfvFElGnpkN4A==`; `latest.yml` matches. Built with Node 24.20.0; embedded `app.asar` SHA-256 `767DA2F8234A2A1ADDEE0FE0C5B04736240D972ADB73CC33EF6C1DD47630D860`. This exact installer passed an isolated NSIS clean install and renderer smoke, reached `RUNTIME READY`, and rendered 25 buttons at 1426×877; screenshot: [`windows-gui-smoke.png`](../release/windows-gui-smoke.png). Its unpacked package CLI completed a live GitHub API task with exact-URL evidence. Package is unsigned. | Windows ARM64 is not built. Native keyboard/accessibility-tree acceptance and a trusted publisher certificate remain open. |
| Linux x64 | AppImage | Current local release: [`Xyst-0.1.0.AppImage`](../release/Xyst-0.1.0.AppImage), 336,438,446 bytes; SHA-512 `wMzRQbIOWdiqgER9FepnZ8JBmeBSjuqmaM8Jwv76R2MTHkrkWEob1qdA7LA/qRSmEzc3rGmP3F+nvSbIFj4o6A==`; `latest-linux.yml` matches. Built in Ubuntu 24.04.5 WSL with bundled Node 22.12.0. Embedded `app.asar` SHA-256 is `8d7555e68737bffcedad5be406f06196d0cb92c75a09375b8315b6d8c85d85ca`; the SQLite native module was rebuilt for the bundled Node ABI. This exact AppImage passed an isolated WSLg renderer smoke and visual inspection, reached `RUNTIME READY`, and rendered 25 buttons at 1440×913; screenshot: current Linux smoke. Its packaged CLI reported healthy storage and retrieved live GitHub API data. A follow-up LM Studio agent attempt using a loaded 16,384-token instance fetched the exact API URL but was interrupted before task completion evidence was verified. Package is unsigned. | Linux ARM64 is not built. Physical/bare-metal Linux, native service behavior, and supported-distribution acceptance remain open. |

## Current-source candidates with real-time GitHub intake (2026-10-26)

Both candidates were built from the current source into `local acceptance evidence (kept outside the repository)`; they have not replaced the `release/` artifacts. Windows NSIS: 267,595,121 bytes, SHA-512 hex `001F83E732D55F0E4324DC46C586D0A5030827CE02685687F4EEDFF0C356ED1BE42CF20807C7593D7CAD66FC919F5DA408B2354856E56568CC6D0477292FB57D`, `app.asar` SHA-256 `FCFB032BF204BE461C3C5686517053F07E71B6DBE94E2F2541FCFFB04B093235`. Linux AppImage: 325,882,690 bytes, SHA-512 hex `12B157C20249837455F1651AB2E5E3CAAA4C562ADD9A47D2B239A9DA8C8EA646CA45441E7307FC2781EE980CEF50870740F09C4B99EC8896BA1D21C9F0DE0DCC`, `app.asar` SHA-256 `97E947F1705FE4DB804F4C58AF3AD98B8AA783DE3199ACF879C14E1A91B952F6`. Both update manifests match their artifact hashes and byte sizes.

The exact Windows installer passed a clean-install renderer smoke (`RUNTIME READY`, 25 controls, 1426×877); screenshot: Windows UI. The exact Linux AppImage passed its WSL renderer smoke (25 controls, 1440×913); screenshot: Linux UI. The packaged service renderer preserves webhook flags for both systemd and Task Scheduler. The Linux CLI listener returned 404 on an unmatched route and 503 on the configured route while its secret was intentionally absent, then drained cleanly on SIGTERM. Its bundled `web_fetch` retrieved live Open-Meteo current conditions (HTTP 200, timestamped JSON); earlier packaged Windows/Linux agent acceptance fetched GitHub REST data. Public JSON APIs require no provider credential; authenticated/private APIs and web search require their respective configured credentials. WSL verification does not establish bare-metal Linux support. Final release promotion remains outstanding.

## Current-source live-attribution package candidates (2026-10-26)

The current runtime now attaches successful live-fetch source URLs and UTC retrieval times to verified final answers. Isolated candidate artifacts containing this change are under `local acceptance evidence (kept outside the repository)`; neither replaced the local `release/` packages. Windows NSIS: 267,597,283 bytes, SHA-512 Base64 `wS77fSybTo85ZiOkY30dKljuP/siZDrIMGgxSziLz/8TtX8BQcVdWlu5zAkxk2XV/Y1zbbsNqAjA4k3lV8Q3vw==`, embedded `app.asar` SHA-256 `46C668552ADC65758F66D331004E0BC661A9CBEFEB63052644BE4EED46323D3F`. Linux AppImage: 336,876,949 bytes, SHA-512 Base64 `kivBxeiNUXPz9GgVNQm4yidAEeDRaGqT6m8Bc1bbfgB7Vxf4ifvfLqh3ziTGs1PEfgYaJr3UblxKm3nL/YAjBQ==`, embedded `app.asar` SHA-256 `0b851ae3d5b5c03fa11c126af3ea7067d3474e73bc7f29d7f31d2a403a2bf564`. Both updater manifests match size and digest.

The exact Windows packaged CLI and exact Linux AppImage CLI each used an already-loaded Qwen3-0.6B through LM Studio, fetched live GitHub repository data, completed evidence verification after resuming the model's first unverified answer, and persisted a source URL plus retrieval time in the session. Linux WSLg renderer smoke reached `RUNTIME READY` with 25 controls at 1440×913; its screenshot was visually inspected. These candidates pass packaged live-data and renderer checks in Windows and Ubuntu 24.04 WSL. Bare-metal Linux and signed release promotion remain unverified.

## Earlier AppImage GNOME Shell/X11 smoke (2026-10-25)

An earlier AppImage was launched as unprivileged `qa` under GNOME Shell 46 (`--x11 --sm-disable`) and its D-Bus session on Xvfb in an Ubuntu 24.04.5 KVM guest. Electron DevTools reported `Xyst Control Room`, 25 visible labeled buttons, and a 1280×804 viewport; the Overview screenshot was visually inspected and the app reported `RUNTIME READY`. This GNOME Shell run lacked the full session and some core/optional services, so it does not establish physical desktop or bare-metal support. The isolated profile used an unreachable LM Studio endpoint; no model was loaded or queried. It is historical evidence and does not test the current AppImage. See [verification history](verification-history.md#current-appimage-under-gnome-shellx11).

## Credential vault checks

- Windows (exact process-replay candidate above): the candidate's unpacked bundled Node and compiled `CredentialStore` passed set/get/delete/absent against Windows Credential Manager. The smoke used a 256-bit random dummy value, printed no secret, and attempted deletion in `finally`; no LM Studio model was queried. Script: credential-vault-smoke.mjs.
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

## Current CLI outcome-reporting candidate · 2026-10-27

The latest unsigned Windows and Linux packages include explicit inspect/resume instructions when an agent run ends at its turn limit, is cancelled, or remains unverified. The Windows NSIS artifact is 264,535,994 bytes (SHA-512 Base64 `W+yRtRX6yq8ppGj1HLgyKbe4RILXsul3Z1xSTYPrRTLdi0YNyCLdr3efB7fZ5dnmmwO4/b8H78nHexG2Ouf9KQ==`) and passed an isolated clean installer and renderer smoke with runtime ready, 25 buttons, 1426×877. The Linux AppImage is 321,885,926 bytes (SHA-512 Base64 `fXGpzjMOCkCOnvSW0RAwzD6OwznqWfEo5DCRnMyoyq6tWCYsuqmhkt3I0spqRGoydvk59/NHS1RcDqP0jjEfAA==`) and passed the renderer smoke under Ubuntu 24.04 WSLg with runtime ready, 25 buttons, 1440×913. Both update manifests verify against exact artifact bytes. Linux bare-metal acceptance remains open. The candidates are unsigned/unpublished, and the production HTTPS update feed remains unconfigured. Machine proof and screenshots are in `local acceptance evidence (kept outside the repository)`.
