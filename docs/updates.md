# Desktop update feeds

Xyst can check and download updates for packaged Windows NSIS and Linux AppImage builds. Update checks are off by default. The app only checks after you enable them and set a trusted HTTPS feed URL. Checks and downloads also obey the global network setting and the active access profile. macOS and unpackaged development builds are unsupported.

## Prepare a feed

Build the Windows and Linux packages with `npm run desktop:package` on their respective platforms. Packaging runs electron-builder with publishing disabled, then generates the matching update metadata locally beside each artifact:

- Windows: `latest.yml` and `Xyst Setup <version>.exe`
- Linux: `latest-linux.yml` and `Xyst-<version>.AppImage`

Upload each manifest and its referenced artifact to the same HTTPS directory. Keep filenames and contents unchanged. A generic feed can serve the two platform manifests from the same base URL. The manifest includes the artifact's SHA-512 hash and byte size; `electron-updater` checks these before applying the downloaded package. This integrity check does not authenticate the publisher. Current Xyst packages are unsigned, so only configure a feed you control and trust. Signed release verification is still required before distributing production updates.

No update host is built into Xyst. Set a feed URL you control in **Settings → Application updates**, or configure it with:

```sh
xyst config set updates.feedUrl '"https://releases.example.com/xyst/"' global
xyst config set updates.enabled true global
xyst config set updates.autoDownload false global
```

Set `updates.autoDownload` to `true` to download after a check without pressing Download. Installation is always explicit: open Settings and choose **Install and restart**. Clearing `updates.feedUrl` resets it to the default unset state; turning off `updates.enabled` stops future checks and automatic downloads.

The implementation uses Electron's `electron-updater` generic provider with `NsisUpdater` and `AppImageUpdater`. See the [electron-builder auto-update documentation](https://www.electron.build/v26/docs/features/auto-update/) for provider metadata and platform details. A disposable Ubuntu 24.04 KVM guest completed a local HTTPS-feed update from the packaged 0.1.0 AppImage to a temporary 0.1.1 build: feed discovery, full download, SHA-512/size validation, explicit install, replacement of the temporary AppImage, and launch of version 0.1.1 all passed. This smoke used a loopback-only feed and disabled certificate verification in the test Electron process because Electron rejected the guest-local test CA; it does not verify hosted TLS trust or publisher identity. Xyst does not currently publish releases or host a feed, and production signing remains open.
