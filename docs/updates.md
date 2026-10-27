# Desktop update feeds

Xyst can check and download updates for packaged Windows NSIS and Linux AppImage builds. Update checks are off by default. The app only checks after you enable them and set a trusted HTTPS feed URL. Checks and downloads also obey the global network setting and the active access profile. macOS and unpackaged development builds are unsupported.

## Prepare a feed

Build the Windows and Linux packages with `npm run desktop:package` on their respective platforms. Packaging runs electron-builder with publishing disabled, then generates the matching update metadata locally beside each artifact:

- Windows: `latest.yml` and `Xyst Setup <version>.exe`
- Linux: `latest-linux.yml` and `Xyst-<version>.AppImage`

Upload each manifest and its referenced artifact to the same HTTPS directory. Keep filenames and contents unchanged. A generic feed can serve the two platform manifests from the same base URL. The manifest includes the artifact's SHA-512 hash and byte size; `electron-updater` checks these before applying the downloaded package. This integrity check does not authenticate the publisher. Current Xyst packages are unsigned, so only configure a feed you control and trust. Publisher signing is a deployment option with its own certificate requirements; the signed production release workflow below requires it.

## Tagged GitHub releases

`.github/workflows/release.yml` builds the Windows NSIS installer and Linux AppImage from the matching `v<package version>` tag, runs the full runtime/CLI test suite on both platforms before packaging, verifies each platform manifest against its artifact, then publishes the manifests and packages to a GitHub Release. The Windows release build overrides the ordinary package configuration with `win.signAndEditExecutable=true` and sets `forceCodeSigning=true`. Both are necessary: the default package configuration disables executable signing, which would conflict with forced signing. The workflow fails unless the repository secrets `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` contain the publisher's PFX/P12 certificate (base64 or a hosted file URL) and password. Local and ordinary CI package builds may remain unsigned; the tagged release job must not.

Once the repository has a published release, its public generic feed URL is `https://github.com/iExyst/Xyst-Ai-Agent-PC/releases/latest/download/`. Configure that URL through **Settings → Application updates** or the CLI below. This endpoint has not yet been exercised against a published Xyst release. GitHub Release publishing is tag-only; the tag must match `package.json` and the signed release workflow requires the Windows certificate secrets. A configured, verified HTTPS feed can also serve packages independently of this GitHub publishing workflow.

The current electron-builder v26.18 package format verifies downloaded artifact SHA-512 values from manifests served over HTTPS. It does not cryptographically sign the manifests themselves. Protecting the feed and signing Windows executables remain separate requirements. See the official [Windows code-signing guide](https://www.electron.build/docs/features/code-signing/code-signing-win/) and [auto-update guide](https://www.electron.build/v26/docs/features/auto-update/).

No update host is built into Xyst. Set a feed URL you control in **Settings → Application updates**, or configure it with:

```sh
xyst config set updates.feedUrl '"https://releases.example.com/xyst/"' global
xyst config set updates.enabled true global
xyst config set updates.autoDownload false global
```

Set `updates.autoDownload` to `true` to download after a check without pressing Download. Installation is always explicit: open Settings and choose **Install and restart**. Clearing `updates.feedUrl` resets it to the default unset state; turning off `updates.enabled` stops future checks and automatic downloads.

The implementation uses Electron's `electron-updater` generic provider with `NsisUpdater` and `AppImageUpdater`. See the [electron-builder auto-update documentation](https://www.electron.build/v26/docs/features/auto-update/) for provider metadata and platform details. A disposable Ubuntu 24.04 KVM guest completed a local HTTPS-feed update from the packaged 0.1.0 AppImage to a temporary 0.1.1 build: feed discovery, full download, SHA-512/size validation, explicit install, replacement of the temporary AppImage, and launch of version 0.1.1 all passed. This smoke used a loopback-only feed and disabled certificate verification in the test Electron process because Electron rejected the guest-local test CA; it does not verify hosted TLS trust or publisher identity. The tag-triggered GitHub release workflow and required signing gate are implemented but have not run; repository certificate secrets and a release tag remain prerequisites.
