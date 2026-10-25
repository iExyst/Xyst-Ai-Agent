# Recovery and database integrity

Xyst stores sessions, missions, settings, job history, and local model measurements in SQLite. A database integrity check is available before normal runtime startup:

```sh
xyst database check
```

The command opens the default database in read-only mode and runs SQLite `quick_check`. It does not apply migrations or change the file. It reports `healthy`, `corrupt`, `missing`, or `unavailable`; a non-healthy result returns a nonzero exit code. It works when regular CLI startup fails because the database cannot be opened.

The default database is `%APPDATA%\xyst\xyst.sqlite` on Windows. On Linux it is `$XDG_DATA_HOME/xyst/xyst.sqlite`, or `~/.local/share/xyst/xyst.sqlite` when `XDG_DATA_HOME` is unset.

## Preserve data before recovery

1. Stop the desktop app and all Xyst mission runners so no process is writing to the database.
2. Copy the entire Xyst data directory to a separate location before attempting recovery. Keep the original database and any `xyst.sqlite-wal` or `xyst.sqlite-shm` files together.
3. Restore only from a known-good backup, with all Xyst processes stopped. Run `xyst database check` on the restored copy before reopening Xyst.

`database check` diagnoses integrity; it does not repair a damaged database. Do not delete or replace the only copy of a database that fails the check. Session JSON exports preserve one session and its journal, but do not replace a full data-directory backup of settings, missions, jobs, and other state. Credentials are held separately in the operating-system credential store and are not included in SQLite backups.


## Verification evidence

On the current Ubuntu x64 AppImage, an isolated malformed SQLite fixture made runtime startup fail with `SQLITE_NOTADB`. The desktop showed the runtime unavailable state, a concise recovery instruction, and expandable full error details. The packaged `database check` command returned `corrupt`; the fixture file hash stayed identical before and after both checks. The current Windows NSIS package’s bundled CLI also returned `corrupt` for an isolated malformed SQLite fixture and preserved its SHA-256. These checks verify cross-platform diagnosis and read-only behavior. They do not repair a damaged database; preserve the original files and restore only from a known-good backup.
