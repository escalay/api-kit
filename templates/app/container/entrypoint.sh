#!/bin/sh
# The API gets only the env it reads, never the platform's whole .env
set -e
exec env -i PATH="$PATH" HOME="${HOME:-/root}" ${PORT:+PORT="$PORT"} ${STATE_DIR:+STATE_DIR="$STATE_DIR"} ${DATABASE_FILE:+DATABASE_FILE="$DATABASE_FILE"} \
  ${API_KEYS:+API_KEYS="$API_KEYS"} ${OAUTH_SIGNING_KEY:+OAUTH_SIGNING_KEY="$OAUTH_SIGNING_KEY"} ${ACCESS_TEAM:+ACCESS_TEAM="$ACCESS_TEAM"} \
  ${ACCESS_AUD:+ACCESS_AUD="$ACCESS_AUD"} ${PUBLIC_HOST:+PUBLIC_HOST="$PUBLIC_HOST"} \
  node_modules/.bin/tsx src/server.ts
