# Releasing

How an npm package gets from a merged pull request to the registry with no manual step. The same setup works in
any pnpm repo: `npx shadcn add escalay/api-kit/npm-release` copies it (the workflow, the release-please files, the
check and this page).

## How a change becomes a release

1. **A pull request with a Conventional Commit title.** CI checks the title, because it becomes the commit.
2. **Squash and merge.** The title is now one commit on `main`, and one line of the next release notes.
3. **The release pull request.** `release.yml` runs release-please on every push to `main`. It opens, and keeps
   current, one pull request titled `chore(main): release X.Y.Z`: the version bumps and `CHANGELOG.md`.
   `feat` raises the minor version, `fix` and `perf` the patch, a `!` after the type the major.
4. **Merge it when you want to release.** That is the only decision a person makes.
5. **Publish.** The same workflow tags `vX.Y.Z`, drafts the GitHub release, then typechecks and tests the tagged
   commit, packs every public package, publishes each to npm, waits until npm serves them, runs
   `scripts/release-smoke.sh X.Y.Z` when the repo has one, attaches the tarballs and publishes the GitHub release.
6. **Check.** `pnpm release:check` on `main` says, one line each, whether anything is off.

## What the pipeline guarantees

- **No npm token exists.** npm trusts this repo's `release.yml` in the `npm` environment (OIDC); nothing to leak
  or rotate.
- **Provenance.** Every version carries a signed statement of the commit and workflow run that built it.
- **Tested twice.** The gate runs on the pull request and again on the exact commit that is published.
- **One version everywhere.** Every public package in the workspace is released together at the manifest's
  version; `workspace:` ranges are written as real versions in the tarballs.
- **A stranger can install it.** The job fails unless the registry serves each `name@version`, and, with a smoke
  script, unless a fresh install passes.
- **The GitHub release shows only what shipped.** It stays a draft until npm has the packages, and carries the
  exact tarballs.

## One-time setup for a package repo

The repo uses pnpm, has `packageManager` in `package.json`, a `.node-version` whose npm is 11.5.1 or newer
(Node 24), `typecheck` and `test` scripts, and a `repository.url` in every published `package.json` that points
at the GitHub repo (provenance checks it).

1. Copy the setup: `npx shadcn add escalay/api-kit/npm-release`, then add
   `"release:check": "node scripts/release-check.mjs"` to the scripts.
2. **Publish the first version by hand** (`pnpm publish --access public`). A package must exist on npm before a
   trusted publisher can be added to it.
3. Write that version into `.release-please-manifest.json` (`{".": "1.0.0"}`). With more than one public
   package, list each other `package.json` under `extra-files` in `release-please-config.json`
   (`{"type": "json", "path": "packages/<name>/package.json", "jsonpath": "$.version"}`).
4. Trust the workflow, once per package (asks for your npm second factor):
   `npm trust github <package> --file release.yml --repo <owner>/<repo> --env npm --allow-publish`
5. On GitHub: an environment named `npm` (Settings → Environments; limit it to the `main` branch), and
   Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests".
6. Branch rules for `main`: pull requests only, squash merging only with the pull request title as the commit
   message, and the CI checks required. A pull request opened by the workflow's own token does not start CI, so
   on the release pull request the required checks never report: merge it as an administrator, or close and
   reopen it to start them. Its commits were all tested on their own pull requests, and the publish job tests again.
7. `pnpm release:check` until every line is ✓.

The workflow file must stay named `release.yml`: the trusted publisher names it.

## Titles that read well as release notes

The title is read by someone deciding whether to upgrade. Say what changed for them, imperative and lowercase,
without the ticket, the file or the how.

| Good | Bad | Why |
|---|---|---|
| `feat: add cursor pages to boards` | `feat: boards changes` | says nothing |
| `fix: answer 404 for a board that was deleted` | `fix: bug in handlers.ts` | names a file, not a behaviour |
| `feat(cli)!: drop the --legacy flag` | `refactor: remove flag` | a breaking change hidden from the notes |
| `perf: embed a batch in one request` | `feat: performance` | wrong type, no content |
| `docs: explain how to rotate API keys` | `Update README.md` | not a Conventional Commit; CI refuses it |

`feat`, `fix`, `perf`, `docs` and `revert` appear in the notes (as New, Fixed, Faster, Documentation, Reverted).
`refactor`, `chore`, `test`, `build` and `ci` do not, and release nothing on their own.

## When a release fails

- **Run the failed jobs again** (Actions → the run → "Re-run failed jobs", not "all jobs": a full re-run finds
  no new release and skips publishing). The publish step skips every `name@version` npm already has.
- **A version can never be published twice**, even after unpublishing. If a published version is bad, fix it and
  release the next one; `npm deprecate <package>@<version> "<why>"` warns people off the bad one.
- **"npm still does not serve …" after 20 minutes.** npm can hold a new version back before serving it. The
  package was published; when `npm view <package>@<version>` answers, run the failed jobs again.
- **`npm publish` answers 404 or "OIDC".** The trusted publisher does not match: `npm trust list <package>` must
  show this repo, `release.yml` and the `npm` environment.
- **The smoke check fails.** The packages are public and broken for new installs. Fix forward with a `fix:` pull
  request and merge the next release pull request; the GitHub release of the bad version stays a draft.
- **No release pull request appears.** Only `feat`, `fix`, `perf` and breaking changes raise a version; check the
  repository setting from step 5.

## Checking a published package

```bash
npm view <package> dist.attestations     # the provenance statement's URL and type
npm audit signatures                     # in a project that installed it: signatures and attestations verify
```

On npmjs.com the version shows a "Built and signed on GitHub Actions" badge that links to the commit and the
workflow run. The same tarballs are attached to the GitHub release.
