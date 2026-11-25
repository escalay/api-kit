# __title__

An agent-ready HTTP API built on [api-kit](https://github.com/escalay/api-kit) (the standard: its
`docs/STANDARD.md`). Every route is documented OpenAPI, every answer HAL, every error problem+json, and every route
an MCP tool.

## Commands

`pnpm install` · `pnpm test` · `pnpm typecheck` · `pnpm lint` (oxlint) · `pnpm format` (oxfmt) · `pnpm guide` (after editing `guide/`) · `npx @escalay/kit brand` (after editing `brand/`; needs `pnpm add -D @resvg/resvg-js`; the OG card's text takes this machine's sans-serif font)

- `pnpm dev`: the API on Node at http://localhost:4400 (`/docs`, `/llms.txt`, `/mcp`) <!-- runtime:node -->
- `pnpm __worker_dev__`: the Worker locally over a local D1 (`/docs`, `/llms.txt`, `/mcp`) <!-- preset:api --> <!-- runtime:workers -->
- `pnpm dev`: Vite runs both sides at http://localhost:5173, the browser app at `/app/` with hot reload and the Worker over a local D1 for everything else (`/docs`, `/llms.txt`, `/mcp`); `pnpm build` then `pnpm preview` serves the built result <!-- preset:app -->
- `pnpm migrations` after adding a migration step; `pnpm run deploy` (not `pnpm deploy`, which is pnpm's own command): guide, migrations, `wrangler d1 migrations apply`, `wrangler deploy` <!-- preset:api --> <!-- runtime:workers -->
- `pnpm migrations` after adding a migration step; `pnpm run deploy` (not `pnpm deploy`, which is pnpm's own command): guide, migrations, `vite build`, `wrangler d1 migrations apply`, `wrangler deploy` <!-- preset:app -->
- `pnpm run deploy:env`: the same for a real deployment whose settings live outside the repository: `CLOUDFLARE_ACCOUNT_ID`, `D1_<BINDING>_ID`, every `vars` entry left `""` in `wrangler.jsonc`, optional `PUBLIC_HOST`, from the environment (a secret store's `run`). It writes the git-ignored `wrangler.deploy.jsonc`, makes missing queues and deploys. A repository that may go public keeps no account id or real domain: deploy it this way <!-- runtime:workers -->
- `npx skills add escalay/api-kit -y` (`-y`, or the installer stops to ask): the kit's skills for your coding agent: `api-kit-build` (parts, who may see what, a newer kit), `api-kit-feature` (a feature, its switch), `api-kit-review` (is it ready for agents), `api-kit-cli` (the command line, every `kit` command), `api-kit-skills` (this product's own skills). It installs `api-kit-part` and `npm-release` too, which are for the kit's own repository: leave them be

A new feature: `npx @escalay/kit feature <plural-name> --fields "name:string minutes:int tags:string[] notes:text?"`
(its own fields in every file, `status:enum(to-read|done)` for fixed values; `kit feature --help` lists the types, `--singular` and `--no-remove`), then fill in what is its own. Removing one (the
`notes` sample): delete `src/features/<name>/` and its lines in `src/features/index.ts` (and `catalog.ts`), then
`pnpm guide`, and on Workers `pnpm migrations` (it removes the feature's files). A PATCH schema never takes `.default()`: it would overwrite what a PATCH leaves out.

## Try it

Every route but discovery wants a key. `npx @escalay/kit key` prints one and its `API_KEYS=` line (the app keeps only
the hash):

- Node: `API_KEYS=dev:<hash> pnpm dev`, at http://localhost:4400 <!-- runtime:node -->
- Workers: the line in `.dev.vars` (copy `.dev.vars.example`), then `pnpm __worker_dev__`, at http://localhost:8787 <!-- preset:api --> <!-- runtime:workers -->
- The line in `.dev.vars` (copy `.dev.vars.example`), then `pnpm dev`, at http://localhost:5173 <!-- preset:app -->

```bash
KEY=dev_…   # the key it printed
BASE=http://localhost:4400 # runtime:node
BASE=http://localhost:8787 # preset:api # runtime:cloudflare
BASE=http://localhost:5173 # preset:app
curl -H "authorization: Bearer $KEY" "$BASE/api/notes?limit=5"
# MCP is stateless (no initialize, no session): the protocol version and the method go in headers and in the body's _meta
curl "$BASE/mcp" -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2026-07-28' -H 'mcp-method: tools/call' -H 'mcp-name: list_notes' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_notes","arguments":{"limit":5},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

`tools/list` takes the same headers with `mcp-method: tools/list` and no `mcp-name`. `notes` is the sample: use one of
your own features' paths and tools once it is gone.

## How changes ship

- `pnpm gate` is everything CI runs: `pnpm check` (types, lint, format) and `pnpm test`. <!-- runtime:node-only -->
- `pnpm gate` is everything CI runs: `pnpm check` (types, lint, format, `migrations/`) and `pnpm test`. <!-- preset:api --> <!-- runtime:workers -->
- `pnpm gate` is everything CI runs: `pnpm check` (types, lint, format, `migrations/` and the build) and `pnpm test`. <!-- preset:app -->
  `git push` runs it first (`.githooks/pre-push`; `--no-verify` skips it once). When it fails: `pnpm format`,
  `pnpm migrations` (Workers), then the error it names.
- A change goes in through a pull request whose title is a Conventional Commit (`feat: add notes`,
  `fix(notes): keep the order`): CI checks it, and the pull request is squash-merged, so the title is the commit on
  `main`. Merge only when every check is green. `npx @escalay/kit repo apply` sets the repository up that way once
  it is on GitHub (merges, auto-merge, a read-only Actions token, security alerts, the rules for `main`), and
  `kit repo check` reports what drifted.
- Dependabot opens one grouped pull request a month per ecosystem, for versions out at least a week, and security
  fixes at once. Merge it when green; a red one found a real break, so fix it there and never merge it red.
- Deploy with `pnpm run deploy:env` from a machine that has the secrets, after the merge. <!-- runtime:workers -->
- Anyone else deploys it with the README's Deploy to Cloudflare button (public repository only): `npx @escalay/kit button --check` must pass, so keep ids and the account out of `wrangler.jsonc` and give every setting the form asks for a description under `cloudflare.bindings` in `package.json`; `--smoke` proves it on a real account. <!-- runtime:workers -->
- CI's actions are pinned to commit SHAs with the version in a comment; Dependabot moves them. A new action is pinned
  the same way, and the `workflows / lint` check (actionlint, zizmor) must stay green. `workflows`, `secrets` and
  `title` call escalay/.github's shared workflows, pinned the same way.
- Once the repository is public, CodeQL (`codeql.yml`), OpenSSF Scorecard (`scorecard.yml`) and CI's `dependencies`
  job (dependency review) run too; while it is private they are skipped, since GitHub's free plan offers them on public
  repositories only. None is a required check. Findings are under Security › Code scanning; fix a CodeQL alert like a
  failing test. `scorecard.yml` publishes its results, so keep its job to the steps it has: no `run` steps or env.

## Layout

| Path | What |
|---|---|
| `src/server.ts` | Node: env → `openDb` → `createApp` → listen | <!-- runtime:node -->
| `src/worker.ts`, `wrangler.jsonc` | Workers: the D1 binding → `openDb(drizzle(env.DB))` → the same `createApp`; bindings and secrets | <!-- runtime:workers -->
| `src/guide.gen.ts` | `guide/` as a module (`pnpm guide`), served the same on both runtimes; a test fails when it is older than `guide/` |
| `migrations/`, `scripts/migrations.ts` | Workers: one D1 migration file per kit and feature step, written by `pnpm migrations`, applied at deploy | <!-- runtime:workers -->
| `src/app.ts` | the wiring only: auth and OAuth, every feature, the guide, MCP |
| `web/`, `index.html`, `vite.config.ts` | the browser app, served under `/app`: `main.tsx` (entry), `router.tsx`, `routes/` (one file per page, TanStack Router; `routeTree.gen.ts` is written by Vite), `styles.css` (Tailwind), tests beside the code as `*.test.tsx`. Checked by `tsconfig.web.json` | <!-- preset:app -->
| `src/features/index.ts` | `FEATURES`, the one list of features, and the `Feature` shape |
| `src/features/<name>/` | one feature: `schema.ts` (tables + migration steps) · `repo.ts` (the only queries) · `routes.ts` (OpenAPI contracts) · `handlers.ts` (request → repo → HAL) · `tools.ts` (MCP tools) · `index.ts` (register, tools, sample tool arguments) · `<name>.test.ts` |
| `src/kit/` | the copied kit, owned by this app; `kit.json` records its version, and each part's `README.md` says what it is for and its rules (start with `core`, `db`, `mcp`, `testing`). A newer kit: `npx @escalay/kit upgrading` prints what changed for these parts since `kit.json`'s version and what to do; then `diff --patch`, then `update`, then the `doctor --keep <files>` it ends with for the edits you keep |
| `guide/` | the agent guide: templates whose `{{api.endpoints}}` and `{{mcp.tools}}` are generated from the code |
| `brand/` | the brand: `brand.ts` (name, title, a description of at most 100 characters, the accent) and `icon.svg` (add `icon-dark.svg` for dark backgrounds); MCP, the Server Card, the docs, the A2A card, the guide's `{{brand.*}}` and the favicon all read it |
| `src/brand.gen.ts` | `brand/` rendered (`npx @escalay/kit brand`): the favicon, PNG icons and OG card as base64, committed so nothing renders at runtime; the SVG alone until the first render. `npx @escalay/kit doctor` says when it is stale |
| `guide/skills/__name__/` | the skill this product ships to the agents that use it: `SKILL.md` routes, `references/<job>.md` is one playbook per job. Served at `/skills/*`, offered over MCP as skills and prompts, and installed with `npx skills add <this deployment's address> -y` or from the repository |
| `.agents/skills/` | skills for developing this repository (`.claude/skills` links here). Never served, and marked `metadata.internal: true` so installing from the repository does not offer them |
| `skills.sh.json` | tells `npx skills add <this repository> -y` that the product's skill is in `guide/skills/` |
| `test/api.test.ts` | every route linted, every MCP tool run (`toolsRun`), every guide placeholder filled |
| `container/entrypoint.sh` | the env allowlist: the API sees only the variables it reads | <!-- runtime:node -->

## Rules

- A feature, `src/app.ts` and the browser app never name Cloudflare (`cloudflare:*`, `drizzle-orm/d1`, a provider file under `src/bindings/`): they take what they need from the context `createApp` is given, or from a type in `src/bindings/`, so only `src/worker.ts` and `src/bindings/` know the provider. `pnpm lint` fails on such an import. <!-- runtime:workers -->
- Only a feature's `repo.ts` queries the database; handlers call the repo. That keeps a move off SQLite to one file
  per feature (`openDb` takes any Drizzle SQLite database: Turso via `drizzle-orm/libsql`, D1 via `drizzle(env.DB)`).
- A migration step never changes once it has run anywhere; a change is a new step at the end of the list.
- On Workers, run `pnpm migrations` after adding a step (it refuses to rewrite a shipped one). On a fresh local D1, `wrangler d1 migrations apply DB --local` before the first `wrangler dev`: files replayed over steps `migrate()` already ran must be idempotent. <!-- runtime:workers -->
- Nothing runs at global scope that Workers refuse there (random values, I/O, timers): do it in `createApp` or a handler. <!-- runtime:workers -->
- A new secret: `wrangler secret put <NAME>`, and locally `.dev.vars` (copy `.dev.vars.example`). <!-- runtime:workers -->
- A new env var the API reads goes into `container/entrypoint.sh` too. <!-- runtime:node -->
- The browser app owns `/app` and nothing else: `wrangler.jsonc` sends every other path to the Worker. It calls the API with same-origin `fetch` and holds no key. Import images and fonts from code (there is no `public/` folder), so they are built under `/app/assets/`. <!-- preset:app -->
- `src/kit/` and generated files are left out of `pnpm lint` and `pnpm format`: the kit's copy must stay as the kit wrote it for `doctor` and `update`. What `init` and `feature` write is in the kit's long-line style, so run `pnpm format` after either.
- The starter's text is the product's to replace: the product skill's description, `brand/brand.ts`'s description, and each feature's in `src/features/catalog.ts`. `npx @escalay/kit doctor` fails while any is left.
- A product skill holds no `{{placeholder}}`: the copy in the repository is the copy people install. Run `pnpm guide` after editing one. The kit's `api-kit-skills` skill (`npx skills add escalay/api-kit -y`) is how to write them: from a test of what agents get wrong, never from the route list.
