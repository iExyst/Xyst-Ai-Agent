# ADR 0002: Versioned JSON session files

Status: Accepted for the first vertical slice.

## Context

The product needs resumable sessions, cross-surface portability, migration support, and inspectable local data. A database will be useful for larger indexes and concurrent clients, but is not required for the first single-user CLI.

## Decision

Store each session as a versioned JSON document under `.agent/sessions/<uuid>.json`. Save through a same-directory temporary file and replace with a recoverable Windows fallback. Keep project memory and goals in separate versioned JSON documents. Keep full pre-compaction transcripts in separate immutable archive files referenced by the session.

The current session schema is version 1. Readers and writers reject any other version before validating version-specific fields or replacing the record. There are no older released schemas to migrate yet. When a later schema is introduced, add explicit version-to-version migration functions and tests; only write a migrated record after the entire migration validates. Unknown newer data must remain untouched and available for a compatible build.

Versioned session export envelopes may include a redacted snapshot of project goals explicitly referenced by that session. Import restores those records additively, preserves goal IDs, skips identical records, and rejects conflicting IDs; project backups continue to carry one shared goal snapshot rather than duplicate it per session.

## Consequences

- Session files are inspectable, portable, and easy to back up.
- Same-session writers serialize through cross-process lock files and revision checks; clients receive a conflict instead of silently replacing a newer version.
- Compaction archival, export/import, and lock contention have regression coverage. A future SQLite backend must preserve those APIs, revisions, archive recovery, owner-only permissions, and portable exports before replacing this format.
