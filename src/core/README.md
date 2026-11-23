# core

The API itself: `createAgentApi` builds an OpenAPIHono app that already follows the standard (problem+json errors,
HAL, auth, caching, discovery), so an app only adds its routes. Every other server module builds on it.

Needs: `hono`, `@hono/zod-openapi`, `zod`, `jose`, `@scalar/hono-api-reference`.

```ts
import { createAgentApi, parseApiKeys, problemResponses, HAL_JSON, linksOf, originOf, ProblemError } from './kit/index.js'

const app = createAgentApi({
  title: 'Notes', version: '1.0.0', description: 'What it is and where to start (Markdown).',
  tags: [{ name: 'Notes', description: 'The notes.' }],       // the workflow tag first: the generated guide follows tag order
  auth: { realm: 'notes', keys: parseApiKeys(env.API_KEYS), access },
  oauth,                                                        // optional: createOAuth(…) from the oauth module
  private: true,                                                // optional: nothing readable without credentials, noindex
  home: 'app',                                                  // optional: `/` sends people to the browser app at `/app/` (default: to `/docs`)
  address: { header: 'cf-connecting-ip' },                      // optional: where the caller's address comes from (below)
  brand: createBrand(BRAND, BRAND_ASSETS),                      // optional: the brand part; favicon, icons, x-logo, and what MCP, A2A, the guide and OAuth's pages read
})
```

### The caller's address

A caller with no credentials is counted by its address: by `rateLimit`, by `Idempotency-Key` answers, and by the
setup claim. Name the one place it comes from with `address`; every guard and part reads it from the request
(`addressOf(c)`), and a `rateLimit({ address })` of its own wins.

| In front of the app | `address` |
|---|---|
| Cloudflare (Workers, or a tunnel or proxied DNS with the origin reachable only through it) | `{ header: 'cf-connecting-ip' }` |
| A reverse proxy, with the app reachable only through it, that appends the connection's address to `X-Forwarded-For` on every request | `{ header: 'x-forwarded-for' }`; two such proxies in a row, `hops: 2` |
| Nothing, on Node (`@hono/node-server`) | `'socket'` |

- `{ header, hops = 1 }` takes the value `hops` from the right, the one your nearest proxy wrote; whatever a caller
  put before it is never read. No header, or fewer values than `hops`, is `local`.
- A named header is only as true as the path to the app: anyone who can reach the app without going through that proxy
  (an open port, another hostname, a second route in) sends the header themselves and picks their own address. Close
  every other way in, or use `'socket'`.
- Check that your proxy sets or appends the header on every request: one configured to pass it through untouched
  leaves it as the caller sent it, and `hops` then counts the caller's own values.
- `'socket'` is the connection; where there is none (Workers, `app.request`, a call made in-process) it is `local`,
  never a header.
- A port after the address (`203.0.113.4:5678`, `[2001:db8::1]:443`) is dropped. A global IPv6 address (2000::/3)
  counts by its /64; one that carries an IPv4 address (mapped `::ffff:…`, dotted or hex, and NAT64 `64:ff9b::/96`)
  counts as that IPv4 address; any other (loopback, link-local, unique local) counts whole.
- The default, `'headers'`, is the read before this option: `cf-connecting-ip`, else the whole `X-Forwarded-For`,
  as sent. A caller who can reach the app directly can send either, so set `address` on Node. `kit doctor` notes an
  app on `@hono/node-server` that names none.
- `rateLimit({ key })` replaces the caller in the bucket (`(c) => \`pack:${…}\``: per pack, per grant, per anything);
  `null` lets the call through uncounted.

| File | What |
|---|---|
| `api.ts` | `createAgentApi`: request ids, secure headers, CORS, auth, strict query parameters (unknown ones answer 400), `Idempotency-Key` replay, `/openapi.json`, `/docs`, `/problems/{code}`, `/api/health`, the discovery it can serve alone |
| `problem.ts` | RFC 9457: `ProblemError` (throw it), `PROBLEMS`, `problemResponses(400, 404…)` for a route's documented errors, `problemResponse` |
| `hal.ts` | `linksOf(origin, { self, next… })`, `originOf(c)` (the public origin behind proxies), `pathWith(path, query)`, `LinksSchema`, `HAL_JSON` |
| `auth.ts` | API keys (only hashes kept: `hashApiKey`, `mintApiKey`, `parseApiKeys`; `storedKeys` for keys the app makes and revokes itself, looked up by hash after the start list), Cloudflare Access, `authenticate` (with OAuth on, the 401 names `resource_metadata` and `scope="read write"`, a token `tokens` refuses for another resource is a 401 `invalid_token` saying why, and an agent's caller has the `resource` its token is for); `SCOPES`, `OAUTH_OPEN_PATHS` and the `OAuthServer` shape the oauth module fills (`mcpPath` sets the default relay). `open` and `relay` take path patterns (`matches`): an exact path, a trailing star for a prefix (`/skills/*`), a leading star for a suffix, and a star inside for one whole segment (`/s/*/mcp` matches `/s/alpha/mcp`, not `/s/alpha/mcp/x`). `auth.relay` replaces the default `[mcpPath, '/a2a']`: an app with one MCP per space passes `relay: ['/mcp', '/a2a', '/s/*/mcp']`. Upgrading: a star inside a pattern in `open`, `guards.skip` and `relay` was literal and matched nothing; it now matches one segment (`/a/*/b`, and `/a/**` matches `/a/x/y`), so check those lists for an inner or doubled star first. Exact, leading-star and trailing-star forms are unchanged, except in `relay`, which compared paths exactly before |
| `cache.ts` | `snapshotEtag` (on Workers pass `boot: env.CF_VERSION_METADATA.id`), `CACHE` presets, `cacheControl` |
| `guards.ts` | `idempotency` (wired for you) and `rateLimit({ policy, limit, windowSeconds, store?, address?, key? })` for anything that spends money; both keep state in a `GuardStore`: `memoryGuardStore()` (default, one Node process) or `dbGuardStore(db)` from `db` (every instance shares it: required on Workers), passed as `createAgentApi({ guards: { store } })` and to each `rateLimit`. Both count per caller: an OAuth agent by its client and grant, never the name it registered, and a caller without credentials by `addressOf(c)` (`AddressTrust`, above). `idempotency` keeps only a success (below 400): a refusal or a server error frees the key, so a retry after the cause is fixed runs again (`guards: { keep: (status) => status < 500 }` keeps refusals too, as before). It never keeps `/oauth/*` or `/agent/identity*`, whose answers hold tokens; an app's own open routes that answer a secret (a redirect holding a code) belong in `guards: { skip: ['/join/*'] }`, added to those |
| `discovery.ts` | api-catalog, Link headers, robots.txt with Content Signals, Markdown for agents, skills index, Server Card, `serveAiCatalog`, `publicOriginOf(app, c)` (the origin a publicly cached document names: the OAuth server's `publicOrigin` when set, else the request's) |
| `kv.ts` | `KeyValueStore` (values with expiry) and `memoryStore`, what OAuth and A2A keep |
| `ids.ts` | `newId(prefix)`: `<prefix>_<time><random>` ids that sort by when they were made; `randomLetters` |
| `wait.ts` | `waitFor(look, timeoutSeconds)`: long polling for a route that waits for something to happen (keep it under ~25 s) |
| `cli.ts` | the command line's names: `cliOf(tool)` and `resourceCli` (a tool's `<noun> <verb>`, positional arguments, examples), `fallbackCliName` (the route rule), `pathKeysOf` (the input keys a call puts in its path: the positional ones), `routeOf`, `hintsOf` (read-only only for a `GET`), `CLI_BUILT_INS` and `CLI_AUTH_VERBS`, and the `_meta` keys `CLI_META`, `PROBLEM_META`, `PENDING_META` |
| `jobs.ts` | `Jobs<Job>`: work done later at a delay. `queueJobs(env.JOBS)` on Workers (a Cloudflare Queue, delay capped at 12 h), `memoryJobs()` in tests. One message per attempt: a job that must run again sends itself again |

## Rules

- Every route is `createRoute` + `app.openapi`: camelCase `operationId`, a summary, a description whose first sentence
  says what it is for, described parameters with real examples, a named HAL response, `...problemResponses(…)`.
- Errors are thrown as `ProblemError('not_found', { detail })`; the detail says what to do next.
- A route that spends money answers 202 with a run when slow and carries a `rateLimit`.
- The standard behind all of this: `docs/STANDARD.md` §1–9, §12, §14.
