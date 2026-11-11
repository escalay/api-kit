---
name: api-kit-build
description: Use when starting a new HTTP API that agents should use without help, or moving an existing Hono app onto the Escalay api-kit (copying its parts in, wiring auth, the guide and MCP), or taking a newer kit version into an app.
---

# Build an API on the kit

The kit (`escalay/api-kit`) is a set of **parts** an app copies in and owns: `core`, `db`, `oauth`, `guide`, `mcp`,
`testing`, and more (`npx @escalay/kit list`). A **preset** is a starting combination; `api` is the only one today.
Each part's rules travel with it in `src/kit/<part>/README.md`; the full standard is the kit's `docs/STANDARD.md`.

## A new API

1. `npm create escalay my-api` (add `-- --runtime node` or `cloudflare`; the default is both).
   Done when `cd my-api && pnpm install && pnpm test` passes.
2. Read `AGENTS.md` in the new app, then `src/kit/core/README.md`, `db`, `mcp` and `testing`.
3. `pnpm dev`, then open `/docs`, `/llms.txt` and `/mcp`. The example `notes` feature shows the shape.
4. Replace `notes` with real features: the `api-kit-feature` skill, one feature at a time.
5. Write the guide in `guide/`: only what the code can't know (concepts, what scores mean, real-id examples,
   playbooks). Endpoint and tool lists stay as `{{api.endpoints}}` and `{{mcp.tools}}`. Run `pnpm guide` after.
6. Check it with the `api-kit-review` skill before anyone else uses it.

## An existing app

1. Copy the parts: `npx @escalay/kit add core db oauth guide mcp testing --dir src/kit --install`.
   One part alone also installs with `npx shadcn add escalay/api-kit/<part>`; then `npx @escalay/kit adopt` writes
   `src/kit/kit.json` so later updates can tell your edits from the kit's.
2. Build the app with `createAgentApi` (`src/kit/core/README.md`) and move routes into feature folders
   (`api-kit-feature`). Keep `app.ts` to wiring: auth, each feature, the guide, MCP.
3. Data the API only reads (a built store) stays behind its own store module. What the API writes goes through `db`.
4. Add the tests from `src/kit/testing/README.md`. Done when they return `[]` and
   `npx @escalay/kit doctor` exits 0.
5. Before and after the move, save `/openapi.json`, the tool list and `/llms.txt`. A move that changes no behaviour
   leaves them identical.

## Taking a newer kit

1. `npx @escalay/kit doctor`: one line per file that is missing, edited, or behind, each with its fix.
2. `npx @escalay/kit diff --patch`: your edits beside the kit's changes.
3. `npx @escalay/kit update`: writes what the kit changed and keeps every file you edited. Merge those by hand, or
   `--force` to take the kit's.
4. Done when `doctor` exits 0, or lists only the edits you mean to keep, and `pnpm test` passes.

## Shipping

- One API key per client. The service holds only hashes (`API_KEYS=name:sha256,…`, from `mintApiKey`); the keys live
  in your secret store.
- On a container host: `container/entrypoint.sh` passes the API only the variables it reads. A new variable goes
  there too.
- On Cloudflare Workers: `pnpm run deploy` (never `pnpm deploy`, which is pnpm's own command).
- Back up the database before a release that adds a migration step.

## Pitfalls

- `node:sqlite` needs Node 22.16 or newer.
- A migration step never changes once it has run anywhere. A change is a new step at the end.
- Anchor `.gitignore` rules (`/assets/`): an unanchored `assets/` also hides `src/features/assets/`.
- A recursive zod schema sends the OpenAPI generator into a loop. Describe children in words.
- A `/**` comment that contains `*/` inside a path ends early.

## Done when

`pnpm test` and `pnpm typecheck` pass, `npx @escalay/kit doctor` exits 0, and the `api-kit-review` checks pass.
