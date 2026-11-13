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
| `src/core/cli.ts` | the command line's names: `cliOf` / `resourceCli` (`<noun> <verb>`, positional arguments, examples), `fallbackCliName` (the route rule), `routeOf`, `hintsOf`, the `_meta` keys; shared by `mcp` (publishes) and `testing` (audits), so `testing` needs no `mcp` |
| `src/core/kv.ts` | `KeyValueStore` + `memoryStore`: what OAuth and A2A keep |
| `src/oauth/` | the app as its own OAuth server: metadata, `/oauth/*`, `/agent/identity*` (auth.md), ES256 tokens; `createOAuth`, `memoryOAuthStore`, `dbOAuthStore`, `generateOAuthKey`; its own part (core only needs `OAuthServer`, `SCOPES`, `OAUTH_OPEN_PATHS` from `auth.ts`) |
| `src/core/cache.ts` | snapshot ETags, `Cache-Control` presets |
| `src/guide/guide.ts` | `/llms.txt`, `/llms-full.txt`, `/agents/*`, `/skills/*` from templates, filled per request |
| `src/guide/reference.ts` | the generated guide parts: endpoints from the spec, tools with their routes, playbooks, how to get unstuck |
| `src/a2a/index.ts` | A2A 1.0 over the MCP tools: `mountA2A` (Agent Card + JSON-RPC `/a2a`), `agentCard` |
| `src/mcp/index.ts` | MCP 2026-07-28 over the routes: `mcpTool`, `mcpResource`, `mcpServerFactory`, `inProcess`, `overHttp`, `mountMcp` (+ Server Card), `mountedMcp`; `_meta["api-kit/cli"]` on each tool and template, `_meta["api-kit/problem"]` on a failed call |
| `src/mcp/skills.ts` | `guideSkills`: the guide's skill folders as the factory's skills and prompts, one prompt per playbook; `attachSkills` (the factory calls it): the extension plus what a plain client needs (listed files, a described template, folder reads as lists) |
| `src/testing/index.ts` | `lintOpenApi`, `guideRoutes`, `guideGaps`, `toolRoutes`, `toolsRun`; `src/testing/cli.ts`: `cliGaps`, `cliSnapshot` |
| `src/vectors/index.ts` | Gemini Embedding 2 via OpenRouter: `createEmbedder`, ledgers (`embedMissing`, `readLedger`), `vectorSpace`, `nearest`, `standouts`; `hashOf` must stay byte-compatible with the ledgers already paid for (test pins it) |
| `src/vector-search/index.ts` | `registerVectorSearch` (words, picture, likeness routes), `vectorSearchTools` |
| `src/telemetry/` | `telemetry({ product, schemaVersion, version, url, collect })` → `register` (`GET`/`PATCH /api/telemetry`), `sendDaily` (for the scheduled handler), `bodyOf`; `countRange`, `dayRange`, `coarseReport`; `telemetryTools` |
| `src/web/index.ts` | the front door: `serveFrontDoor`, `frontDoorOpen` |
| `src/boards/` | `registerBoards` (the owner's collections in SQLite), `boardTools`; browser: `src/browser/boards-client.ts`, `src/browser/boards-react.ts`; `src/boards/refs.ts` (`boardRef`, `parseBoardRef`) is copied with both `boards` and `boards-client` |
| `src/browser/search-client.ts`, `src/browser/search-react.ts`, `src/browser/vector-search-block.tsx` | browser parts (`meta.web` in `registry.json`): headless client and controller, React hooks, the optional shadcn block. Typechecked by `tsconfig.web.json` (bundler resolution, `erasableSyntaxOnly`); the block's shadcn imports resolve to `test/shadcn/` stand-ins |
| `registry.json` | the parts, as a shadcn registry read straight from GitHub (no build step): one `registry:item` per part, each file a `registry:file` with its `target` under `~/src/kit/`, npm `dependencies` as `name@range` (a bare name is a peer), other parts as `registryDependencies` (`escalay/api-kit/<part>`), `meta.entry` / `meta.web` for the CLI. A **root item** (`meta.root`, today `npm-release`) is repo setup, not a part: its files come from outside `src/`, go to the repo root, and only the shadcn CLI installs it (`list` names it, `add` refuses it, `adopt` and `doctor` never see it) |
| `cli.mjs` | `add`, `list`, `diff`, `update`, `doctor` (also `cliGaps` when the kit folder sits in an installed app), `adopt`, `init`, `feature`, `guide` (the guide folder as a module for Workers; must write exactly `guideModuleSource`), `sdk` (the client and the CLI), `cli` (the CLI for an app with `sdk/`; `--update` replaces only `sdk/cli/engine`), `repo` (the GitHub repository's settings and rules through `gh`, `check`/`apply`; `test/repo.test.ts` runs it against `test/fixtures/fake-gh.mjs`) (plain JS: it runs from `npx` without a build). Reads the parts from `registry.json`. Copies mirror `src/`'s folders; `--web-dir` puts the browser files in their own folder under the same `kit.json`. `kit.json` is the lock: a sha256 per file as the kit wrote it; `doctor` reports missing, edited and behind, `adopt` writes it for parts the shadcn CLI copied |
| `packages/create-escalay` | `npm create escalay <name>`: hands its arguments to `init` |
| `scripts/starter-check.mjs` | `pnpm test:starter`: scaffolds one app per preset in the OS temp folder, installs it, runs its typecheck, lint and tests, and for `app` the build and a dry-run deploy (CI runs it). Lint runs here and not in `test/kit.test.ts`: oxlint finds no files under the git-ignored `test/.generated/` |
| `scripts/release-check.mjs` | `pnpm release:check`: read-only; clean tree on `main`, one version across the public packages, what each tarball holds, whether the version is on npm, whether npm trusts `release.yml`. Generic: it ships in `npm-release` |
| `scripts/release-smoke.sh` | what `release.yml` runs after publishing: `npm create escalay@<version>`, install, test |
| `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json` | the release: release-please keeps the release pull request, then the publish job. The workflow names no package, because `npm-release` installs this same file in other repos |
| `skills/` | `api-kit-build`, `api-kit-cli` (the command line: names, jobs, `cliGaps`), `api-kit-feature`, `api-kit-review`, `api-kit-skills` (writing a product's own skills from tests of what agents get wrong), `npm-release` (releases, for any npm package repo), installed with `npx skills add escalay/api-kit`; a test checks their frontmatter, length and commands |
| `templates/sdk` | what `kit sdk` adds: `sdk/` (the fetch-only client, its coverage test) and `scripts/openapi.ts` (the document and `sdk/cli/commands.json`). `sdk/cli/engine/` is the CLI engine (Node 20.10+, built-ins only, no placeholders, so `test/cli.test.ts` imports and typechecks it in place); `sdk/cli/bin.ts`, `jobs/`, `commands.json`, `tsconfig.json` (its own: Node types, `dist/cli`) and `sdk/test/cli.test.ts` are filled per app |
| `templates/npm-release` | the blank release-please config and manifest `npm-release` installs; a test keeps the config equal to this repo's, minus its bootstrap commit and extra files |
| `templates/runtime-cloudflare` | what `init --runtime cloudflare|both` adds: `worker.ts`, `wrangler.jsonc`, `scripts/migrations.ts`, the workerd test project |
| `templates/preset-app` | what `init --preset app` adds (Cloudflare only): the browser app in `web/` (React, TanStack Router and Query, Tailwind), `index.html`, `vite.config.ts` (Vite with Cloudflare's plugin runs and builds both sides), `tsconfig.web.json`. Its files are kept formatted with the app's `oxfmtrc.json`. What it changes in shared files is lines marked `// preset:app` or `<!-- preset:app -->` in `templates/app` and `templates/runtime-cloudflare` (`init` keeps a marked line only in an app that has that preset or runtime) |
| `templates/app/github`, `githooks`, `node-version`, `gitleaks.toml` | every app's CI (`.github/workflows/ci.yml`: `pnpm check` and `pnpm test`, actionlint and zizmor, gitleaks, the title), `.githooks/pre-push` (`pnpm gate`, which is `check` + `test`; `scripts/hooks.ts` points git at it on install, only at a repository's root), monthly Dependabot, the secrets scan's allowlist, and the kit's Node. `check` per runtime is built by `scriptsFor` in `cli.mjs`; `init` runs `git init` unless the folder is already in a repository (`--no-git`). `scripts/starter-check.mjs` runs `gate` on each starter |
| `templates/app/skills.sh.json` | points `npx skills add <repository>` at `guide/skills/`; without it the installer stops at `.agents/skills/` and offers only developer skills |
| `templates/app/guide/skills/__name__`, `templates/app/agents-skills` | the two places for a product's skills: the skill it ships to its users' agents, and (copied to `.agents/skills/`, with `.claude/skills` linked to it by `init`) the skills for developing the repository |
| `templates/app`, `templates/feature` | what `init` and `feature` copy, `__placeholders__` filled from the name (`namesOf` in `cli.mjs`). Never typechecked or tested in place: the generator test in `test/kit.test.ts` makes an app under `test/.generated/`, typechecks it and runs its tests |
| `test/cli.test.ts` | the CLI engine run in-process against a sample app (its `fetch` is `app.request`): snapshot equals the live commands, help, `--json`, exit codes, `--yes`, `--input`, resources, jobs, device sign-in with refresh, `cliGaps` on the kit's own parts |
| `test/a2a.test.ts`, `test/oauth.test.ts` | the A2A card and methods; OAuth flows (code + PKCE, refresh families, agent claim, device grant), scopes and metadata |
| `test/telemetry.test.ts` | the usage report: the body sent, the daily schedule, every switch, coarse values only, routes and tool |
| `test/kit.test.ts` | a sample API through every rule, discovery, the generated guide, the CLI (add, diff, update, doctor, adopt, init), the registry (every part and file listed), the skills, an MCP round trip |
| `test/workers/` | the `workers` Vitest project, run inside workerd (`@cloudflare/vitest-plugin`): `worker.ts` imports the whole kit at global scope and serves a probe app over D1, so a Node-only top-level import or a random value at global scope stops it starting; `smoke.test.ts` checks it, D1 migrations and `testDb` |
| `test/vectors.test.ts`, `test/vector-search.test.ts`, `test/web.test.ts` | ledgers and search; the search routes and tools over `test/logos-fixture.ts`; the front door |
| `test/search-client.test.ts`, `test/search-ui.test.tsx` | the browser client and controller; the hooks and block in happy-dom |

## Commands

`pnpm install` · `pnpm test` (both projects: `node`, and `workers` inside workerd; one alone: `--project <name>`) ·
`pnpm typecheck` (Node, browser, Workers) · `pnpm test:starter` (needs the network) · `pnpm release:check` (needs the network) · `pnpm exec wrangler dev -c test/workers/wrangler.jsonc` (the probe app,
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

[`docs/releasing.md`](docs/releasing.md) is the standard; nothing is bumped, tagged or published by hand.

1. Change, test, update `docs/STANDARD.md` when a rule changes, and `registry.json` when a part's files or
   dependencies change (a test fails when a file under `src/` is not listed).
2. Open a pull request whose title is a Conventional Commit that reads well in release notes (CI checks it), and
   squash-merge it.
3. Merge the release pull request (`chore(main): release X.Y.Z`) to publish: it bumps `package.json` (the CLI
   stamps that version into each app's `kit.json`) and `packages/create-escalay/package.json` together, and
   `release.yml` publishes both to npm, then runs `scripts/release-smoke.sh`.
4. `pnpm release:check` on `main` when something looks off. The trusted publishers, set once per package:
   `npm trust github @escalay/kit --file release.yml --repo escalay/api-kit --env npm --allow-publish` and the
   same for `create-escalay`.
5. Apps take it with `diff` + `update` deliberately; nothing follows `main`.

## Rules

- Every part's folder has a `README.md` (what it is for, what it needs, an example, its exports, its rules, the
  STANDARD section). It ships with the part, so change it with the code; a part without one is unfinished.

- A rule lives in `docs/STANDARD.md` and the code that enforces it, never only in one of them.
- Every export has a JSDoc with an example; every rule has a test in `test/`.
- Keep app-specific things (schemas, routes, guides) in the apps.
