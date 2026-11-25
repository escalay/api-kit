---
name: api-kit-review
description: Use when checking whether an API built on the Escalay api-kit is ready for agents, before a release or a first deploy, after a refactor or a kit update, when an agent stalled on it, or when checking its sign-ins, invites, feature switches, usage report, repository settings, Deploy to Cloudflare button or brand. Lists the commands and tests to run and what each failure means.
---

# Review an API for agent-readiness

Run every check. A check that was not run counts as failed.

## 1. The copied kit

`npx @escalay/kit doctor` (add `--dir <path>` when the kit is not in `src/kit`). It exits 0 when clean.

| Line starts with | Means | Fix |
|---|---|---|
| `no record` | parts were copied without `kit.json` (the shadcn CLI) | `npx @escalay/kit adopt` |
| `missing` | a recorded file is gone | `npx @escalay/kit update` |
| `edited` | the file differs from what the kit wrote; "and kit X changed it" when the kit moved on too | keep it on purpose, or `update --force` (then edit again) |
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
7. With `switches`: `GET /api/features` lists every catalog feature with `on` and `source`. Switch one off with
   `PATCH /api/features/{key}` (`?dryRun=true` first: it names what else stops); each route it adds then answers
   `403 feature_disabled` whose `detail` starts "This feature is disabled." and names `switchOn`, and its tools stay
   listed. A feature nothing can run without has no switch.
8. With `telemetry`: `GET /api/telemetry` shows `body`, exactly what is sent, with coarse values only (ranges,
   booleans: no names, ids or addresses). `DO_NOT_TRACK=1` or the owner's `PATCH { "enabled": false }` turns it off,
   and `why` says which. The README says the product reports and how to stop it.

## 4. Repository and deploy

Each exits 1 and names what to fix; run them in the app's folder.

| Command | Fails when |
|---|---|
| `npx @escalay/kit repo check` | the GitHub repository drifted from §20: merges, the Actions token, alerts, the rules and required checks for `main` (`repo apply` sets them) |
| `npx @escalay/kit button --check` | a stranger's Deploy to Cloudflare would fail: an id or account in `wrangler.jsonc`, a setting with no description under `cloudflare.bindings`, migrations the deploy skips |
| `npx @escalay/kit brand --check` | `brand/` changed since `src/brand.gen.ts` was rendered: `npx @escalay/kit brand` again |

`pnpm gate` (what CI and the pre-push hook run) passes on a clean checkout. A public repository keeps no account id
or real domain: on Workers it deploys with `pnpm run deploy:env`.

## 5. Who may sign in

With the `oauth` part, a test per row in the app's tests. The owner approves through `approveSignIn(app, query,
{ headers })` (`testing`): the kit's page, its ticket cookie, a same-origin POST. An app with an `approve` hook drives
its own page the same way with `approveSignIn(app, query, { form: { action, fields } })`: the one form posting to
`action`, its hidden inputs and `fields`, the cookie, `sec-fetch-site: same-origin`. Standard: §7 and §23.

| Row | Passes when |
|---|---|
| Owner approval | `approveSignIn` answers 302 with a `code`; with `decision: 'deny'`, `access_denied`; without the owner signed in there is no consent page to approve |
| Invite | the typed code joins; a return not listed in `knownReturns` (nor loopback) sees "This app returns to <host>"; the token is bound to the invite's space (`aud`), and the invite again, a wrong code or an expired invite gets none |
| Account line | every approval page says it connects the app signed in in this browser |
| Revoke | after `revokeGrant`, `revokeClient` or a removed member, the next call with the token answers 401, and `onRevoke` dropped the app's row |
| Another space | a space's token at another space answers 401; a root token is given only to the owner's own sign-ins |
| Leaks nothing | an unknown space and a space the caller may not see answer the same 404 with the same body; no 403 confirms it exists |

With the `sharing` part, also (its tests hold each; the app's tests run them against its own wiring):

| Row | Passes when |
|---|---|
| Typed codes | with no `limits` option given, codes past the limit answer 429 with `Retry-After`, and the fifth wrong code ends the sign-in (`access_denied`) |
| Known return | a custom scheme not in `knownReturns` is warned and needs the code; only an http loopback redirect is "on this computer" |
| Owner’s one click | at an unknown return the owner page starts at read for 30 days; the token's scopes and the member's lifetime are what the page named, never what the client asked |
| Withdrawn | a code exchanged twice at once makes one member; one the app's own `onGrant` refuses makes none and leaves the invite open |
| Shown once | `POST …/invites` again with the same Idempotency-Key answers 409 `shown_once`, and nothing the guard store keeps holds the code |
| Never through A2A | read the wiring: `sharingTools` are in the owner's MCP only, never passed to `mountA2A` |
| Agent invites | an agent's invite is for 7 or 30 days (`until_revoked`: 400) and names its maker; once that agent's grant ends its open invites stop working, and people who joined keep access |

## 6. The agent test

Give a fresh agent only the base URL, a key and one real task. Ask it for a log of every place it stalled or guessed.
Fix the API or the guide for each one, then run it again with a new agent. Done when the log is empty.

## Report

List each check with pass or fail, the failing output verbatim, and the fix. Do not call the API ready while any check
fails or was skipped.
