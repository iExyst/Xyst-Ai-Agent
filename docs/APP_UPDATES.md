# Application updates

Xyst AI Assistant lets each user choose whether to check for application releases and whether to download an available release. **Xyst AI Assistant never installs or replaces itself automatically.** After checking, the user can explicitly request a download. Xyst AI Assistant rechecks the signed feed, downloads the selected platform package to a private temporary directory, and verifies its exact signed size and SHA-256 before it offers a one-time download link. The user decides whether and when to run the downloaded Windows installer or use the Linux package manager.

## User controls

Open **Runtime settings → Application updates**:

- **Never check** is the default.
- **Only when I check** checks when the user presses the button.
- **Check when Xyst AI Assistant starts and notify me** checks once when the application starts and shows a notification when a newer release is available.
- **Stable** and **Preview** are separate signed channels.

The app sends one HTTPS request to the configured feed during a check. Choosing **Download and verify update** rechecks that feed and then downloads the signed artifact over HTTPS. These requests do not include prompts, files, credentials, workspace paths, or a device identifier. The feed and artifact hosts can observe the network requests and the client's IP address. Project configuration cannot set update feeds or signing keys.

## Configure a release feed

The maintainer must publish a signed JSON feed and provide its HTTPS URL, key ID, and Ed25519 public key through a trusted release channel. Enter these in Runtime settings. Xyst AI Assistant displays a SHA-256 fingerprint for the saved key; compare the complete value out of band before relying on that trust root. A key entered into the UI is persisted in the user runtime settings file and is public material; the signing private key must remain offline and must never be shipped in the application.

The application version is read from `package.json` for CLI/source runs. The desktop host passes its Cargo package version to the service. Keep `package.json`, `gui/desktop/src-tauri/Cargo.toml`, and `gui/desktop/src-tauri/tauri.conf.json` versions aligned for every release.

## Feed format

The signature is standard Base64-encoded Ed25519 over the canonical JSON statement, with `signature` omitted. Canonical JSON recursively sorts object keys and uses UTF-8 JSON encoding. Unknown fields are rejected. Feed schema version is `1`; sequences start at `1` and must increase for every published feed. The client persists the highest verified sequence per channel and rejects rollback or equivocation while that key ID is trusted. Give each rotated key a new key ID. Feeds must be issued no more than five minutes in the future and expire within seven days.

```json
{
  "schema_version": 1,
  "sequence": 1,
  "key_id": "xyst-release-2026",
  "channel": "stable",
  "issued_at": "2026-10-21T18:00:00.000Z",
  "expires_at": "2026-10-28T18:00:00.000Z",
  "releases": [
    {
      "platform": "win32",
      "arch": "x64",
      "channel": "stable",
      "version": "0.2.0",
      "published_at": "2026-10-21T17:00:00.000Z",
      "download_url": "https://releases.example.com/xyst-0.2.0-x64.exe",
      "sha256": "<64 lowercase hexadecimal characters>",
      "size_bytes": 123456789,
      "notes": "Fixes and improvements."
    }
  ]
}
```

Release records must specify the exact platform (`win32` or `linux`) and architecture (`x64` or `arm64`). Download URLs must use HTTPS without credentials or fragments. Each record contains the exact artifact size and SHA-256. Channels are `stable` and `preview`.

To sign a prepared statement, store an Ed25519 private key in an offline protected file and run:

```powershell
pnpm sign:app-updates -- .\release-statement.json .\offline-release-key.pem .\releases.json
```

The command validates the statement, verifies the produced signature locally, refuses to overwrite the output, and reports the public-key fingerprint. It never writes or prints the private key. Publish only the resulting feed and the artifacts whose digests are in that feed. Generate a fresh statement with a higher sequence for every metadata change; never reuse a sequence for different content.

## Download and installation boundary

The download endpoint accepts only the version and sequence returned by a fresh verified feed check. It rejects redirects and checks the complete artifact's size and SHA-256 before exposing a random, short-lived, single-use loopback link. The staged copy is removed after download, expiry, replacement by another staged download, or application shutdown. A failed or interrupted verification never produces a usable link.

Xyst AI Assistant does not execute the installer, replace its own files, elevate privileges, choose a package manager, or perform rollback. Windows installation and Linux package-manager actions remain explicit user steps. A production release service, signing-key custody/rotation procedure, and hosted Windows/Linux update/install validation still need to be established before shipping update feeds.
