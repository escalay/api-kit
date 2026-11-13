#!/usr/bin/env bash
# Starts an app from the published packages in a temp folder, installs it and runs its tests: release-smoke.sh <version>
set -euo pipefail

version="${1:?usage: release-smoke.sh <version>}"
parent="$(mktemp -d)"
trap 'rm -rf "$parent"' EXIT
cd "$parent"

# Ask the registry, not the local cache, which may not know the new version yet
export npm_config_prefer_online=true
npm create "escalay@$version" smoke-api -- --yes
cd smoke-api
# What the published package gives a new app, which the repository's own tests cannot see
[ -x .githooks/pre-push ] || { echo "::error::a new app's .githooks/pre-push is missing or not executable"; exit 1; }
for path in .github/workflows/ci.yml .github/dependabot.yml .gitleaks.toml .node-version; do
  [ -f "$path" ] || { echo "::error::a new app has no $path"; exit 1; }
done
if ! jq -re '.packageManager | test("^pnpm@[0-9]+\\.[0-9]+\\.[0-9]+$")' package.json >/dev/null; then
  echo "::error::a new app's package.json pins no pnpm (packageManager)"
  exit 1
fi
pnpm install
pnpm format
pnpm migrations
# Everything the app's CI and its pre-push hook run
pnpm gate
