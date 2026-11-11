# api-kit

A standard for agent-ready HTTP APIs and the parts that implement it. **The standard:
[`docs/STANDARD.md`](docs/STANDARD.md)** — read it before changing anything here or building an API on it. Apps copy
the parts in with `cli.mjs` (npm: `@escalay/kit`, bin `kit`) or the shadcn CLI (`registry.json` lists them); no app
imports this repo as a library.

Words: a **part** is one installable unit (a folder under `src/`; the code and `kit.json` say module), the **kit** is
the set in this repo, a **preset** is a starting combination (`init --preset`).

## Layout

Every part is a folder under `src/`. A feature with routes and data keeps one shape (`boards/` is the model, and
what `feature` generates): `schema.ts` (Drizzle tables + migration steps) · `repo.ts` (the only queries) ·
`routes.ts` (createRoute contracts) · `handlers.ts` (request → repo → HAL) · `tools.ts` (MCP tools) · `index.ts`
(`registerX` wiring them, and the part's exports).


| Path | What |
|---|---|
| `src/core/api.ts` | `createAgentApi`: OpenAPIHono with request ids, secure headers, auth, problem handlers, `/openapi.json` (3.1), `/docs` (Scalar), `/problems/{code}`, `/api/health`, and the discovery it can serve alone |
| `src/core/discovery.ts` | api-catalog, Link headers, robots.txt with Content Signals, Markdown for agents, skills index + archives, Server Card, AI Catalog (`serveAiCatalog`) |
| `src/core/guards.ts` | `idempotency` (Idempotency-Key on POST/PATCH, wired by `createAgentApi`) and `rateLimit` (per caller, RateLimit headers) |
| `src/core/hal.ts` | HAL links: `originOf`, `linksOf`, `pathWith`, `LinksSchema` |
| `src/core/problem.ts` | RFC 9457 problems: `PROBLEMS`, `ProblemError`, `problemResponses`, `validationHook` |
| `src/pagination/index.ts` | cursor pages: `limitQuery`, `cursorQuery`, `pageOf`, `pageSchema` |
| `src/core/auth.ts` | API keys (hash-only), Access JWT check, `authenticate` |
| `src/db/index.ts` | the database through Drizzle: `openDb` (node:sqlite via the `sqlite-proxy` driver, rows as arrays; or a Drizzle database passed in), `migrate` (per-feature steps in `kit_migrations`, each in a transaction), `testDb` |
| `src/core/kv.ts` | `KeyValueStore` + `memoryStore`: what OAuth and A2A keep |
| `src/oauth/` | the app as its own OAuth server: metadata, `/oauth/*`, `/agent/identity*` (auth.md), ES256 tokens; `createOAuth`, `memoryOAuthStore`, `dbOAuthStore`, `generateOAuthKey`; its own part (core only needs `OAuthServer`, `SCOPES`, `OAUTH_OPEN_PATHS` from `auth.ts`) |
| `src/core/cache.ts` | snapshot ETags, `Cache-Control` presets |
| `src/guide/guide.ts` | `/llms.txt`, `/llms-full.txt`, `/agents/*`, `/skills/*` from templates, filled per request |
| `src/guide/reference.ts` | the generated guide parts: endpoints from the spec, tools with their routes, playbooks, how to get unstuck |
| `src/a2a/index.ts` | A2A 1.0 over the MCP tools: `mountA2A` (Agent Card + JSON-RPC `/a2a`), `agentCard` |
| `src/mcp/index.ts` | MCP 2026-07-28 over the routes: `mcpTool`, `mcpResource`, `mcpServerFactory`, `inProcess`, `overHttp`, `mountMcp` (+ Server Card) |
| `src/testing/index.ts` | `lintOpenApi`, `guideRoutes`, `guideGaps`, `toolRoutes`, `toolsRun` |
| `src/vectors/index.ts` | Gemini Embedding 2 via OpenRouter: `createEmbedder`, ledgers (`embedMissing`, `readLedger`), `vectorSpace`, `nearest`, `standouts`; `hashOf` must stay byte-compatible with the ledgers already paid for (test pins it) |
| `src/vector-search/index.ts` | `registerVectorSearch` (words, picture, likeness routes), `vectorSearchTools` |
| `src/web/index.ts` | the front door: `serveFrontDoor`, `frontDoorOpen` |
| `src/boards/` | `registerBoards` (the owner's collections in SQLite), `boardTools`; browser: `src/browser/boards-client.ts`, `src/browser/boards-react.ts`; `src/boards/refs.ts` (`boardRef`, `parseBoardRef`) is copied with both `boards` and `boards-client` |
| `src/browser/search-client.ts`, `src/browser/search-react.ts`, `src/browser/vector-search-block.tsx` | browser parts (`meta.web` in `registry.json`): headless client and controller, React hooks, the optional shadcn block. Typechecked by `tsconfig.web.json` (bundler resolution, `erasableSyntaxOnly`); the block's shadcn imports resolve to `test/shadcn/` stand-ins |
| `registry.json` | the parts, as a shadcn registry read straight from GitHub (no build step): one `registry:item` per part, each file a `registry:file` with its `target` under `~/src/kit/`, npm `dependencies` as `name@range` (a bare name is a peer), other parts as `registryDependencies` (`escalay/api-kit/<part>`), `meta.entry` / `meta.web` for the CLI |
| `cli.mjs` | `add`, `list`, `diff`, `update`, `doctor`, `adopt`, `init`, `feature`, `guide` (the guide folder as a module for Workers; must write exactly `guideModuleSource`) (plain JS: it runs from `npx` without a build). Reads the parts from `registry.json`. Copies mirror `src/`'s folders; `--web-dir` puts the browser files in their own folder under the same `kit.json`. `kit.json` is the lock: a sha256 per file as the kit wrote it; `doctor` reports missing, edited and behind, `adopt` writes it for parts the shadcn CLI copied |
| `packages/create-escalay` | `npm create escalay <name>`: hands its arguments to `init` |
| `scripts/starter-check.mjs` | `pnpm test:starter`: scaffolds an app in the OS temp folder, installs it, runs its typecheck and tests (CI runs it) |
| `skills/` | `api-kit-build`, `api-kit-feature`, `api-kit-review`, installed with `npx skills add escalay/api-kit`; a test checks their frontmatter, length and commands |
| `templates/runtime-cloudflare` | what `init --runtime cloudflare|both` adds: `worker.ts`, `wrangler.jsonc`, `scripts/migrations.ts`, the workerd test project |
| `templates/app`, `templates/feature` | what `init` and `feature` copy, `__placeholders__` filled from the name (`namesOf` in `cli.mjs`). Never typechecked or tested in place: the generator test in `test/kit.test.ts` makes an app under `test/.generated/`, typechecks it and runs its tests |
| `test/a2a.test.ts`, `test/oauth.test.ts` | the A2A card and methods; OAuth flows, scopes and metadata |
| `test/kit.test.ts` | a sample API through every rule, discovery, the generated guide, the CLI (add, diff, update, doctor, adopt, init), the registry (every part and file listed), the skills, an MCP round trip |
| `test/workers/` | the `workers` Vitest project, run inside workerd (`@cloudflare/vitest-plugin`): `worker.ts` imports the whole kit at global scope and serves a probe app over D1, so a Node-only top-level import or a random value at global scope stops it starting; `smoke.test.ts` checks it, D1 migrations and `testDb` |
| `test/vectors.test.ts`, `test/vector-search.test.ts`, `test/web.test.ts` | ledgers and search; the search routes and tools over `test/logos-fixture.ts`; the front door |
| `test/search-client.test.ts`, `test/search-ui.test.tsx` | the browser client and controller; the hooks and block in happy-dom |

## Commands

`pnpm install` · `pnpm test` (both projects: `node`, and `workers` inside workerd; one alone: `--project <name>`) ·
`pnpm typecheck` (Node, browser, Workers) · `pnpm test:starter` (needs the network) · `pnpm exec wrangler dev -c test/workers/wrangler.jsonc` (the probe app,
for a look at the kit on Workers by hand)

## Using it from another repo

- `npx @escalay/kit add <parts…> --dir <app>/src/kit --install`, or one part with
  `npx shadcn add escalay/api-kit/<part>` and then `npx @escalay/kit adopt` (the README has the rest). The app imports
  `./kit/index.js` and each entry part's folder (`./kit/mcp/index.js`, `./kit/boards/index.js`,
  `./kit/testing/index.js`); its container build needs nothing from this repo.
- A new app: `npm create escalay <name>` (`init <dir>`); a new feature in it: `feature <plural-name>`.
- The app owns the copy. Before taking a new kit version: `doctor`, `diff --patch`, then `update`; edits are kept unless
  `--force`. A fix that belongs to every app goes back into the kit, with a test.

## Releasing

1. Change, test, update `docs/STANDARD.md` when a rule changes, and `registry.json` when a part's files or
   dependencies change (a test fails when a file under `src/` is not listed).
2. Bump `version` in `package.json` (the CLI stamps it into each app's `kit.json`) and in
   `packages/create-escalay/package.json`, commit, tag `vX.Y.Z` (`-a -m`), push with the tag. Publish with
   `pnpm publish -r` (it rewrites `workspace:^`).
3. Apps take it with `diff` + `update` deliberately; nothing follows `main`.

## Rules

- Every part's folder has a `README.md` (what it is for, what it needs, an example, its exports, its rules, the
  STANDARD section). It ships with the part, so change it with the code; a part without one is unfinished.

- A rule lives in `docs/STANDARD.md` and the code that enforces it, never only in one of them.
- Every export has a JSDoc with an example; every rule has a test in `test/`.
- Keep app-specific things (schemas, routes, guides) in the apps.
