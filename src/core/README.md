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
})
```

| File | What |
|---|---|
| `api.ts` | `createAgentApi`: request ids, secure headers, CORS, auth, strict query parameters (unknown ones answer 400), `Idempotency-Key` replay, `/openapi.json`, `/docs`, `/problems/{code}`, `/api/health`, the discovery it can serve alone |
| `problem.ts` | RFC 9457: `ProblemError` (throw it), `PROBLEMS`, `problemResponses(400, 404…)` for a route's documented errors, `problemResponse` |
| `hal.ts` | `linksOf(origin, { self, next… })`, `originOf(c)` (the public origin behind proxies), `pathWith(path, query)`, `LinksSchema`, `HAL_JSON` |
| `auth.ts` | API keys (only hashes kept: `hashApiKey`, `mintApiKey`, `parseApiKeys`; `storedKeys` for keys the app makes and revokes itself, looked up by hash after the start list), Cloudflare Access, `authenticate`; `SCOPES`, `OAUTH_OPEN_PATHS` and the `OAuthServer` shape the oauth module fills |
| `cache.ts` | `snapshotEtag` (on Workers pass `boot: env.CF_VERSION_METADATA.id`), `CACHE` presets, `cacheControl` |
| `guards.ts` | `idempotency` (wired for you) and `rateLimit({ policy, limit, windowSeconds, store? })` for anything that spends money; both keep state in a `GuardStore`: `memoryGuardStore()` (default, one Node process) or `dbGuardStore(db)` from `db` (every instance shares it: required on Workers), passed as `createAgentApi({ guards: { store } })` and to each `rateLimit` |
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
