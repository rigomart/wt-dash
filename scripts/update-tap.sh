#!/bin/sh
set -eu

if [ "$#" -ne 3 ]; then
  echo "Usage: sh scripts/update-tap.sh path/to/wt-dash.rb vX.Y.Z tap-repository-url" >&2
  exit 1
fi
formula=$1
version=${2#v}
tap=$3
if [ -z "${HOMEBREW_TAP_DEPLOY_KEY:-}" ]; then
  message="HOMEBREW_TAP_DEPLOY_KEY is not set, so the Homebrew tap was not updated. Add the deploy key as described in CONTRIBUTING.md under \"Homebrew tap deploy key\", then re-run this workflow."
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "::error::$message" >&2
  else
    echo "$message" >&2
  fi
  exit 1
fi
if [ ! -f "$formula" ]; then
  echo "Formula not found: $formula" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
(umask 077 && printf '%s\n' "$HOMEBREW_TAP_DEPLOY_KEY" > "$work/key")
# GitHub's SSH host keys, from https://api.github.com/meta.
cat > "$work/known_hosts" <<'EOF'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
EOF
export GIT_SSH_COMMAND="ssh -F /dev/null -i '$work/key' -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='$work/known_hosts'"

git clone --quiet "$tap" "$work/tap"
if [ -f "$work/tap/Formula/wt-dash.rb" ]; then
  current=$(sed -n 's/^ *version "\(.*\)"$/\1/p' "$work/tap/Formula/wt-dash.rb")
  newest=$(printf '%s\n%s\n' "$current" "$version" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)
  if [ "$current" != "$version" ] && [ "$newest" = "$current" ]; then
    echo "The tap already has wt-dash $current, newer than $version. Nothing to commit."
    exit 0
  fi
fi
mkdir -p "$work/tap/Formula"
cp "$formula" "$work/tap/Formula/wt-dash.rb"
git -C "$work/tap" add Formula/wt-dash.rb
if git -C "$work/tap" diff --cached --quiet; then
  echo "The tap already has wt-dash $version. Nothing to commit."
  exit 0
fi
git -C "$work/tap" \
  -c user.name="github-actions[bot]" \
  -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet -m "wt-dash $version"
git -C "$work/tap" push --quiet origin HEAD
echo "Committed wt-dash $version to $tap"
