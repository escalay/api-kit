# api-kit

A standard for agent-ready HTTP APIs and the parts that implement it. **The standard:
[`docs/STANDARD.md`](docs/STANDARD.md)** — read it before changing anything here or building an API on it. Apps copy
the parts in with `cli.mjs` (npm: `@escalay/kit`, bin `kit`) or the shadcn CLI (`registry.json` lists them); no app
imports this repo as a library.

Words: a **part** is one installable unit (a folder under `src/`; the code and `kit.json` say module), the **kit** is
the set in this repo, a **preset** is a starting combination (`init --preset`).

## Layout

Every part is a folder under `src/`. A feature with routes and data keeps the one shape in `docs/STANDARD.md` §1
(`boards/` is the model, and what `feature` generates).


| Path | What |
|---|---|
| `src/<part>/` | one folder per part (a browser part is one file in `src/browser/`), each with a README in one shape that ships with it. What each part is, needs and exports, and where an app imports it from: [docs/PARTS.md](docs/PARTS.md) (generated) and the part's README |
| `registry.json` | the parts, as a shadcn registry read straight from GitHub (no build step): one `registry:item` per part, each file a `registry:file` with its `target` under `~/src/kit/`, npm `dependencies` as `name@range` (a bare name is a peer), other parts as `registryDependencies` (`escalay/api-kit/<part>`), `meta.entry` / `meta.web` for the CLI, `meta.standard` (its STANDARD sections) and `meta.layerOf` (a browser layer's server part) for `docs/PARTS.md`, which `pnpm parts` (`scripts/parts.mjs`) writes from it and `test/parts.test.mjs` keeps current. A **root item** (`meta.root`, today `npm-release`) is repo setup, not a part: its files come from outside `src/`, go to the repo root, and only the shadcn CLI installs it (`list` names it, `add` refuses it, `adopt` and `doctor` never see it) |
| `cli.mjs` | `add` (and the wiring a part with tables or routes still needs: its README's feature for an app made by `init`, the line an older `scripts/migrations.ts` lacks), `list`, `diff`, `update`, `upgrading` (the notes in `docs/upgrading.md`, which the package ships, for `kit.json`'s parts since its version, up to the kit's own; `doctor` and `update` print the command when the app is behind; `test/upgrading.test.ts`), `doctor` (also `cliGaps` when the kit folder sits in an installed app, and notes from the app's source: no `address` on Node, `createOAuth` with `approve` but without `limits` and `publicOrigin`, the people part with no `personOf` owner, the sharing part with no `sweep(` call or, on Workers, no `address: { header }`; and, as findings, the starter's text left in a product skill's description, `brand/brand.ts` and `src/features/catalog.ts`), `adopt`, `init`, `feature`, `guide` (the guide folder as a module for Workers; must write exactly `guideModuleSource`), `sdk` (the client and the CLI), `cli` (the CLI for an app with `sdk/`; `--update` replaces only `sdk/cli/engine`), `button` (the Deploy to Cloudflare button: link and snippets, `--check` that a stranger's deploy would work, `--write` into the README, `--smoke` a real deploy and cleanup; `test/button.test.ts`), `license` (`keys`, `mint`, `verify`: a product's ES256 signing pair and the license keys `licenseOf` accepts, made with `node:crypto`; `test/license.test.ts` checks them against the kit's `verifyLicense`), `repo` (the GitHub repository's settings and rules through `gh`, `check`/`apply`; `test/repo.test.ts` runs it against `test/fixtures/fake-gh.mjs`), `brand` (the app's `brand/` rendered into `src/brand.gen.ts` with the app's own `@resvg/resvg-js`, loaded by dynamic import and never a dependency of the CLI, and `brand.ts` run by the app's tsx; `--check`, and the brand lines of `doctor` (only in an app with the brand part or a `src/brand.gen.ts`): stale by the inputs' hash, an inline icon over 10 KB, notes for a never-rendered brand and a subdomain host; `add brand` and `init` scaffold a monogram from `templates/brand/`, and `add brand` adds `src/brand.gen.ts` to an older app's oxfmt, oxlint and gitleaks ignores (or prints the line); the checks read the module in either quote style; `test/brand-cli.test.ts`) (plain JS: it runs from `npx` without a build). Reads the parts from `registry.json`. Copies mirror `src/`'s folders; `--web-dir` puts the browser files in their own folder under the same `kit.json`. `kit.json` is the lock: a sha256 per file as the kit wrote it; `doctor` reports missing, edited and behind (`--keep` records an edit as kept), `adopt` writes it for parts the shadcn CLI copied |
| `packages/create-escalay` | `npm create escalay <name>`: hands its arguments to `init` (`--help` prints init's); depends on the kit of its own version exactly (`workspace:*`) |
| `scripts/starter-check.mjs` | `pnpm test:starter`: scaffolds one app per preset in the OS temp folder (`init` installs it, formats it and writes its migrations), runs its gate with nothing run by hand first, and for `app` the build and a dry-run deploy (CI runs it). Lint runs here and not in `test/kit.test.ts`: oxlint finds no files under the git-ignored `test/.generated/` |
| `scripts/release-check.mjs` | `pnpm release:check`: read-only; clean tree on `main`, one version across the public packages, what each tarball holds, whether the version is on npm, whether npm trusts `release.yml`. Generic: it ships in `npm-release` |
| `scripts/release-smoke.sh` | what `release.yml` runs after publishing: `npm create escalay@<version>` (which installs it), then its gate |
| `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json` | the release: release-please keeps the release pull request, then the publish job. The workflow names no package, because `npm-release` installs this same file in other repos |
| `skills/` | `api-kit-build` (a new app, its parts by goal, who may see what, a newer kit), `api-kit-cli` (the app's command line: names, jobs, `cliGaps`; and every `kit` command and preset), `api-kit-feature`, `api-kit-review`, `api-kit-skills` (writing a product's own skills from tests of what agents get wrong), `api-kit-part` (for this repository: adding or changing a part), `npm-release` (releases, for any npm package repo), installed with `npx skills add escalay/api-kit -y` (`-y`, or the installer stops to ask); `test/kit.test.ts` checks their frontmatter, length and commands (only ones the CLI has), that each is in the README's table and this row, that between them they name every part, that `api-kit-cli` names every command and preset, and that `api-kit-build` starts with the command `init` prints |
| `templates/sdk` | what `kit sdk` adds: `sdk/` (the fetch-only client, its coverage test) and `scripts/openapi.ts` (the document and `sdk/cli/commands.json`). `sdk/cli/engine/` is the CLI engine (Node 20.10+, built-ins only, no placeholders, so `test/cli.test.ts` imports and typechecks it in place); `sdk/cli/bin.ts`, `jobs/`, `commands.json`, `tsconfig.json` (its own: Node types, `dist/cli`) and `sdk/test/cli.test.ts` are filled per app |
| `templates/npm-release` | the blank release-please config and manifest `npm-release` installs; a test keeps the config equal to this repo's, minus its bootstrap commit and extra files |
| `templates/runtime-cloudflare` | what `init --runtime cloudflare|both` adds: `worker.ts`, `wrangler.jsonc`, `scripts/migrations.ts` (the tables of every kit part copied in and every feature), the workerd test project |
| `templates/preset-app` | what `init --preset app` adds (Cloudflare only): the browser app in `web/` (React, TanStack Router and Query, Tailwind; the switches' client and hooks in `web/kit`, `web/lib/features.ts` typed by the catalog, `FeaturesProvider` at the root), `index.html`, `vite.config.ts` (Vite with Cloudflare's plugin runs and builds both sides), `tsconfig.web.json`. Its files are kept formatted with the app's `oxfmtrc.json`. What it changes in shared files is lines marked `// preset:app` or `<!-- preset:app -->` in `templates/app` and `templates/runtime-cloudflare` (`init` keeps a marked line only in an app that has that preset or runtime) |
| `templates/app/github`, `githooks`, `node-version`, `gitleaks.toml` | every app's CI (`.github/workflows/ci.yml`: `pnpm check` and `pnpm test`; actionlint and zizmor, gitleaks and the title through escalay/.github's shared workflows, whose checks are `<job> / <its job>`; dependency review once public), `codeql.yml` and `scorecard.yml` (skipped while the repository is private; none is a required check), `.githooks/pre-push` (`pnpm gate`, which is `check` + `test`; `scripts/hooks.ts` points git at it on install, only at a repository's root), monthly Dependabot, the secrets scan's allowlist, and the kit's Node. `check` per runtime is built by `scriptsFor` in `cli.mjs`; `init` runs `git init` unless the folder is already in a repository (`--no-git`). `scripts/starter-check.mjs` runs `gate` on each starter |
| `templates/app/skills.sh.json` | points `npx skills add <repository> -y` at `guide/skills/`; without it the installer stops at `.agents/skills/` and offers only developer skills |
| `templates/app/guide/skills/__name__`, `templates/app/agents-skills` | the two places for a product's skills: the skill it ships to its users' agents, and (copied to `.agents/skills/`, with `.claude/skills` linked to it by `init`) the skills for developing the repository |
| `templates/app/src/features/catalog.ts`, `flags.ts`, `switches/` | feature switches in every new app: the empty catalog (`// kit:catalog`, filled by `feature <name> --switch`), the one-line providers, and the always-on switches feature (`switch_feature` offered once the catalog has a feature) |
| `templates/app`, `templates/feature` | what `init` and `feature` copy, `__placeholders__` filled from the name (`namesOf` in `cli.mjs`). Never typechecked or tested in place: the generator test in `test/kit.test.ts` makes an app under `test/.generated/`, typechecks it and runs its tests |
| `test/cli.test.ts` | the CLI engine run in-process against a sample app (its `fetch` is `app.request`): snapshot equals the live commands, help, `--json`, exit codes, `--yes`, `--input`, resources, jobs, device sign-in with refresh, `cliGaps` on the kit's own parts |
| `test/a2a.test.ts`, `test/oauth.test.ts` | the A2A card and methods; OAuth flows (code + PKCE, refresh families, agent claim, device grant), callers by client and grant, audiences (resources, the canonical form, `accepts`, rows from before audiences, a forwarded host with a path never widening one, whether refreshed, issued or presented), approvals (`approve`, `complete` and its `resource`, `onGrant`, `onRevoke` on every path, deciding later with `ticketTtl` and with `holdTicket` (probe T3: a held ask through newer tickets; the cookie never cut short; after the client lapsed), the ticket cookie, the origin rule, the brand on the pages, the README's invite example, who is "this computer", `named` and `expiresAt` on an ask, `approveSignIn` on an app's own form), the open endpoints (a forged host under `publicOrigin`, in the OAuth documents and every public discovery file, `no-store` without it, a week for an unused registration, the caps, pruning, the limits and the owner outside them), scopes and metadata. `test/oauth-store-contract.ts` is what every OAuth store must pass (`take`, `markUsed`, `trim` and its `heldBy`, `hold` (never reopening a spent ticket), `extend` (two holds from one browser at once keep the longer), expiry, the caps on every row written without auth with an open invite's client kept, a waiting ticket evicted by newer ones and a held one never, outside the cap, refresh rows by generation: replays of any earlier token, made-up tokens, 1.29.0 tokens, a 1.29.0 successor after a rollback, a retry of a token 1.29.0 answered first) with the attacks on the token endpoint (codes and refresh tokens raced and replayed, revokes racing refreshes, device approvals and claims polled at once, codes, device approvals and claim tokens collected after `revokeClient`, a claim token collected after `revokeGrant`, consent, claim and device forms posted twice at once, a completed ticket posted again, a stored approval never standing in for a click, the device page for the owner only, a grant ended while `onGrant` runs (a retried exchange, `revokeGrant`, `revokeClient`), or a throw in it or in the token writes, issuing nothing and withdrawing the grant once); `oauth.test.ts` runs it on memory and node:sqlite, `test/workers/oauth.test.ts` on D1 |
| `test/license.test.ts` | license keys: made, minted and verified by `kit license`, checked by `verifyLicense` (tampered, expired, foreign product, another deployment), paid features off without one, their 403 and 409 |
| `test/switches.test.ts` | feature switches: the catalog's checks, the 403 and its order after auth and before validation, needs and dry runs, per person and key, `FEATURES_OFF`, old names, the cache, a flag service in front of the database, routes and tools |
| `test/telemetry.test.ts` | the usage report: the body sent, the daily schedule, every switch, coarse values only, routes and tool |
| `test/kit.test.ts` | a sample API through every rule, discovery, the generated guide, the CLI (add, diff, update, doctor, adopt, init), the registry (every part and file listed), the skills, an MCP round trip |
| `test/workers/` | the `workers` Vitest project, run inside workerd (`@cloudflare/vitest-plugin`): `worker.ts` imports the whole kit at global scope and serves a probe app over D1, so a Node-only top-level import or a random value at global scope stops it starting; `smoke.test.ts` checks it, D1 migrations and `testDb` |
| `test/brand.test.ts` | the brand on every surface over `test/brand-fixture.ts` (a cookbook API with hand-made PNGs); without one, every surface equals `test/fixtures/no-brand.json`, captured before the part existed |
| `test/vectors.test.ts`, `test/vector-search.test.ts`, `test/web.test.ts` | ledgers and search; the search routes and tools over `test/logos-fixture.ts`; the front door |
| `test/search-client.test.ts`, `test/search-ui.test.tsx` | the browser client and controller; the hooks and block in happy-dom |

## Commands

`pnpm install` · `pnpm test` (both projects: `node`, and `workers` inside workerd; one alone: `--project <name>`) ·
`pnpm typecheck` (Node, browser, Workers) · `pnpm test:starter` (needs the network) · `pnpm release:check` (needs the network) · `pnpm exec wrangler dev -c test/workers/wrangler.jsonc` (the probe app,
for a look at the kit on Workers by hand)

## Using it from another repo

- `npx @escalay/kit add <parts…> --dir <app>/src/kit --install`, or one part with
  `npx shadcn add escalay/api-kit/<part>` and then `npx @escalay/kit adopt` (the README has the rest). The app imports
  `./kit/index.js` and each entry part's folder (`./kit/mcp/index.js`, `./kit/testing/index.js`); its container build needs nothing from this repo.
- A new app: `npm create escalay <name>` (`init <dir>`); a new feature in it: `feature <plural-name>`.
- The app owns the copy. Before taking a new kit version: `doctor`, `diff --patch`, then `update`; how `update` treats
  the app's edits is in [docs/upgrading.md › Taking a new version](docs/upgrading.md#taking-a-new-version). A fix
  that belongs to every app goes back into the kit, with a test.

## Releasing

[`docs/releasing.md`](docs/releasing.md) is the standard; nothing is bumped, tagged or published by hand.

1. Change, test, update `docs/STANDARD.md` when a rule changes, and `registry.json` when a part's files or
   dependencies change (a test fails when a file under `src/` is not listed, or a `src/browser` file is in no browser
   part). Adding or changing a part: the `api-kit-part` skill.
2. Open a pull request whose title is a Conventional Commit that reads well in release notes (CI checks it), and
   squash-merge it.
3. Before merging the release pull request, rename `docs/upgrading.md`'s `### Unreleased (after X)` headings to the
   version it names, in a commit pushed to release-please's own branch (the release pull request's head): the heading
   test in `test/readmes.test.mjs` passes only beside the version bump, so a docs pull request before it fails, and
   one after it ships the release with the old headings. Merge the release pull request (`chore(main): release X.Y.Z`) to publish: it bumps `package.json` (the CLI
   stamps that version into each app's `kit.json`) and `packages/create-escalay/package.json` together, and
   `release.yml` publishes both to npm, then runs `scripts/release-smoke.sh`.
4. `pnpm release:check` on `main` when something looks off. The trusted publishers, set once per package:
   `npm trust github @escalay/kit --file release.yml --repo escalay/api-kit --env npm --allow-publish` and the
   same for `create-escalay`.
5. Apps take it with `diff` + `update` deliberately; nothing follows `main`.
6. The canaries, `escalay/kit-canary-api` and `escalay/kit-canary-app` (private), are new apps made again from the
   newest `create-escalay` every Monday (their `refresh.yml`), pushed, and run through their own CI on GitHub. A
   failed refresh is a broken starter. When a release changes the template's workflows, the refresh fails asking a
   person to push them (no workflow token may): `npm create escalay@<version> … --no-git`, copy `.github/workflows/`
   beside `refresh.yml`, push.

## Rules

- Every part's folder has a `README.md` in one shape: `README_SHAPE` in `scripts/parts.mjs`, listed in
  [docs/PARTS.md](docs/PARTS.md#every-readme-has-one-shape) and checked by `test/readmes.test.mjs`. It ships with the
  part, so change it with the code; a part without one is unfinished. History goes in `docs/upgrading.md`, never in
  the README.

- A rule lives in `docs/STANDARD.md` and the code that enforces it, never only in one of them.
- Every export has a JSDoc with an example; every rule has a test in `test/`.
- Keep app-specific things (schemas, routes, guides) in the apps.

## Decisions

Why the kit is built as it is, one line each; a new record takes the next number in `docs/decisions/` and a line here.
What shipped when is in the changelog.

- [0001](docs/decisions/0001-features-drizzle-scaffold.md): feature folders, Drizzle for write state, a scaffolder
- [0002](docs/decisions/0002-node-and-workers.md): one kit, two runtimes, Node and Cloudflare Workers
- [0003](docs/decisions/0003-the-command-line.md): every app's MCP tools as a command line, for agents first and people too
