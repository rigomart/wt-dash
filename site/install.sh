#!/bin/sh
# Installs wt-dash from its GitHub releases. https://wt-dash.rigos.dev
#
#   curl -fsSL https://wt-dash.rigos.dev/install.sh | sh
#
# WT_DASH_VERSION      the release to install, such as 0.1.1 (default: the latest)
# WT_DASH_INSTALL_DIR  the folder to install into (default: ~/.local/bin)
# WT_DASH_RELEASES_URL where releases are downloaded from, for a mirror or a test
#                      (default: https://github.com/rigomart/wt-dash/releases)
#
# Everything runs from main on the last line, so a download cut off partway runs nothing.

set -eu

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || fail "the installer needs $1."; }

main() {
  releases=${WT_DASH_RELEASES_URL:-https://github.com/rigomart/wt-dash/releases}
  dest=${WT_DASH_INSTALL_DIR:-"$HOME/.local/bin"}

  need curl
  need tar
  if command -v sha256sum >/dev/null 2>&1; then
    sha256="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    sha256="shasum -a 256"
  else
    fail "the installer needs sha256sum or shasum to check the download."
  fi

  case $(uname -s) in
    Darwin) os=darwin ;;
    Linux)
      os=linux
      if ldd --version 2>&1 | grep -qi musl; then
        fail "wt-dash needs glibc, and this system uses musl (Alpine, for example)."
      fi
      ;;
    *) fail "wt-dash runs on macOS and Linux only." ;;
  esac
  case $(uname -m) in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "wt-dash has no build for $(uname -m) processors." ;;
  esac
  # A shell running under Rosetta reports x86_64 on an Apple Silicon Mac.
  if [ "$os" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
    arch=arm64
  fi

  if [ -n "${WT_DASH_VERSION:-}" ]; then
    tag=v${WT_DASH_VERSION#v}
  else
    latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$releases/latest") ||
      fail "could not reach $releases/latest."
    tag=${latest##*/}
    case $tag in
      v[0-9]*) ;;
      *) fail "could not find the latest release at $releases/latest." ;;
    esac
  fi

  archive="wt-dash-$tag-$os-$arch.tar.gz"
  url="$releases/download/$tag/$archive"
  tmp=$(mktemp -d)
  staged=""
  trap 'rm -rf "$tmp" "$staged"' EXIT

  say "Downloading wt-dash ${tag#v} for $os-$arch"
  curl -fsSL -o "$tmp/$archive" "$url" || fail "could not download $url"
  curl -fsSL -o "$tmp/$archive.sha256" "$url.sha256" || fail "could not download $url.sha256"
  (cd "$tmp" && $sha256 -c "$archive.sha256" >/dev/null 2>&1) ||
    fail "$archive does not match its published checksum, so nothing was installed."
  tar -xzf "$tmp/$archive" -C "$tmp" wt-dash || fail "could not extract wt-dash from $archive."

  mkdir -p "$dest"
  staged="$dest/.wt-dash.$$"
  install -m 755 "$tmp/wt-dash" "$staged"
  version=$("$staged" --version 2>&1) ||
    fail "wt-dash ${tag#v} does not run on this system, so nothing was installed: $version"
  mv -f "$staged" "$dest/wt-dash"
  say "Installed wt-dash $version to $dest/wt-dash"

  case ":$PATH:" in
    *":$dest:"*)
      found=$(command -v wt-dash || true)
      if [ "$found" != "$dest/wt-dash" ]; then
        warn "$found comes first on your PATH, so the wt-dash command runs that copy instead."
      fi
      ;;
    *)
      say ""
      say "$dest is not on your PATH. Add this line to your shell's startup file, such as ~/.zshrc or ~/.bashrc:"
      say "  export PATH=\"$dest:\$PATH\""
      ;;
  esac

  if ! command -v wt >/dev/null 2>&1; then
    say ""
    {
      warn "wt-dash needs Worktrunk 0.80.0 or newer, and its wt command is not on your PATH."
      say "Install it with: brew install worktrunk, or cargo install worktrunk,"
      say "or from https://github.com/max-sixty/worktrunk/releases"
    } >&2
  fi

  say ""
  say "Check the setup with: wt-dash --doctor"
}

main "$@"
