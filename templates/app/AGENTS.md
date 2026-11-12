# __title__

An agent-ready HTTP API built on [api-kit](https://github.com/escalay/api-kit) (the standard: its
`docs/STANDARD.md`). Every route is documented OpenAPI, every answer HAL, every error problem+json, and every route
an MCP tool.

## Commands

`pnpm install` · `pnpm test` · `pnpm typecheck` · `pnpm lint` (oxlint) · `pnpm format` (oxfmt) · `pnpm guide` (after editing `guide/`)

- `pnpm dev`: the API on Node at http://localhost:4400 (`/docs`, `/llms.txt`, `/mcp`) <!-- runtime:node -->
- `pnpm __worker_dev__`: the Worker locally over a local D1 (`/docs`, `/llms.txt`, `/mcp`) <!-- preset:api --> <!-- runtime:workers -->
- `pnpm dev`: Vite runs both sides at http://localhost:5173, the browser app at `/app/` with hot reload and the Worker over a local D1 for everything else (`/docs`, `/llms.txt`, `/mcp`); `pnpm build` then `pnpm preview` serves the built result <!-- preset:app -->
- `pnpm migrations` after adding a migration step; `pnpm run deploy` (not `pnpm deploy`, which is pnpm's own command): guide, migrations, `wrangler d1 migrations apply`, `wrangler deploy` <!-- preset:api --> <!-- runtime:workers -->
- `pnpm migrations` after adding a migration step; `pnpm run deploy` (not `pnpm deploy`, which is pnpm's own command): guide, migrations, `vite build`, `wrangler d1 migrations apply`, `wrangler deploy` <!-- preset:app -->

A new feature: `npx @escalay/kit feature <plural-name>`, then fill in its files.

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
| `src/kit/` | the copied kit, owned by this app; `kit.json` records its version, and each part's `README.md` says what it is for and its rules (start with `core`, `db`, `mcp`, `testing`). Update with `diff --patch`, then `update` |
| `guide/` | the agent guide: templates whose `{{api.endpoints}}` and `{{mcp.tools}}` are generated from the code |
| `guide/skills/__name__/` | the skill this product ships to the agents that use it: `SKILL.md` routes, `references/<job>.md` is one playbook per job. Served at `/skills/*`, offered over MCP as skills and prompts, and installed with `npx skills add <this deployment's address>` or from the repository |
| `.agents/skills/` | skills for developing this repository (`.claude/skills` links here). Never served |
| `test/api.test.ts` | every route linted, every MCP tool run (`toolsRun`), every guide placeholder filled |
| `container/entrypoint.sh` | the env allowlist: the API sees only the variables it reads | <!-- runtime:node -->

## Rules

- Only a feature's `repo.ts` queries the database; handlers call the repo. That keeps a move off SQLite to one file
  per feature (`openDb` takes any Drizzle SQLite database: Turso via `drizzle-orm/libsql`, D1 via `drizzle(env.DB)`).
- A migration step never changes once it has run anywhere; a change is a new step at the end of the list.
- On Workers, run `pnpm migrations` after adding a step (it refuses to rewrite a shipped one). On a fresh local D1, `wrangler d1 migrations apply DB --local` before the first `wrangler dev`: files replayed over steps `migrate()` already ran must be idempotent. <!-- runtime:workers -->
- Nothing runs at global scope that Workers refuse there (random values, I/O, timers): do it in `createApp` or a handler. <!-- runtime:workers -->
- A new secret: `wrangler secret put <NAME>`, and locally `.dev.vars` (copy `.dev.vars.example`). <!-- runtime:workers -->
- A new env var the API reads goes into `container/entrypoint.sh` too. <!-- runtime:node -->
- The browser app owns `/app` and nothing else: `wrangler.jsonc` sends every other path to the Worker. It calls the API with same-origin `fetch` and holds no key. Import images and fonts from code (there is no `public/` folder), so they are built under `/app/assets/`. <!-- preset:app -->
- `src/kit/` and generated files are left out of `pnpm lint` and `pnpm format`: the kit's copy must stay as the kit wrote it for `doctor` and `update`. What `init` and `feature` write is in the kit's long-line style, so run `pnpm format` after either.
- A product skill holds no `{{placeholder}}`: the copy in the repository is the copy people install. Run `pnpm guide` after editing one. The kit's `api-kit-skills` skill (`npx skills add escalay/api-kit`) is how to write them: from a test of what agents get wrong, never from the route list.
