# api-kit

Hono + zod OpenAPI 3.1 APIs that agents can use without help: HAL links, problem+json errors, cursor pages, ETags,
per-client API keys and OAuth, discovery documents, an `llms.txt` guide whose code-derived parts are generated,
skills, an MCP server (spec 2026-07-28) and A2A over the same routes, a database layer on Drizzle, search by words,
picture and likeness over embeddings, and the headless browser side of all of it.

It ships as **parts you copy into your app**, shadcn-style: the app owns the code, `kit.json` records what came from
which kit version, and the CLI shows your edits next to the kit's changes. Every part carries its own README, so
the practices travel with the copy into `src/kit/<part>/README.md`.

| Word | Means |
|---|---|
| **part** | one installable unit (`core`, `mcp`, `boards`); the code calls it a module |
| **kit** | the set of parts in one repo: this one is `escalay/api-kit`, on npm as `@escalay/kit` |
| **preset** | a starting combination: `api` (an API), `app` (the API with a browser app beside it, on Cloudflare Workers) |

## Start a new API

```bash
npm create escalay my-api                        # the `api` preset, with an example `notes` feature
cd my-api && pnpm install && pnpm test && pnpm dev   # http://localhost:4400/docs, /llms.txt, /mcp
npx @escalay/kit feature reading-lists           # a new feature folder, listed and tested
npx @escalay/kit sdk                             # a typed TypeScript client in sdk/, a method per operation
```

`npm create escalay my-api -- --runtime node --title "My API"` passes flags on: `--runtime both|cloudflare|node`
(default `both`), `--preset api`, `--bare` (no example feature), `--yes` (it never asks; accepted for scripts).
`--preset selfhosted` is not built yet: it arrives with `escalay/selfhost-kit`.

On Workers, `pnpm run deploy:env` deploys with the account id, database ids and settings taken from the environment
(a secret store's `run`), so a repository that may go public holds none of them. Every app also ships a developer
skill, `<name>-agent-test`, for proving each route works for an agent that has never seen it.

Every new app lints with [oxlint](https://oxc.rs/docs/guide/usage/linter) and formats with
[oxfmt](https://oxc.rs/docs/guide/usage/formatter) (`pnpm lint`, `pnpm format`); the kit's copy in `src/kit/` and
generated files are left out of both. What `init` and `feature` write is in the kit's long-line style: the first
`pnpm format` rewrites it.

## Start an app with a browser side

```bash
npm create escalay my-tool -- --preset app       # the API plus web/: React, TanStack Router and Query, Tailwind
cd my-tool && pnpm install && pnpm migrations && pnpm test
pnpm dev                                         # Vite runs both sides: the app at /app/, the API everywhere else
pnpm run deploy                                  # guide, migrations, vite build, wrangler deploy: one Worker
```

One package, one Worker, on Cloudflare only. `src/` is the API exactly as the `api` preset makes it; `web/` is the
browser app, built by Vite with Cloudflare's plugin and served as the Worker's static files under `/app`. The Worker
answers every other path, so the API, the guide and MCP keep their addresses, and `/` sends people to `/app/`.

```
web/main.tsx, router.tsx   the entry and the router (base path /app)
web/routes/                one file per page (TanStack Router file routes; routeTree.gen.ts is written by Vite)
web/app.test.tsx           the browser app's tests, in happy-dom (a third Vitest project beside node and workers)
vite.config.ts             both sides in one dev server and one build
wrangler.jsonc             `assets`: only /app/ is left to the built files
```

What `init` makes:

```
src/server.ts            Node: env → openDb → createApp → listen
src/worker.ts            Workers: D1 → openDb → the same createApp (wrangler.jsonc, migrations/ for D1)
src/app.ts               the wiring only: auth + OAuth, every feature, the guide, MCP
src/features/index.ts    FEATURES, the one list (and the Feature shape)
src/features/<name>/     schema.ts · repo.ts · routes.ts · handlers.ts · tools.ts · index.ts · <name>.test.ts
src/kit/                 the copied kit (kit.json + a README per part)
guide/                   llms.txt and agents/*.md templates; {{api.endpoints}} and {{mcp.tools}} are generated
guide/skills/<name>/     the skill the product ships to agents that use it: served, offered over MCP, installable
.agents/skills/          skills for developing the repository (.claude/skills links here); never served
test/api.test.ts         every route linted, every MCP tool run (toolsRun), every guide placeholder filled
container/entrypoint.sh  the env allowlist: the API sees only the variables it reads
```

## The practices it enforces

1. **One shape per feature.** `schema.ts` (Drizzle tables + migration steps) · `repo.ts` (the only queries) ·
   `routes.ts` (contracts) · `handlers.ts` (request → repo → HAL) · `tools.ts` (MCP tools) · `index.ts`. The kit's
   own [`boards`](src/boards/README.md) is the reference.
2. **Only repos touch the database.** Moving off the local SQLite file (Turso, D1) changes how `openDb` is called,
   not the queries. A migration step never changes once it has run; existing tables are adopted with step 1.
3. **The API is the contract.** Every route documented (camelCase ids, descriptions an agent chooses by, examples,
   problem+json errors); unknown query parameters answer 400; errors say what to do next.
4. **MCP and A2A are thin calls to the routes**, so they can't drift; every tool runs in the tests (`toolsRun`).
5. **The guide writes only what the code can't know**; endpoint and tool lists are generated placeholders.
6. **Money is bounded**: embeddings and model calls go through ledgers that never pay twice, with budgets and capped
   keys; slow work answers 202 with a run.
7. **Private by default where it should be**: `private: true` hides everything behind credentials and says `noindex`.

The full standard: [docs/STANDARD.md](docs/STANDARD.md). Why the layout is what it is:
[docs/decisions/0001](docs/decisions/0001-features-drizzle-scaffold.md).

## Parts

| Part | What | README |
|---|---|---|
| `core` | `createAgentApi`: OpenAPI 3.1 + Scalar, HAL, problem+json, keys + Access, caching, Idempotency-Key, rate limits, discovery, a key-value store type; `newId`, `waitFor`, `Jobs` (a queue for later work) | [core](src/core/README.md) |
| `db` | the app's database through Drizzle: `openDb`, `migrate` per feature, `testDb` | [db](src/db/README.md) |
| `oauth` | the app as its own OAuth server (auth code + PKCE, agent registration via auth.md, ES256 tokens) | [oauth](src/oauth/README.md) |
| `pagination` | cursor pages and sorting | [pagination](src/pagination/README.md) |
| `guide` | the agent guide from templates and its generated parts | [guide](src/guide/README.md) |
| `mcp` | an MCP server over the routes: tools, resources, prompts, skills, its Server Card | [mcp](src/mcp/README.md) |
| `a2a` | A2A 1.0 over the MCP tools | [a2a](src/a2a/README.md) |
| `vectors` | Gemini Embedding 2 look and meaning vectors: ledgers that never pay twice, `nearest`, `standouts` | [vectors](src/vectors/README.md) |
| `vector-search` | search by words, picture and likeness: three routes and their tools | [vector-search](src/vector-search/README.md) |
| `web` | the front door: a public `/` or none, the browser app under `/app` | [web](src/web/README.md) |
| `keys` | API keys made and revoked through the app's own API beside `API_KEYS`, `GET /api/me`, their MCP tools | [keys](src/keys/README.md) |
| `boards` | the owner's collections of items with notes; `boardRef` / `parseBoardRef`; the reference feature shape | [boards](src/boards/README.md) |
| `telemetry` | a daily anonymous usage report (coarse ranges only) to the product's collector, the owner's switch, `GET /api/telemetry` showing exactly what is sent | [telemetry](src/telemetry/README.md) |
| `testing` | `lintOpenApi`, `guideRoutes`, `guideGaps`, `toolRoutes`, `toolsRun` | [testing](src/testing/README.md) |
| `search-client`, `search-react`, `vector-search-ui`, `boards-client`, `boards-react` | the browser side: typed clients, headless hooks, an optional shadcn block | [browser](src/browser/README.md) |

## Add parts to an existing app

```bash
npx @escalay/kit add core db oauth guide mcp testing --dir apps/api/src/kit --install
npx @escalay/kit list                                # parts, what they need, what's installed
npx @escalay/kit doctor --dir apps/api/src/kit       # missing, edited, behind: one line each with its fix; exits 1
npx @escalay/kit diff --dir apps/api/src/kit --patch # before upgrading
npx @escalay/kit update --dir apps/api/src/kit       # never overwrites your edits without --force
```

`--dir` defaults to `src/kit`. The app imports `./kit/index.js` and each entry part's folder (`./kit/mcp/index.js`,
`./kit/boards/index.js`, `./kit/testing/index.js`). Its container build needs nothing from this repo.

The browser parts go into the frontend. Either a kit of their own, or, in a repo that has both, `--web-dir`
(relative to `--dir`, remembered in `kit.json`) so one `kit.json` tracks the server and browser files:

```bash
npx @escalay/kit add search-react --dir apps/web/src/search
npx @escalay/kit add boards boards-react --dir src/kit --web-dir ../web
```

### One part with the shadcn CLI

The repo is a shadcn registry ([`registry.json`](registry.json), no build step). Each part is a universal item whose
files land in `src/kit/<part>/`, so no `components.json` is needed; parts it requires and npm packages come with it.

```bash
npx shadcn add escalay/api-kit/pagination          # core comes with it
npx shadcn add escalay/api-kit/vector-search-ui    # the search block; needs shadcn's button and input
npx @escalay/kit adopt                             # then write kit.json from what is on disk
```

The shadcn CLI writes no record, so run `adopt` once (or `doctor --adopt`): it records every part found in `--dir`
and writes the generated `index.ts`. A file you already changed shows as edited.

### What `kit.json` records

`src/kit/kit.json` is the lock file; there is no second one. It holds the kit it came from (`source`), the kit
`version`, the parts (`modules`), `webDir` when browser files live elsewhere, and a sha256 per file **as the kit
wrote it**. Comparing that hash with the file on disk and with the current kit is how `diff`, `update` and `doctor`
tell "you changed it" from "the kit changed it".

## Using it with agents

```bash
npx skills add escalay/api-kit
```

| Skill | Use it to |
|---|---|
| [`api-kit-build`](skills/api-kit-build/SKILL.md) | start a new API, move an app onto the kit, take a newer kit |
| [`api-kit-feature`](skills/api-kit-feature/SKILL.md) | add a feature folder: schema, repo, routes, handlers, tools, tests |
| [`api-kit-review`](skills/api-kit-review/SKILL.md) | check an API is agent-ready: the commands to run and what a failure means |
| [`npm-release`](skills/npm-release/SKILL.md) | set up or run releases of any npm package from GitHub Actions, or find out why one failed |

## Releases

Merging a pull request is the only manual step. Its title, a Conventional Commit, becomes a line of the release
notes; merging the release pull request publishes `@escalay/kit` and `create-escalay` to npm from GitHub Actions,
with provenance and no npm token. How it works, and how to set it up in another repo:
[docs/releasing.md](docs/releasing.md). `pnpm release:check` says whether a release is ready, and
`npx shadcn add escalay/api-kit/npm-release` copies the setup into another repo.

Working on the kit itself: [AGENTS.md](AGENTS.md). Licence: [MIT](LICENSE).
