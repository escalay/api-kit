---
name: api-kit-build
description: Use when starting a new HTTP API that agents should use without help, moving an existing Hono app onto the Escalay api-kit, adding a kit part to an app (sign-in for a team and its owner, OAuth approval by invite, feature switches, boards, search by words or pictures, usage reports, a brand, a front page, the Deploy to Cloudflare button), deciding who may see what, or taking a newer kit version into an app.
---

# Build an API on the kit

The kit (`escalay/api-kit`) is a set of **parts** an app copies in and owns: `core`, `db`, `oauth`, `guide`, `mcp`,
`testing`, and more (`npx @escalay/kit list`). A **preset** is a starting combination: `api`, or `app` for an API with a browser app beside it.
Each part's rules travel with it in `src/kit/<part>/README.md`; the full standard is the kit's `docs/STANDARD.md`.

## A new API

1. `npm create escalay my-api` (add `-- --runtime node` or `cloudflare`; the default is both). For a tool people
   also open in a browser: `-- --preset app` (Cloudflare only; `web/` served under `/app` by the same Worker).
   It installs the app, formats it and writes its migrations, so its gate passes as made. Then run what its `Next:`
   line prints, up to `pnpm dev`: `cd my-api && pnpm test`; with `-- --no-install`, or without pnpm, it is
   `cd my-api && pnpm install && pnpm format && pnpm migrations && pnpm test` (with `--runtime node` there is no
   `pnpm migrations`). Done when it passes. Give your coding agent the kit's
   skills with `npx skills add escalay/api-kit -y` (without `-y` the installer stops to ask).
2. Read `AGENTS.md` in the new app, then `src/kit/core/README.md`, `db`, `mcp` and `testing`.
3. `pnpm dev`, then open `/docs`, `/llms.txt` and `/mcp`. The example `notes` feature shows the shape.
4. Replace `notes` with real features: the `api-kit-feature` skill, one feature at a time.
5. Write the guide in `guide/`: only what the code can't know (concepts, what scores mean, real-id examples,
   playbooks). Endpoint and tool lists stay as `{{api.endpoints}}` and `{{mcp.tools}}`. Run `pnpm guide` after.
6. Write the product's own skill in `guide/skills/<name>/` with the `api-kit-skills` skill: one playbook per job
   people bring to it, from a test of what agents get wrong. `kit doctor` fails while its description, the one in
   `brand/brand.ts` or one in `src/features/catalog.ts` is still the starter's text.
7. Decide who may see what (below), then check it with the `api-kit-review` skill before anyone else uses it.

## Who may see what

In this order; stop at the first that fits.

1. Only you: `API_KEYS` (hashes), and the person Cloudflare Access proves approves agents (`owner` in `src/app.ts`).
2. A team: `people` (passkeys for the owner, Access members with roles) and `setup` (the first person with the
   deploy's `SETUP_CODE` becomes the owner); then `owner` is the people part's owner (`personOf`, the comment in
   `src/app.ts`). Keys made through the API: `keys`.
3. Agents signing in for a person: `oauth`, the owner approving on the kit's page. An app's own page deciding: the
   `approve` hook, `complete` with a `resource`, and `onGrant` / `onRevoke` to mirror who holds access
   (`src/kit/oauth/README.md`).
4. Other people, and their agents, into one part of the app (a space): `sharing`, by single-use invite or the
   owner's approval at the space (`npx @escalay/kit add sharing --dir src/kit --install`, then its README's Wire it).
   - `SHARING_SECRET`: 32+ random bytes, its own entry in your secret store, never the OAuth signing key.
   - `createOAuth` with `publicOrigin` and `...sharing.oauth`; `SHARING_OPEN_PATHS` in `auth.open`, `sharing.relay`
     in `auth.relay`, `sharing.neverKept` in `guards.skip`; then `registerSharing`.
   - `await sharing.sweep()` in the scheduled handler, `sharing.forget(id)` when a space is deleted (`kit doctor`
     notes an app that never sweeps). On Workers, `address: { header: 'cf-connecting-ip' }`.
   - Behind Cloudflare Access, let exactly `sharingSignInPaths(sharing)` through.
   - `sharingTools` go to the owner's MCP only, never to `mountA2A`: a delegating agent must not mint invites.

## Parts beyond the core

`init` copies `core`, `db`, `oauth`, `pagination`, `guide`, `mcp`, `brand`, `switches` and `testing`. The rest, by goal (every
part, what it needs and the order to add them: the kit's `docs/PARTS.md`):

| Goal | Parts |
|---|---|
| Lists that page by cursor | `pagination` |
| A team and its owner | `people`, then `setup`; `keys` for keys made through the API |
| Agents over A2A as well as MCP | `a2a` |
| Search by words, by picture, by likeness | `vectors` (the embeddings), then `vector-search`; in the browser `search-client`, `search-react`, `vector-search-ui` |
| Saved collections of the app's items | `boards`; in the browser `boards-client`, `boards-react` |
| Features the owner can switch off | `switches` (in every new app); in the browser `switches-client`, `switches-react`, `switches-ui` |
| A daily anonymous usage report | `telemetry` |
| A public front page and a browser app under `/app` | `web` (Node only; on Workers the `app` preset serves `web/`) |
| One name and icon on every surface | `brand`, then `npx @escalay/kit brand` |
| Other people into one part of the app (invites, the owner's approval) | `sharing` (step 4 above) |

Add one with `npx @escalay/kit add <part> --dir src/kit --install` (browser parts take `--web-dir`), then read its
`src/kit/<part>/README.md` and wire it in `src/app.ts`. A new feature the owner can switch off:
`npx @escalay/kit feature <plural-name> --switch` (`api-kit-feature`).

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

1. `npx @escalay/kit upgrading`: it prints, for the parts in `src/kit/kit.json`, every upgrade note after the
   version it records: what each part changed and what the app must do. After `update`, the `--from` it prints
   still finds them.
2. `npx @escalay/kit doctor`: one line per file that is missing, edited, or behind, each with its fix.
3. `npx @escalay/kit diff --patch`: your edits beside the kit's changes.
4. `npx @escalay/kit update`: writes what the kit changed and keeps every file you edited. When it exits 1, the
   kit's [Taking a new version](https://github.com/escalay/api-kit/blob/main/docs/upgrading.md#taking-a-new-version)
   says what to do.
5. Record each edit you mean to keep with `doctor --keep <file>`. Done when `doctor` exits 0 and `pnpm test` passes.

## Shipping

- One API key per client. The service holds only hashes (`API_KEYS=name:sha256,…`, from `mintApiKey`); the keys live
  in your secret store.
- On a container host: `container/entrypoint.sh` passes the API only the variables it reads. A new variable goes
  there too.
- On Cloudflare Workers: `pnpm run deploy` (never `pnpm deploy`, which is pnpm's own command). For strangers to deploy
  their own copy: `npx @escalay/kit button --check`, then `--write` puts the Deploy to Cloudflare button in the README.
- On GitHub: `npx @escalay/kit repo apply` sets the repository up as the standard says (§20).
- Back up the database before a release that adds a migration step.

## Pitfalls

- `node:sqlite` needs Node 22.16 or newer.
- A migration step never changes once it has run anywhere. A change is a new step at the end.
- Anchor `.gitignore` rules (`/assets/`): an unanchored `assets/` also hides `src/features/assets/`.
- A recursive zod schema sends the OpenAPI generator into a loop. Describe children in words.
- A `/**` comment that contains `*/` inside a path ends early.

## Done when

`pnpm test` and `pnpm typecheck` pass, `npx @escalay/kit doctor` exits 0, and the `api-kit-review` checks pass.
