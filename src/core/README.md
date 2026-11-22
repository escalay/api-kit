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
})
```

### The caller's address

A caller with no credentials is counted by its address: by `rateLimit`, by `Idempotency-Key` answers, and by the
setup claim. Name the one place it comes from with `address`; every guard and part reads it from the request
(`addressOf(c)`), and a `rateLimit({ address })` of its own wins.

| In front of the app | `address` |
|---|---|
| Cloudflare (Workers, or a tunnel or proxied DNS with the origin reachable only through it) | `{ header: 'cf-connecting-ip' }` |
| A reverse proxy that appends the connection's address to `X-Forwarded-For` on every request | `{ header: 'x-forwarded-for' }`; two such proxies in a row, `hops: 2` |
| Nothing, on Node (`@hono/node-server`) | `'socket'` |

- `{ header, hops = 1 }` takes the value `hops` from the right, the one your nearest proxy wrote; whatever a caller
  put before it is never read. No header, or fewer values than `hops`, is `local`.
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
| `auth.ts` | API keys (only hashes kept: `hashApiKey`, `mintApiKey`, `parseApiKeys`; `storedKeys` for keys the app makes and revokes itself, looked up by hash after the start list), Cloudflare Access, `authenticate`; `SCOPES`, `OAUTH_OPEN_PATHS` and the `OAuthServer` shape the oauth module fills |
| `cache.ts` | `snapshotEtag` (on Workers pass `boot: env.CF_VERSION_METADATA.id`), `CACHE` presets, `cacheControl` |
| `guards.ts` | `idempotency` (wired for you) and `rateLimit({ policy, limit, windowSeconds, store?, address?, key? })` for anything that spends money; both keep state in a `GuardStore`: `memoryGuardStore()` (default, one Node process) or `dbGuardStore(db)` from `db` (every instance shares it: required on Workers), passed as `createAgentApi({ guards: { store } })` and to each `rateLimit`. Both count per caller: an OAuth agent by its client and grant, never the name it registered, and a caller without credentials by `addressOf(c)` (`AddressTrust`, above) |
| `discovery.ts` | api-catalog, Link headers, robots.txt with Content Signals, Markdown for agents, skills index, Server Card, `serveAiCatalog` |
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
