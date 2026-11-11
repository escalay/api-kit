---
name: npm-release
description: Use when setting up or running releases of an npm package from GitHub Actions with release-please and npm trusted publishing (no npm token, provenance, a release pull request), or when diagnosing a release that failed or a version that did not appear on npm.
---

# Release an npm package from GitHub Actions

The standard is `docs/releasing.md` in the repo (installed with the setup); read it before changing anything.
In short: pull request titles are Conventional Commits, squash merges put them on `main`, release-please keeps one
release pull request, and merging that publishes every public package with provenance. Nobody bumps, tags or
publishes by hand, and no npm token exists.

## First, look

```bash
pnpm release:check          # node scripts/release-check.mjs; read-only
```

One line per check: the tree is clean and on `main`, every public package has the manifest's version, what each
tarball holds and whether a path in it looks private, whether the version is already on npm, whether npm trusts
this repo's `release.yml`. ✗ comes with its fix and exits 1; `?` means it could not check (not logged in to npm,
offline) and is never a failure.

## Set it up in a repo

Needs: pnpm with `packageManager` set, `.node-version` at Node 24 or newer (npm 11.5.1+), `typecheck` and `test`
scripts, `repository.url` in every published `package.json`.

1. `npx shadcn add escalay/api-kit/npm-release` copies `.github/workflows/release.yml`,
   `release-please-config.json`, `.release-please-manifest.json`, `scripts/release-check.mjs`, `docs/releasing.md`.
   Add `"release:check": "node scripts/release-check.mjs"` to the scripts.
2. The package must already be on npm. If it is not, a person publishes the first version by hand:
   `pnpm publish --access public`. Never do this for them.
3. Write the version on npm into `.release-please-manifest.json`: `{".": "1.0.0"}`. More than one public package:
   add each other `package.json` to `extra-files` in `release-please-config.json`, as
   `{"type": "json", "path": "packages/<name>/package.json", "jsonpath": "$.version"}`.
4. A person runs, once per package (it asks for their second factor):
   `npm trust github <package> --file release.yml --repo <owner>/<repo> --env npm --allow-publish`
5. A person sets on GitHub: an environment named `npm`; Settings → Actions → General → "Allow GitHub Actions to
   create and approve pull requests"; squash merging with the pull request title as the commit message.
6. Optional `scripts/release-smoke.sh` (executable, gets the version as `$1`): install the published package the
   way a stranger would and run something. The workflow runs it after npm serves the version.
7. Done when `pnpm release:check` on `main` prints no ✗ and the trusted publisher line is ✓.

Do not rename `release.yml` (the trusted publisher names it) and do not put package names into it.

## Run a release

1. Merge pull requests. A title must match
   `^(feat|fix|perf|docs|refactor|chore|test|build|ci|revert)(\([a-z0-9./-]+\))?!?: [^ ].*$` and read well as a
   release note: `fix: answer 404 for a board that was deleted`, not `fix: bug in handlers.ts`.
2. Merge the pull request titled `chore(main): release X.Y.Z` when its notes are what you want to ship.
3. Watch it: `gh run watch $(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')`
4. Done when `npm view <package>@X.Y.Z version` prints the version and `gh release view vX.Y.Z` is not a draft.

`feat` raises the minor version, `fix` and `perf` the patch, `!` the major. `refactor`, `chore`, `test`, `build`
and `ci` release nothing and stay out of the notes.

## A release failed

```bash
gh run list --workflow release.yml --limit 5
gh run view <run-id> --log-failed
gh run rerun <run-id> --failed       # never a full rerun: it finds no new release and skips publishing
```

| The log says | Do |
|---|---|
| typecheck or tests fail | fix on `main` with a `fix:` pull request; the next release pull request carries it |
| `npm … is older than 11.5.1` | raise `.node-version` |
| `npm publish` 404, 403 or an OIDC error | `npm trust list <package>`: it must show this repo, `release.yml`, environment `npm` |
| `cannot publish over` a version | it is already on npm; rerun the failed jobs, the step skips it |
| `npm still does not serve` | npm is holding the version back; when `npm view <package>@<version>` answers, rerun the failed jobs |
| the smoke script fails | the version is public and broken: fix forward and release the next one, then `npm deprecate <package>@<version> "<why>"` |
| no release pull request | only `feat`, `fix`, `perf` or `!` raise a version; else check the Actions setting in step 5 |

A version can never be published twice, even after unpublishing. Never work around a failure with a token or a
publish from a laptop: the provenance would be missing.

## Check what shipped

```bash
npm view <package> dist.attestations     # provenance is attached
npm audit signatures                     # in a project that installed it
gh release view vX.Y.Z                   # notes and the tarballs that were published
```
