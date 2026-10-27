#!/usr/bin/env bash
set -euo pipefail

if (( EUID == 0 )); then
  printf '%s\n' 'Run pnpm check:linux as a non-root user so Bubblewrap tests exercise the supported unprivileged user boundary.' >&2
  exit 2
fi

keyring_data="$(mktemp -d "${TMPDIR:-/tmp}/xyst-keyring-ci.XXXXXX")"
trap 'rm -rf "$keyring_data"' EXIT
chmod 700 "$keyring_data"

export XDG_DATA_HOME="$keyring_data"
export XYST_REQUIRE_BWRAP_TEST=true
export XYST_REQUIRE_PIDFD_TEST=true
export XYST_REQUIRE_LINK_TESTS=true
export XYST_REQUIRE_SECRET_SERVICE_TEST=true

mkdir -p "$XDG_DATA_HOME"
printf '%s\n' 'xyst-ci-keyring-password' | gnome-keyring-daemon --unlock --components=secrets >/dev/null
node scripts/check.mjs
