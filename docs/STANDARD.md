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

## 4. Lists

- Cursor paging: `?limit=` (documented max) and `?cursor=` copied from `_links.next`; items under
  `_embedded.<plural>`, `count` on the page, `total` only when cheap. Keep reading until `_links.next` is absent.
- Small in-memory lists may page by `page`/`perPage` with `first`/`prev`/`next`/`last` links; the item shape is the
  same.
- Filters are plain query parameters; repeating one means OR (`?course=starter&course=main`). An unknown value is a
  `400`, never silently ignored. So is an unknown parameter: `createAgentApi` answers a `400` naming the parameters the
  operation does take (read from its query schema), so `?sinse=` can't pass for a filter. Sorting is `sortBy=` one of
  the documented fields and `order=asc|desc` (`sortQuery`).

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
- **People:** Cloudflare Access SSO in front of the web pages; the app also verifies `Cf-Access-Jwt-Assertion` against
  the team's keys, so nothing reaches data without either a key or a verified person.
- **A browser app on the same host:** on the bypassed paths Access sends no header, but the browser still sends Access's
  `CF_Authorization` cookie (the same signed token), and the app accepts it. Writes made with the cookie must come from
  the same site (`Sec-Fetch-Site: same-origin`, else a matching `Origin`), so other sites can't post through a login.
  The host must not bypass Access for people (no IP bypass), or they arrive without a token.
- **Open without auth:** `/api/health`, `/openapi.json`, `/docs`, `/llms*.txt`, `/agents/*`, `/skills/*`,
  `/problems/*` (no data). In Access, these paths and `/api/*`, `/mcp` bypass SSO; the app's key check
  guards them.
- A 401 carries `WWW-Authenticate: Bearer realm="<app>"` (plus `error="invalid_token"` for a wrong key). Keys never go
  in URLs or logs.
- **Agents that get their own token (optional, `oauth.ts`):** the app is its own OAuth server. MCP clients follow the
  401's `resource_metadata` to `/.well-known/oauth-protected-resource[/mcp]`, register (RFC 7591, public clients), and
  send the owner to `/oauth/authorize` (code + PKCE S256); other agents follow `/auth.md` (anonymous or by email),
  and the owner types the agent's 6-digit code at `/oauth/claim`. Both approval pages sit behind Access and check the
  signed-in person again; **nothing is granted before a person approves** (an unclaimed registration has no scopes).
  Tokens: ES256 JWTs for an hour (`OAUTH_SIGNING_KEY`, a private JWK in your secret store), checked against a revocation list
  on every request; refresh tokens rotate. Scopes: `read` for safe methods, `write` for the rest; the relay endpoints (`/mcp`, `/a2a`,
  `auth.relay`) need only `read`, since each call they make reaches a route that checks its own scope. In Access, only
  `/oauth/authorize` and `/oauth/claim` stay gated; `/oauth/register|token|revoke`, `/agent/identity*`, `/auth.md` and
  `/.well-known/*` bypass it.

## 8. Caching

- Data is a snapshot: a GET's ETag is `W/"hash(version, process start, URL, Accept)"`; `If-None-Match` → `304`. The start is in it so a deploy that changes an answer never confirms the old one. On Workers, pass the deploy's version id as `boot` (`snapshotEtag(v, { boot: env.CF_VERSION_METADATA.id })`) so every isolate of one deploy agrees. Writable routes
  (boards) opt out.
- `Cache-Control`: API `private, no-cache`; media `private, max-age=86400, immutable`; guides and OpenAPI
  `private, max-age=300`; any error `no-store`. **Anything behind auth is `private`, never `public`**: a CDN in front
  (Cloudflare caches `.png`, `.jpg`, `.svg` by extension) would otherwise serve it to anyone. Only discovery files and the
  front door's own page assets are `public`.

## 9. Cost and slow work

- A response that spent money says so: `meta.cost: { usd, cached }`. Paid results are cached by input hash, so the
  same request twice costs once.
- Slow or paid work answers `202 Accepted` with `Location: /api/v1/runs/{id}`; `GET` it until `status` is `done`
  (follow `_links.result`) or `failed`.
- The guards below keep their state where every instance of the app sees it: memory is right for one Node process;
  on Workers (an isolate each) they use the database (`dbGuardStore(db)`), never KV, which is eventually consistent.
- Every `POST` and `PATCH` honours `Idempotency-Key` (kept 24 h per caller): a retry gets the first answer
  (`Idempotent-Replayed: true`), the key with another body is a `422`, one in flight a `409`. `/openapi.json` documents
  the header on each of them.
- Paid routes sit behind `rateLimit` per caller, with the `RateLimit-Policy` / `RateLimit` headers and a `429` with
  `Retry-After` past the limit, so a looping agent can't drain the budget.
- Every model key is the app's own capped OpenRouter key, never a shared one; the
  cap answers `429 spend_cap`.

## 10. The agent guide

Templates in `apps/api/guide/`, served live with `{{origin}}`, `{{snapshot}}`, `{{counts.*}}` filled. On Workers the
folder is shipped as a module (`kit guide` → `src/guide.gen.ts`, served with `serveGuide({ files })`), and
a test fails when the module is older than the folder. **Anything the
code already knows is generated, never written by hand**, so the guide cannot drift from the API:

| Placeholder | Generated from |
|---|---|
| `{{api.endpoints}}`, `{{api.tag.<slug>}}` | `/openapi.json`: per tag, every operation as a working example call, what it is for, its query parameters (`*` required, enums, defaults), its body type and the schema it returns with its top-level fields |
| `{{api.unblock}}` | the kit: how to look a call or a field up in the spec, read an error, restart from `/api`, handle a `202` |
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
  as MCP prompts, and through the MCP Skills extension; copy the folder into the agent's skills folder to install.
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
  (`GET /api/v1/recipes/{id}`), so a gateway can tell which tool a guide or playbook means when it names a route.
- **Argument names follow the routes**: a tool's arguments are the route's query and path parameter names (`q`, not
  `query`; `slug` where the path says `{slug}`). Ids also accept the board ref form (`recipe:<slug>`); the route, not
  the tool, resolves it, trying the id as given first, so ids that hold a colon themselves (`step:<slug>`) work.
- **Tools are thin calls to the routes**, run in-process with the caller's credentials (`inProcess(app)`), so the API
  and MCP cannot drift. Names `snake_case` verbs (`search_recipes`); `title`, a description that says when to use it;
  `annotations` (read-only, idempotent, closed-world unless a tool writes or calls out); `outputSchema` = the route's
  2xx schema, with its JSON as `structuredContent`; a short text summary first; images as `resource_link`s.
- Errors are tool results with `isError: true` and the problem's one-line summary, never protocol errors.
- `instructions` on discover: what the server is for and the order to use tools in (not a repeat of descriptions).
  Cache hints: lists and discover cached an hour, `private`.
- Skills through the Skills extension (SEP-2640) and as prompts. A stdio wrapper (`overHttp(origin, key)`) runs the
  same tools from a laptop against the remote API.
- Auth is the API's: the same bearer key, or an OAuth token when the app runs `oauth.ts` (then MCP clients such as
  hosted chat apps connect with no key at all: the 401 on `/mcp` points at `/.well-known/oauth-protected-resource/mcp`).
  Never publish protected-resource metadata without a working authorization server: it sends clients into a flow that
  cannot succeed.
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
  leaves the task `TASK_STATE_WORKING` until `GetTask` finds it done. Tasks are kept a day, visible only to their
  caller. Requests must send `A2A-Version: 1.0` (absent means 0.3: `-32009`); streaming, push and the extended card
  answer the spec's errors and the card says they are off. Pick the one-call workflows as skills, not every tool.

## 12. Secrets and deployment

- Each app's secrets live in your secret store, scoped to that app (`API_KEY_<CLIENT>` values, `API_KEYS` hashes,
  capped model keys, a read-only storage key). Values never enter a repo, doc, commit or transcript.
- On your host as a container: the API runs with an allowlisted env (`container/entrypoint.sh`), behind Cloudflare
  Access with the bypass paths above; a separate job syncs any read-only store in.
- **Or on Cloudflare Workers** (`init --runtime cloudflare|both`): `wrangler.jsonc` pins `account_id` (the global
  wrangler login may be another account), D1 is the database, secrets go in with `wrangler secret put` (locally
  `.dev.vars`), and `pnpm run deploy` (never `pnpm deploy`, pnpm's own command) writes the guide module and the D1 migration files, applies them, then deploys.
  Deploy with a scoped token kept in the app's secrets.

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
| `/.well-known/poppy.json` (`discovery.poppy`) | Personal Agent Protocol 0.3: the organization (this host), its APIs and agent protocols, the issuer with scope hints |
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
  402/403 is a `SpendCapError` that stops the run, and a rerun resumes.
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
  tools if any); the browser app lives under `/app` behind Access (`ONLY_PATHS="app oauth/authorize oauth/claim"`);
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
  `PUT|DELETE /api/boards/{id}/items/{ref}` (idempotent; a note per item), and `/suggestions` when the app can say
  what is alike (e.g. the centroid of the board's look vectors). Writes need `write`.
- Agents get `list_boards`, `create_board`, `get_board`, `save_to_board`, `remove_from_board` (and
  `board_suggestions`). Browsers use the headless client and hooks; the UI is the app's.

