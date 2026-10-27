# Recovery and database integrity

Xyst stores sessions, missions, settings, job history, and local model measurements in SQLite. A database integrity check is available before normal runtime startup:

```sh
xyst database check
```

The command opens the default database in read-only mode and runs SQLite `quick_check`. It does not apply migrations or write database pages. SQLite may create its normal WAL/shared-memory sidecar files while opening a WAL-mode database; keep any `xyst.sqlite-wal` and `xyst.sqlite-shm` files with the database when making a backup. It reports `healthy`, `corrupt`, `missing`, or `unavailable`; a non-healthy result returns a nonzero exit code. It works when regular CLI startup fails because the database cannot be opened.

`xyst status` and the desktop snapshot also check integrity before runtime startup. A corrupt database is reported as `runtime: unavailable` and `database: corrupt`, with a read-only check and restore-from-backup instruction. These diagnostics do not attempt repair or run migrations against a corrupt database.

The default database is `%APPDATA%\xyst\xyst.sqlite` on Windows. On Linux it is `$XDG_DATA_HOME/xyst/xyst.sqlite`, or `~/.local/share/xyst/xyst.sqlite` when `XDG_DATA_HOME` is unset.

## Preserve data before recovery

1. Stop the desktop app and all Xyst mission runners so no process is writing to the database.
2. Copy the entire Xyst data directory to a separate location before attempting recovery. Keep the original database and any `xyst.sqlite-wal` or `xyst.sqlite-shm` files together.
3. Restore only from a known-good backup, with all Xyst processes stopped. Run `xyst database check` on the restored copy before reopening Xyst.

`database check` diagnoses integrity; it does not repair a damaged database. Do not delete or replace the only copy of a database that fails the check. Session JSON exports preserve one session and its journal, but do not replace a full data-directory backup of settings, missions, jobs, and other state. Credentials are held separately in the operating-system credential store and are not included in SQLite backups.

## Optional manual salvage

If no known-good backup exists, SQLite provides a best-effort `.recover` command. Treat its output as an untrusted salvage copy: SQLite warns that rows can be missing, altered, resurrected from deleted pages, or assigned to the wrong table. Review recovered records before using them. Never run recovery against the only copy or write its output over the original profile.

With all Xyst processes stopped and a verified full-directory backup made, install the official SQLite command-line tools and work only on a copy of `xyst.sqlite`:

```powershell
sqlite3.exe .\xyst-copy.sqlite ".recover --ignore-freelist" > .\recovery.sql
sqlite3.exe .\xyst-salvaged.sqlite ".read .\recovery.sql"
sqlite3.exe .\xyst-salvaged.sqlite "PRAGMA quick_check;"
sqlite3.exe .\xyst-salvaged.sqlite "PRAGMA foreign_key_check;"
```

```sh
sqlite3 ./xyst-copy.sqlite '.recover --ignore-freelist' > ./recovery.sql
sqlite3 ./xyst-salvaged.sqlite '.read ./recovery.sql'
sqlite3 ./xyst-salvaged.sqlite 'PRAGMA quick_check;'
sqlite3 ./xyst-salvaged.sqlite 'PRAGMA foreign_key_check;'
```

`--ignore-freelist` avoids deliberately scanning pages SQLite considers reusable, which could reintroduce deleted records. A clean integrity result alone does not prove the recovered application data is complete. Compare table counts and inspect sessions, messages, jobs, missions, settings, and tool-call relationships. Keep the original, backup, and salvage candidate separately until the recovered contents are reviewed and Xyst starts against an isolated copy. Only then consider restoring the candidate, with another backup in hand.

The command syntax is documented by the [SQLite recovery guide](https://www.sqlite.org/recovery.html). Its recovery API describes `.recover` as best-effort salvage and details the possibility of missing, altered, or resurrected rows.


## Verification evidence

On the current Ubuntu x64 AppImage, an isolated malformed SQLite fixture made runtime startup fail with `SQLITE_NOTADB`. The desktop showed the runtime unavailable state, a concise recovery instruction, and expandable full error details. The packaged `database check` command returned `corrupt`; the fixture file hash stayed identical before and after both checks. The current Windows NSIS package’s bundled CLI also returned `corrupt` for an isolated malformed SQLite fixture and preserved its SHA-256. These checks verify cross-platform diagnosis and read-only behavior. They do not repair a damaged database; preserve the original files and restore only from a known-good backup.
