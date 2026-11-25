# Upgrading

What changes for an app when it takes a newer kit, part by part, newest first. Each part's README says what the part
does now; this page says what changed between versions and what to do about it. The [changelog](https://github.com/escalay/api-kit/blob/main/CHANGELOG.md)
lists every release.

## Taking a new version

```bash
npx @escalay/kit upgrading --dir src/kit      # this page's notes for your parts since kit.json's version, up to the kit's
npx @escalay/kit doctor --dir src/kit         # missing, edited, behind: one line each with its fix
npx @escalay/kit diff --dir src/kit --patch   # your edits next to the kit's changes
npx @escalay/kit update --dir src/kit         # never overwrites your edits without --force
```

When `kit.json` records an older kit, `doctor` prints a `note` line naming `kit upgrading`, and `update` a line naming
`kit upgrading --from <that version>`; neither changes the exit code or `doctor`'s count to fix.

The app owns the copy, and nothing follows `main`: a version is taken on purpose. A file equal to the kit's counts as
unchanged, whatever `kit.json` recorded. `update` keeps a file you edited; when the kit also changed that file since
the version `kit.json` records, it exits 1 and leaves `kit.json` at that version, so `doctor` still names the file:
`update --force` takes the kit's, then make your edits again. An edit the team keeps is recorded with
`doctor --keep <file>` (`kept` in `kit.json`, the file's hash): `doctor` then notes it instead of failing, until the
file changes again, the kit changes it too, or `update --force` takes the kit's. `add` and `update` print `pnpm add`
only for what `package.json` lacks. Read the sections below for every part the app has, from
the version in `kit.json` up.

## core

### 1.32.0

- A new app names where a caller's address comes from: `createApp({ db, env, address })`, `'socket'` in `server.ts`
  and `{ header: 'cf-connecting-ip' }` in `worker.ts`, passed to `createAgentApi`. An older app that `kit doctor`
  notes for it sets `createAgentApi({ address })` the same way (core README, The caller's address).
- **`originOf(c)` takes a forwarded host only when it is a bare host[:port]**, and a forwarded proto only when `http`
  or `https`: any other value (`localhost/s/soups`, a query, a fragment, a user, an empty one) gives the request URL's
  own origin. Of a list, the first item is taken, as for the proto. New: `originOfRequest(request)`, the same for a raw
  `Request`, which the mcp part now uses for its server identity, so update core and mcp together. Nothing to change
  in the app unless it relied on a forwarded host with a path in it; an app behind a proxy or reachable by more than
  one host sets the oauth part's `publicOrigin`.

### 1.31.0

- `core/cli.ts` gains `CallAt` (a tool call's mount parameters, the mcp part's) and `PLACEHOLDER_AT`, which `routeOf`,
  `pathKeysOf` and the guide pass a call. Nothing to change in the app.

### 1.30.1

- **Security:** `idempotency` kept a whole successful answer for 24 hours and replayed it, so an answer that showed a
  secret once (a key made with `POST /api/keys`, setup's enrolment, a session cookie) sat in the guard store, in
  memory or the `kit_guards` table, and a retry with the same `Idempotency-Key` got it again. A route now marks such
  an answer with `showOnce(c, replay)`: the guard keeps only `replay`, and the retry is a 409 `shown_once` (a new
  problem code) saying what was made. The keys, setup and people parts call it.
- MCP and A2A never keep their own answer (`neverKeep`, wherever they are mounted) and pass the caller's
  `Idempotency-Key` on to the route a tool runs (`FORWARDED`), which keeps its own answer: a retried tool call runs
  once, and a key made by a tool is never answered twice. A relay of the app's own calls `neverKeep(c)` too.
- `StoredAnswer` is now `ReplayedAnswer | ShownOnceAnswer`, each with `version: 2`. An answer without a version was
  kept whole by 1.30.0 and is never replayed: its request runs again, so one an old instance writes during a rolling
  deploy, after the migration below, is never answered either (it still sits in `kit_guards` until it lapses, within
  the day). Any custom `GuardStore`: delete every answer it kept under 1.30.0 (one may hold a secret for a day), and
  if it copies known fields, keep `version` and `shownOnce` too.
- The answers kept under 1.30.0 are dropped for you: the database store's next start runs a new migration step that
  deletes them (the db part, below), and the memory store goes with the restart. The cost is one day of replay
  protection: a retry of a request made before the update runs again.
- Rolling back to 1.30.0 within a day: it cannot read a `shown_once` answer this version kept, and a retry with that
  key answers 500 until the row lapses (24 hours). Before rolling back, `delete from kit_guards where kind = 'key' and
  value <> ''`.

### 1.30.0

- `tellApp` (what the parts' hooks go through: a hook that throws is logged, never answered) lives in
  `core/hooks.ts`, a new file `update` adds.
- `memoryGuardStore` never evicts an idempotency lock a request still holds, caps its rate windows at `maxEntries`,
  and drops what lapsed at most once a minute. Nothing to change in the app.

### 1.29.0

- A star inside a pattern in `auth.open`, `guards.skip` and `auth.relay` now matches one whole path segment: `/a/*/b`
  matches `/a/x/b` and not `/a/x/y/b`, and `/a/**` matches `/a/x` and `/a/x/y`. Before, such a star was literal and
  matched nothing an app serves, so check those lists for an inner or doubled star before updating. Exact,
  leading-star and trailing-star patterns are unchanged in `open` and `skip`; `relay` compared paths exactly before,
  so a star anywhere in it was literal and now matches as in `open`.
- With OAuth on, the 401 challenge names `scope="read write"`, and a 403 `insufficient_scope` names
  `resource_metadata` (the oauth part, 1.29.0).

### 1.27.1

- `createAgentApi({ address })` names where a caller's address is read. Left out, it is `'headers'`, the read from
  before: `cf-connecting-ip`, else the whole `X-Forwarded-For`, as sent. Set it on Node (`'socket'`, or the header
  your proxy writes); `kit doctor` notes an app on `@hono/node-server` that names none.
- `idempotency` keeps only a success (below 400): a refusal or a server error frees the key, so a retry after the cause
  is fixed runs again. `guards: { keep: (status) => status < 500 }` keeps refusals too, as before. It never keeps
  `/oauth/*` or `/agent/identity*`, whose answers hold tokens.

### 1.27.0

- Rate limits and stored idempotency answers key an OAuth agent by `client` and `grant`, not by its name: same-named
  clients stop sharing a bucket.

## db

### 1.32.0

- A new app's `scripts/migrations.ts` removes the files of a feature taken out of the app (`--check` fails on them)
  and numbers a new file after the highest, so a file deleted by hand never makes two share a number. An older app
  can take the script from the kit's `templates/runtime-cloudflare/scripts/migrations.ts`.

### 1.30.1

- `GUARD_MIGRATIONS` has a second step that deletes every stored idempotency answer (`kit_guards` rows of kind `key`
  with a value; the locks of requests still running and the rate windows stay), because through 1.30.0 an answer
  that showed a key once was kept whole for a day. On Node,
  `dbGuardStore` runs it on the next start. On Workers, run `pnpm migrations` after `update`: it adds the step as a new
  file in `migrations/` (`pnpm check` and CI fail until it is there), and the deploy applies it.

## oauth

### 1.32.0

- **Fixed: a forwarded host with a path in it no longer widens a token.** Without `publicOrigin`, the root (`rootOf`)
  and every audience check followed `X-Forwarded-Host` as sent, so a client refreshing a token for `/s/soups/mcp`
  with `X-Forwarded-Host: localhost/s/soups` got one whose audience was the forged root plus `mcpPath`, which the
  default `accepts` took everywhere: a space's token became a root token. `originOf` (core) now takes only a bare
  host, so the root never has a path. Update core with it. An app reachable by more than one host or behind a proxy
  sets `publicOrigin`: a caller can still forward any bare host, which moves the root to that origin but never puts
  a path in it, so no token widens.
- New: `oauth.publicOrigin`, the origin the server is pinned to (canonical), or undefined when the app set none.
  Nothing to do.
- **A grant `onGrant` said yes to that gets no token is withdrawn, once.** A throw in `onGrant` (a hook chained
  after another) or in the token writes now ends the grant and tells `onRevoke` `withdrawn` before the 500; before,
  nothing was told and a row the app wrote in `onGrant` stayed. A grant ended while `onGrant` ran is also told
  `withdrawn` now, where 1.31.0 told the marker's reason (`replayed`, `revoked`, `client_revoked`) again. An app whose
  `onRevoke` treats `withdrawn` as "never became a member" (deletes the row) needs nothing else.
- When `onGrant` says no and the store then fails to write the grant's marker, `onRevoke` is still told `withdrawn`
  and the answer is 400 `invalid_grant`; 1.31.0 answered 500 and told nothing, so a row a hook chained inside
  `onGrant` wrote (its yes before the app's no) stayed.

### 1.31.0

New: `SignInAsk.named` (the client chose its `resource`, so `complete` binds no other for it) and `SignInAsk.expiresAt`
(the ticket's expiry, epoch seconds). What an app may see change:

- **Only an http redirect to a loopback host is "this computer".** A custom scheme (`sample-app:`, `evil-app://`, a
  scheme a browser registers to open any page) was read as an app on this computer; any app may claim one, so it is
  now named as where the client returns, as a host is: the kit's consent page says it sends you back to
  `sample-app:`, and `SignInAsk.onThisComputer` is false for it and for `https://localhost`. An
  app's own page that trusted `onThisComputer` for an app's scheme lists that exact callback itself. Which redirects
  a client may register does not change.
- **A grant ended while `onGrant` ran gets no token.** With `onGrant` set, the kit reads the grant's and the client's
  revoke markers again after it answers yes, in the code, device and claim branches. A grant ended meanwhile (a
  retried exchange of the same code, `revokeGrant`, `revokeClient`) answers `invalid_grant` ("This sign-in was
  revoked: start again.") where it used to get tokens that failed at once, and `onRevoke` hears it a second time,
  after the row `onGrant` wrote, so the app ends that row too. An app without `onGrant` sees no change. A grant's
  revoke marker now keeps its reason; one written by 1.30.0 reads as `revoked`.

New, off unless the app calls it: `oauth.holdTicket(c, ticket, seconds)`, so an app that decides later (an ask to
join) holds that one ticket for its wait while every other page keeps `ticketTtl`. Nothing changes for an app that
does not call it.

- **An app that set a long `ticketTtl` to decide later** keeps working, and moves to `holdTicket` when it likes: hold
  the ask's ticket from the route its page posts to, append the `cookie` it returns, and drop `ticketTtl` back to the
  default. A long `ticketTtl` makes every page live as long, and newer tickets still evict a waiting one; a held
  ticket is never evicted and sits outside `maxUnusedTickets`, so the app bounds how many it holds (oauth README,
  Deciding later: holding a ticket).
- **`OAuthStore` has an optional `hold`** (one conditional write: a live, unused row's expiry moved and `held: true`
  set); `dbOAuthStore` and `memoryOAuthStore` have it. A store of the app's own without it falls back to a read then
  a write, safe only one request at a time. Its `trim` should skip rows marked `held: true` and leave them out of the
  `keep` newest; one that does not evicts held tickets like any other.
- **`OAuthStore` has an optional `extend`** (one conditional write: `{ until }` kept under an id, never lowered, the
  longest returned), for the `held-nonce` row; `dbOAuthStore` and `memoryOAuthStore` have it. Without it, a read then
  a write: two holds sent at once from one browser may keep the shorter life.
- When a browser that already has the ticket cookie opens another sign-in, `/oauth/authorize` reads one more row
  (`held-nonce`, written only by `holdTicket`), so the renewed cookie never cuts a held ticket short.

### 1.30.0

New, off unless set: `ticketTtl` (default 600, as before), `complete`'s `resource`, `onRevoke`. Defaults that change
when an app takes this version:

- **Every row anyone may write without auth is capped** (before, only registrations and consent tickets): agent
  registrations and their claim tokens under `maxUnusedClients`, claim attempts and device codes under
  `maxUnusedTickets`. A client a live consent ticket holds is no longer evicted by the client cap. A store of the app's
  own with a `trim` gets a third argument, `heldBy`, which it may ignore (it then evicts a held client as before).
- **`OAUTH_MIGRATIONS` has a step 2**, an index on `expires_at`: `dbOAuthStore` applies it when made; a Workers app
  runs `pnpm migrations` (`scripts/migrations.ts`) to write its D1 file. It is `create index if not exists`, so a
  database `migrate()` already brought up takes the file cleanly.
- An app that passes `approve` without both `limits` and `publicOrigin` logs one warning at start; `kit doctor` notes
  it, and notes an app with the `people` part whose `owner` never asks `personOf`.
- The starter sets `reuseGraceSeconds: 30` (an app made before keeps its own `createOAuth` call; the kit's default stays
  0).
- A code or device grant `onGrant` withdraws now gets a revoke marker too, as a withdrawn claim did: nothing was
  issued for it, so nothing else changes.
- **A refresh leaves no used row behind** (before, each kept 30 days, about 720 a month for a client refreshing
  hourly): refresh tokens issued from now on name their grant and generation (`rt_<grant>.<generation>.<nonce>.<MAC>`),
  and a grant keeps one `refresh-family` row. Replays are found as before, 1.29.0 tokens included. An app's own test
  that reads a used refresh row by its hash finds none once the grace has passed.

Refresh tokens issued by 1.29.0, rollbacks, and a rollout with both versions:

- A token issued by 1.29.0 (`rt_` and 32 random characters, or 43 for one it rotated) carries no family. Its first
  refresh after the update marks it used and keeps its row 30 days, as before, and gives a token one generation past
  its family's newest (generation 1 for a family with no row). So after a rollback shorter than 30 days, when 1.29.0
  refreshed a token of a family this version had moved to generation 4, the family goes on at 5 and every earlier
  token still ends it. It and the used 1.29.0 tokens before it are still known by their rows; its row also keeps the
  generation its successor got, so a retry in the grace gets that same successor.
- A family's row lapses 30 days after this version last rotated it, and 1.29.0 never writes it. So when 1.29.0 alone
  rotates a sign-in for 30 days or more (a longer rollback), the family has no row when this version comes back, and
  its next refresh starts it again at generation 1: this version's tokens from before the rollback, at generation 1 or
  later, are then only unknown, no longer replays. That is the memory 1.29.0 had: it kept a used token's row 30 days,
  and one used longer ago was unknown to it too.
- A retry in the grace of a token 1.29.0 answered first (1.29.0 still serving during an update, or after a rollback)
  gets the successor 1.29.0 gave: 1.29.0 named it `rt_` and an HMAC of the token under a secret from the signing key,
  so this version names it the same way and finds its row. Once that successor is used, the retry is reuse and ends
  the grant, as any other. With `reuseGraceSeconds` set, a retry that lands across the update (the first refresh
  answered by 1.29.0, the retry by this version) gets that successor, which goes on working.
- The reverse does not hold: while 1.29.0 answers (an instance not yet updated, or a rollback), it knows nothing of
  this version's tokens. It keeps no family row and names successors its own way, so an earlier token of this
  version reads as unknown there, and a retry or replay inside the grace of a token this version answered gets new
  tokens from it (a retried one gets a successor no row backs, which then fails). Replay detection for those tokens
  resumes once this version answers them again. Finish an update quickly, and keep rollbacks short.

### 1.29.0: open sign-in

New, off unless set: `publicOrigin`, `limits`, `maxUnusedClients` and `maxUnusedTickets` (both default 10 000), and
the store's `trim`. Defaults that change when an app takes this version:

- **Without `publicOrigin`, the metadata and auth.md are `no-store`** (before, `public, max-age=300`): a forged
  `X-Forwarded-Host` could have put another origin's documents in a shared cache. A client fetches them once more per
  connection. Set `publicOrigin` to cache them again.
- **A registration left unused for a week lapses** (before, every registration lived a year): the client registers
  again, and a person who opens its sign-in link meets the "add it again" page. Its first sign-in gives it a year.
  Registrations from before keep their year.
- **Unused registrations are capped at 10 000**, and so are open consent tickets: past it the oldest goes.
- `dbOAuthStore` prunes expired rows while it runs, at most once a minute.

Nothing else changes until the app passes `publicOrigin` or `limits`.

### 1.29.0: approvals

New, off unless set: `approve`, `onGrant`, `ticketOf`, `answeredOf`, `complete`, and `brand` (the app's brand on the
kit's pages is on by itself once the app has one). Defaults that change when an app takes this version:

- **Breaking for tests:** a POST to `/oauth/authorize` needs the ticket cookie its page set, and is refused (403) when
  `Sec-Fetch-Site` is absent and `Origin` is not the issuer's; `/oauth/claim` and `/oauth/device` take the same origin
  rule (before, an absent header passed). Over https and on this machine's own address, browsers send
  `Sec-Fetch-Site`, so people notice nothing. Over plain http at another address they may not, and then only `Origin`
  decides: the kit's pages carry `<meta name="referrer" content="same-origin">` so it is the issuer's, and an app's own
  approval page needs the same tag (without it the browser sends `Origin: null`, refused). A test that posts an
  approval by hand breaks. Use `approveSignIn` from the `testing` part, and add `'sec-fetch-site': 'same-origin'` to
  hand-made claim and device POSTs.
- A ticket opened before the update has no nonce: it is refused once ("This approval expired") and lapses within 10
  minutes; the person starts again.
- A consent ticket posted again from the browser that answered it says "Already approved" (or "Already answered")
  instead of "This approval expired". Still 400, still no code.
- The page for an unknown or expired `client_id` says to remove the connection in the app and add it again. The
  consent page names the resource asked for and says "an app on this computer" for a loopback or app-scheme redirect;
  the device page says when the client has no page to send anyone back to.
- With `onGrant` set, a claimed agent's identity assertion (jwt-bearer) is refused until its claim token was collected
  and heard. An agent claimed before the app set `onGrant` keeps its refresh tokens; its assertion (a day at most) is
  refused, so it refreshes or registers again.

### 1.29.0: audiences

Defaults that change when an app takes this version:

- **New tokens carry `aud`.** Every grant made from now on is bound: the resource its client asked for (the origin or
  `/mcp`), else the root (the origin). The default `accepts` takes the root and `/mcp` everywhere on the origin, so
  tokens work where they did. Code that reads a token's claims sees `aud`, and the caller has `resource`.
- A token request naming a resource other than the authorization request's is `invalid_target` (before, ignored).
- More than one `resource` at `/oauth/authorize` is a 400 page (before, the first was kept); at
  `/oauth/device_authorization` and the token endpoint it is `invalid_target`, and so is a JSON `resource` that is not a
  string (before, ignored). A grant from before audiences still ignores it.
- `oauth.verify` may answer `{ refused }` (a valid token `accepts` turned away), which is truthy: code calling it
  directly checks for `'refused' in answer` before treating the answer as a caller. Only an app's own `accepts` or a
  token for another resource gives one; `createAgentApi` already handles it.
- With OAuth on, the 401 challenge names `scope="read write"`; a 403 `insufficient_scope` names `resource_metadata`.
  Without OAuth the challenge is unchanged.
- The 401 pointer uses `mcpPath` exactly: `/mcp` and `/mcp/…` point at `/.well-known/oauth-protected-resource/mcp`,
  `/mcpx` no longer does. `createAgentApi`'s default relay follows `mcpPath`, so an app with MCP mounted elsewhere
  that passes it stops needing `write` for every MCP POST.
- A star inside a pattern in `auth.open`, `guards.skip` and `auth.relay` now matches one whole path segment (core,
  1.29.0).

Codes, device approvals, refresh tokens and agent registrations from before audiences (claimed or not) never gain one,
whatever resource the client sends: their tokens stay aud-less, accepted everywhere. A code written by the previous
version kept the query's `resource` as it came; it is never signed.

### 1.27.0: grants

Defaults that change when an app takes this version:

- Rate limits, stored idempotency answers and A2A task ownership key an OAuth agent by `client` and `grant`, not by
  its name: same-named clients stop sharing a bucket or each other's tasks. A2A tasks stored under the old key (kept a
  day) are no longer found by their agent.
- MCP's `authInfo.clientId` is an OAuth agent's client_id (before, the name it registered). A tool that showed or
  stored the name reads `authInfo.extra.name`; the grant is `authInfo.extra.grant`.
- `verify` refuses a token whose grant was revoked at once (before, up to an hour), including after a refresh token is
  replayed. A claimed agent's identity assertion is refused once its grant is revoked: it registers again.
- A code sent twice with its verifier revokes its sign-in.
- `revokeClient` deletes the registration: a revoked client registers again. A code or a device approval collected
  after it gets `invalid_grant` (before, it was issued tokens `verify` refused), and so does a claim token (before,
  `expired_token`, or tokens when the revoke landed during the poll).
- A claim token collected after `revokeGrant` ended its grant gets `invalid_grant` (before, it was issued a refresh
  token in the revoked grant, which outlived the revoke marker).
- A second claim code typed for a registration already approved is refused with a 409 page (before, it replaced the
  registration's grant, so its jwt-bearer tokens and its claim and refresh tokens no longer shared one).
- `createOAuth` throws on a malformed signing key when called. On Node a bad key already stopped the process at start
  (an unhandled rejection); on Workers the app now fails to build instead of failing only its OAuth requests.

Tokens, codes, refresh rows and claims from before grants keep working.

## pagination

### 1.32.0

- A new app has the part, and `kit feature` writes a list paged by cursor with it (`limitQuery`, `cursorQuery`,
  `pageOf`); in an app without it, `kit feature` copies it into `src/kit` first. Features made before keep their
  `limit`-only lists until you page them.

## guide

### 1.32.0

- `kit doctor` fails (a `starter` line) while a product skill's description still holds the starter's "Replace this
  line with…": write when an agent should use the product, then `pnpm guide`.

### 1.30.0

- `{{origin}}` is the app's `publicOrigin` (the OAuth server's) when it has one; without it, the request's origin, as
  before.
- The OpenAPI document and the skills discovery files are kept for the 8 origins used last, and the skills files are
  rendered once per origin instead of on every request.

## mcp

### 1.31.0

- `mountMcp` takes a path with parameters (`/s/:space/mcp`): each tool's `call` and resource's `read` get them as a
  second argument, `at.params`, decoded (also in `authInfo.extra.params`). A tool with one argument works as before,
  and a mount without parameters passes `{ params: {} }`. A `call` or `read` that took a second parameter of its own
  now receives `at` there.
- `routeOf`, the guide and `cliGaps` run a call with each mount parameter as `{name}`; a tool that ignores the
  second argument reads the same route as before.
- A mount with parameters is left out of `mountedMcp`, the guide, the AI Catalog and the well-known Server Card, so
  they keep describing `/mcp`. Nothing to change in an app with one mount.

### 1.30.1

- `FORWARDED` adds `idempotency-key`: a tool's route gets the caller's key with the call's JSON-RPC id
  (`<key>:<id>`, so two calls in one batch never share it), and a retried `tools/call` runs the route once (through 1.30.0 a retry replayed the whole `/mcp` answer, a key made by a tool included). `mountMcp` never keeps
  its own answer, on any path. `pollRun`'s call made again once a run is done goes without the key, so it gets the
  result, not the 202 kept for it.

### 1.30.0

- `callWaiting` looks at a run right away. A tool still working past `waitMs` says which run to `GET` and where, and
  `_meta["api-kit/pending"]` gains `location` beside `run` (unchanged).

### 1.27.0

- `authInfo.clientId` is an OAuth agent's client_id (before, the name it registered): a tool that showed or stored the
  name reads `authInfo.extra.name`; the grant is `authInfo.extra.grant`.

## a2a

### 1.30.1

- `mountA2A` never keeps its own answer and passes the caller's `Idempotency-Key` to the route a skill runs, as MCP
  does: a retried `SendMessage` runs the route once.
- A task whose route answered `Shown-Once: true` (core's `showOnce`: a new key) is kept without its artifacts: the
  reply that finished the task (`SendMessage`, or the first `GetTask` of a slow one) shows the secret once, and later
  `GetTask` and `ListTasks` say it was shown once. Through 1.30.0 the task
  kept a made key for a day.

### 1.30.0

- `GetTask` on a working task polls the run its slow call started instead of calling the tool again, so a tool with
  side effects is not repeated; a done run answers from its `_links.result` when it names one. A task that ended
  stays ended.
- A task stored by 1.29.0 has no run kept: `GetTask` calls its tool again, as it did then.

### 1.27.0

- A task's owner is an OAuth agent's client and grant (`agent:<client_id>/<grant>`), not its name: two clients that
  call themselves the same are two owners. Tasks stored under the old key (kept a day) are no longer found by their
  agent.

## vectors

### 1.30.0

- `embedMissing` takes `<file>.lock` while it runs: a second run on the same ledger throws, naming the lock. A lock
  left on shared storage by another machine must be deleted by hand.
- A torn last ledger line is skipped by `readLedger` with one warning and dropped by the next `embedMissing`; a bad
  line anywhere else still throws, with its line number.

## vector-search

Nothing to do in any version recorded here.

## web

Nothing to do in any version recorded here.

## brand

The part arrived in 1.28.0. In an app made before it, `npx @escalay/kit add brand` also adds `src/brand.gen.ts` to the
ignore lists in `.oxfmtrc.json` and `.oxlintrc.json` and the allowlist in `.gitleaks.toml`, or prints the line to add
where it can't read one. An app with its own Dockerfile adds `COPY brand brand` beside `COPY src src`.

### 1.32.0

- `kit doctor` fails (a `starter` line) while `brand/brand.ts`'s description is still the starter's
  "<title>, an agent-ready API.": write what the product does, then `kit brand`.

## boards

### 1.32.0

- `itemOf` may return a promise: the routes await it, so a card looked up in the database answers a ref that is not
  there with a 404 on save and `item: null` on the board. A synchronous `itemOf` works as before.
- `kit/index.ts` re-exports boards, like `people` and `setup`: `import { registerBoards } from './kit/index.js'`.
  `update` rewrites `index.ts`; imports from `./kit/boards/index.js` keep working.

### 1.30.0

- Two PUTs of one item that arrive together add it once (201, then 200), never a 500.
- A note can be cleared: `null` clears it, left out (or blank) keeps it, text sets it.
- `boardTools({ refExample })` shows agents the app's own ref: the tools' `ref` argument says `<type>:<id>`.

## keys

### 1.30.1

- A made key is never kept by Idempotency-Key (core's `showOnce`): a create retried with the same key is a 409
  `shown_once` naming the key made and where it is, never the key again. The kit's client retries a lost answer
  with the same key, so it now gets that 409: revoke the key it names and make another. The answers 1.30.0 kept are
  dropped by a migration step (db).

### 1.30.0

- `onKeyChange` is guarded: a hook that throws is logged and never answered, so a key made is still shown (once) with
  its 201.

## people

### 1.32.0

- Nothing changes in the part. Its README now shows it as a feature of its own in an app made by `kit init`, what
  each route answers, and the whole sign-in as a test. A new app's `scripts/migrations.ts` writes the D1 files of
  every part copied in; in an older app, `kit add people` prints the import and the line its script lacks:
  `['people', PEOPLE_MIGRATIONS]` (and `['setup', SETUP_MIGRATIONS]`) to its sets, then `pnpm migrations`, or D1
  never gets the tables.
- A new app's list-route test in `test/workers/api.test.ts` leaves out `/api/session*` and `/api/setup*`, which answer
  by who signs in; an older app whose test fails on them after adding the part does the same.

### 1.30.1

- `startSession` marks its answer shown once (core's `showOnce`): Idempotency-Key never keeps the session cookie, and
  a verify retried with the same key is a 409 `shown_once`. The verify routes document the 409.

### 1.30.0

- A challenge or enrolment is taken in one statement: two verifies that race sign in once.
- Expired challenges and sessions are swept from the write paths, at most once a minute.
- A new `limits` option (off by default) limits the two anonymous options routes; an app whose sign-in page is open to
  anyone passes it.
- A migration step indexes sessions by person; `registerPeople` applies it when the app starts.

## setup

### 1.30.1

- The claim's enrolment is never kept by Idempotency-Key (core's `showOnce`): a claim or recovery retried with the same
  key is a 409 `shown_once` saying to rotate the code to get back in.

### 1.30.0

- Every attempt still counts at its address (5 an hour), but only wrong codes count toward the day's 20, so the right
  code always gets through (through 1.29.0 every attempt counted, and 20 junk posts locked the owner out of claiming).
  Past the day's 20, a wrong code is 429.

## telemetry

### 1.30.0

- The day's stamp is one conditional update: replicas running the schedule together send once.
  `telemetryRepo.markSent` returns a boolean, whether this call made the stamp.
- A `collect` that throws no longer fails `GET` and `PATCH /api/telemetry`.

## switches

### 1.32.0

- A new app's `src/features/switches/index.ts` lets an owner signed in by passkey (the people part) switch, beside
  the deployment's keys: `isOwner` is a key, or a person whose role is `owner`. An older app with the people part
  copies that line.
- `kit doctor` fails (a `starter` line) while a feature's description in `src/features/catalog.ts` is still
  "…: say here what switching it off stops.": write what switching it off stops.

### 1.30.0

- `onSwitch` is guarded: a hook that throws is logged and never answered, so the switch stays made.

## sharing

### 1.32.0

- A new part (an invite joins by its typed code; a page for its link and asking to join are not built): its tables (`SHARING_MIGRATIONS` step 1:
  `sharing_invites`, `sharing_members`), `sharingRepo`, the named states of its rows and its
  secrets; `createSharing` and `registerSharing` with the owner's routes under `/api/spaces/{space}` (the space's
  sharing and its invites: made with the code shown once beside the space's address and a message to send, listed, read one at a time, revoked) and
  `sharingTools`; and the oauth hooks, `sharing.oauth` (`approve`, `onGrant`, `onRevoke`, `accepts`, `resources`,
  `resourceOf`) to spread into `createOAuth`, with `handles`, `memberOf` and `bind` (`registerSharing` calls it).
  `spaces` takes `byId` beside `byName`, and the new option `spaceOfPath` names the space of an in-process `/api` call.
  It needs `createOAuth`'s `publicOrigin`: `registerSharing` throws without it. Nothing to do in an app that doesn't
  add it.
- Signing in with an invite's code: `approve` shows the code page (`signInStepOf` picks it), and `registerSharing`
  adds `POST /sharing/join`, which needs `SHARING_OPEN_PATHS` in `auth.open`. Typed codes are always limited
  (`limits`, by default counted in the app's database: `createSharing` makes the guard table there, and `limits:
  false` throws): 10 a minute per address, 10 per 10 minutes per address at a space, 600 per 10 minutes per space;
  set the app's `address`, else each post names its own.
  The new option `knownReturns` names the apps the app expects. Behind Cloudflare Access, let
  `sharingSignInPaths(sharing)` through.
- The owner's approval at a space: `approve` shows the signed-in owner their own page (Approve or Refuse; Allow
  changes and Until revoked start ticked at a known return, unticked elsewhere: read for 30 days), or "No space …
  here". A space's code page offers Continue as the owner (`POST /sharing/as-owner`, then `POST /sharing/owner`);
  the new option `signInPath` links "Sign in first". `signInStepOf` takes `found`. Members: `GET {path}/{space}/members`
  and `/members/{id}`, Remove (`DELETE`, its invites revoked too), `POST …/invite-again`, and the tools `list_members`,
  `remove_member`, `invite_again`. Call `sharing.sweep()` from the app's scheduled handler, and `sharing.forget(spaceId)` when it
  deletes a space.
- `kit doctor` notes an app with the part that never calls `sweep(`, and one on Workers that names no
  `address: { header: 'cf-connecting-ip' }`.

## testing

### 1.31.0

- `approveSignIn(app, query, { form: { action, fields } })` drives an app's own sign-in page (`approve`): it posts
  the one `<form method="post">` whose `action` is `form.action`, with its hidden inputs and `fields`, and throws
  when none or more than one matches. Without `form`, nothing changes.

### 1.29.0

- A hand-made approval POST to `/oauth/authorize` is refused without the ticket cookie and a same-origin header: use
  `approveSignIn` (oauth, 1.29.0: approvals).

## browser

Nothing to do in any version recorded here.
