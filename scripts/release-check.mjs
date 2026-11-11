#!/usr/bin/env node
/**
 * release-check: is this repo ready for its next release? Read-only; one line per check, each ✗ with its fix.
 * ✓ fine · ✗ fix it (exit 1) · ? could not check (exit 0). docs/releasing.md describes the release it checks.
 *
 *   node scripts/release-check.mjs        (pnpm release:check)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const WORKFLOW = 'release.yml'
const MANIFEST = '.release-please-manifest.json'

const ok = (text) => ({ mark: '✓', text })
const bad = (text, fix) => ({ mark: '✗', text, fix })
const unknown = (text) => ({ mark: '?', text })

/** Whether a path in a tarball looks like a secret: `.env` files, keys, npm credentials. */
export const looksPrivate = (path) =>
  /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/.test(path) || /\.pem$/.test(path) || /(^|\/)id_rsa[^/]*$/.test(path) || /(^|\/)\.npmrc$/.test(path)

/** `owner/repo` from a package.json repository or a git remote, GitHub only. */
export const repoOf = (url) => (typeof url === 'string' ? url : (url?.url ?? '')).match(/github\.com[/:]([^/\s]+\/[^/\s]+?)(\.git)?\/?$/)?.[1] ?? null

/** Bytes as people read them. */
export const sizeOf = (bytes) => (bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} kB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`)

/** The tree is clean and on main: both, or the release would not be what was tested. */
export const treeLines = (status, branch) => [
  status === null ? unknown('could not check the tree: not a git repository') : status.trim() ? bad(`${status.trim().split('\n').length} uncommitted change(s)`, 'commit or stash them: a release is cut from what is on main') : ok('the tree is clean'),
  branch === 'main' ? ok('on main') : bad(`on ${branch || 'no branch'}, not main`, 'releases are cut from main: `git switch main && git pull`'),
]

/** Every public package carries the manifest's version: the release pull request bumps them together. */
export const versionLines = (packages, manifestVersion) =>
  manifestVersion === undefined
    ? [bad(`${MANIFEST} has no version for "."`, 'write {".": "<the version on npm>"} into it')]
    : packages.map(({ name, version }) =>
        version === manifestVersion
          ? ok(`${name} is at ${version}, like ${MANIFEST}`)
          : bad(`${name} is at ${version}, ${MANIFEST} says ${manifestVersion}`, `set its version to ${manifestVersion} and list its package.json under extra-files in release-please-config.json`),
      )

/** What a package's tarball would hold, from `npm pack --dry-run --json`, and anything in it that looks private. */
export const tarballLines = (name, packed) => {
  const secrets = packed.files.map((file) => file.path).filter(looksPrivate)
  return [
    ok(`${name} packs ${packed.files.length} files, ${sizeOf(packed.size)} (${sizeOf(packed.unpackedSize)} unpacked)`),
    ...secrets.map((path) => bad(`${name} would publish ${path}`, 'leave it out with "files" in package.json or .npmignore; if it was ever published, rotate what it holds')),
  ]
}

/** The trusted publishers in the output of `npm trust list --json`: one object, a list, or objects one after another. */
export const publishersOf = (stdout) => {
  const text = stdout.trim()
  if (!text) return []
  const parsed = JSON.parse(text.startsWith('[') ? text : `[${text.replace(/\}\s*\{/g, '},{')}]`)
  if (parsed.some((entry) => entry?.error)) throw new Error(parsed.find((entry) => entry.error).error.summary ?? 'npm answered with an error')
  return parsed
}

/** Whether one of the package's trusted publishers is this repo's release workflow on GitHub. */
export const publisherLine = (name, publishers, repo) => {
  const command = `npm trust github ${name} --file ${WORKFLOW} --repo ${repo} --env npm --allow-publish`
  const github = publishers.filter((publisher) => publisher.type === 'github')
  const mine = github.find((publisher) => publisher.repository?.toLowerCase() === repo.toLowerCase() && basename(publisher.file ?? '') === WORKFLOW)
  if (mine) return ok(`${name} trusts ${repo} ${WORKFLOW}${mine.environment ? ` (environment ${mine.environment})` : ''}`)
  const others = github.map((publisher) => `${publisher.repository} ${publisher.file}`).join(', ')
  return bad(`${name} has no trusted publisher for ${repo} ${WORKFLOW}${others ? ` (it trusts ${others})` : ''}`, `\`${command}\``)
}

/** 1 when any line needs fixing; a check that could not run never fails the whole. */
export const exitCodeOf = (lines) => (lines.some((line) => line.mark === '✗') ? 1 : 0)

/** A line as printed: the mark, what was found, and how to fix it. */
export const render = (line) => `${line.mark} ${line.text}${line.fix ? `\n  fix: ${line.fix}` : ''}`

// ---- Reading the repo and the registry ----

const run = (command, args, cwd = process.cwd()) => {
  const { status, stdout, stderr } = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
  return { status, stdout: stdout ?? '', stderr: stderr ?? '' }
}
const jsonOf = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Every package that gets published: the workspace's when pnpm lists them, else the one at the root. */
const publicPackages = () => {
  const listed = jsonOf(run('pnpm', ['ls', '--recursive', '--depth', '-1', '--json']).stdout)
  const folders = listed?.length ? listed.map((project) => project.path) : [process.cwd()]
  return folders.map((path) => ({ path, ...JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) })).filter((pkg) => !pkg.private && pkg.name)
}

const packedLines = (pkg) => {
  // --ignore-scripts keeps the check read-only: a package that builds on prepack shows what is on disk now
  const [packed] = jsonOf(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], pkg.path).stdout) ?? []
  return packed ? tarballLines(pkg.name, packed) : [unknown(`could not check what ${pkg.name} packs: \`npm pack --dry-run\` in its folder says why`)]
}

const publishedLine = ({ name, version }) => {
  const { status, stdout } = run('npm', ['view', `${name}@${version}`, 'version', '--json'])
  if (status === 0 && jsonOf(stdout) === version) return ok(`${name}@${version} is on npm: already published, the next release pull request bumps it`)
  if (status === 0 && !stdout.trim()) return ok(`${name}@${version} is not on npm yet: merging the release pull request publishes it`)
  if (jsonOf(stdout)?.error?.code === 'E404') return bad(`${name} is not on npm at all`, 'publish its first version by hand (`pnpm publish --access public`): a trusted publisher can only be added to a package that exists')
  return unknown(`could not check whether ${name}@${version} is on npm`)
}

const trustLine = (pkg, repo) => {
  if (!repo) return unknown(`could not check ${pkg.name}'s trusted publisher: no GitHub repository in its package.json or the origin remote`)
  // Never answers a login or one-time-password prompt: stdin is closed
  const { status, stdout } = run('npm', ['trust', 'list', pkg.name, '--json'])
  try {
    if (status !== 0) throw new Error('npm trust list failed')
    return publisherLine(pkg.name, publishersOf(stdout), repo)
  } catch {
    return unknown(`could not check ${pkg.name}'s trusted publisher (npm 11.10 or newer, logged in, maybe a one-time password): \`npm trust list ${pkg.name}\``)
  }
}

const main = () => {
  const packages = publicPackages()
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {}
  const origin = run('git', ['remote', 'get-url', 'origin']).stdout.trim()
  const tree = run('git', ['status', '--porcelain'])
  const lines = [
    ...treeLines(tree.status === 0 ? tree.stdout : null, run('git', ['branch', '--show-current']).stdout.trim()),
    ...(packages.length ? versionLines(packages, manifest['.']) : [bad('no public package here', 'a package to release has a name and no "private": true')]),
    ...packages.flatMap(packedLines),
    ...packages.map(publishedLine),
    ...packages.map((pkg) => trustLine(pkg, repoOf(pkg.repository) ?? repoOf(origin))),
  ]
  for (const line of lines) console.log(render(line))
  const [fixes, unchecked] = ['✗', '?'].map((mark) => lines.filter((line) => line.mark === mark).length)
  console.log(fixes ? `${fixes} to fix before the next release` : `ready to release${unchecked ? ` (${unchecked} could not be checked)` : ''}`)
  process.exitCode = exitCodeOf(lines)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
