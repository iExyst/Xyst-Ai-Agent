# Third-party license policy

The native desktop host resolves Rust dependencies from `gui/desktop/src-tauri/Cargo.lock`. CI generates an inventory from the full Cargo package graph with `cargo-license --json`, validates it against `licenses/rust-policy.json`, and uploads the exact inventory only after validation succeeds.

The policy currently permits Apache-2.0, MIT, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, BSL-1.0, CC0-1.0, CDLA-Permissive-2.0, MPL-2.0, Unicode-3.0, and Unlicense. For an SPDX `OR` expression, at least one approved option is sufficient. Every branch of an `AND` expression must be approved. `WITH` expressions require both the base license and exception to be listed. Missing metadata, unknown identifiers, unsupported syntax, and unapproved licenses fail CI instead of being silently accepted.

MPL-2.0 appears in Tauri's dependency graph through `tauri-utils` and `dom_query`. It is allowed by the graph gate, and the generated notice includes the full MPL text when it is in the selected graph. The project does not modify third-party MPL source files. This automated inclusion does not replace the required release legal review.

The desktop package notice is generated with pinned `cargo-about` 0.9.2 using the locked dependency graph and `licenses/third-party-notices.hbs`; the required generated file is included in both native installers. CI checks that the tracked notice matches the current graph. Run `cargo install --locked --features cli cargo-about --version 0.9.2`, then `pnpm licenses:desktop` to refresh it. To approve another license, review its obligations for source and binary distribution, update both the JSON allowlist and `licenses/about.toml`, add a test for its expression behavior, and record required attribution or source-availability steps here. `LLVM-exception` is the only currently allowed exception, and it does not approve a base license on its own.

The policy check is an automated gate, not a substitute for legal review. An approved identifier does not establish that all obligations are met. Native artifact inclusion now provides the license texts and crate source links; full review of license obligations and source availability remains a release gate.

The inventory consumer follows the JSON array format emitted by [cargo-license](https://github.com/onur/cargo-license) and Cargo's documented [SPDX expression syntax](https://doc.rust-lang.org/cargo/reference/manifest.html#the-license-and-license-file-fields).
