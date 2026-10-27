# Release and compatibility policy

## Versioning

Xyst AI Assistant releases use Semantic Versioning. Before `1.0.0`, breaking changes increment the minor version; compatible fixes increment the patch version. After `1.0.0`, public API and configuration compatibility follows the normal major/minor/patch rules. Pre-release identifiers are used for release candidates and previews and sort below the corresponding final version.

The CLI, desktop host, VS Code extension, and source archive share one product version. Update `package.json`, `gui/desktop/src-tauri/Cargo.toml`, `gui/desktop/src-tauri/tauri.conf.json`, and `vscode/package.json` together for a release. Persisted data and extension package formats have independent `schema_version` values; changing the product version does not change a data schema by itself.

## Changelog

Keep an `Unreleased` section at the top of `CHANGELOG.md`. Group concise user-visible entries under `Added`, `Changed`, `Fixed`, `Security`, and `Removed` headings as needed. Before tagging, move those entries into a version heading with the release date, then create a new empty `Unreleased` section. Mention migrations and compatibility impact in the entry. Do not publish secret details before coordinated disclosure.

## Branches and tags

Use `main` for ongoing development and short-lived `release/<major>.<minor>` branches only when a release needs stabilization. Tag source releases as `v<version>` (for example, `v1.2.3`) and prereleases as `v<version>-rc.<number>`. Tags are immutable; corrections use a new version and tag. A release must be built from the tagged commit in Windows and Linux CI, with the source archive manifest and platform artifacts retained alongside checksums.

## Data and extension compatibility

Persisted session, memory, goal, registry, and package formats are versioned independently from the application. Readers must reject unknown newer schemas without mutating source data. A released schema change requires an explicit migration function, fixtures for every supported prior version, interruption/corruption tests, and a documented recovery path. Preserve the source until migration succeeds; do not silently discard fields. Until a migration is implemented and tested, a schema change that cannot read the prior version is a breaking product change.

Extension package signatures cover their manifest and exact payload hashes. Any change to the signed manifest contract requires a new schema version and compatible verification tests. A release must not activate downloaded packages automatically; activation remains a distinct user action.

## Release gate

Before publishing a tag, require the full JavaScript check suite, lint/format checks, routing and agent evaluations, VS Code package validation, source-archive reproducibility, Windows and Linux desktop builds, native Rust lint/tests, security/dependency/license scans, and review of documented open risks. Do not describe a platform as release-ready until its CI jobs pass; record environment-dependent skips by reason.
