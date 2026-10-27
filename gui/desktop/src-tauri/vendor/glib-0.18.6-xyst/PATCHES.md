# Local GLib patch

This directory contains the crates.io `glib 0.18.5` source with the `VariantStrIter::impl_get` soundness fix applied. The fix changes the C out-parameter from a shared reference to `&mut p`, matching the pointer mutability required by `g_variant_get_child`.

The change is byte-identical to upstream gtk-rs commit `b5a4071` on the maintained line and is also present in the proposed backport commit `ea720152f28e293ef4362ee844ee5cc499f32d2a` ([PR 2009](https://github.com/gtk-rs/gtk-rs-core/pull/2009)). The backport PR is closed without merging and no upstream `glib 0.18.6` release is available, so Xyst carries this small patch locally for Linux GTK3 builds.

The manifest version `0.18.6` is a local compatibility version only; it is not a published crates.io release. Remove this vendor override and the specific RustSec audit exception once a published fixed version is available and verified.

The Linux CI runs GLib's release-mode `test_variant_iter_array` regression before packaging. The security audit ignores only `RUSTSEC-2024-0429` for this locally patched package and continues to deny all other unsound advisories.
