#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo "wt-dash supports macOS only." >&2
  exit 1
fi
if [ "$#" -gt 1 ]; then
  echo "Usage: sh scripts/install.sh [path/to/wt-dash]" >&2
  exit 1
fi
binary=${1:-dist/wt-dash}
destination=${WT_DASH_INSTALL_DIR:-"$HOME/.local/bin"}
if [ ! -f "$binary" ] || [ ! -x "$binary" ]; then
  echo "Executable not found: $binary. Build it with bun run build first." >&2
  exit 1
fi
mkdir -p "$destination"
install -m 755 "$binary" "$destination/wt-dash"
echo "Installed $destination/wt-dash"
echo "Make sure $destination is on PATH. Then run: wt-dash --doctor ~/projects"
