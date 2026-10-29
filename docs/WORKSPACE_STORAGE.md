# Workspace storage

The installed Xyst app has its own program directory. Development build caches,
test workspaces, and old release staging folders in this checkout are not needed
to run that installed app.

## Keep

- Source, tests, documentation, lockfiles, and Git history.
- `.agent/` and user configuration: these contain real conversations and workspace data.
- Any worktrees with work that has not been preserved elsewhere.
- `dist/desktop-runtime/` for the next desktop package build.
- One retained installer per platform in `dist/releases/`, with SHA-256 checksums.
- Installed dependencies and the system Rust/Windows build tools.

## Rebuildable output

After builds and test processes have stopped, these ignored folders can be removed:

- `gui/desktop/src-tauri/target/` and root `target/`: Rust build output and intermediates.
- Root and desktop `.test-tmp/` folders: disposable test workspaces and downloads.
- `dist/dev/`, `dist/release/`, and release `archive/` folders: superseded staging copies.
- `.toolchains/`: checkout-local downloaded tools and caches, when they are no longer in use.
  Keep this folder if your active Rust environment points into it.

Before removing a build folder, copy any installer that should be retained to
`dist/releases/` and verify its checksum. Check every cleanup path resolves inside
the intended checkout; never include `.agent/`, user data, or the installed app.
Do not commit generated packages or caches to Git.

A subsequent desktop build recompiles removed Rust output and may download cached
tools again. Use the platform build commands documented in the README to regenerate
those files. Avoid keeping copies of the same CI download in multiple staging folders.

## Cleanup on October 29, 2026

Removed obsolete build intermediates, disposable test output, duplicate CI downloads,
checkout-local tool caches, and archived installers. The system Rust installation was
verified to live outside this checkout before the local tool caches were removed.
Approximately 32.3 GB (30.1 GiB) of disk space was recovered.

The current Windows installer was retained in `dist/releases/`. The latest available
downloaded Linux DEB and AppImage were retained under `dist/releases/linux/`, from
the previous local `verified-40844780369` download. Those Linux packages were not
rebuilt during cleanup and do not represent the latest Windows-only visual rebuild.
`dist/releases/SHA256SUMS.txt` records the retained packages' checksums.
