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
pnpm install
pnpm migrations
pnpm test
