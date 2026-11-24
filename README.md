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
cd my-api && pnpm install && pnpm format && pnpm migrations && pnpm test && pnpm dev   # http://localhost:4400/docs, /llms.txt, /mcp
npx @escalay/kit feature reading-lists           # a new feature folder, listed and tested
npx @escalay/kit sdk                             # a typed TypeScript client in sdk/, a method per operation
gh repo create my-api --private --source . --push && npx @escalay/kit repo apply   # CI runs; the repository set up as §20 says
npx @escalay/kit button --check && npx @escalay/kit button --write                 # the Deploy to Cloudflare button, ready and in the README
pnpm add -D @resvg/resvg-js && npx @escalay/kit brand    # brand/ (a monogram to start) rendered: favicon, PNG icons, OG card
```

Every new app is a git repository with CI (`.github/workflows/ci.yml`), monthly Dependabot, a secrets scan, a
pre-push hook running `pnpm gate` (what CI runs), and Node and pnpm pinned; its `AGENTS.md` says how changes ship.

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
cd my-tool && pnpm install && pnpm format && pnpm migrations && pnpm test
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
src/features/<name>/     one feature, in the shape of docs/STANDARD.md §1, with its <name>.test.ts
src/kit/                 the copied kit (kit.json + a README per part)
guide/                   llms.txt and agents/*.md templates; {{api.endpoints}} and {{mcp.tools}} are generated
guide/skills/<name>/     the skill the product ships to agents that use it: served, offered over MCP, installable
.agents/skills/          skills for developing the repository (.claude/skills links here); never served
test/api.test.ts         every route linted, every MCP tool run (toolsRun), every guide placeholder filled
container/entrypoint.sh  the env allowlist: the API sees only the variables it reads
```

## The practices it enforces

1. **One shape per feature**, the files and what each holds: [docs/STANDARD.md §1](docs/STANDARD.md#1-stack-and-layout).
   The kit's own [`boards`](src/boards/README.md) is the reference.
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

[docs/PARTS.md](docs/PARTS.md) maps them: what each needs, where the app imports it from, its STANDARD sections, how
the parts depend on each other, and which parts a goal takes, in the order they go in.

<!-- parts:start: generated by `pnpm parts` from registry.json; edit that, never this table -->
| Part | What | README |
|---|---|---|
| `core` | createAgentApi: OpenAPI 3.1 + Scalar docs, HAL links, problem+json, API keys + Access, ETags and Cache-Control, Idempotency-Key and rate limits, discovery (api-catalog, Link headers, robots.txt, Markdown for agents), a key-value store type, sortable ids (`newId`), long-poll waits (`waitFor`) and later work through a queue (`Jobs`: `queueJobs`, `memoryJobs`); an OAuth server plugs in from the `oauth` part | [core](src/core/README.md) |
| `db` | The app's database through Drizzle: `openDb` (node:sqlite, Turso/libSQL, or any async Drizzle SQLite database), `migrate` (each feature's steps, recorded in `kit_migrations`), `testDb`; `dbGuardStore` (idempotency and rate limits shared by every instance) | [db](src/db/README.md) |
| `oauth` | The app as its own OAuth server: metadata, `/oauth/*`, agent registration (auth.md), ES256 tokens; `createOAuth` (with `approve`, `onGrant`, `onRevoke`, `ticketOf`, `answeredOf`, `complete`: the app's own sign-in page), `dbOAuthStore`, `memoryOAuthStore`, `generateOAuthKey` | [oauth](src/oauth/README.md) |
| `pagination` | Cursor pages and sorting: limitQuery, cursorQuery, sortQuery, pageOf, pageSchema | [pagination](src/pagination/README.md) |
| `guide` | The agent guide from Markdown templates (llms.txt, agents/, skills/), its generated parts (endpoints, tools, playbooks, how to get unstuck) and the skills discovery index | [guide](src/guide/README.md) |
| `mcp` | An MCP server (2026-07-28) over the app's own routes: tools, resources, prompts, skills, and its Server Card; each tool publishes its command-line name | [mcp](src/mcp/README.md) |
| `a2a` | A2A 1.0 over the MCP tools: the Agent Card at /.well-known/agent-card.json and a JSON-RPC endpoint (SendMessage, GetTask, ListTasks, CancelTask) whose skills are tools | [a2a](src/a2a/README.md) |
| `vectors` | Gemini Embedding 2 through OpenRouter: look (image) and meaning (text) vectors, append-only ledgers that never pay twice, budgets and spend caps, nearest and standouts search (sharp, for pictures only) | [vectors](src/vectors/README.md) |
| `vector-search` | Search by words, by picture and by likeness over the vectors: three documented routes (rate-limited where they cost) and the MCP tools that call them | [vector-search](src/vector-search/README.md) |
| `web` | The front door: a public landing page at /, the browser app under /app behind the sign-in, old addresses redirected, and the paths auth must leave open | [web](src/web/README.md) |
| `brand` | One brand on every surface: defineBrand (the app's brand/brand.ts) and createBrand for createAgentApi({ brand }): the favicon, PNG and SVG icons, manifest and OG card rendered at build time by `kit brand`, and MCP serverInfo, the Server Card, OpenAPI x-logo, the A2A card, the guide and head tags read it | [brand](src/brand/README.md) |
| `boards` | The owner's collections of the app's items: boards with notes in SQLite, their routes (idempotent saves, where an item is saved, optional suggestions) and MCP tools | [boards](src/boards/README.md) |
| `keys` | API keys made and revoked through the app's own API beside `API_KEYS` (hashes only, first characters, maker, last use), `GET /api/me`, and the MCP tools; only deployment keys and signed-in people manage keys | [keys](src/keys/README.md) |
| `people` | The owner and members of a deployment: passkey sign-in with an HttpOnly session cookie (hash stored), Access members matched to the team by email or domain, roles (owner, member), the team routes and MCP tools | [people](src/people/README.md) |
| `setup` | Claiming a fresh deployment with the SETUP_CODE secret (fails closed, rate-limited), recovery by rotating it, and a self-checking setup checklist of the app's own steps | [setup](src/setup/README.md) |
| `telemetry` | A daily anonymous usage report to the product's collector (`{ schema, instance, version, report }`, coarse ranges and booleans only), off with `DO_NOT_TRACK=1`, `TELEMETRY=off` or the owner's switch; `GET`/`PATCH /api/telemetry` and its MCP tool | [telemetry](src/telemetry/README.md) |
| `switches` | One catalog of the app's additive features (`defineFeatures`, stable kebab-case keys), each on or off for everyone, one person or one API key; providers in order (`databaseProvider`, `memoryProvider`, `fromSdk` for any flag service), `FEATURES_OFF` locks, `needs`, `requires` and offline license keys (`licenseOf`, ES256, `kit license`) for paid features; `gated` routes answer 403 `feature_disabled`, `isOn` for background work; `GET`/`PATCH /api/features` and its MCP tools | [switches](src/switches/README.md) |
| `testing` | Checks for an app's tests: lintOpenApi, guideRoutes, guideGaps, toolRoutes, toolsRun, cliGaps and cliSnapshot (the command line), softAuthenticator (passkeys in CI) and approveSignIn (an OAuth approval as a browser makes it) | [testing](src/testing/README.md) |
| `search-client` | Browser, no framework: a typed client for vector-search's routes, a controller for one search's state (debounced, cancelling), paste and drop of pictures | [browser](src/browser/README.md) |
| `search-react` | Browser, React: useVectorSearch, usePictureInput, useSimilar over search-client; headless, each app draws its own UI | [browser](src/browser/README.md) |
| `vector-search-ui` | Browser, React + shadcn: an optional search block (field with a picture chip, look/meaning switch, results grid) over search-react | [browser](src/browser/README.md) |
| `switches-client` | Browser, no framework: the features for the person signed in from `GET /api/features` (createFeaturesClient: getState, subscribe, isOn, refresh on focus, switch with dryRun, onDisabled and watchFetch for every 403 feature_disabled), isFeatureDisabled, whyOff | [browser](src/browser/README.md) |
| `switches-react` | Browser, React: FeaturesProvider, useFeature, `<Feature>` (children while on, `off` while not), useFeatures, useSwitchFeature (preview and apply), useFeatureDisabled, featureHooks typed by the app's keys; headless | [browser](src/browser/README.md) |
| `switches-ui` | Browser, React + shadcn: FeatureSwitches (every feature with its switch, a confirm naming what else stops; read-only for members) and FeatureDisabledNotice ("This feature is disabled.", why, the app's own action) over switches-react | [browser](src/browser/README.md) |
| `boards-client` | Browser, no framework: a typed client for the board routes | [browser](src/browser/README.md) |
| `boards-react` | Browser, React: useBoards, useItemBoards over boards-client (headless) | [browser](src/browser/README.md) |
<!-- parts:end -->

## Add parts to an existing app

```bash
npx @escalay/kit add core db oauth guide mcp testing --dir apps/api/src/kit --install
npx @escalay/kit list                                # parts, what they need, what's installed
npx @escalay/kit doctor --dir apps/api/src/kit       # missing, edited, behind: one line each with its fix; exits 1
npx @escalay/kit upgrading --dir apps/api/src/kit   # what changed for your parts since kit.json's version
npx @escalay/kit diff --dir apps/api/src/kit --patch # before upgrading
npx @escalay/kit update --dir apps/api/src/kit       # never overwrites your edits without --force
```

What changes for an app between versions, part by part: [docs/upgrading.md](docs/upgrading.md). How `update` treats
your edits, and what to do when it exits 1: [Taking a new version](docs/upgrading.md#taking-a-new-version).

`--dir` defaults to `src/kit`. The app imports `./kit/index.js` and each entry part's folder (`./kit/mcp/index.js`,
`./kit/testing/index.js`). Its container build needs nothing from this repo.

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

<!-- skills:start: generated by `pnpm parts` from each skill’s frontmatter; edit that, never this table -->
| Skill | Use it when |
|---|---|
| [`api-kit-build`](skills/api-kit-build/SKILL.md) | starting a new HTTP API that agents should use without help, moving an existing Hono app onto the Escalay api-kit, adding a kit part to an app (sign-in for a team and its owner, OAuth approval by invite, feature switches, boards, search by words or pictures, usage reports, a brand, a front page, the Deploy to Cloudflare button), deciding who may see what, or taking a newer kit version into an app. |
| [`api-kit-cli`](skills/api-kit-cli/SKILL.md) | giving an API built on the Escalay api-kit its command line, naming its MCP tools as commands, writing a job (one command for a playbook step), or fixing what cliGaps reports. |
| [`api-kit-feature`](skills/api-kit-feature/SKILL.md) | adding a feature (a resource with routes, data and MCP tools) to an API built on the Escalay api-kit, making a feature one the owner can switch off, or reshaping existing routes into the kit's feature folder. |
| [`api-kit-part`](skills/api-kit-part/SKILL.md) | working in the escalay/api-kit repository itself - adding a part, changing what a part ships, needs or exports, adding a browser layer (a client, React hooks, a shadcn block), or deciding whether new apps start with a part. |
| [`api-kit-review`](skills/api-kit-review/SKILL.md) | checking whether an API built on the Escalay api-kit is ready for agents, before a release or a first deploy, after a refactor or a kit update, when an agent stalled on it, or when checking its sign-ins, invites, feature switches, usage report, repository settings, Deploy to Cloudflare button or brand. |
| [`api-kit-skills`](skills/api-kit-skills/SKILL.md) | a product built on the Escalay api-kit needs its own skills - playbooks its users' agents load to do a job with it, or skills for the people developing it - or when its existing skills are stale, generic, or agents still stall on its API. |
| [`npm-release`](skills/npm-release/SKILL.md) | setting up or running releases of an npm package from GitHub Actions with release-please and npm trusted publishing (no npm token, provenance, a release pull request), or when diagnosing a release that failed or a version that did not appear on npm. |
<!-- skills:end -->

## Releases

Merging a pull request is the only manual step. Its title, a Conventional Commit, becomes a line of the release
notes; merging the release pull request publishes `@escalay/kit` and `create-escalay` to npm from GitHub Actions,
with provenance and no npm token. How it works, and how to set it up in another repo:
[docs/releasing.md](docs/releasing.md). `pnpm release:check` says whether a release is ready, and
`npx shadcn add escalay/api-kit/npm-release` copies the setup into another repo.

Working on the kit itself: [AGENTS.md](AGENTS.md). Licence: [MIT](LICENSE).
