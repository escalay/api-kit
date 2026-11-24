# The agent-ready API standard

How an HTTP API on the kit is built, so an agent that has used one can use them all: it reads `/llms.txt`,
follows links, branches on error codes, and calls the same operations as MCP tools. The kit implements each rule as
parts an app copies in (`npx @escalay/kit add`, see the README); its `testing` part enforces them.

## 1. Stack and layout

- **Hono + `@hono/zod-openapi`** (zod 4): every route is `createRoute` + `app.openapi`, so validation, types and the
  OpenAPI document come from one definition. `createAgentApi()` wires the rest.
- **One service, one origin:** `/api/v1/*` (the API), `/mcp` (MCP), `/openapi.json`, `/docs` (Scalar), `/llms.txt`,
  `/llms-full.txt`, `/agents/*.md`, `/skills/*`, `/problems/{code}`, `/api/health`, the discovery documents (§14),
  then media and web pages.
- **In a repo:** `apps/api/` (`src/features/<name>/` one folder per feature: `schema.ts` tables and migration steps,
  `repo.ts` the only queries, `routes.ts` contracts, `handlers.ts` request → repo → HAL, `tools.ts` MCP tools,
  `index.ts`; `src/app.ts` only wires them; `src/kit/` the copied kit with its `kit.json`, `guide/` the agent guide,
  `test/`), shared logic in `packages/*`. `kit init` makes this layout and `feature` adds to it. The app owns its kit copy: edit it when it must differ, and
  `kit diff` shows those edits next to the kit's changes.
  Read-only data an API serves is built elsewhere (a store in object storage) and synced in; the API never parses raw sources.
- **Two runtimes, one app:** the same `createApp` runs on Node (`server.ts`, a container) and on Cloudflare Workers
  (`worker.ts`, `nodejs_compat`). Nothing runs at global scope that Workers refuse there (random values, I/O, timers),
  and no module imports a Node-only API at the top unless Workers provide it. The kit's tests run in both (`node` and
  `workers` projects); `test/workers/worker.ts` imports the whole kit at global scope so a regression fails to start.
- **The provider stays at the edge:** only `worker.ts` and `src/bindings/` name Cloudflare (`cloudflare:*`,
  `drizzle-orm/d1`, a provider's file such as `bindings/mail/cloudflare.ts`). A feature, `app.ts` and the browser app
  take what they need from the context `createApp` is given, or from a type in `src/bindings/`; another provider is one
  more file there. `pnpm lint` enforces it (the `no-restricted-imports` override every new app's `.oxlintrc.json` has).
- **What the API writes goes through Drizzle** (`db`): one `openDb(source)` per app (a `node:sqlite` file on Node; D1
  on Workers, `openDb(drizzle(env.DB))`; Turso by passing its Drizzle database), and only a feature's repo queries it, never a handler. Each feature
  brings its tables and its migration steps (`migrate(db, feature, steps)`, recorded in `kit_migrations`); a step
  never changes once shipped. Read-only catalogs (a built store, JSON in memory) stay behind their own store module.
- **OAuth is a part of its own** (`oauth`): `createAgentApi({ oauth: createOAuth({ store: await dbOAuthStore(db) }) })`.

## 2. Resources and URLs

- Plural nouns, ids from the source system, slugs for taxonomy: `/api/v1/recipes/{id}`, `/api/v1/categories/{slug}`.
  Actions that are not resources are verbs under a noun: `POST /api/v1/menus/check`.
- Fields are `camelCase`; dates are ISO 8601 (`2026-10-31`, `2026-10-31T12:00:00Z`); money is `{ usd }`.
- `/api/v1` is a promise: changes are additive. A breaking change is `/api/v2`, with `Deprecation` and `Sunset`
  headers on the old routes for at least a month.
- `GET /api` (the root) lists every collection with links and live counts: the one URL an agent needs to start.

## 3. Representations: HAL

- Media type `application/hal+json` for resources and pages; problems are `application/problem+json`.
- **`_links`** on every resource: absolute `href`s (built from the forwarded proto and host), `self` always, plus
  every neighbour worth visiting (`cook`, `recipes`, `similar`, `web` for the human page). Agents follow links; they
  never build URLs from ids.
- **`_embedded`** holds related resources inlined on request (`?include=steps,cook`), each once.
- Lists and search results carry **summaries** (id, name, a few key fields, `_links.self`); `GET` the link for the
  full resource. `?fields=a,b` trims a resource; heavy parts (full text, steps) are opt-in.
- A score is a number with its meaning documented (cosine, rank-only); a model label is `{ value, confidence }` or
  `"unsure"` below its measured threshold, never a bare guess.
- **Text written by strangers is named.** A resource that carries text someone outside wrote (a mail, an upload, a
  scraped page, a form entry) lists those fields' paths in one array (`senderWritten: ["subject", "text",
  "links[].url"]`), on every answer and webhook body that holds them, and the field and tool descriptions say it is
  untrusted. Anything read out of that text (a code, a link) is listed too. Agents treat the listed fields as data,
  never as instructions.

## 4. Lists

- Cursor paging: `?limit=` (documented max) and `?cursor=` copied from `_links.next`; items under
  `_embedded.<plural>`, `count` on the page, `total` only when cheap. Keep reading until `_links.next` is absent.
- Small in-memory lists may page by `page`/`perPage` with `first`/`prev`/`next`/`last` links; the item shape is the
  same.
- Filters are plain query parameters; repeating one means OR (`?course=starter&course=main`). An unknown value is a
  `400`, never silently ignored. So is an unknown parameter: `createAgentApi` answers a `400` naming the parameters the
  operation does take (read from its query schema), so `?sinse=` can't pass for a filter. Sorting is `sortBy=` one of
  the documented fields and `order=asc|desc` (`sortQuery`).
- **An empty answer says why when it can.** A filter or a wait that finds nothing, while something it left out did
  arrive, names it (`found: false, skippedFrom: "no-reply@mailer.example"`), so an agent fixes its filter instead of
  waiting again. Measured: without it, a guessed sender domain made an agent wait forever.

## 5. Errors: RFC 9457 problem details

Every error is `application/problem+json`: `type` (a URI ending in the code, served at `/problems/{code}`), `code`
(branch on this), `title`, `status`, `detail` (what happened and what to do next), `instance` (the request id), and
for `bad_request` an `errors` list of `{ in, path, message }`.

| Code | Status | Meaning |
|---|---|---|
| `bad_request` | 400 | A parameter or the body is invalid; `errors` lists each one. |
| `unauthorized` | 401 | No valid API key; `WWW-Authenticate: Bearer realm="…"`. |
| `forbidden` | 403 | A valid key that may not do this. |
| `not_found` | 404 | No such route or id in this snapshot. |
| `conflict` | 409 | Clashes with the current state. |
| `payload_too_large` | 413 | Over the documented size. |
| `too_many_requests` | 429 | Wait `Retry-After` seconds. |
| `spend_cap` | 429 | A paid operation's budget is spent; free ones still work. |
| `upstream` | 503 | A model or storage call failed; `Retry-After` (30 s by default). Never 502: Cloudflare replaces a 502's body with its own page. |
| `unavailable` | 503 | Data loading or being replaced; `Retry-After`. A thrown 503 the app didn't name becomes this, never `upstream`. |
| `internal` | 500 | Our bug; quote `instance`. |

## 6. OpenAPI 3.1

`/openapi.json` (`doc31`) and Scalar at `/docs`. The document is the contract, so it must stand on its own:

- Every operation: a unique camelCase `operationId` (`listRecipes`, `searchRecipes`), a `summary` ≤ 80 characters, a
  `description` that says when to use it and what comes back, one or more declared `tags`, a description on every
  parameter (with an `example`), a named, described 2xx schema, and its 4xx/5xx as problem+json
  (`...problemResponses(400, 404)`).
- Every named schema (`.openapi('Recipe', { description })`) is described; fields carry `description` and `example`.
- `info.description` says what the API is and where to start; `externalDocs` points at `/llms.txt`; `x-tagGroups`
  orders the sidebar; `security` is global with `security: []` on open routes.
- `lintOpenApi(doc)` in the app's tests must return `[]`.

## 7. Auth

- **Agents and scripts:** an API key per client, `Authorization: Bearer <prefix>_<random>`. The service holds only
  hashes (`API_KEYS=laptop:<sha256>,ci:<sha256>`); the keys live in **your secret store, scoped to the app**,
  one secret per client (`API_KEY_LAPTOP`, …). Revoke = remove its line and redeploy.
- **Keys an app makes itself (optional, `keys` module):** for a tool whose users hand out keys without a deploy,
  `registerKeys` adds `/api/keys` (make, list, revoke; the key shown once, only its hash kept) and `/api/me` (who is
  calling). `API_KEYS` keeps working beside them. Only a key from `API_KEYS` or a signed-in person may make or revoke
  keys: a key made through the API cannot make another, so a leaked one can't make itself a spare.
- **People:** Cloudflare Access SSO in front of the web pages; the app also verifies `Cf-Access-Jwt-Assertion` against
  the team's keys, so nothing reaches data without either a key or a verified person.
- **A browser app on the same host:** on the bypassed paths Access sends no header, but the browser still sends Access's
  `CF_Authorization` cookie (the same signed token), and the app accepts it. Writes made with the cookie must come from
  the same site (`Sec-Fetch-Site: same-origin`, else a matching `Origin`), so other sites can't post through a login.
  The host must not bypass Access for people (no IP bypass), or they arrive without a token.
- **The owner and the team (optional, `people` and `setup` parts):** for an app someone deploys for themselves. The
  first person to send the deploy's `SETUP_CODE` secret to `POST /api/setup/claim` becomes the **owner** and makes a
  **passkey** (WebAuthn, `@simplewebauthn/server`); signing in with it sets an HttpOnly cookie (`__Host-session` on
  https, SameSite=Lax, 30 days) whose token is stored only as a SHA-256. `auth.session` checks it after keys and agent
  tokens and before Access; a write made with it must come from the same site, as with Access's cookie. Claiming
  **fails closed** (no secret set: 503) and is limited (5 an hour per address, read as §9 says; 20 wrong codes a day in all, so the right code is never locked out); a claimed deployment
  answers the same code with 409, and a **rotated** code opens recovery for an existing owner, once. **Members** come
  through Access: with `access.roleOf: roleOf(db)` an email that is neither listed nor of a listed domain gets 403
  (without `roleOf`, Access works as before). Roles: `owner` does everything; `member` everything but admin (the team,
  keys, setup, and what the app marks admin). A person with no role (an app without `people`) keeps today's rights.
  Admin checks use `isAdmin(caller, fixedKeys)`: the owner or a key from `API_KEYS`. The last owner cannot be demoted
  or removed, and an owner cannot remove their last passkey (409). Passkeys work only on the host they were made on.
  A new passkey is named after the device and browser it was made in unless the person names it, and no two of a
  person's passkeys share a name. A challenge is taken in one statement (two verifies of it sign in once), and expired
  challenges and sessions are swept from the writes that add them, at most once a minute. The options routes store a
  challenge for anyone who asks: an app whose sign-in is open to anyone passes `registerPeople({ limits })` (30 a
  minute per caller, an anonymous one by address).
- **Who changed access is on the record:** `registerPeople` takes `onTeamChange` (each person or domain added, its
  role changed, or removed: `who`, the role `from` and `to`, `by`, and for a person added `notify`, false when the
  caller asked that they not be told), `onPasskeyChange` (each passkey added or removed: whose, its id and name, `by`,
  and for one added `via`: `session`, `claim` or `recovery`), `registerSetup` takes `onRecovery` (an owner's recovery
  `started` with a rotated code and `completed` with the passkey it made) and `registerKeys` takes `onKeyChange` (each key
  made or deleted: its id, name and `by`, never its value). An app logs them where it logs the rest, so an owner can
  see who was let in, and alerts the person whose way in changed. Every hook is told after its change is made, and a
  hook that throws is logged, never answered (`tellApp`): the change stands and the request succeeds.
- **Open without auth:** `/api/health`, `/openapi.json`, `/docs`, `/llms*.txt`, `/agents/*`, `/skills/*`,
  `/problems/*` (no data), and with a brand (§22) its files: `/favicon.ico`, `/icon.svg`, `/icon-192.png`,
  `/icon-512.png`, `/apple-touch-icon.png`, `/og.png`, `/site.webmanifest`, and `/icon-dark.svg`,
  `/icon-dark-192.png`, `/icon-dark-512.png` with a dark icon. In Access, these paths and `/api/*`, `/mcp` bypass SSO;
  the app's key check guards them.
- A 401 carries `WWW-Authenticate: Bearer realm="<app>"` (plus `error="invalid_token"` for a wrong key; with OAuth on,
  `resource_metadata` and `scope="read write"`). Keys never go in URLs or logs.
- **Agents that get their own token (optional, `oauth.ts`):** the app is its own OAuth server. MCP clients follow the
  401's `resource_metadata` to `/.well-known/oauth-protected-resource[/mcp]`, register (RFC 7591, public clients), and
  send the owner to `/oauth/authorize` (code + PKCE S256); other agents follow `/auth.md` (anonymous or by email),
  and the owner types the agent's 6-digit code at `/oauth/claim` (once per registration: a second code is refused); a CLI or device without a browser uses the device
  authorization grant (RFC 8628: `POST /oauth/device_authorization`, a `XXXX-XXXX` code with no vowels for the owner
  to type at `/oauth/device`, 10 minutes, single use, hashes only, 5 wrong codes per person per 10 minutes, then it
  polls the token endpoint and hears `authorization_pending`, `slow_down`, `expired_token` or `access_denied`). The
  approval pages sit behind Access and check the
  signed-in person again; **nothing is granted before a person approves** (an unclaimed registration has no scopes).
  Tokens: ES256 JWTs for an hour (`OAUTH_SIGNING_KEY`, a private JWK in your secret store), checked against a revocation list
  on every request. Refresh tokens (30 days, MCP clients and claimed agents alike) rotate on each use and are kept only as
  hashes, a row for the newest token of each sign-in only (an earlier one is known by its MAC and its family's
  generation); a used one sent again revokes every refresh token of that sign-in, and so does revoking any of them. **An
  OAuth caller is known by its client_id and its grant (one approval, every token of one sign-in), never by the name it
  registered; the name is for display.** Rate limits, idempotency, MCP and A2A task ownership key on them, and revoking a grant ends its
  access tokens at once (`revokeGrant`), and a claimed agent's identity assertion with them; `revokeClient` also drops the registration and refuses a code, device approval or claim token not yet collected, and a claim token collected after its grant was revoked is refused too (the revoke markers outlive anything issued behind them, so nothing may be issued into a revoked grant or client). A code, a refresh token, a device code and a claim token are
  used once under concurrent requests, and so is each approval (a consent ticket, a typed claim or device code: a
  double-clicked Approve approves once): a second valid exchange of a code, or a refresh token sent again (outside an
  optional `reuseGraceSeconds`, default 0), revokes the grant. OAuth rows live in SQLite or D1, never KV. Scopes: `read` for safe methods, `write` for the rest; the relay endpoints (`/mcp` or the OAuth
  server's `mcpPath`, `/a2a`, `auth.relay`) need only `read`, since each call they make reaches a route that checks its own scope (`auth.relay` takes the same path patterns as the open list, a star inside one whole segment: `/s/*/mcp`). In Access,
  `/oauth/claim` and `/oauth/device` stay gated, and `/oauth/authorize` unless the app passes `approve`;
  `/oauth/register|token|revoke|device_authorization`, `/agent/identity*`, `/auth.md` and `/.well-known/*` bypass it.
- **Who approves a sign-in (`approve`, `onGrant`):** by default the owner, on the kit's page behind the sign-in. With
  an `approve` hook, `/oauth/authorize` may bypass Access: the app's page decides (an invite, an ask to join), and the
  grant follows only a same-origin POST from the browser that opened it (`complete`), once; nothing is granted without
  a click, and a stored approval never stands in for one. Each ticket is bound to its browser by an HttpOnly,
  SameSite=Lax nonce cookie (`__Host-oauth_ticket` on https, living as long as the ticket: `ticketTtl`, 10 minutes by default, so an app that decides later, an ask to join, keeps it waiting up to a week; renewed and reused by a second sign-in), and
  answered once: posted again from that browser it is a page saying it went through, from another "expired". With
  `approve` set, `/oauth/authorize` never redirects before a person acts: every error is a page. Every approval POST
  (`complete`, the kit's consent, claim and device pages) needs `Sec-Fetch-Site: same-origin`, or with none an
  `Origin` equal to the issuer's (never `null`, so every page whose form posts there, the kit's and the app's, sets
  `<meta name="referrer" content="same-origin">` over the `no-referrer` header); `same-site` is refused, since a
  sibling host is same-site. The approval only narrows scopes, and sets the resource only where the client named none (an invite binds its space; checked as a client's resource would be, the client's own never changed). `onGrant` hears
  the first token of every grant (code, device, claim) after the kit's checks, once, and false withdraws it
  (`invalid_grant`); an app that keeps its own client rows makes them in `onGrant`, drops them in `onRevoke`,
  which hears every grant the kit ends (revoked, replayed, withdrawn, its client revoked; a throw there never fails the
  revoke), and refuses a token whose grant has none. A grant that lapses (its refresh token unused for 30 days) is not
  told, since nothing ends it: the app ages its own rows (a last-seen time written in `accepts`, a row with none for 30
  days dropped with `revokeGrant`). The kit's own pages carry the app's brand (§22) and name the client by text only, never a `logo_uri`; the
  consent page names the resource asked for and whether the client returns to a host or an app on this computer.
- **Audiences (RFC 8707, RFC 9728, MCP 2026-07-28):** every grant is bound to one resource, signed as the token's
  `aud`. It is the resource the client sent at the authorization request (or device authorization) when the server
  issues for it, else the **root** (the issuer's origin): a client that sends none, or (without `resources`) one the
  app does not describe, gets the root. A resource is compared in one canonical form: an absolute http(s) URL, scheme
  and host lower-cased, the default port and one trailing slash dropped; a user part, a query, a fragment, a dot
  segment or an encoded dot makes it no resource. The audience is fixed at the authorization request: a token request
  naming another is `invalid_target` (before anything is written), refresh keeps it, and an audience the server chose
  is never held against a resource the client sends later. More than one resource is refused everywhere: a page at
  authorize, `invalid_target` at the device authorization and token endpoints, except by a grant from before
  audiences, which ignores `resource` altogether. The server checks a resource's
  origin itself; an app serving several MCP resources passes `resources` (a pure check of the path, never a lookup)
  and `resourceOf`, and then an unknown resource or another origin is `invalid_target` and metadata is never
  served for a resource that cannot be granted (404). The default `accepts` takes a token whose audience is exactly
  `resourceOf(c)`, so each resource's token works at its own address; an in-process `/api` call with a path-scoped
  token has lost that path and needs the app's own `accepts`. A token that does not fit a request is a 401 `invalid_token` whose
  `resource_metadata` points at the requested resource's document (`/.well-known/oauth-protected-resource<path>`).
  Three exceptions to "reject a token whose audience is not this resource", each with its reason:
  - **A token with no `aud` is accepted** (the default `accepts`): every token, code, device approval, refresh token
    and agent registration from before audiences has none, and none ever gains one, so connections made before keep
    working.
  - **A root token is accepted at a path-scoped resource:** the default `accepts` takes it everywhere on the origin,
    so a client that sent no resource, or a connection made before the app had path-scoped resources, keeps working
    there. The app, one process with one issuer and a row per grant, is then the one that verifies it is the
    intended recipient. An app that wants a resource to take only its own tokens refuses the root in its own
    `accepts`.
  - **A token whose `aud` is the origin plus `mcpPath` is accepted everywhere on the origin** (the default
    `accepts`): MCP tools call `/api` in-process with the same bearer, so the token for the single MCP must fit the
    whole origin, path-scoped resources included. An app that wants otherwise refuses it in its own `accepts`, as for
    the root.
- **Open endpoints (`publicOrigin`, `limits`):** an app whose sign-in is reachable outside Access passes
  `publicOrigin` and `limits`. `publicOrigin` is the only origin the issuer, `iss`, every metadata document, auth.md,
  the 401's pointer, the resource's origin check, the root audience and the same-origin rule use, and the origin every
  publicly cached discovery document names (api-catalog, robots.txt, sitemap.xml, poppy.json, the Server Card, the
  Agent Card, the skills index and archives, the AI Catalog), so a forged `X-Forwarded-Host` changes none of them and
  reaches no shared cache; without it the metadata and auth.md are `no-store`, never cached publicly, while the other
  discovery documents keep the request's origin and an hour's public caching, as before. What is never cached publicly
  (HAL links, OpenAPI, the guide) keeps the request's origin either way.
  A registration no sign-in has used lives a week (its first code exchanged or device token collected gives it a
  year), and every kind of row written without auth is capped (registrations, client or agent, and claim tokens; open
  consent tickets, claim attempts and device codes; 10 000 of each by default; past it the oldest unused goes, never a
  client a live consent ticket waits on), so rows written without auth stay bounded; the database store prunes
  expired rows on a write, at most once a minute, through an index on their expiry. `limits` counts per address, read as §9 says: a named source counts IPv6 by its /64, while the default
  `'headers'` read takes the address as sent, so a Workers app passes `address: { header: 'cf-connecting-ip' }`.
  Registration, `/agent/identity` and `/agent/identity/claim` (each call writes a claim attempt) 20 an hour
  together, device authorization 20 an hour, the sign-in page 60 a minute, token-endpoint misses 30 a minute,
  counted after the lookup so a right code is never refused; the owner is never counted; past a limit, 429 with
  `Retry-After`. The limits live in the kit because `oauth.mount` runs inside `createAgentApi`, before any app
  middleware.

## 8. Caching

- Data is a snapshot: a GET's ETag is `W/"hash(version, process start, URL, Accept)"`; `If-None-Match` → `304`. The start is in it so a deploy that changes an answer never confirms the old one. On Workers, pass the deploy's version id as `boot` (`snapshotEtag(v, { boot: env.CF_VERSION_METADATA.id })`) so every isolate of one deploy agrees. Writable routes
  (boards) opt out.
- `Cache-Control`: API `private, no-cache`; media `private, max-age=86400, immutable`; guides and OpenAPI
  `private, max-age=300`; any error `no-store`. **Anything behind auth is `private`, never `public`**: a CDN in front
  (Cloudflare caches `.png`, `.jpg`, `.svg` by extension) would otherwise serve it to anyone. Only discovery files and the
  front door's own page assets are `public`, and the OAuth metadata and auth.md only with `publicOrigin` (§7); with it,
  every public discovery file names that origin, never a forwarded host.

## 9. Cost and slow work

- A response that spent money says so: `meta.cost: { usd, cached }`. Paid results are cached by input hash, so the
  same request twice costs once.
- Slow or paid work answers `202 Accepted` with `Location: /api/v1/runs/{id}`; `GET` it until `status` is `done`
  (follow `_links.result`) or `failed`.
- The guards below keep their state where every instance of the app sees it: memory is right for one Node process;
  on Workers (an isolate each) they use the database (`dbGuardStore(db)`), never KV, which is eventually consistent.
- Every `POST` and `PATCH` honours `Idempotency-Key` (kept 24 h per caller; an OAuth agent is its client and grant): a retry gets the first answer
  (`Idempotent-Replayed: true`), the key with another body is a `422`, one in flight a `409`. `/openapi.json` documents
  the header on each of them. Only a success is kept: a refusal (`401`, `403`, `404`, `408`, `409`, `422`, `429`, any
  `4xx`) or a server error changed nothing, so a retry with the same key runs again. The token endpoints (`/oauth/*`,
  `/agent/identity*`) are never kept; an app lists its own open routes that answer a secret in `skip`, so they never are.
- Paid routes sit behind `rateLimit` per caller, with the `RateLimit-Policy` / `RateLimit` headers and a `429` with
  `Retry-After` past the limit, so a looping agent can't drain the budget. `rateLimit({ key })` counts per anything
  else instead (a pack, a grant); a `null` key leaves the call uncounted.
- **A caller without credentials is counted by its address, read from one source the app names**
  (`createAgentApi({ address })`, §12), never from whichever header a caller sent: a header a proxy writes,
  `hops` values from the right (default 1, the nearest proxy's), or the connection (`'socket'`, on Node; `local`
  where there is none). A missing source is `local`, never another header. A port is dropped, a global IPv6 address
  counts by its /64, and an IPv6 address that carries an IPv4 one (mapped, NAT64) counts as that IPv4 address. The
  default, `'headers'`, is the earlier read (`cf-connecting-ip`, else the whole `X-Forwarded-For`, as sent): an app on
  Node names its source, and `kit doctor` notes one that doesn't.
- Every model key is the app's own capped OpenRouter key, never a shared one; the
  cap answers `429 spend_cap`.

## 10. The agent guide

Templates in `apps/api/guide/`, served live with `{{origin}}`, `{{snapshot}}`, `{{counts.*}}` filled. `{{origin}}` is
the app's `publicOrigin` when it has one, so a forwarded host never changes what the guide names; what is kept per
origin (the spec, the skills discovery renders) is bounded. On Workers the
folder is shipped as a module (`kit guide` → `src/guide.gen.ts`, served with `serveGuide({ files })`), and
a test fails when the module is older than the folder. **Anything the
code already knows is generated, never written by hand**, so the guide cannot drift from the API:

| Placeholder | Generated from |
|---|---|
| `{{api.endpoints}}`, `{{api.tag.<slug>}}` | `/openapi.json`: per tag, every operation as a working example call, what it is for, its query parameters (`*` required, enums, defaults), its body type and the schema it returns with its top-level fields |
| `{{api.unblock}}` | the kit: how to look a call or a field up in the spec, read an error, restart from `/api`, handle a `202` |
| `{{cli.commands}}` | the CLI's commands (§19), jobs first: name with positional arguments, summary, the tool behind it |
| `{{mcp.tools}}`, `{{mcp.count}}`, `{{mcp.resources}}` | the MCP tools (name, the route its call reaches, description) and resources (URI template, what it gives) |
| `{{skills.<name>.playbooks}}` | the skill folder: each playbook's title and first sentence |

Hand-written: what only a person knows (concepts, trust and measured accuracy, real-id examples, playbook steps and
judgement). Write it for an agent: an index that points, one source of truth per
fact, steps with checkable done-when criteria.

- **`llms.txt`** ([llmstxt.org](https://llmstxt.org)): H1, a one-paragraph summary, base URL and auth, "Start here"
  with real calls and real ids, then links: Docs, Skills, Optional.
- **`agents/`**: `concepts.md` (data model, how things link, words to use), `endpoints.md` (every call, filters,
  examples), `trust.md` (what each score and label means, measured accuracy, coverage gaps), `mcp.md` (connecting,
  tools, costs).
- **`skills/<name>/SKILL.md`** + `references/*.md`: a skill folder (frontmatter `name`, `description`) with one
  playbook per task: when to use, steps with exact calls, done-when, judgement rules, output, cost. Served over HTTP,
  as MCP prompts, and through the MCP Skills extension (`guideSkills` gives the factory both). It installs with
  `npx skills add <the deployment's address>` (through the discovery index, §14) or `npx skills add <owner>/<repo>`.
- **Three kinds of skill, three places.** A *product skill* is for agents using the product: one folder,
  `guide/skills/<product>/`, served and installable, and free of `{{placeholders}}` when it should also install from
  the repository, because that copy is read as it is. A *developer skill* is for agents changing the repository:
  `.agents/skills/<product>-<job>/` (`.claude/skills` links there), never served, with `metadata.internal: true` in
  its frontmatter. `skills.sh.json` at the root names `./guide/skills`, so installing from the repository offers the
  product skill and not the developer ones (the installer would otherwise stop at `.agents/skills/`). A *kit skill* serves any product on
  the kit and lives in the kit's `skills/`. `init` makes the first two places; the kit's `api-kit-skills` skill is
  how to fill them: from a test of what agents get wrong, never from the route list.
- **`/llms-full.txt`** is assembled from all of them in a fixed order, never written by hand.
- Tests: `guideRoutes(files, doc)`, `guideGaps(files, vars, { doc, tools })` and `toolRoutes(tools, doc)` return
  `[]`; every example id exists in the data. `toolsRun(tools, app, args, { headers })` runs every tool with sample
  arguments and returns `[]` only when each answers 2xx with a readable summary; a tool with no sample arguments fails
  it, so a new tool can't ship untested.

## 11. MCP

- Spec **2026-07-28**, stateless Streamable HTTP at `/mcp` (POST; GET/DELETE → 405), via `@modelcontextprotocol/server`
  v2 `createMcpHandler`; 2025-era clients get the SDK's stateless fallback. Origin checked against the public host.
  2026-07-28 has no `initialize` (`server/discover` replaced it), but agents open with it out of habit: `mountMcp`
  answers it with the discover facts (capabilities as the server declares them, `listChanged: true`) and a note that it
  isn't needed, never with "method not found".
- **Tools say their route**: each tool's `tools/list` entry carries `_meta["api-kit/route"]`
  (`GET /api/v1/recipes/{id}`), so a gateway can tell which tool a guide or playbook means when it names a route,
  and its command in `_meta["api-kit/cli"]` (§19).
- **Argument names follow the routes**: a tool's arguments are the route's query and path parameter names (`q`, not
  `query`; `slug` where the path says `{slug}`). Ids also accept the board ref form (`recipe:<slug>`); the route, not
  the tool, resolves it, trying the id as given first, so ids that hold a colon themselves (`step:<slug>`) work.
- **Tools are thin calls to the routes**, run in-process with the caller's credentials (`inProcess(app)`), so the API
  and MCP cannot drift. Names `snake_case` verbs (`search_recipes`); `title`, a description that says when to use it;
  `annotations` (read-only, idempotent, closed-world unless a tool writes or calls out); `outputSchema` = the route's
  2xx schema, with its JSON as `structuredContent`; a short text summary first; images as `resource_link`s. An app
  whose clients show `structuredContent` instead of the text may send it only for tools with an output schema
  (`structured: 'withOutput'`); the default sends it with every JSON answer, which the app's CLI reads for `--json`.
- Errors are tool results with `isError: true` and the problem's one-line summary, never protocol errors; the problem
  itself (with its `status`) rides in `_meta["api-kit/problem"]`. Hints: read-only by default only for a `GET`.
- `instructions` on discover: what the server is for and the order to use tools in (not a repeat of descriptions).
  Cache hints: lists and discover cached an hour, `private`.
- Skills through the Skills extension (SEP-2640) and as prompts, findable by a client that knows neither:
  `resources/list` names each `SKILL.md` (`<name> skill: start here`, its frontmatter description) and its references
  while a skill has at most 20; the `skill://{+path}` template's description and the server's `instructions` name the
  start URI; a folder read (`skill://<name>`) answers its files as a Markdown list of `skill://` URIs, never only a
  pointer to `resources/directory/read`; a miss names the start URI. A stdio wrapper (`overHttp(origin, key)`) runs the
  same tools from a laptop against the remote API.
- Auth is the API's: the same bearer key, or an OAuth token when the app runs `oauth.ts` (then MCP clients such as
  hosted chat apps connect with no key at all: the 401 on `/mcp` points at `/.well-known/oauth-protected-resource/mcp`).
  Never publish protected-resource metadata without a working authorization server, nor for a resource no token can
  be granted for: it sends clients into a flow that cannot succeed. Tokens are audience-bound when the client sends
  `resource` (§7); MCP mounted away from `/mcp` passes the same path as `mcpPath`, and a server serving several MCP
  resources passes `resources`, `resourceOf` and `accepts`, whose `accepts` also judges the in-process `/api` calls its
  tools make with the same bearer.
- `mountMcp` publishes the Server Card (SEP-2127) at `<mcp>/server-card` and `/.well-known/mcp/server-card.json`.
- **Resources** (`mcpResource`) let a client attach a thing (a recipe with its picture, a tree): a URI template read
  through the routes, JSON as text and images as blobs; a part marked `optional` (an image that may be missing) is
  left out when it fails, so the rest still arrives. `resources/read` carries the URI in the `Mcp-Name` header.
  The guide lists them with `{{mcp.resources}}`.
- **A2A (optional, `a2a.ts`):** A2A 1.0 over the same tools. `mountA2A` serves the Agent Card at
  `/.well-known/agent-card.json` (one `JSONRPC` interface at `/a2a`, the API key and, with `oauth.ts`, the OAuth flow
  as security schemes, one skill per chosen tool) and JSON-RPC `SendMessage`, `GetTask`, `ListTasks`, `CancelTask`.
  A message's text fills the skill's main argument (a `data` part may give all of them; `metadata.skill` picks the
  skill, else the first); the task's artifact is the tool's summary (text) plus the route's JSON (data). A slow route
  leaves the task `TASK_STATE_WORKING` until `GetTask`, polling the run (never calling the tool again while it works),
  finds it done; a canceled task stays canceled. Tasks are kept a day, visible only to their
  caller. Requests must send `A2A-Version: 1.0` (absent means 0.3: `-32009`); streaming, push and the extended card
  answer the spec's errors and the card says they are off. Pick the one-call workflows as skills, not every tool.

## 12. Secrets and deployment

- Each app's secrets live in your secret store, scoped to that app (`API_KEY_<CLIENT>` values, `API_KEYS` hashes,
  capped model keys, a read-only storage key). Values never enter a repo, doc, commit or transcript.
- On your host as a container: the API runs with an allowlisted env (`container/entrypoint.sh`), behind Cloudflare
  Access with the bypass paths above; a separate job syncs any read-only store in.
- **Or on Cloudflare Workers** (`init --runtime cloudflare|both`): `wrangler.jsonc` holds no `account_id` and no
  resource ids (`pnpm run deploy:env` takes yours from the environment: `CLOUDFLARE_ACCOUNT_ID`, `D1_<BINDING>_ID`), D1 is the database, secrets go in with `wrangler secret put` (locally
  `.dev.vars`), and `pnpm run deploy` (never `pnpm deploy`, pnpm's own command) writes the guide module and the D1 migration files, applies them, then deploys.
  Deploy with a scoped token kept in the app's secrets.
- **A browser app on Workers** (`init --preset app`): one package and one Worker. Vite with Cloudflare's plugin builds
  the Worker from `src/` and the browser app from `web/`; the built files are the Worker's static assets, and
  `assets.run_worker_first` leaves only `/app/` to them (`["/*", "!/app/*"]`), so every other path reaches the
  API and an unknown one still gets a problem, never the app's page. `home: 'app'` sends `/` and `/app` to `/app/`. The dev
  server uses `base: '/app/'`; the build writes into `app/assets/` instead, because the built folder is served from
  the root. A repository others deploy with their own account (a template, a deploy button) leaves `account_id` out of
  `wrangler.jsonc` and takes it from the environment instead.
- **The Deploy to Cloudflare button** (`kit button`): anyone deploys the app to their own account from its README.
  The button reads only the repository (`?url=https://github.com/<owner>/<repo>`, a branch and folder as
  `/tree/<branch>/<dir>`), makes every D1, KV, R2, queue and Hyperdrive the config names without an id, asks for each
  secret in `.dev.vars.example`, shows the description `package.json` gives under `cloudflare.bindings`, then runs the
  `build` and `deploy` scripts. So: no ids or account in `wrangler.jsonc`, a description for every secret and every
  empty `vars` entry, a `deploy` script that applies the migrations. `kit button --check` holds an app to that (exit
  1 with a fix per line; the starter check runs it on every starter), `--write` keeps the README's
  `<!-- deploy-button -->` block current, and `--smoke` deploys a copy as a stranger would (its resources made under
  `-smoke-` names first, as the button makes them, then the scripts), checks `/api/health` and `/llms.txt`, and
  deletes all it made. The button needs a public github.com or gitlab.com repository, and deploys Workers only.
- **The caller's address** (§9): on Workers, or behind Cloudflare with the origin reachable only through it,
  `address: { header: 'cf-connecting-ip' }`; behind a reverse proxy that appends to `X-Forwarded-For`,
  `{ header: 'x-forwarded-for', hops }` with one hop per such proxy (only a proxy that appends on every request: one
  that passes the header through leaves it as sent); on Node with nothing in front, `'socket'`. A named header holds
  only when the app is reachable through that proxy alone: a caller who reaches it another way sets the header
  themselves.
- **Lint and format:** every app has `pnpm lint` (oxlint) and `pnpm format` (oxfmt). Both leave out `src/kit/` (the
  kit's copy must stay byte-equal for `doctor`) and generated files.

## 13. Checklist for a new API

1. `createAgentApi({ title, version, description, tags, tagGroups, auth })`.
2. Routes with `createRoute`: HAL responses, `problemResponses`, cursor pages, real `example`s; every accepted query
   parameter in the route's query schema (anything else is a `400`).
3. `GET /api` root with links and counts.
4. `guide/` with `llms.txt`, `agents/` and a skill folder, the code-derived parts as generated placeholders;
   `serveGuide`.
5. MCP tools over the routes; `mountMcp`; a stdio entry; `serveAiCatalog` last.
6. Tests: `lintOpenApi`, `guideRoutes`, `guideGaps` (with the doc and tools), `toolRoutes`, `toolsRun` (every tool, run), contract tests per route,
   an MCP round trip, and one agent given only `/llms.txt` and a key doing a real task (note where it stalls).
7. Keys minted per client into your secret store; hashes into `API_KEYS`; Access app with the bypass paths, `/.well-known`
   and `/robots.txt` included.
8. Pictures or prose to search by sense: ledgers built with `embedMissing` (pilot, budget, capped key),
   `registerVectorSearch` with the app's filters, `vectorSearchTools`, the measured `minZ` in the trust page (§15).
9. A browser app: the front door (`web.ts`), and the headless search parts under its own UI (§16).
10. The command line: `kit sdk` (or `kit cli`), a `cli` name and example on every tool, `cliGaps` empty and
    `commands.json` current in the tests, jobs only for steps agents repeat (§19).
11. The repository: CI, the pre-push gate, Dependabot and the secrets scan as `init` writes them (§20).
12. Feature switches (§21): every additive feature in `src/features/catalog.ts` with a title and what switching it off
    stops, `switch:` on its feature (`kit feature <name> --switch`), and its work outside requests asking `isOn`.
13. The brand (§22): `brand/brand.ts` and `brand/icon.svg`, rendered with `kit brand`, passed as `createAgentApi({ brand })`.
14. Letting people into part of the app (§23): a resource per space, single-use invites, grants mirrored with
    `onGrant` and `onRevoke`, and the same 404 for a space that exists and one that does not.

## 14. Discovery

Public, read-only, generated from what the app already serves (`discovery.ts`); cached an hour with ETags and open
CORS:

| Where | What |
|---|---|
| `/.well-known/api-catalog` | RFC 9727 linkset: OpenAPI (`service-desc`), docs and guide (`service-doc`), health (`status`) |
| `Link` header on `/`, `/api`, health, `/docs`, `/llms.txt` and every `401` | RFC 8288: `api-catalog`, `service-desc`, `service-doc`, `describedby` |
| `/robots.txt` | Content Signals (`ai-train`, `search`, `ai-input`; default all `no`), `Disallow: /` unless `crawl`, `Agentmap` |
| `Accept: text/markdown` on `/` and `/docs` | the guide (`llms.txt`) with `x-markdown-tokens`; browsers still get HTML |
| `/.well-known/agent-skills/index.json` | Agent Skills Discovery v0.2.0; a skill with references as one deterministic `.tar.gz`, digests over the exact bytes served |
| `<mcp>/server-card`, `/.well-known/mcp/server-card.json` | MCP Server Card (SEP-2127): identity, the remote with its auth header, protocol versions |
| `/.well-known/ai-catalog.json` | AI Catalog (ARD): the API, the MCP server and each skill, with representative queries |
| `/sitemap.xml` (`discovery.sitemap`) | the public pages only, named in robots.txt |
| `/.well-known/agent-card.json` (`a2a.ts`) | A2A 1.0 Agent Card: the JSON-RPC interface, security schemes, skills |
| `/.well-known/poppy.json` (`discovery.poppy`) | Personal Agent Protocol 0.3: the organization (this host, or the OAuth server's `publicOrigin`), its APIs and agent protocols, the issuer with scope hints |
| with `oauth.ts` | `/.well-known/oauth-protected-resource[/<path>]`, `/.well-known/oauth-authorization-server` (with `agent_auth`, `protected_resources`, `poppy_domains`), `/.well-known/jwks.json`, `/auth.md` |

An app with a public page adds WebMCP there itself (tools registered on load); DNS-AID records live in DNS, outside
the app.

**Private services** (`createAgentApi({ private: true })`, `serveFrontDoor(app, { …, private: true })`): for content
whose existence shouldn't be advertised. Everything above except the OAuth metadata, `jwks.json` and `robots.txt`
needs credentials; `robots.txt` names nothing (no guide, catalog or sitemap); `/api/health` answers status and
version only; no `Link` header points at the guide; `/` sends people to the app (behind the sign-in) and the app's
files need credentials too. Every response carries `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet,
noimageindex` and every page a `noindex` meta, and `public` cache-control becomes `private` (a CDN that caches by
extension would otherwise hand an authenticated `/llms.txt` to anyone). MCP clients still connect through the 401's
resource metadata; agents with a key read the guide as before. Name the OAuth `resource_name` and the auth realm
generically: both stay public.

## 15. Search by vectors

Where items have pictures or prose worth searching by sense, not by keyword (`vectors.ts`, `vector-search.ts`):

- **Model and spaces.** Gemini Embedding 2 through the app's own capped OpenRouter key, 768 dimensions, unit vectors.
  `look` = the item's picture (flattened onto white, at most 384 px); `meaning` = its words as
  `title: … | text: …` (`documentText`); queries as `task: search result | query: …`. Text and pictures share the
  space, so words can search looks and a picture can search meanings. Plain fetch for both (the AI SDK embeds strings
  only).
- **Never pay twice.** One append-only JSONL ledger per space, keyed by item, with the hash of model, size and content;
  `embedMissing` embeds only stale items and appends each batch as it returns. Builds run off the request path (a job,
  or a larger machine for big sets), keep ledgers in object storage, start with a pilot (`limit: 200`) and carry a `budget`; a
  402/403 is a `SpendCapError` that stops the run, and a rerun resumes. One run writes a ledger at a time
  (`<file>.lock`); a torn last line (a crash mid-append) is skipped with a warning and dropped by the next run, and
  any other line that isn't JSON is damage that stops the read.
- **Routes.** `GET {path}?q=&by=look|meaning|both` (words), `POST {path}` (a picture: multipart `image` or JSON
  `{ image }`, filters in the query), `GET {item}/similar?by=` (likeness, free). Results are HAL,
  `_embedded.results[]` of `{ score, z, space, item }`. Every filter is declared on all three.
- **Only what stands out.** Words and pictures keep rows `minZ` standard deviations above the query's own mean over
  the whole catalog (default `max(3.5, √(2 ln n) − 0.5)`); measure the bar on each catalog with real and nonsense
  queries and record it in the guide's trust page. A picture always has look-alikes, so it takes its own, lower bar
  (`minZ.picture`, default 2.5). A corpus all about one subject makes everything
  stand out a little: there, add a raw-score floor (`minScore`) measured the same way. In practice z separates real
  queries from gibberish poorly on a topical catalog (gibberish can reach z 6), the raw score well: measure both
  on the full build, then prefer a low `minZ` (≈ 2.5) with a `minScore` between the two groups. `both` merges spaces on
  `z`, never on raw cosine. An empty answer means nothing fits, and carries `_embedded.closest`: the three nearest rows
  below the bar (`z: null`), so an agent can judge for itself and say they are not matches. Likeness always answers
  (`nearest`). Give the route an `example` query the catalog answers well, and declare `offers: ['meaning']` on a
  text-only catalog so `by=look` is neither advertised nor a 503. z is measured over the whole catalog, filters
  applied after: a narrow filter can leave few rows above a z bar, one more reason the score floor carries the bar.
- **Pictures by URL**: the API's own image links (fetched in-process with the caller's credentials, so an agent can
  search with a picture the API just showed it), and the app's `imageHosts` (https, exact host, no redirects); data URLs
  and uploads always. A server never fetches an arbitrary URL.
- **Cost and failure.** Words and pictures cost one embedding each (queries cached in memory), rate-limited per caller
  (`hourlyLimit`, default 600). No key: `503 unavailable`; budget gone: `429 spend_cap`; vectors not built:
  `503` with `Retry-After`. Likeness and every other route keep working.
- **Agents** get the same routes as MCP tools (`vectorSearchTools`: `search_<noun>`, `search_<noun>_by_image`,
  `similar_<noun>`).

## 16. The browser side

- **Front door (`web.ts`).** `/` is a public page with no data (what the service is, how agents connect, WebMCP
  tools if any); the browser app lives under `/app` behind Access (which gates only `/app`, `/oauth/authorize` unless the app passes `approve` (§7), `/oauth/claim` and `/oauth/device`);
  the app's old addresses and `/?query` deep links redirect there; `frontDoorOpen` lists what auth leaves open. The
  app's calls carry Access's cookie, so the browser never holds a key.
- **Headless first.** Search logic for browsers is `search-client.ts` (no framework: a typed client for §15's routes, a
  controller with debouncing and cancellation, paste and drop of pictures) and `search-react.ts` (`useVectorSearch`,
  `usePictureInput`, `useSimilar`). They render nothing; each app draws its own UI.
- **UI is a suggestion.** `vector-search-block.tsx` is one shadcn block over the hooks (field with a picture chip,
  look/meaning/both, status line, the app's own cards). It uses only `button` and `input`, so Radix and Base UI styles
  both work. Apps install it with `npx shadcn add escalay/api-kit/vector-search-ui` or `kit add vector-search-ui`, then own
  it.

## 17. Boards

The owner's own collections of a catalog's items (`boards.ts`, `boards-client.ts`, `boards-react.ts`):

- An item is a **ref**, `<type>:<id>`: the type a lowercase word the app chooses, the id everything after the first
  colon (it may hold colons: `segment:episode:intro:2`). Build and read refs with `boardRef` / `parseBoardRef`
  (`refs.ts`, shipped with both `boards` and `boards-client`), never by hand. Boards live in the app's database (`db`) next to
  its OAuth state.
- `GET /api/boards` (`?item=<ref>`: where it is saved), `POST` (201 + `Location`), `GET|PATCH|DELETE /api/boards/{id}`,
  `PUT|DELETE /api/boards/{id}/items/{ref}` (idempotent, also when two arrive together; a note per item: left out
  keeps it, `null` clears it), and `/suggestions` when the app can say
  what is alike (e.g. the centroid of the board's look vectors). Writes need `write`.
- Boards are single-owner: every caller with `read` sees every board. Per-person boards are the app's own feature.
- Agents get `list_boards`, `create_board`, `get_board`, `save_to_board`, `remove_from_board` (and
  `board_suggestions`); `boardTools({ refExample })` shows them the app's ref. Browsers use the headless client and hooks; the UI is the app's.

## 18. Usage reports

A product people deploy for themselves may report its use once a day (`telemetry` part), and only so:

- One `POST <collector>/v1/<product>` a UTC day at most, never in the first 24 hours after the first run, with
  exactly `{ "schema": <n>, "instance": "<random v4 UUID>", "version": "1.2.3", "report": { … } }` and a 5 second
  timeout. The instance is made on the first run and names nothing else; the product is in the path, not the body.
- The report holds **coarse ranges and booleans, never ids or text**: counts as `0`, `1-10`, `11-100`, `101-1k`,
  `1k-10k`, `10k+` (`countRange`), days as `0`, `1-7`, `8-30`, `31-90`, `91-365`, `365+` (`dayRange`). Anything else
  is dropped before sending.
- Off when `DO_NOT_TRACK=1` or `TELEMETRY=off` (`false`, `0`) is set, or the owner switched it off (`PATCH /api/telemetry`
  `{ enabled }`, owner only). `GET /api/telemetry` shows whether it is on, why, and exactly the body it would send;
  agents get it as `get_telemetry`.
- It runs from the app's scheduled handler (`sendDaily`), is tried at most once a day even when the collector is
  down or several instances run it, and never throws into the app. The collector may answer `{ "latest": "<version>" }`; the app keeps and shows it.
- The product's README and setup say that it reports, what, and how to switch it off.

## 19. The command line

Every app's MCP tools are also its command line, for agents first and people too (decision 0003). The app ships it as
the bin of its npm package (`sdk/`, made by `kit sdk`, or `kit cli` for an app that has one); it is an MCP client of
the deployment's `/mcp`, so it can't disagree with the tools.

- **Names are noun then verb**, as `gh` writes them, and each tool declares its own: `cli: { name: 'mail wait',
  examples: [{ run: 'mail wait adr_1 --timeout 30', about: '…' }] }` on `mcpTool` (and `mcpResource`). Nouns are
  singular; verbs are `gh`'s (`list`, `view`, `create`, `edit`, `delete`) where one fits, the task's word otherwise.
  No noun is a built-in (`help`, `commands`, `api`, `tool`, `doctor`, `completion`, `version`) or a job; `auth login`,
  `logout`, `token` and `switch` are built in, and a tool may fill another `auth` verb (`who_am_i` is `auth status`). A tool
  without a name gets the route rule's (`GET /api/addresses/{id}` → `address view`) and `cliGaps` asks for one. The
  MCP name stays a hidden alias.
- **Arguments come from the input schema**: the input keys the call puts in its path are positional, in path order
  (`cli.positional` overrides); no property may hide a global flag (`json`, `yes`, `input`, `profile`); every property is a
  `--kebab-case` flag (positional ones too); `--x` / `--no-x` for booleans; a repeated flag for an array (`--no-x`
  sends it empty); numbers and
  enums checked before the call; nested objects only through `--input -`, a JSON object the flags win over.
- **Agents first**: stdout holds only the answer; progress, prompts and warnings go to stderr. `--json [fields]` prints
  `structuredContent` (fields of each item for a list; `senderWritten` is always kept, and a field the answer
  doesn't have is named on stderr; under `structured: 'withOutput'` a tool with no output schema prints `{ text }`). A resource's JSON reads as `key: value` lines without `--json`, under the app's
  untrusted-text note when it names `senderWritten` fields (`createCli({ untrusted })`). Errors are the problem as one line on stderr (JSON with
  `--json`) with stable exit codes: 0 done, 1 usage, 2 sign-in, 3 not found, 4 refused or a limit, 5 the server,
  6 timed out or still working, 130 stopped. Nothing prompts without a terminal; a destructive tool needs `--yes` there.
  `--dry-run` prints the call. `<app> commands --json` is the manifest, `<app> help agents` the rules on one screen.
  Help, summaries and error lines name commands, not MCP names: a tool's name, a route it calls (`GET /api/addresses`)
  and a resource URI read as the command (`` `<app> address list` ``), and a backticked argument of the command or of
  one named there as its flag (`` `after` `` → `--after`, `` `read: false` `` → `--no-read`). Each command carries its
  `route` for this. `--json` and the manifest stay exactly as the server wrote them.
- **Sign-in**: `<app> auth login <url>` with a device code (RFC 8628, the `oauth` part; the CLI registers itself as a
  public client), or `--with-token` with a key on stdin; profiles per deployment in the user's config folder, mode
  0600, tokens renewed under a lock (a refresh token sent twice revokes the sign-in). `<APP>_URL`, `<APP>_API_KEY`
  and `<APP>_PROFILE` override them. A sign-in that fails or ends (an expired or unknown code, a refresh refused) says
  the command to run, `` `<app> auth login <url>` again ``, never the OAuth endpoint the server's own error names.
- **Commands come from the deployment**: the package carries `sdk/cli/commands.json` (`cliSnapshot`, written by
  `pnpm sdk:types`) for help before sign-in; signed in, the live `tools/list` wins, cached per profile for its `ttlMs`.
  Each listed tool and every call's result carry `_meta["api-kit/tools-hash"]` (a hash of the whole listing): an
  answer from another list drops the cache, and a command or flag the cache doesn't know gets one fresh look before
  it is called unknown, so a deploy never leaves the CLI on old names. `<app> doctor` reports drift between the
  snapshot and the server, and the cache's age and hash.
- **Jobs**: one task, one top-level command (`sdk/cli/jobs/`, `defineJob`), written when the agent test shows agents
  making the same few calls for one playbook step; the playbook then names the job.
- **The guide** lists the commands with `{{cli.commands}}`, jobs first; `serveGuide({ commands: snapshot })` (the
  imported `commands.json`) lets it list the jobs, which the server can't see.
- **A job that fails** throws: its numeric `exitCode` wins, else its problem's `status`, else 1; `ctx.fail(result)`
  throws a failed call's problem.
- Tests: `cliGaps({ tools, resources, jobs })` returns `[]`, `commands.json` equals `cliSnapshot(...)` byte for byte,
  and the live commands equal the packaged ones (`sdk/test/cli.test.ts`). `kit doctor` runs `cliGaps` too.

## 20. The repository

What `init` sets up, and what an app keeps:

- **One gate.** `pnpm check` (types, lint, `oxfmt --check`, `migrations.ts --check` on Workers, the build for the
  `app` preset) and `pnpm test`; `pnpm gate` runs both. CI's jobs call those two scripts and nothing else, and
  `.githooks/pre-push` runs `gate`, so a push the hook lets through passes CI.
- **CI** (`.github/workflows/ci.yml`): `checks` and `test` in parallel, `workflows` (actionlint, zizmor), `secrets`
  (gitleaks over the whole history, `.gitleaks.toml` allowing `src/kit/kit.json`), and on pull requests `title`. The
  last three call the shared workflows in [escalay/.github](https://github.com/escalay/.github), pinned to a release's
  commit, so their checks are `workflows / lint`, `secrets / gitleaks` and `title / conventional`. Read-only
  `contents` permission, actions pinned to commit SHAs, `persist-credentials: false`, a newer push cancelling only a
  pull request's run.
- **Security scanning, once public**: CodeQL (`codeql.yml`: `javascript-typescript` and `actions`, on main, pull
  requests and weekly), OpenSSF Scorecard (`scorecard.yml`, published; the Scorecard API rejects results from a
  workflow with top-level env or write permissions, or `run` steps in its job) and dependency review (CI's
  `dependencies` job, on pull requests, failing on a high-severity vulnerability). GitHub's free plan offers code
  scanning and dependency review on public repositories only, so each job is skipped while the repository is private
  (`if: !github.event.repository.private`), and none is a required check.
- **Changes**: through pull requests titled as Conventional Commits, squash-merged.
- **The repository's settings** (`kit repo apply`, through `gh`; `kit repo check` exits 1 on drift): squash merges
  only with the title as the commit (or `--merge rebase`), auto-merge and the update-branch button on, merged branches
  deleted, a read-only Actions token that may open pull requests only when a `release.yml` needs it, vulnerability
  alerts and security updates on, and a `main` ruleset (no deletion or force-push, linear history, pull requests only,
  required checks = the CI jobs that always run; a job that calls a reusable workflow reports one check per job of it,
  `<job> / <called job>`, read from the called workflow at the ref the CI pins). With a `release.yml`, `v*` tags can't
  be moved or deleted. A private repository on GitHub's free plan has no rulesets: `check` says so, and the person
  merging is the gate.
- **Dependencies**: Dependabot monthly, one grouped pull request per ecosystem (npm minor and patch together, majors
  alone), a 7-day cooldown; security updates on.
- **Toolchain pinned**: `.node-version` (the kit's Node) for CI and people alike, `packageManager` (the kit's pnpm) so
  corepack installs the pnpm that wrote the lockfile.
- The kit proves it: `scripts/starter-check.mjs` runs `gate` on each new starter, and `scripts/release-smoke.sh` checks
  an app made from the published package.


## 21. Feature switches

A feature an app can work without (sending, webhooks, a model, a report) can be switched off, through the API, by
the owner (`switches` part). The core an app cannot run without (sign-in, its main data, the switches themselves) is
never switchable.

- **One catalog** (`defineFeatures`), one file the app owns: every switchable feature by a stable kebab-case key, its
  title, what switching it off stops, its default, the features it `needs`. The key is the one name a database row,
  `FEATURES_OFF` and a flag service use; it never changes, and a rename keeps the old name in `renamedFrom`.
- **One line says where switches come from**: `providers`, asked in order, the first answer winning and the catalog's
  default deciding the rest (`databaseProvider(db)` in the app's own database; `fromSdk` puts any flag service
  in front of it). A switch is for everyone, one person (`person:<email>`) or one API key (`key:<name>`); the
  caller's own wins. An OAuth agent counts as the person who approved it; work no caller started (incoming mail,
  queue jobs, scheduled runs) is resolved for everyone.
- **Off means listed, answering 403**: every route a feature adds goes through `gated(app, key)` and answers
  `403 feature_disabled` with `detail` "This feature is disabled.", `feature`, `blockedBy` and `switchOn`. The gate
  runs after auth and before validation. The routes stay in the OpenAPI document and the tools in the MCP list, each
  documenting the 403. Background work asks `isOn` and does nothing when off; an action that leaves the app (a send,
  a delivery) asks with `fresh: true`, past the 5 second cache.
- A feature is off when any feature it `needs` is off. `PATCH /api/features/{key}` (owner only) with `?dryRun=true`
  says what else stops first. `FEATURES_OFF` in the environment locks features off whatever is stored; a name it
  holds that is no feature is listed as `unknownOff`. A switch another provider decides is changed there: the API
  answers 409 naming it.
- `GET /api/features` lists every feature, on or off for the caller, what decided it (`source`, `reason`) and the
  stored switches; agents get `list_features` and `switch_feature`.
- A feature that is on but cannot do its work now, for want of something outside the switches (a setting, a binding),
  says so in the list as `unavailable` (one sentence, from the app's `unavailable` hook), and so do the features that
  need it. It gates nothing: the feature stays on and its own routes answer as they would, saying the same.
- The 403's `detail` starts "This feature is disabled." and goes on to say which feature, for whom, who switched it
  and when, and how it comes back on; `switch_feature` acts only on the user's word. Each switchable feature's tools
  say which switch they belong to (`featureTools`).
- A paid feature has `requires` in the catalog and is off until the deployment's license key (an ES256 JWT, checked
  offline against the product's public key: `licenseOf`, `kit license`) grants it. Its 403 says `reason: "LICENSE"`
  with `requires` and `upgrade`; the owner cannot switch it on (409).
- The browser asks the same list (`switches-client`, `switches-react`): `useFeature` and `<Feature>` show a screen
  only while its feature is on, `useFeatureDisabled` hears every 403 for one alert, and the `switches-ui` block is
  the owner's panel and the disabled notice.

## 22. Identity

One brand names the service everywhere (`brand` part): the app owns `brand/brand.ts` (`defineBrand`: name, title, a
description of at most 100 characters, an accent) and `brand/icon.svg`, and `createAgentApi({ brand })` hands it to
every surface, so none of them can disagree.

- **Rendered at build time, committed.** `kit brand` turns the SVG into the PNGs and the OG card (`src/brand.gen.ts`);
  nothing rasterises at runtime. The module records a hash of its inputs, and `kit doctor` calls it stale when they
  changed.
- **The same identity on every surface:** MCP `serverInfo` (`server/discover`, 2025's `initialize`) and the Server Card
  (`title`, `description`, `websiteUrl`, `icons`), OpenAPI's `x-logo`, the A2A card's `iconUrl`, the guide's
  `{{brand.*}}`, the favicon, manifest and Open Graph tags of the pages the app serves, and the OAuth approval pages
  (§7: the head tags, the icon, the title and the accent; never a client's `logo_uri`).
- **PNG first, SVG last.** Icons go in this order: the 96 px PNG inline (the only kind Claude shows: a `data:` PNG
  under 10 KB), then the 192 and 512 PNGs on the server's own host (VS Code takes no SVG and no other host), then the
  SVG. A dark variant adds entries with `theme: 'dark'`, never a second inline icon. On 2026-07-28 the inline icon
  rides on `server/discover` only, not on the serverInfo every answer carries.
- `/favicon.ico` (16, 32 and 48 px), `/icon.svg`, `/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png`, `/og.png` and
  `/site.webmanifest` (and `/icon-dark.svg`, `/icon-dark-192.png`, `/icon-dark-512.png` with a dark icon) are public
  (credentials first when the service is private), cached a week with an ETag of the bytes served, and
  `cross-origin-resource-policy: cross-origin`, so other sites can show them (`same-site` when the service is
  private), the SVGs with `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, so a
  script in one never runs in the API's origin; a path the app serves itself stays the app's. Behind Access they bypass SSO with §7's open paths, or the icons clients fetch from
  the server's host and the pages' head tags get the sign-in page.
- Connector lists in claude.ai and Claude Desktop show the favicon of the address's **root domain**, whatever the
  server says: serve the same icon there. `kit doctor` notes a host on a subdomain.
- No brand changes nothing: every document is byte for byte what it was without one.

## 23. Sharing

An app that lets people into a part of it (a **space**: a project, a list, a household) and not the whole of it. No
kit part does this yet; an app builds it on the `oauth` hooks (§7: `approve`, `complete`, `onGrant`, `onRevoke`,
`resources`, `accepts`), and keeps these rules.

- **A space is named by its resource.** Each space has its own address on the app's origin (`<origin>/s/<space>/mcp`),
  and every grant into it carries that audience. The app passes `resources` (a pure check of the path, never a
  lookup) and `resourceOf`, so each space's token works at its own address and nowhere else.
- **Invites are single-use, with a link and a typed code.** An invite is for one space and one person, and expires.
  Its link opens the app's own page (`approve`); the code, typed there, decides. A link passed on without
  its code lets no one in. The invite is spent with the grant's first token (`onGrant`), so a second use is refused.
- **An app the person has not used before is named and warned.** The page names the client as it registered (its own
  claim, never verified), where it returns (`redirectHost`, or an app on this computer) and the space, and asks for
  the code: nothing is approved by the link alone, and nothing without a click.
- **The owner's approval makes a space-locked grant, never an owner token.** Asking to join waits on the owner (the
  asker's page polls the app, then posts `complete` from the same browser: `ticketTtl`). The grant names the person let
  in as `approver` and binds the space with `complete`'s `resource`, even when the client asked for none. The default
  `accepts` takes a root token at every space, so only the owner's own sign-ins get the root.
- **The app's page names who is signed in.** The kit passes `approve` the request and no account (`SignInAsk` has
  none), so the app's page reads its own session from `c` and names the account this browser is signed in to, so
  nobody joins a space as whoever used the browser last. The kit's own pages do the same: its consent page says
  "as you (…)" and its claim page "You are signed in as …", both from `owner(c)`.
- **Revocation is mirrored.** The app keeps a row per grant (who is in a space, their agents): made when `onGrant`
  says yes, dropped when `onRevoke` names the grant (every grant of a client on `client_revoked`), aged out by its
  last use (`revokeGrant` after 30 days). `accepts` refuses a token whose grant has no row, so removing a member
  stops their agents on the next request.
- **Nothing leaks whether a space exists.** A caller who may not see a space gets the same 404, with the same body,
  for a space that exists and one that does not; never a 403 that confirms it. Metadata is 404 only for a path
  `resources` refuses, and a wrong code is "not one of ours" whether or not the space is real. The code page is
  limited like the kit's own open endpoints.
- **Tested as a browser does it.** The owner's approval through `approveSignIn` (`testing`); the app's own page with
  the same ticket cookie and `Sec-Fetch-Site: same-origin`; then a space's token refused at another space, a spent
  invite refused, a removed member's token refused, and the 404 the same for an unknown and a hidden space.
