---
name: api-kit-part
description: Use when working in the escalay/api-kit repository itself - adding a part, changing what a part ships, needs or exports, adding a browser layer (a client, React hooks, a shadcn block), or deciding whether new apps start with a part. Covers the part's files, its README, the registry item, meta.web, shadcn stand-ins, tsconfig.web.json, happy-dom tests, the STANDARD section, APP_MODULES, docs/PARTS.md and the release note. Not for an app built on the kit (api-kit-build).
---

# Add or change a part of the kit

For maintainers of `escalay/api-kit`. A **part** is one folder under `src/` (or one file under `src/browser/`) that
apps copy in and own. Read the repository's `AGENTS.md` and `docs/STANDARD.md` first; `boards` is the model part.

## 1. The files

1. `src/<part>/`, named as the part. A part with routes and data keeps the feature shape of `docs/STANDARD.md` §1;
   `boards` is the model.
2. Every export has a JSDoc with an example; every rule has a test in `test/<part>.test.ts`.
3. It runs on Node and Workers: nothing at global scope that workerd refuses (random values, I/O, timers). A part
   apps import through `./kit/index.js` (no `meta.entry`) goes into `src/index.ts`, which the Workers probe
   (`test/workers/worker.ts`) imports; an entry part that runs on Workers is imported there by its folder.
4. Hooks the app passes are told after the change and never fail the request (`tellApp`, `src/core/hooks.ts`).
5. A migration step never changes once released: a change is a new step at the end.

## 2. The README

`src/<part>/README.md` ships with the part, so it changes with the code in the same pull request. Its shape is
`README_SHAPE` in `scripts/parts.mjs` (listed in `docs/PARTS.md`, Every README has one shape), checked by
`test/readmes.test.mjs`. The `Standard:` line under its rules equals the registry's `meta.standard`, history stays in
`docs/upgrading.md`, and every option and hook is in it.

## 3. The registry item

One `registry:item` per part in `registry.json`; `kit add`, `kit list` and the shadcn CLI read it as it is:

```json
{
  "name": "reminders",
  "type": "registry:item",
  "title": "Reminders",
  "description": "One line: what it gives an app (kit list and docs/PARTS.md show it)",
  "dependencies": ["drizzle-orm@^0.45.4"],
  "registryDependencies": ["escalay/api-kit/db", "escalay/api-kit/mcp"],
  "files": [
    { "path": "src/reminders/index.ts", "type": "registry:file", "target": "~/src/kit/reminders/index.ts" },
    { "path": "src/reminders/README.md", "type": "registry:file", "target": "~/src/kit/reminders/README.md" }
  ]
}
```

- Every file under `src/` is listed, the README too, each `target` its path under `~/src/kit/` (a test fails
  otherwise). npm `dependencies` are `name@range`; a bare name is a peer the app already has.
- Other parts go in `registryDependencies` as `escalay/api-kit/<part>`; a shadcn component by its bare name.
- `meta.entry: true` when the app imports the part's own folder (`./kit/reminders/index.js`) rather than
  `./kit/index.js`. A part that is repo setup, not code, is a root item (`meta.root`), like `npm-release`.
- `meta.standard`: the STANDARD sections the part implements (`docs/PARTS.md` and the README's `Standard:` line read
  it); a browser layer adds `meta.layerOf`, the server part it sits on.

## 4. Browser layers

A browser part is one file in `src/browser/`, with `meta: { "entry": true, "web": true }` and the shared
`src/browser/README.md`; `--web-dir` puts it in the app's frontend. Three layers, each its own part:

| Layer | File | Needs |
|---|---|---|
| client | `<name>-client.ts` | no framework, `fetch` only; typed by the routes, problems as errors |
| react | `<name>-react.ts(x)` | the client, `react` as a peer; headless hooks |
| ui | `<name>-block.tsx` | the hooks, shadcn components by bare name (`button`, `input`, `switch`) |

- A shadcn component the kit has not used before gets a stand-in in `test/shadcn/` (the `@/components/ui/*` alias
  in `tsconfig.web.json` and `vitest.config.ts`) and joins the bare names the registry test allows.
- `tsconfig.web.json` typechecks `src/browser/*` (bundler resolution, `erasableSyntaxOnly`): add the part's UI
  test to its `include`.
- Its tests run in happy-dom (`// @vitest-environment happy-dom` on the first line, `@testing-library/react`),
  against the real routes through `app.request` where the part talks to the kit's own API.
- A test fails when a `src/browser` file is in no browser part, or in more than one.

## 5. Where else it goes

- **The standard.** A rule an app must keep is a `docs/STANDARD.md` section (or a line in one) and the code that
  enforces it, never only one of them; the checklist (§13) names it.
- **New apps.** Does every new app need it? Then it joins `APP_MODULES` in `cli.mjs` (`WEB_APP_MODULES` for the
  `app` preset's browser), the generator test's `kit.json` modules, and the starter's wiring in `templates/app`.
  Most parts do not: an app adds them with `kit add`.
- **The map.** `docs/PARTS.md` is generated from `registry.json`: run `pnpm parts` after changing a part's
  registry item (`test/parts.test.mjs` fails while it is stale), and give the part a row in its goal table in
  `scripts/parts.mjs` when it serves a new goal. The `api-kit-build` skill names every part by goal: add the new one there
  (a test checks every part is named in some skill). `AGENTS.md` names no part: it points at `docs/PARTS.md`.
- **The release note.** The pull request's title is the line in the release notes: `feat(reminders): …` for a new
  part or option, `fix(<part>): …` for a fix. A change an app must act on (a new migration step, a renamed export, a
  changed default) gets its entry in `docs/upgrading.md` and says so in the part's README. Existing apps keep
  working: new behaviour is an option with today's default.

## Checks

| Rule | Verified by |
|---|---|
| Every file listed, targets right, parts it needs exist | the registry tests in `test/kit.test.ts` |
| Each browser file is one browser part | `gives every browser file a browser part of its own` |
| Runs on Workers | the `workers` project (`pnpm test`) starting `test/workers/worker.ts` |
| Browser code compiles as an app's would | `pnpm typecheck` (`tsconfig.web.json`) |
| New apps still build, lint and pass | `pnpm test:starter` |

## Done when

`pnpm typecheck`, `pnpm test` and `pnpm test:starter` pass, the README has every heading, `docs/PARTS.md` is current,
and the part is named in `api-kit-build`.
