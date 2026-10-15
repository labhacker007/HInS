#!/usr/bin/env bash
# One-time per-developer setup: configures this clone to authenticate to
# GitHub with short-lived tokens only, and never persist credentials to disk
# or the macOS Keychain.
#
# Usage (from anywhere inside the clone):  scripts/dev-auth/setup.sh
set -euo pipefail

# Public identifier of the HInS GitHub App (not a secret; safe to commit).
CLIENT_ID="${HINS_GITHUB_APP_CLIENT_ID:-Iv23lia4FQn9RwxQKhIG}"

# 8h, matching the lifetime of GitHub App user tokens.
CACHE_TIMEOUT=28800

repo_root=$(git rev-parse --show-toplevel)
helper_src="$repo_root/scripts/dev-auth/git-credential-hins"
helper_dst="$HOME/.local/bin/git-credential-hins"

if [[ -z "$CLIENT_ID" ]]; then
  echo "error: set CLIENT_ID in $0 (or export HINS_GITHUB_APP_CLIENT_ID)." >&2
  exit 1
fi
command -v jq >/dev/null || { echo "error: jq is required." >&2; exit 1; }

# Install a pinned copy outside the repo so a later pull can't silently change
# the code that handles your credentials.
mkdir -p "$(dirname "$helper_dst")"
install -m 0755 "$helper_src" "$helper_dst"

cd "$repo_root"
git config --local hins.githubAppClientId "$CLIENT_ID"

# An empty value resets the helper list, dropping Apple git's system-level
# `osxkeychain` helper for this repo. Then: in-memory cache, then our helper.
git config --local --unset-all credential.helper 2>/dev/null || true
git config --local --add credential.helper ""
git config --local --add credential.helper "cache --timeout=$CACHE_TIMEOUT"
git config --local --add credential.helper "$helper_dst"

git remote set-url origin https://github.com/labhacker007/HInS.git

echo "Done. The first push/fetch will open GitHub to authorize this machine."
echo "To sign out early:  git credential-cache exit"
