# ADR 0011: Initial end-user support matrix

- Status: Accepted as the initial release target; native validation is still required before claiming a verified release.
- Date: 2026-10-22
- Supersedes: ADR 0009's broad OS/architecture target only. ADR 0009's data-location decision remains in effect.

## Decision

- Target 64-bit x86 Windows 11 Home, Pro, and Enterprise, version 25H2 or newer. The Windows release format is the NSIS installer.
- Target 64-bit x86 Ubuntu Desktop 24.04 LTS. The Linux release format is a DEB package. The target includes Ubuntu's supported X11 and Wayland sessions, subject to the optional capability requirements documented in [platform support](../PLATFORM_SUPPORT.md).
- Require Node.js 22 or newer for direct CLI execution; validate Node.js 22.x and 24.x in the release matrix. The desktop package bundles the exact Node.js version pinned by `gui/desktop/runtime-node.json` (currently 24.22.0).
- Require Linux 5.3 or newer for pidfd-backed recovered process stopping, plus trusted Bubblewrap and compatible user, mount, PID, network, and IPC namespaces for required process isolation. Runtime isolation fails closed when these facilities are unavailable; recovered stop fails closed without pidfd support.
- Keep Windows ARM64 and Linux ARM64 experimental. Runtime artifacts exist, but no ARM64 CI matrix or packaged acceptance evidence exists. Do not advertise ARM64 support until both platforms pass native CI and install/runtime smoke checks.
- Do not claim distro-wide Linux compatibility. Other Linux distributions, Windows versions older than 25H2, WSL, macOS, and other package formats are outside this initial target.

## Rationale

This target uses the Windows client and Ubuntu LTS environments closest to the project's current Windows 11 desktop work and Ubuntu CI/package pipeline. Restricting release claims to x86-64 follows the architectures currently exercised by CI. Node.js 22 and 24 are the direct-runtime majors exercised by CI, while desktop packages avoid an external Node installation by bundling a pinned runtime.

## Validation and consequences

- Existing CI uses Windows Server 2022 and Ubuntu 24.04; it does not prove Windows 11 client behavior or interactive Ubuntu desktop behavior.
- Before release, add or run native acceptance on Windows 11 25H2+ x64 and Ubuntu Desktop 24.04 LTS x86-64, including install, upgrade, startup, API/UI, sandbox and uninstall/data-retention paths.
- Recheck Windows servicing status, Node.js majors, and Ubuntu LTS status before each release. Raise the minimum Windows release only through a reviewed support-policy update.
- The release support gate stays open until the named end-user targets are validated and the required sandbox, Secret Service, graphical, and package checks pass.

## References

- [Platform support and data locations](../PLATFORM_SUPPORT.md)
- [Microsoft Windows 11 Home and Pro lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/windows-11-home-and-pro)
- [Ubuntu release cycle](https://ubuntu.com/about/release-cycle)
