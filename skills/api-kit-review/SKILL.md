---
name: api-kit-review
description: Use when checking whether an API built on the Escalay api-kit is ready for agents, before a release, after a refactor, or when an agent stalled on it. Lists the commands and tests to run and what each failure means.
---

# Review an API for agent-readiness

Run every check. A check that was not run counts as failed.

## 1. The copied kit

`npx @escalay/kit doctor` (add `--dir <path>` when the kit is not in `src/kit`). It exits 0 when clean.

| Line starts with | Means | Fix |
|---|---|---|
| `no record` | parts were copied without `kit.json` (the shadcn CLI) | `npx @escalay/kit adopt` |
| `missing` | a recorded file is gone | `npx @escalay/kit update` |
| `edited` | the file differs from what the kit wrote | keep it on purpose, or `update --force` |
| `behind` | the kit changed a part since it was copied | `diff --patch`, then `update` |
| `cli` | a command is unnamed, duplicated, plural, undescribed or without an example (`cliGaps`) | name it: the `api-kit-cli` skill |

An `edited` line is fine when the edit is deliberate. Say which ones are, and why, in the review.

## 2. The app's tests

`pnpm test && pnpm typecheck`. The kit's checks live in `test/api.test.ts`; each returns a list of problems.

| Check | A non-empty result means |
|---|---|
| `lintOpenApi(doc)` | a route lacks an `operationId`, summary, description, parameter description or example, a named 2xx schema, or problem responses |
| `toolRoutes(TOOLS, doc)` | an MCP tool calls a route that does not exist |
| `toolsRun(TOOLS, app, samples, { headers })` | a tool has no sample arguments, or its route answered an error with them |
| `guideRoutes(files, doc)` | the guide names a route the API does not have |
| `guideGaps(files, vars, { doc, tools })` | a `{{placeholder}}` in the guide was left unfilled |
| `guide.gen.ts` equals `guideModuleSource(...)` | `guide/` changed after the last `pnpm guide` |
| `cliGaps({ tools, resources, jobs })` | a tool or resource has no `cli` name or example, a name is taken twice or shadows a built-in or job, a noun is plural, an argument has no description |
| `sdk/cli/commands.json` equals `cliSnapshot(...)` | a tool or job changed after the last `pnpm sdk:types` |

If a check is absent from the tests, add it (`src/kit/testing/README.md`) before reviewing further.

## 3. By hand, against a running app

`pnpm dev`, then with a key:

1. `GET /api/health` answers without a key. Any other `/api/…` route without a key answers 401 with `WWW-Authenticate` and a
   problem body.
2. `GET /llms.txt` reads as a start page: what the API is, auth, real calls with real ids. No hand-written endpoint
   or tool list.
3. `GET /openapi.json` is OpenAPI 3.1. An unknown query parameter on any route answers 400 and names the valid ones.
4. A list follows `_links.next` to the end. An unknown id answers 404 with a `detail` that says what to do next.
5. `POST /mcp` with `tools/list` returns every tool; each carries its route in `_meta["api-kit/route"]` (a tool without one needs `route` set) and its command in `_meta["api-kit/cli"]`.
6. With `<APP>_URL` and `<APP>_API_KEY` set, the app's CLI (`sdk/cli/bin.ts`): `doctor` prints no `fail` and no drift,
   a missing id exits 3 with one line on stderr, and a destructive command without `--yes` exits 1.

## 4. The agent test

Give a fresh agent only the base URL, a key and one real task. Ask it for a log of every place it stalled or guessed.
Fix the API or the guide for each one, then run it again with a new agent. Done when the log is empty.

## Report

List each check with pass or fail, the failing output verbatim, and the fix. Do not call the API ready while any check
fails or was skipped.
