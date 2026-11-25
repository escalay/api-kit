#!/usr/bin/env node
/**
 * kit: copy the kit's parts into an app (shadcn-style), then keep them in step with the kit.
 * The app owns the copies; `kit.json` beside them records the kit version and the hash of every file as copied, so
 * `diff` can tell your edits from the kit's changes and `update` never overwrites an edit without `--force`.
 * `--web-dir` (relative to `--dir`, remembered in kit.json) puts the browser parts in their own folder, still
 * tracked by the one kit.json (as `@web/<file>`).
 *
 *   kit <command> --help                      that command's lines from this list (-h too)
 *   kit list                                  parts, what they need, which are installed; then the root items
 *   kit add core guide mcp testing [--dir src/kit] [--web-dir ../web] [--install]
 *   kit diff [--dir src/kit] [--patch]        per file: unchanged, you edited, kit changed, both
 *   kit update [part…] [--dir src/kit] [--force [--all]]
 *                                             --force takes the kit's file over your edit in the parts named (`kit` names
 *                                             the generated index.ts), and names each edit it overwrites or keeps; naming
 *                                             no part, it refuses while it would overwrite an edit: --force --all takes them all
 *   kit upgrading [--dir src/kit] [--from <version>]
 *                                             what changed for the parts in kit.json since its version (or --from), up to
 *                                             this kit, and what to do: their notes from the kit's docs/upgrading.md, part by part;
 *                                             first, each edit the kit changed too in a part whose notes name a fix
 *   kit doctor [--dir src/kit] [--adopt] [--keep <file…>]
 *                                             missing files, edited files, parts behind this kit; exits 1 with a fix per line (a note never fails it);
 *                                             --keep records those edited files as kept in kit.json: a note while they stay so
 *   kit adopt [--dir src/kit]                 write kit.json for parts copied without it (by the shadcn CLI)
 *   kit init <dir> [--preset api|app] [--title "My API"] [--runtime both|cloudflare|node] [--bare] [--no-git] [--no-install] [--yes]
 *                                             a new app: features/, the kit in src/kit, tests; Node (server.ts, a
 *                                             container) and/or Workers (worker.ts, D1); then pnpm install, format and
 *                                             migrations, so its gate passes as made (--no-install leaves them to you).
 *                                             It never asks; --yes is accepted
 *   kit feature <plural-name> [--app .] [--switch] [--singular <name>] [--no-remove] [--fields "name:string minutes:int tags:string[] notes:text?"]
 *                                             a new feature folder (schema, repo, routes, handlers, tools), listed;
 *                                             --switch lists it in src/features/catalog.ts so an owner can switch it off;
 *                                             --fields gives its own fields (string, text, int, number, bool, string[],
 *                                             enum(a|b|c); ? when it may be left out) instead of a title and a body;
 *                                             --singular names one (shelves → shelf); --no-remove leaves out delete
 *   kit guide [--from guide] [--out src/guide.gen.ts]  the guide folder as a module (GUIDE_FILES), for Workers
 *   kit sdk [--app .] [--package name] [--bin name]
 *                                             a typed TypeScript client in sdk/: generated types, a fetch-only core,
 *                                             a coverage test that fails until every route has a method; `pnpm sdk:types`;
 *                                             and the app's command line (sdk/cli, the package's bin)
 *   kit cli [--app .] [--bin name] [--update] the command line for an app that already has sdk/; --update takes this
 *                                             kit's engine (sdk/cli/engine) and leaves the app's bin, jobs and commands
 *   kit button [--app .] [--repo owner/name] [--branch b [--subdir d]] [--check] [--write] [--smoke]
 *                                             the Deploy to Cloudflare button: prints its link, Markdown and HTML; --check
 *                                             lists what would stop a stranger's deploy (ids or account in wrangler.jsonc,
 *                                             settings the form can't describe, migrations the deploy skips), exit 1;
 *                                             --write puts it in README.md; --smoke deploys a copy as a stranger would,
 *                                             checks it answers, and deletes all it made (CLOUDFLARE_API_TOKEN/_ACCOUNT_ID)
 *   kit repo [check|apply] [--app .] [--repo owner/name] [--merge squash|rebase] [--checks a,b]
 *                                             the GitHub repository set up as the standard says (§20), through `gh`:
 *                                             merges, the Actions token, security alerts, and the rules for main
 *                                             (required checks: ci.yml's jobs that always run, and for a job calling a
 *                                             reusable workflow, "<job> / <its job>"); check exits 1 on drift
 *   kit brand [--app .] [--check]             brand/ (brand.ts, icon.svg, icon-dark.svg) rendered into src/brand.gen.ts: the
 *                                             favicon, PNG icons and OG card, committed (needs @resvg/resvg-js in the app);
 *                                             --check exits 1 when brand/ changed since. `kit add brand` scaffolds brand/
 *   kit license keys [--out <folder>]        a product's signing key pair: the private key into <folder>/license-private.jwk
 *                                             (0600, keep it in a secret store), the public JWK printed for the app's code
 *   kit license mint --private <file> --product <name> --licensee <who> --plan <plan> [--grants a,b] [--days 365] [--instance <id>]
 *                                             a license key (an ES256 JWT) the app's `licenseOf` accepts; printed, never stored
 *   kit license verify <key> --public <file> --product <name> [--instance <id>]
 *                                             what a key grants, or why it is refused
 *
 * @example
 * npx @escalay/kit add core pagination guide mcp testing --dir apps/api/src/kit --install
 * import { createAgentApi } from './kit/index.js'      // in the app
 */
import { spawnSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const KIT = dirname(fileURLToPath(import.meta.url))
const REPO = 'escalay/api-kit'
const rangeOf = (dependency) => [dependency.slice(0, dependency.lastIndexOf('@')), dependency.slice(dependency.lastIndexOf('@') + 1)]
/** registry.json is a shadcn registry; a part's requires are its dependencies on this repo, a dependency without a range is a peer. */
const ITEMS = JSON.parse(readFileSync(join(KIT, 'registry.json'), 'utf8')).items
/** Root items (`meta.root`) are repo setup the shadcn CLI installs at the repo root: not parts, so `add`, `adopt` and `doctor` never see them. */
const ROOT_ITEMS = ITEMS.filter((item) => item.meta?.root)
const shadcnAdd = (name) => `npx shadcn add ${REPO}/${name}`
const REGISTRY = Object.fromEntries(
  ITEMS.filter((item) => !item.meta?.root).map((item) => [
    item.name,
    {
      description: item.description,
      files: item.files.map((file) => file.path.replace(/^src\//, '')),
      requires: (item.registryDependencies ?? []).filter((name) => name.startsWith(`${REPO}/`)).map((name) => name.slice(REPO.length + 1)),
      dependencies: Object.fromEntries((item.dependencies ?? []).filter((dependency) => dependency.lastIndexOf('@') > 0).map(rangeOf)),
      entry: item.meta?.entry,
      web: item.meta?.web,
      wiring: item.meta?.wiring,
    },
  ]),
)
const VERSION = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')).version
const SOURCE = '@escalay/kit'

const sha = (text) => createHash('sha256').update(text).digest('hex')
const fail = (message) => {
  console.error(`kit: ${message}`)
  process.exit(1)
}

// ---- Arguments ----

const [command = 'help', ...rest] = process.argv.slice(2)
const flags = new Set(rest.filter((arg) => arg.startsWith('--') && !arg.includes('=')))
const valueOf = (flag) => rest.find((arg, index) => rest[index - 1] === flag) ?? rest.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
const dirArg = valueOf('--dir') ?? 'src/kit'
const webDirArg = valueOf('--web-dir')
/** Flags that take the next argument as their value, so it is never read as a name. */
const VALUE_FLAGS = new Set(['--fields', '--singular', '--dir', '--web-dir', '--title', '--runtime', '--preset', '--app', '--from', '--out', '--package', '--bin', '--repo', '--merge', '--checks', '--branch', '--subdir', '--private', '--public', '--product', '--licensee', '--plan', '--grants', '--days', '--instance'])
const names = rest.filter((arg, index) => !arg.startsWith('--') && !VALUE_FLAGS.has(rest[index - 1]))
const dir = resolve(process.cwd(), dirArg)
/** The app the kit folder belongs to: `--app`, else the nearest folder at or above `--dir` with a package.json; null when none. */
const appRootOf = () => {
  if (valueOf('--app')) return resolve(process.cwd(), valueOf('--app'))
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, 'package.json'))) return at
    if (dirname(at) === at) return null
  }
}
const lockPath = join(dir, 'kit.json')

// ---- Modules ----

/** The modules asked for plus everything they require, in registry order. */
const withRequired = (wanted) => {
  const all = new Set()
  const visit = (name) => {
    if (ROOT_ITEMS.some((item) => item.name === name)) fail(`"${name}" goes to the repo root, not into ${dirArg}: \`${shadcnAdd(name)}\``)
    if (!REGISTRY[name]) fail(`no module "${name}". Modules: ${Object.keys(REGISTRY).join(', ')}`)
    if (all.has(name)) return
    for (const required of REGISTRY[name].requires ?? []) visit(required)
    all.add(name)
  }
  wanted.forEach(visit)
  return Object.keys(REGISTRY).filter((name) => all.has(name))
}

const upstreamOf = (file) => readFileSync(join(KIT, 'src', file), 'utf8')

// A browser module's files sit under the web dir when there is one; kit.json keys them `@web/<file>` (a module folder
// can be called web/, so the prefix must be something no folder is)
const WEB = '@web/'
const WEB_FILES = new Set(Object.values(REGISTRY).filter((module) => module.web).flatMap((module) => module.files))
// Every module carries its README (what it is for, an example, its rules), so the practices travel with the copy
const keyOf = (name, file, webDir) => (REGISTRY[name].web && webDir ? WEB + file : file)
const sourceOf = (key) => (key.startsWith(WEB) ? key.slice(WEB.length) : key)
const pathOf = (key, webDir) => (key.startsWith(WEB) && webDir ? join(resolve(dir, webDir), key.slice(WEB.length)) : join(dir, key))

/** index.ts re-exports every installed module that isn't its own entry point (mcp, testing, the browser modules). */
const indexFor = (modules) =>
  modules
    .filter((name) => !REGISTRY[name].entry)
    .flatMap((name) => {
      const own = REGISTRY[name].files.find((file) => file.endsWith('/index.ts'))
      return own ? [own] : REGISTRY[name].files.filter((file) => /\.tsx?$/.test(file))
    })
    .sort()
    .map((file) => `export * from './${file.replace(/\.ts$/, '.js')}'`)
    .join('\n') + '\n'

/** What each file should contain at this kit version: the module files, plus the generated index when anything goes in it. */
const expectedFiles = (modules, webDir) => {
  const files = Object.fromEntries(modules.flatMap((name) => REGISTRY[name].files.map((file) => [keyOf(name, file, webDir), upstreamOf(file)])))
  if (modules.some((name) => !REGISTRY[name].entry)) files['index.ts'] = indexFor(modules)
  return files
}

/** kit.json, with web-dir keys from kit 0.10–1.0.1 (`web/<file>`) read as `@web/<file>`. */
const readLock = () => {
  if (!existsSync(lockPath)) return null
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  if (!lock.webDir) return lock
  const flat = { 'web/search-client.ts': 'browser/search-client.ts', 'web/search-react.ts': 'browser/search-react.ts', 'web/boards-client.ts': 'browser/boards-client.ts', 'web/boards-react.ts': 'browser/boards-react.ts', 'web/refs.ts': 'boards/refs.ts', 'web/vector-search-block.tsx': 'browser/vector-search-block.tsx' }
  const keyFor = (key) => (flat[key] ? `${WEB}${flat[key]}` : key.startsWith('web/') && WEB_FILES.has(key.slice(4)) ? WEB + key.slice(4) : key)
  return { ...lock, files: Object.fromEntries(Object.entries(lock.files).map(([key, hash]) => [keyFor(key), flat[key] ? null : hash]).filter(([, hash]) => hash !== null)) }
}
/** `kept` is the edits `doctor --keep` recorded: each file's hash as it was kept. */
const writeLock = (modules, hashes, webDir, version = VERSION, kept = {}) =>
  writeFileSync(lockPath, JSON.stringify({ $comment: 'Written by @escalay/kit; hashes are of the files as the kit last wrote them.', source: SOURCE, version, modules, ...(webDir ? { webDir } : {}), files: Object.fromEntries(Object.entries(hashes).sort()), ...(Object.keys(kept).length ? { kept: Object.fromEntries(Object.entries(kept).sort()) } : {}) }, null, 2) + '\n')

const localHash = (key, webDir) => (existsSync(pathOf(key, webDir)) ? sha(readFileSync(pathOf(key, webDir), 'utf8')) : null)
/** The kept edits still on disk as they were kept: one taken from the kit, or changed since, is no longer kept. */
const keptOf = (lock) => Object.fromEntries(Object.entries(lock?.kept ?? {}).filter(([file, hash]) => localHash(file, lock.webDir) === hash))

const dependenciesOf = (modules) => Object.assign({}, ...modules.map((name) => REGISTRY[name].dependencies ?? {}))

/** A declared spec (`^4.13.20`, `4.14.0`) whose lowest version a range (`^4.13.18`) takes; another range is met only by itself. */
const meetsRange = (spec, range) => {
  if (spec === range) return true
  const version = spec?.replace(/^[\^~]/, '')
  if (!range.startsWith('^') || !isVersion(version ?? '')) return false
  const [floor, [major, minor]] = [range.slice(1), version.split('.').map(Number)]
  const [floorMajor, floorMinor] = floor.split('.').map(Number)
  return major === floorMajor && (major > 0 || minor === floorMinor) && compareVersions(version, floor) >= 0
}

/** The parts' dependencies the app's package.json lacks, or declares at a version their range doesn't take. */
const missingDependencies = (modules) => {
  const manifestPath = join(appRootOf() ?? dir, 'package.json')
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {}
  const declared = { ...manifest.dependencies, ...manifest.devDependencies }
  return Object.entries(dependenciesOf(modules)).filter(([name, range]) => !meetsRange(declared[name], range))
}

const installCommand = (modules) => {
  const deps = missingDependencies(modules).map(([name, range]) => `${name}@${range}`)
  return deps.length ? `pnpm add ${deps.join(' ')}` : Object.keys(dependenciesOf(modules)).length ? 'package.json has them' : 'none'
}

const install = (modules) => {
  if (!installCommand(modules).startsWith('pnpm add')) return
  const result = spawnSync('pnpm', installCommand(modules).split(' ').slice(1), { stdio: 'inherit', cwd: process.cwd() })
  if (result.status !== 0) fail('pnpm add failed; run it yourself: ' + installCommand(modules))
}

/** Each file's state against kit.json: did you edit it, did the kit change it. A file equal to the kit's is unchanged, whatever kit.json recorded. */
const statusOf = (lock, expected) =>
  Object.keys({ ...lock.files, ...expected }).sort().map((file) => {
    const path = pathOf(file, lock.webDir)
    const local = existsSync(path) ? sha(readFileSync(path, 'utf8')) : null
    const recorded = lock.files[file] ?? null
    const kit = expected[file] === undefined ? null : sha(expected[file])
    if (local !== null && local === kit) return { file, state: 'unchanged', edited: false, changed: false }
    const edited = local !== null && recorded !== null && local !== recorded
    // A part's file is fixed per kit version, so at kit.json's version an edited one's other hash is a wrong record; index.ts also follows the parts
    const changed = kit !== recorded && !(edited && lock.version === VERSION && file !== 'index.ts')
    const state = local === null ? 'missing' : recorded === null ? 'new in kit' : kit === null ? 'dropped by kit' : edited && changed ? 'both changed' : edited ? 'you edited' : changed ? 'kit changed' : 'unchanged'
    return { file, state, edited, changed }
  })

/** What to do with files you edited that the kit changed too; `--force` names their parts, so it overwrites no other edit. */
const keptFix = (parts) => `\`kit diff --dir ${dirArg} --patch\` shows both; \`${forceCommand(parts)}\` takes the kit's, then make your edits again`
/** `kit update <parts> --force`; `kit` names the generated index.ts, which belongs to no part. */
const forceCommand = (parts) => ['kit update', ...parts, '--dir', dirArg, '--force'].join(' ')

/** The part a recorded file came with (`index.ts` is the kit's own). */
const partOf = (key, modules) => modules.find((name) => REGISTRY[name].files.includes(sourceOf(key))) ?? 'kit'

/** The edits kit.json records as kept, still as they were: notes, never findings, until the kit changes the file too. */
const keptEditsOf = (lock) => {
  const kept = keptOf(lock)
  return statusOf(lock, expectedFiles(lock.modules, lock.webDir)).filter(({ file, state }) => state === 'you edited' && kept[file] !== undefined).map(({ file }) => file)
}

/** One line per thing wrong with the copy, each saying how to fix it. */
const findingsOf = (lock) => {
  const keptEdits = keptEditsOf(lock)
  const statuses = statusOf(lock, expectedFiles(lock.modules, lock.webDir)).filter(({ file }) => !keptEdits.includes(file))
  const behind = [...new Set(statuses.filter(({ state }) => ['kit changed', 'new in kit', 'dropped by kit'].includes(state)).map(({ file }) => partOf(file, lock.modules)))]
  const kept = statuses.filter(({ state }) => state === 'both changed')
  return [
    ...statuses.filter(({ state }) => state === 'missing').map(({ file }) => `missing  ${file}: \`kit update --dir ${dirArg}\` writes it again`),
    ...statuses
      .filter(({ edited }) => edited)
      .map(({ file, state }) => (state === 'both changed' ? `edited   ${file}: you edited it, and kit ${VERSION} changed it: ${keptFix([partOf(file, lock.modules)])}` : `edited   ${file}: yours to keep; \`kit diff --dir ${dirArg} --patch\` shows the change, \`${forceCommand([partOf(file, lock.modules)])}\` takes the kit's`)),
    ...behind.map((part) => `behind   ${part} was copied from kit ${lock.version} and kit ${VERSION} changed it: \`kit diff --dir ${dirArg} --patch\`, then \`kit update --dir ${dirArg}\``),
    ...(lock.version !== VERSION && !behind.length && !kept.length ? [`behind   kit.json says kit ${lock.version}, this is ${VERSION} with the same files: \`kit update --dir ${dirArg}\` records it`] : []),
  ]
}

/** `doctor --keep <file…>`: records each edited file's hash as kept, so doctor counts it no more while it stays so. */
const keepEdits = (lock) => {
  if (!names.length) fail(`name the edited files to keep, as doctor names them: \`kit doctor --dir ${dirArg} --keep core/guards.ts\``)
  const edited = statusOf(lock, expectedFiles(lock.modules, lock.webDir)).filter(({ state }) => state === 'you edited').map(({ file }) => file)
  for (const file of names) if (!edited.includes(file)) fail(`${file} is not an edit doctor can keep (only "edited … yours to keep" lines): ${edited.join(', ') || 'none here'}`)
  writeLock(lock.modules, lock.files, lock.webDir, lock.version, { ...keptOf(lock), ...Object.fromEntries(names.map((file) => [file, localHash(file, lock.webDir)])) })
  console.log(`Kept ${names.join(', ')} in kit.json: doctor notes ${names.length === 1 ? 'it' : 'them'} until ${names.length === 1 ? 'it changes' : 'they change'} or the kit changes ${names.length === 1 ? 'it' : 'them'} too`)
}

// ---- Upgrade notes: docs/upgrading.md, which the npm package ships ----

/** Below zero when version `a` is older than `b`: `1.9.0` is older than `1.10.0`. */
const compareVersions = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number))
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
const isVersion = (text) => /^\d+\.\d+\.\d+$/.test(text)
/** `### 1.30.0`, `### 1.29.0: approvals`, `### Unreleased (after 1.30.0)`. */
const NOTE_HEADING = /^### (?:(\d+\.\d+\.\d+)|Unreleased \(after (\d+\.\d+\.\d+)\))(?:: .+)?$/

/** The folder a part's notes are under: its README's (every browser part's is `browser`). */
const notesFolderOf = (name) => REGISTRY[name].files.find((file) => file.endsWith('README.md')).split('/')[0]

/**
 * A part folder's notes in docs/upgrading.md newer than `since` and no newer than this kit, each its `###` heading and
 * text; Unreleased is newer than the version it follows, an unknown heading always shown.
 */
const notesSince = (markdown, folder, since) => {
  const notes = []
  let inSection = false
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced
    if (!fenced && line.startsWith('## ')) {
      inSection = line === `## ${folder}`
      continue
    }
    if (!inSection) continue
    if (!fenced && line.startsWith('### ')) {
      const [, version, after] = NOTE_HEADING.exec(line) ?? []
      const newer = version ? compareVersions(version, since) > 0 && compareVersions(version, VERSION) <= 0 : after ? compareVersions(after, since) >= 0 && compareVersions(after, VERSION) <= 0 : true
      notes.push({ newer, lines: [line] })
    } else notes.at(-1)?.lines.push(line)
  }
  return notes.filter(({ newer }) => newer).map(({ lines }) => lines.join('\n').trim())
}

/** What an app behind this kit runs to read what changed: printed by `doctor` and `update`. */
const upgradingCommand = (since, withFrom) => `\`kit upgrading --dir ${dirArg}${withFrom ? ` --from ${since}` : ''}\``

/** Writes kit.json for parts that were copied without one (the shadcn CLI): every part whose files are all on disk. */
const adopt = () => {
  if (existsSync(lockPath)) fail(`${dirArg} already has a kit.json; \`kit doctor --dir ${dirArg}\` checks it`)
  const found = Object.keys(REGISTRY).filter((name) => REGISTRY[name].files.every((file) => existsSync(join(dir, file))))
  if (!found.length) fail(`no parts in ${dirArg}; \`kit add <part> --dir ${dirArg}\` copies one, \`kit list\` names them`)
  const modules = withRequired(found)
  const expected = expectedFiles(modules)
  const index = join(dir, 'index.ts')
  if (expected['index.ts'] && !existsSync(index)) writeFileSync(index, expected['index.ts'])
  // The kit's hashes, not the disk's: a file that already differs shows as edited instead of passing as the kit's
  writeLock(modules, Object.fromEntries(Object.entries(expected).map(([file, text]) => [file, sha(text)])))
  console.log(`Adopted ${found.join(', ')} in ${dirArg} as kit ${VERSION}`)
  const absent = modules.filter((name) => !found.includes(name))
  if (absent.length) console.log(`Recorded ${absent.join(', ')} too (they are required): \`kit update --dir ${dirArg}\` copies them`)
}

// ---- Generators: a new app, a new feature ----

/** The modules a new app starts with. */
const APP_MODULES = ['core', 'db', 'oauth', 'pagination', 'guide', 'mcp', 'brand', 'switches', 'testing']
/** The browser parts the app preset's web/ starts with. */
const WEB_APP_MODULES = ['switches-client', 'switches-react']
const RUNTIME = { '@hono/node-server': '^2.1.8', tsx: '^4.23.15' }
const DEV = { '@types/node': '^26.6.6', typescript: '^7.0.2', vitest: '^5.1.0' }
/** What the Cloudflare side adds, at the versions the kit tests with. */
const KIT_DEV = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')).devDependencies
const WORKERS_DEV = Object.fromEntries(['wrangler', '@cloudflare/vitest-plugin', '@cloudflare/workers-types'].map((name) => [name, KIT_DEV[name]]))
/**
 * The pnpm the kit is built with, pinned in each new app so its CI installs with the pnpm that wrote its lockfile.
 * Written here because `pnpm pack` drops `packageManager` from the published package.json; a test keeps it equal to ours.
 */
const KIT_PACKAGE_MANAGER = 'pnpm@12.3.4'
/** The newest compatibility date the pinned workerd is sure to know: the day its types were cut (`5.20261106.1` → `2026-11-06`). Today's date fails once it is ahead of that binary. */
const COMPATIBILITY_DATE = KIT_DEV['@cloudflare/workers-types'].replace(/^\D*\d+\.(\d{4})(\d{2})(\d{2})\..*$/, '$1-$2-$3')
/** The runtimes an app can run on: `node` (server.ts, a container), `cloudflare` (worker.ts, D1), or `both`. */
const RUNTIMES = ['both', 'cloudflare', 'node']
/** The linter and formatter every new app gets, at the versions the kit tests with. */
const LINT_DEV = Object.fromEntries(['oxlint', 'oxfmt'].map((name) => [name, KIT_DEV[name]]))
/** What the browser app of the `app` preset adds, at the versions the kit tests with. */
const WEB_DEPS = Object.fromEntries(['@tanstack/react-query', '@tanstack/react-router', 'react', 'react-dom'].map((name) => [name, KIT_DEV[name]]))
const WEB_DEV = Object.fromEntries(['@cloudflare/vite-plugin', '@tailwindcss/vite', '@tanstack/router-plugin', '@testing-library/react', '@types/react', '@types/react-dom', '@vitejs/plugin-react', 'happy-dom', 'tailwindcss', 'vite'].map((name) => [name, KIT_DEV[name]]))
/**
 * The starting combinations: `api` is the kit's parts for an API with one example feature; `app` is that API with a
 * browser app beside it (web/: React, TanStack Router and Query, Tailwind), built by Vite and served by one Worker.
 */
/** openapi-typescript, pinned: `kit sdk` turns the API's document into the client's types with it. */
const OPENAPI_TYPESCRIPT = '7.13.0'
const PRESETS = ['api', 'app', 'selfhosted']
const scriptsFor = (runtime, preset) => {
  const node = { dev: 'tsx watch src/server.ts', start: 'tsx src/server.ts' }
  const workers = {
    migrations: 'tsx scripts/migrations.ts',
    deploy: 'pnpm guide && pnpm migrations && wrangler d1 migrations apply DB --remote && wrangler deploy',
    // The same, for a deployment whose account and ids live in a secret store, not the repository
    'deploy:env': 'tsx scripts/deploy-env.ts',
  }
  const typecheck = runtime === 'node' ? 'tsc --noEmit' : 'tsc --noEmit && tsc --noEmit -p test/workers/tsconfig.json'
  // `check` is CI's checks job and `gate` everything CI runs, so a push that passes the pre-push hook passes CI
  const gateOf = (...more) => ({
    lint: 'oxlint',
    format: 'oxfmt',
    // Each failure names its fix: oxfmt's own message doesn't, and the migrations check does
    check: ['pnpm typecheck', 'pnpm lint', "(oxfmt --check || (echo 'Not formatted: run pnpm format' >&2 && exit 1))", ...more].join(' && '),
    gate: 'pnpm check && pnpm test',
    prepare: 'tsx scripts/hooks.ts',
  })
  const migrationsCheck = 'tsx scripts/migrations.ts --check'
  // The app preset: Vite runs and builds both sides (the Worker through Cloudflare's plugin), and wrangler deploys the build
  if (preset === 'app')
    return {
      dev: 'vite',
      build: 'vite build',
      preview: 'vite preview',
      guide: 'tsx scripts/guide.ts',
      migrations: workers.migrations,
      deploy: 'pnpm guide && pnpm migrations && vite build && wrangler d1 migrations apply DB --remote && wrangler deploy',
      'deploy:env': workers['deploy:env'],
      test: 'vitest run',
      typecheck: `${typecheck} && tsc --noEmit -p tsconfig.web.json`,
      ...gateOf(migrationsCheck, 'vite build'),
    }
  return {
    ...(runtime === 'cloudflare' ? { dev: 'wrangler dev' } : node),
    ...(runtime === 'both' ? { 'dev:worker': 'wrangler dev' } : {}),
    guide: 'tsx scripts/guide.ts',
    ...(runtime === 'node' ? {} : workers),
    test: 'vitest run',
    typecheck,
    ...gateOf(...(runtime === 'node' ? [] : [migrationsCheck])),
  }
}

/** Writes a guide folder as a module (GUIDE_FILES). Must match guideModuleSource in src/guide/guide.ts byte for byte (test/kit.test.ts checks). */
const writeGuideModule = (from, out) => {
  const files = []
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(md|txt)$/.test(entry.name)) files.push([relative(from, path).split('\\').join('/'), readFileSync(path, 'utf8')])
    }
  }
  walk(from)
  files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(
    out,
    '// Generated by `kit guide` from the guide folder: edit the templates there, then run it again.\n' +
      'export const GUIDE_FILES: Record<string, string> = {\n' +
      files.map(([path, body]) => `  ${JSON.stringify(path)}: ${JSON.stringify(body)},\n`).join('') +
      '}\n',
  )
  return files.length
}

/**
 * Lines marked for one runtime, preset or feature shape (`<!-- runtime:node -->`, `// preset:app`, `# runtime:workers`,
 * `// feature:no-remove`, several at a line's end) stay, unmarked, only where `keeps` names that mark true.
 */
const MARK = /^(.*?) (?:<!-- ((?:runtime|preset|feature):[\w-]+) -->|\/\/ ((?:runtime|preset|feature):[\w-]+)|# ((?:runtime|preset|feature):[\w-]+))$/
const keepMarked = (text, keeps) => {
  const unmarked = (line) => {
    const marked = line.match(MARK)
    return !marked ? [line] : keeps[marked[2] ?? marked[3] ?? marked[4]] ? unmarked(marked[1]) : []
  }
  return text.split('\n').flatMap(unmarked).join('\n')
}

/** Copies a template folder, filling every placeholder in names and contents. */
const copyTemplate = (from, to, vars, renameOf = (file) => file) => {
  const fill = (text) => Object.entries(vars).reduce((filled, [key, value]) => filled.replaceAll(key, value), text)
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const source = join(from, entry)
    const target = join(to, fill(renameOf(entry)))
    if (statSync(source).isDirectory()) copyTemplate(source, target, vars)
    else writeFileSync(target, fill(readFileSync(source, 'utf8')), { mode: statSync(source).mode })
  }
}

const capital = (word) => word[0].toUpperCase() + word.slice(1)
const singularOf = (word) => (word.endsWith('ies') ? `${word.slice(0, -3)}y` : /(ss|x|ch|sh)es$/.test(word) ? word.slice(0, -2) : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word)

/** Every spelling a feature's files need, from its plural kebab-case name (`reading-lists`) and its singular, when the naive one is wrong (`shelf`). */
export const namesOf = (name, singular) => {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) fail(`"${name}" isn't a plural kebab-case name like notes or reading-lists`)
  if (singular !== undefined && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(singular)) fail(`"${singular}" isn't a kebab-case name like book or reading-list`)
  const many = name.split('-')
  const one = singular?.split('-') ?? [...many.slice(0, -1), singularOf(many.at(-1))]
  return {
    __name__: name,
    __camel__: many[0] + many.slice(1).map(capital).join(''),
    __Pascal__: many.map(capital).join(''),
    __Singular__: one.map(capital).join(''),
    __CONST__: many.join('_').toUpperCase(),
    __table__: many.join('_'),
    __snake_singular__: one.join('_'),
    __snake__: many.join('_'),
    __kebab_singular__: one.join('-'),
    __labels__: many.join(' '),
    __label__: one.join(' '),
  }
}

/**
 * The types `feature --fields` takes: the Drizzle column, its SQL, the answer's and the input's zod, the TypeScript
 * type, a value to make one with and another to change it to.
 */
const FIELD_TYPES = {
  string: { column: (name) => `text('${name}')`, sql: 'text', out: 'z.string()', input: 'z.string().trim().min(1).max(200)', type: 'string', made: 'First', changed: 'Changed' },
  text: { column: (name) => `text('${name}')`, sql: 'text', out: 'z.string()', input: 'z.string().max(10_000)', type: 'string', made: 'Some text', changed: 'Changed text' },
  int: { column: (name) => `integer('${name}')`, sql: 'integer', out: 'z.number().int()', input: 'z.number().int()', type: 'number', made: 3, changed: 4 },
  number: { column: (name) => `real('${name}')`, sql: 'real', out: 'z.number()', input: 'z.number()', type: 'number', made: 1.5, changed: 2.5 },
  bool: { column: (name) => `integer('${name}', { mode: 'boolean' })`, sql: 'integer', out: 'z.boolean()', input: 'z.boolean()', type: 'boolean', made: true, changed: false },
  'string[]': { column: (name) => `text('${name}', { mode: 'json' }).$type<string[]>()`, sql: 'text', out: 'z.array(z.string())', input: 'z.array(z.string().trim().min(1).max(200)).max(100)', type: 'string[]', made: ['one'], changed: ['two'] },
}
/** `enum(to-read|reading|done)`: one of the values, as text, checked by the route, the tool and the table. */
const enumType = (values) => ({
  column: (name) => `text('${name}', { enum: ${literal(values).replaceAll(',', ', ')} })`,
  sql: 'text',
  check: (column) => ` check ("${column}" in (${values.map((value) => `\\'${value}\\'`).join(', ')}))`,
  out: `z.enum(${literal(values).replaceAll(',', ', ')})`,
  input: `z.enum(${literal(values).replaceAll(',', ', ')})`,
  type: values.map((value) => `'${value}'`).join(' | '),
  made: values[0],
  changed: values[1] ?? values[0],
})
/** What the sample feature has when no --fields are given. */
const SAMPLE_FIELDS = 'title:string body:text?'
/** Names a feature's own fields can't take: the kit's, and the list's and the command line's flags. */
const OWN_FIELDS = ['id', 'createdAt', 'updatedAt', 'limit', 'cursor', 'json', 'yes', 'dryRun', 'input', 'timeout', 'profile', 'help']

/** `name:string minutes:int tags:string[] status:enum(to-read|done) notes:text?`, read: each field's name, type, and whether it may be left out. */
const fieldsOf = (spec) =>
  spec.trim().split(/\s+/).map((field) => {
    const [, name, type, values, optional] = field.match(/^([a-z][a-zA-Z0-9]*):([a-z]+(?:\[\])?|enum\(([a-z0-9][a-z0-9_-]*(?:\|[a-z0-9][a-z0-9_-]*)*)\))(\?)?$/) ?? []
    if (!values && !FIELD_TYPES[type]) fail(`${field}: a field is <name>:<type>, the type one of ${Object.keys(FIELD_TYPES).join(', ')}, enum(a|b|c) (lowercase values, a-z 0-9 - _), and ? after it when it may be left out (notes:text?)`)
    if (OWN_FIELDS.includes(name)) fail(`${name} is the kit’s own field or flag: name it something else`)
    const named = values?.split('|')
    if (named && new Set(named).size !== named.length) fail(`${name} names ${named.find((value, at) => named.indexOf(value) !== at)} twice: give each value once`)
    return { name, type: named ? 'enum' : type, optional: Boolean(optional), ...(named ? enumType(named) : FIELD_TYPES[type]) }
  }).map((field, index, fields) => {
    if (fields.findIndex((other) => other.name === field.name) !== index) fail(`${field.name} is named twice: give each field its own name`)
    return field
  })

const snakeOf = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
const literal = (value) => JSON.stringify(value).replaceAll('"', "'")
const flagOf = ({ name, made }, value = made) => {
  const flag = `--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
  return typeof value === 'boolean' ? (value ? flag : `--no-${flag.slice(2)}`) : `${flag} ${JSON.stringify([value].flat()[0])}`
}

/** The template's field placeholders, from the fields: columns, SQL, schemas, the tools' inputs, samples. */
const fieldVarsOf = (fields) => {
  const described = (field, zod) => `${field.name}: ${zod}.describe('Its ${snakeOf(field.name).replaceAll('_', ' ')}.')`
  const [first, last] = [fields[0], fields.at(-1)]
  return {
    __column_imports__: [...new Set(['sqliteTable', 'text', ...fields.map((field) => field.column('').split('(')[0])])].sort().join(', '),
    __columns__: fields.map((field) => `  ${field.name}: ${field.column(snakeOf(field.name))}${field.optional ? '' : '.notNull()'},`).join('\n'),
    __sql_columns__: fields.map((field) => `"${snakeOf(field.name)}" ${field.sql}${field.optional ? '' : ' not null'}${field.check?.(snakeOf(field.name)) ?? ''}`).join(', '),
    __out_fields__: fields.map((field) => `${field.name}: ${field.out}${field.optional ? '.nullable()' : ''},`).join(' '),
    __in_fields__: fields.map((field) => `${field.name}: ${field.input}${field.optional ? '.optional()' : ''}.openapi({ description: 'Its ${snakeOf(field.name).replaceAll('_', ' ')}.', example: ${literal(field.made)} })`).join(', '),
    __tool_create_fields__: fields.map((field) => described(field, `${field.input}${field.optional ? '.optional()' : ''}`)).join(', '),
    __tool_update_fields__: fields.map((field) => described(field, `${field.input}.optional()`)).join(', '),
    __card_fields__: fields.map((field) => `${field.name}: ${field.type}${field.optional ? ' | null' : ''}`).join('; '),
    __detail_lines__: fields.map((field) => `\`${field.name}: \${row.${field.name}${field.type === 'string[]' ? `${field.optional ? '?' : ''}.join(', ')` : ''}${field.optional ? " ?? '–'" : ''}}\``).join(', '),
    __first__: first.name,
    __sample__: `{ ${fields.map((field) => `${field.name}: ${literal(field.made)}`).join(', ')} }`,
    __patch_entries__: `${last.name}: ${literal(last.changed)}`,
    __create_flags__: fields.filter((field) => !field.optional).map((field) => flagOf(field)).join(' '),
    __edit_flags__: flagOf(last, last.changed),
  }
}

const addFeature = (root, name, { switchable = false, fieldSpec = SAMPLE_FIELDS, singular, remove = true } = {}) => {
  const vars = { ...namesOf(name, singular), ...fieldVarsOf(fieldsOf(fieldSpec)) }
  const list = join(root, 'src/features/index.ts')
  if (!existsSync(list)) fail(`no src/features/index.ts in ${relative(process.cwd(), root) || '.'}: run it inside an app made by init, or pass --app <dir>`)
  const folder = join(root, 'src/features', name)
  if (existsSync(folder)) fail(`src/features/${name} already exists`)
  const text = readFileSync(list, 'utf8')
  if (!text.includes('// kit:imports') || !text.includes('  // kit:features')) fail('src/features/index.ts lost its `// kit:imports` or `// kit:features` line; add the feature there by hand')
  // The list pages by cursor with the pagination part, which an older app may not have. `add` would also move every
  // part to this kit, so an app at another version is told the command for its own instead
  const lockFile = join(root, 'src/kit/kit.json')
  const kit = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : null
  if (kit && !kit.modules.includes('pagination') && kit.version !== VERSION)
    fail(`a feature's list pages with the pagination part, which src/kit lacks: \`npx @escalay/kit@${kit.version} add pagination --dir src/kit\` adds it at your kit's version (or take kit ${VERSION} first: \`kit upgrading\`, then \`kit update\`), then run this again`)
  if (kit && !kit.modules.includes('pagination')) {
    const added = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'add', 'pagination', '--dir', 'src/kit'], { cwd: root, encoding: 'utf8' })
    if (added.status !== 0) fail(`a feature's list pages with the pagination part, and copying it failed: ${added.stderr}`)
    console.log('Copied the pagination part into src/kit: the new list pages by cursor')
  }
  copyTemplate(join(KIT, 'templates/feature'), folder, vars, (file) => (file === 'feature.test.ts' ? `${name}.test.ts` : file))
  // Delete is a route, a handler, a repo call, a tool and a sample: all or none
  for (const file of readdirSync(folder)) writeFileSync(join(folder, file), keepMarked(readFileSync(join(folder, file), 'utf8'), { 'feature:remove': remove, 'feature:no-remove': !remove }))
  writeFileSync(list, text.replace('// kit:imports', `import { feature as ${vars.__camel__} } from './${name}/index.js'\n// kit:imports`).replace('  // kit:features', `  ${vars.__camel__},\n  // kit:features`))
  if (switchable) {
    const catalog = join(root, 'src/features/catalog.ts')
    const listed = existsSync(catalog) ? readFileSync(catalog, 'utf8') : ''
    if (!listed.includes('  // kit:catalog')) fail('src/features/catalog.ts lost its `// kit:catalog` line (or is missing): add the feature there by hand')
    writeFileSync(catalog, listed.replace('  // kit:catalog', `  '${name}': { title: '${vars.__Pascal__}', description: '${vars.__Pascal__}: say here what switching it off stops.' },\n  // kit:catalog`))
    const index = join(folder, 'index.ts')
    writeFileSync(index, readFileSync(index, 'utf8').replace(`  name: '${name}',`, `  name: '${name}',\n  switch: '${name}',`))
  }
  console.log(`Made src/features/${name}/ (schema, repo, routes, handlers, tools, index, test${remove ? '' : '; no delete'}), each one a ${vars.__label__}${singular ? '' : ' (--singular names it otherwise)'}, and listed it in src/features/index.ts${switchable ? `; an owner can switch it off ('${name}' in src/features/catalog.ts: describe what that stops)` : ''}`)
}

/**
 * Writes one client method per operation of the app's OpenAPI document into sdk/src/index.ts, named by operationId,
 * and lists each in the coverage test. Returns how many, or 0 when the document could not be built.
 */
const sdkMethods = (root) => {
  const built = spawnSync('pnpm', ['exec', 'tsx', 'scripts/openapi.ts'], { cwd: root, encoding: 'utf8' })
  const docFile = join(root, 'sdk/openapi.json')
  if (built.status !== 0 || !existsSync(docFile)) return 0
  const doc = JSON.parse(readFileSync(docFile, 'utf8'))
  const lines = []
  for (const [path, methods] of Object.entries(doc.paths ?? {}))
    for (const [method, operation] of Object.entries(methods)) {
      const id = operation.operationId
      if (!id || id === 'getHealth') continue
      const params = [...path.matchAll(/\{(\w+)\}/g)].map(([, name]) => name)
      const query = (operation.parameters ?? []).some((parameter) => parameter.in === 'query')
      const body = Boolean(operation.requestBody)
      const args = [...params.map((name) => `${name}: string`), ...(body ? [`body: Body<'${id}'>`] : []), ...(query ? [`query: Query<'${id}'> = {}`] : [])]
      const url = params.length ? `\`${path.replace(/\{(\w+)\}/g, '${segment($1)}')}\`` : `'${path}'`
      const call = [...(method === 'get' ? [] : [`method: '${method.toUpperCase()}'`]), ...(body ? ['body'] : []), ...(query ? ['query'] : [])]
      lines.push({ id, text: `    ${id}: (${args.join(', ')}) => request<Answer<'${id}'>>(${url}${call.length ? `, { ${call.join(', ')} }` : ''}),` })
    }
  const index = join(root, 'sdk/src/index.ts')
  const test = join(root, 'sdk/test/client.test.ts')
  writeFileSync(index, readFileSync(index, 'utf8').replace('    // kit:methods\n', lines.map(({ text }) => `${text}\n`).join('')))
  writeFileSync(test, readFileSync(test, 'utf8').replace('      // kit:covered\n', lines.map(({ id }) => `      ${id}: '${id}',\n`).join('')))
  return lines.length + 1
}

/** The names the SDK and CLI templates fill: the package, its title, its bin (`postbox`) and env prefix (`POSTBOX`). */
const sdkVarsOf = (root, packageName) => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const words = basename(pkg.name ?? basename(root)).split(/[-_.]/).filter(Boolean)
  const bin = valueOf('--bin') ?? words.join('-')
  if (!/^[a-z][a-z0-9-]*$/.test(bin)) fail(`--bin is one lowercase word or kebab-case name, like postbox`)
  return { __package__: packageName ?? valueOf('--package') ?? `${words.join('-')}-client`, __Title__: words.map(capital).join(' '), __Pascal__: words.map(capital).join(''), __camel__: words[0] + words.slice(1).map(capital).join(''), __bin__: bin, __PREFIX__: bin.replace(/-/g, '_').toUpperCase() }
}

/** Lint and format leave the generated files and the kit's CLI engine alone (the engine stays the kit's bytes, like src/kit). */
const ignoreGenerated = (root) => {
  for (const file of ['.oxlintrc.json', '.oxfmtrc.json'].map((name) => join(root, name)).filter(existsSync)) {
    const config = JSON.parse(readFileSync(file, 'utf8'))
    config.ignorePatterns = [...new Set([...(config.ignorePatterns ?? []), 'sdk/src/schema.gen.ts', 'sdk/openapi.json', 'sdk/dist/**', 'sdk/cli/engine/**', 'sdk/cli/commands.json'])]
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
  }
}

/** The app's typecheck covers the CLI's own tsconfig too. */
const typecheckCli = (root) => {
  const manifest = join(root, 'package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  if (pkg.scripts?.typecheck && !pkg.scripts.typecheck.includes('sdk/cli/tsconfig.json')) pkg.scripts.typecheck += ' && tsc --noEmit -p sdk/cli/tsconfig.json'
  writeFileSync(manifest, JSON.stringify(pkg, null, 2) + '\n')
}

/**
 * The app's commands through `cliGaps`, when the kit folder sits in an app (`<app>/src/kit` beside `src/app.ts`) with
 * its dependencies installed: the app is built in-process and its mounted tools, resources and jobs checked.
 */
const cliFindings = () => {
  const root = resolve(dir, '../..')
  if (!existsSync(join(root, 'src/app.ts')) || !existsSync(join(dir, 'testing/cli.ts'))) return []
  const url = (path) => JSON.stringify(pathToFileURL(join(root, path)).href)
  const jobs = existsSync(join(root, 'sdk/cli/jobs/index.ts')) ? `(await import(${url('sdk/cli/jobs/index.ts')})).jobs` : '[]'
  const script = join(tmpdir(), `kit-cli-gaps-${process.pid}.mts`)
  writeFileSync(script, `const { createApp } = await import(${url('src/app.ts')})
const { mountedOf, testDb } = await import(${url(`${relative(root, dir)}/index.ts`)})
const { cliGaps } = await import(${url(`${relative(root, dir)}/testing/cli.ts`)})
const app = await createApp({ db: await testDb(), env: {} })
const { tools = [], resources = [] } = mountedOf(app).mcp ?? {}
console.log(JSON.stringify(cliGaps({ tools, resources, jobs: ${jobs} })))
`)
  const checked = spawnSync('pnpm', ['exec', 'tsx', script], { cwd: root, encoding: 'utf8' })
  rmSync(script, { force: true })
  const gaps = checked.status === 0 ? JSON.parse(checked.stdout.trim().split('\n').at(-1) || '[]') : null
  // Not a finding about the kit's copy: say so, and leave the exit code to the copy
  if (!gaps) console.log(`note     could not build the app to check its commands with cliGaps (installed? createApp({ db, env }) enough?): ${(checked.stderr || '').trim().split('\n')[0] ?? ''}`)
  return (gaps ?? []).map((gap) => `cli      ${gap}`)
}

/** The text of each `name(…)` call in a file (`createAgentApi`, `createOAuth`), to its closing parenthesis. */
const callsOf = (text, name) =>
  [...text.matchAll(new RegExp(`\\b${name}\\(`, 'g'))].map(({ index }) => {
    const open = index + name.length
    let depth = 0
    for (let at = open; at < text.length; at++) {
      if (text[at] === '(') depth++
      else if (text[at] === ')' && --depth === 0) return text.slice(open, at + 1)
    }
    return text.slice(open)
  })

/** An option a call names, as `key:` or shorthand (`key,`, `key }`). */
const namesOption = (call, key) => new RegExp(`\\b${key}\\s*[:,}]`).test(call)

/** An option a call names with a value other than `false` (`limits: false` is no limits). */
const setsOption = (call, key) => namesOption(call, key) && !new RegExp(`\\b${key}\\s*:\\s*false\\b`).test(call)

/** Source with its comments blanked and its strings kept: an option or call named only in a comment is not code. */
const codeOf = (text) => text.replace(/('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? '')

/**
 * The app's own source files: under the nearest `src/` above the kit folder inside the app, else `./src` (the kit
 * folder left out). Never above the app (the folder kit runs in): a `src` there holds other projects.
 */
const appTexts = () => {
  const root = process.cwd()
  const srcAbove = (path) => (relative(root, path).startsWith('..') ? undefined : basename(path) === 'src' ? path : path === root ? undefined : srcAbove(dirname(path)))
  const src = srcAbove(dirname(dir)) ?? join(root, 'src')
  if (!existsSync(src)) return []
  return readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(m?ts|m?js|tsx)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => relative(dir, path).startsWith('..') && !path.includes('node_modules'))
    .map((path) => codeOf(readFileSync(path, 'utf8')))
}

/** A hint, not a finding: an app served on Node whose code names no `address` counts anonymous callers by headers as sent. */
const addressNotes = (texts) => {
  const onNode = texts.some((text) => text.includes('@hono/node-server'))
  const named = texts.some((text) => callsOf(text, 'createAgentApi').some((call) => namesOption(call, 'address')))
  return onNode && !named ? ["note     the app runs on Node (@hono/node-server) and names no source for the caller's address, so anonymous callers are counted by cf-connecting-ip or x-forwarded-for as sent: set createAgentApi({ address }) to the header your proxy writes, or 'socket' with nothing in front (STANDARD §9)"] : []
}

/**
 * Hints, not findings, on the app's OAuth server: an `approve` that opens the sign-in page to anyone without `limits`
 * and `publicOrigin` (what `createOAuth` warns of at start), and an app with the people part whose `owner` never asks
 * `personOf`, so a passkey owner can't approve. The owner is often a variable declared beside the call, so `personOf`
 * is looked for in the file that calls `createOAuth`, never in another.
 */
const oauthNotes = (texts, modules) => {
  const servers = texts.filter((text) => callsOf(text, 'createOAuth').length > 0)
  const calls = servers.flatMap((text) => callsOf(text, 'createOAuth'))
  const open = calls.some((call) => namesOption(call, 'approve') && !(setsOption(call, 'limits') && namesOption(call, 'publicOrigin')))
  const ownerless = modules.includes('people') && servers.length > 0 && !servers.some((text) => /\bpersonOf\(/.test(text))
  return [
    ...(open ? ['note     createOAuth has approve, so its sign-in page answers anyone, but no limits or publicOrigin: pass both (oauth README, Open endpoints; STANDARD §7)'] : []),
    ...(ownerless ? ['note     the app has the people part, but no createOAuth owner asks personOf: a deploy signed in by passkey alone can never approve a sign-in (oauth README)'] : []),
  ]
}

/**
 * Hints, not findings, on an app with the sharing part that calls `createSharing`: no `sweep(` call, so ended members
 * keep their grants; and on Workers, no `address: { header }` anywhere, so typed codes count each IPv6 address alone.
 */
const sharingNotes = (texts, modules) => {
  if (!modules.includes('sharing')) return []
  if (!texts.some((text) => callsOf(text, 'createSharing').length > 0)) return []
  const sweeps = texts.some((text) => /\bsweep\(/.test(text))
  const onWorkers = texts.some((text) => /\bExportedHandler\b/.test(text))
  const namesHeader = texts.some((text) => /\baddress\s*:\s*\{\s*header\s*:/.test(text))
  return [
    ...(sweeps ? [] : ['note     the app has the sharing part, but nothing calls sharing.sweep(): call it from the scheduled handler, or members past their lifetime or unused for 30 days keep their grants and old rows are never deleted (sharing README, Wire it)']),
    ...(onWorkers && !namesHeader ? ["note     the app runs on Workers with the sharing part, but names no header for the caller's address, so typed codes are counted per IPv6 address rather than per /64: pass address: { header: 'cf-connecting-ip' } (sharing README, Limits; STANDARD §9)"] : []),
  ]
}

/**
 * Text `init`, `feature --switch` and `add brand` write for the app to replace, each with what to write instead. Agents
 * read it as the product's own, so it fails `doctor` until it is replaced; every check of the app passes with it.
 */
const productSkills = (root) => (existsSync(join(root, 'guide/skills')) ? readdirSync(join(root, 'guide/skills'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => `guide/skills/${entry.name}/SKILL.md`) : [])
const STARTER_TEXT = [
  { files: productSkills, text: 'Replace this line with', what: 'its description', instead: 'say when an agent should use the product, in its users’ words' },
  { files: () => ['brand/brand.ts'], text: ', an agent-ready API.', what: 'its description', instead: 'say what the product does, in at most 100 characters, then `pnpm add -D @resvg/resvg-js` && `kit brand`' },
  { files: () => ['src/features/catalog.ts'], text: 'say here what switching it off stops', what: 'a description', instead: 'say what switching the feature off stops' },
]

/**
 * The product's skills (`guide/skills/`, the files the guide module carries) read by the app's own MCP SDK, as its
 * server reads them: a finding for each skill it would skip, in its words. A note when the SDK isn't installed.
 */
const skillFindings = async (root) => {
  const folder = join(root, 'guide/skills')
  if (!existsSync(folder)) return { findings: [], notes: [] }
  let sdk
  try {
    sdk = await import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('@modelcontextprotocol/server/ext/skills')).href)
  } catch {
    return { findings: [], notes: ["note     could not load the app's @modelcontextprotocol/server (installed?), so guide/skills/ was not read as its MCP server reads it"] }
  }
  const files = readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && /\.(md|txt)$/.test(entry.name))
  const skills = Object.fromEntries(files.map((entry) => [relative(folder, join(entry.parentPath, entry.name)).split('\\').join('/'), readFileSync(join(entry.parentPath, entry.name), 'utf8')]))
  const findings = []
  if (Object.keys(skills).length) await sdk.SkillsExtension.load(sdk.memorySkillFiles(skills), { onWarning: ({ path, message }) => findings.push(`skill    guide/skills/${path === '.' ? '' : path}: ${message}`) })
  return { findings, notes: [] }
}

/** One line for each file that still holds the starter's text. */
const starterFindings = (root) =>
  STARTER_TEXT.flatMap(({ files, text, what, instead }) => files(root).filter((path) => textOf(join(root, path))?.includes(text)).map((path) => `starter  ${path}: ${what} is still the starter’s ("${text}"): ${instead}`))

// ---- The brand ----

/** What `kit brand` renders. It is part of the inputs' hash, so a change here calls every app's module stale. */
const BRAND_SPEC = 'kit-brand/1 png:16,32,48,96,180,192,512 dark:192,512 og:1200x630'
const BRAND_PNG = [16, 32, 48, 96, 180, 192, 512]
/** A dark icon is never inline (one inline icon keeps serverInfo small): only the PNGs served at this host. */
const BRAND_DARK = [192, 512]
const BRAND_MODULE = 'src/brand.gen.ts'
/** Claude shows an inline icon only under 10 KB. */
const INLINE_LIMIT = 10 * 1024
const RESVG_INSTALL = '`pnpm add -D @resvg/resvg-js`'

const brandFiles = (root) => ({ brand: join(root, 'brand/brand.ts'), icon: join(root, 'brand/icon.svg'), dark: join(root, 'brand/icon-dark.svg'), module: join(root, BRAND_MODULE) })
const textOf = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)

/** sha256 of brand.ts, the SVGs and BRAND_SPEC: never of the rendered bytes, which differ between machines. */
const brandInputsHash = (root) => {
  const files = brandFiles(root)
  return sha([textOf(files.brand), textOf(files.icon), textOf(files.dark) ?? '', BRAND_SPEC].join('\0'))
}

/** src/brand.gen.ts: the `BrandAssets` the brand part serves, base64 PNGs by size; no `png` until the first render. */
const brandModuleSource = ({ inputsHash, svg, svgDark, png, pngDark, og }) => {
  const sizes = (images) => `{\n${Object.entries(images).map(([size, data]) => `    ${size}: ${JSON.stringify(data)},\n`).join('')}  }`
  return [
    '// Generated by `kit brand` from brand/ (brand.ts, icon.svg, icon-dark.svg): edit those, then run it again.',
    '// Committed, so nothing renders at runtime; `kit doctor` says when it is stale.',
    'export const BRAND_ASSETS = {',
    `  inputsHash: ${JSON.stringify(inputsHash)},`,
    `  svg: ${JSON.stringify(svg)},`,
    ...(svgDark ? [`  svgDark: ${JSON.stringify(svgDark)},`] : []),
    ...(png ? [`  png: ${sizes(png)},`] : []),
    ...(pngDark ? [`  pngDark: ${sizes(pngDark)},`] : []),
    ...(og ? [`  og: ${JSON.stringify(og)},`] : []),
    '}',
    '',
  ].join('\n')
}

/** The SVG-only module, before the first render (what `init` writes). */
const writeSvgOnlyBrand = (root) => {
  const files = brandFiles(root)
  mkdirSync(dirname(files.module), { recursive: true })
  writeFileSync(files.module, brandModuleSource({ inputsHash: brandInputsHash(root), svg: textOf(files.icon), svgDark: textOf(files.dark) }))
}

/** Lint, format and the secrets scan leave src/brand.gen.ts alone in an app made before the part; what it can't edit, it names. */
const ignoreBrandModule = (root) => {
  const done = []
  const todo = []
  for (const name of ['.oxfmtrc.json', '.oxlintrc.json'].filter((name) => existsSync(join(root, name)))) {
    let config
    try {
      config = JSON.parse(readFileSync(join(root, name), 'utf8'))
    } catch {
      todo.push(`Add "${BRAND_MODULE}" to ignorePatterns in ${name}`)
      continue
    }
    if (config.ignorePatterns?.includes(BRAND_MODULE)) continue
    config.ignorePatterns = [...(config.ignorePatterns ?? []), BRAND_MODULE]
    writeFileSync(join(root, name), JSON.stringify(config, null, 2) + '\n')
    done.push(name)
  }
  const gitleaks = join(root, '.gitleaks.toml')
  const entry = "'''src/brand\\.gen\\.ts'''"
  const toml = textOf(gitleaks)
  if (toml !== null && !toml.includes(entry)) {
    // The one-line list every app's template has had; any other shape is the app's own
    const paths = /^paths = \[(.+)\]$/m
    if (paths.test(toml)) {
      writeFileSync(gitleaks, toml.replace(paths, (_, list) => `paths = [${list}, ${entry}]`))
      done.push('.gitleaks.toml')
    } else todo.push(`Add ${entry} to [allowlist] paths in .gitleaks.toml`)
  }
  return { done, todo }
}

/** brand/brand.ts and a monogram brand/icon.svg, unless they are there; `part` is the kit's brand folder. */
const scaffoldBrand = (root, { name, title, part }) => {
  const vars = { __kit_brand__: relative(join(root, 'brand'), join(part, 'index.js')).split('\\').join('/'), __name__: name, __title__: title, __initial__: (title.match(/[A-Za-z0-9]/)?.[0] ?? 'A').toUpperCase() }
  mkdirSync(join(root, 'brand'), { recursive: true })
  const written = []
  for (const file of ['brand.ts', 'icon.svg']) {
    const target = join(root, 'brand', file)
    if (existsSync(target)) continue
    writeFileSync(target, Object.entries(vars).reduce((text, [key, value]) => text.replaceAll(key, value), readFileSync(join(KIT, 'templates/brand', file), 'utf8')))
    written.push(`brand/${file}`)
  }
  return written
}

/** The hosts the brand is reached at: `websiteUrl` in brand.ts and `PUBLIC_HOST` in wrangler.jsonc. */
const brandHosts = (root) => {
  const hosts = new Set()
  const website = textOf(brandFiles(root).brand)?.match(/\bwebsiteUrl:\s*['"`]https:\/\/([^/'"`:]+)/)?.[1]
  if (website) hosts.add(website)
  const wrangler = textOf(join(root, 'wrangler.jsonc'))
  try {
    const host = wrangler && parseJsonc(wrangler).vars?.PUBLIC_HOST
    if (host) hosts.add(host)
  } catch {}
  return [...hosts]
}

/** Public suffixes of two labels, so `example.co.uk` is a root domain; the common ones, not the whole list. */
const TWO_LABEL_SUFFIXES = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.jp', 'co.nz', 'com.br', 'co.za', 'com.mx', 'co.in', 'com.cn', 'com.tr']

/** What `doctor` and `kit brand --check` say of the brand: findings fail, notes never do; nothing for brand files an app without the part or a module keeps. */
const brandFindings = (root, installed) => {
  const files = brandFiles(root)
  if (!installed && !existsSync(files.module)) return { findings: [], notes: [] }
  if (!existsSync(files.brand) || !existsSync(files.icon)) return { findings: [], notes: installed ? ['note     brand: no brand/brand.ts and brand/icon.svg: `kit add brand` scaffolds them (a brand is optional)'] : [] }
  const findings = []
  const notes = []
  const module = textOf(files.module)
  if (module === null) findings.push(`brand    ${BRAND_MODULE} is missing: \`kit brand\` writes it`)
  else if (module.match(/\binputsHash: (["'])([0-9a-f]*)\1/)?.[2] !== brandInputsHash(root)) findings.push(`stale    brand/ changed since ${BRAND_MODULE} was written: \`kit brand\` renders it again`)
  else if (!/\n {2}png: \{/.test(module)) notes.push(`note     brand: ${BRAND_MODULE} has the SVG only: \`kit brand\` renders the favicon, PNG icons and OG card (it needs ${RESVG_INSTALL})`)
  const inline = module?.match(/\n {2}png: \{[^}]*?\n {4}96: (["'])([A-Za-z0-9+/=]*)\1/)?.[2]
  const bytes = inline ? Buffer.from(inline, 'base64').length : 0
  if (bytes > INLINE_LIMIT) findings.push(`brand    the inline icon is ${(bytes / 1024).toFixed(1)} KB, over the 10 KB Claude shows: simplify brand/icon.svg (flat colours, no filters, gradients or embedded images), then \`kit brand\``)
  // claude.ai's connector list asks Google for the favicon of the address's root domain
  for (const host of brandHosts(root)) {
    const labels = host.split('.')
    const rootLabels = TWO_LABEL_SUFFIXES.includes(labels.slice(-2).join('.')) ? 3 : 2
    if (labels.length > rootLabels && labels[0] !== 'www' && !/^[\d.]+$/.test(host)) notes.push(`note     claude.ai shows the favicon of ${labels.slice(-rootLabels).join('.')} in its connector list, not this server's icon: serve the same icon there (${host} is a subdomain)`)
  }
  return { findings, notes }
}

/** @resvg/resvg-js from the app (never a dependency of the kit's CLI). */
const loadResvg = async (root) => {
  let path
  try {
    path = createRequire(join(root, 'package.json')).resolve('@resvg/resvg-js')
  } catch {
    fail(`rendering the brand needs @resvg/resvg-js in the app: ${RESVG_INSTALL}, then \`kit brand\` again`)
  }
  const module = await import(pathToFileURL(path).href)
  return module.Resvg ?? module.default.Resvg
}

/** The app's brand.ts, run by the app's tsx (as `doctor` runs the app for `cliGaps`). */
const loadBrand = (root) => {
  const script = join(tmpdir(), `kit-brand-${process.pid}.mts`)
  writeFileSync(script, `const { default: brand } = await import(${JSON.stringify(pathToFileURL(brandFiles(root).brand).href)})\nconsole.log(JSON.stringify(brand))\n`)
  const loaded = spawnSync('pnpm', ['exec', 'tsx', script], { cwd: root, encoding: 'utf8' })
  rmSync(script, { force: true })
  const lines = (loaded.stderr || '').trim().split('\n')
  if (loaded.status !== 0) {
    // esbuild (tsx's) names a syntax error `<file>:<line>:<column>: ERROR: …`; pnpm says when there is no tsx to run
    const syntax = lines.find((line) => /:\d+:\d+: ERROR: /.test(line))
    if (syntax) fail(`brand/brand.ts has a syntax error: ${syntax.slice(syntax.lastIndexOf('brand.ts:') - 'brand/'.length)}`)
    if (lines.some((line) => /Command "tsx" not found/.test(line))) fail('running brand/brand.ts needs tsx in the app: `pnpm add -D tsx`, then `kit brand` again')
    fail(`could not load brand/brand.ts: ${lines.find((line) => /Error|brand:/.test(line)) ?? lines[0] ?? ''}`)
  }
  return JSON.parse(loaded.stdout.trim().split('\n').at(-1))
}

const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/**
 * The image as an indexed PNG of at most 256 colours: each channel's precision lowered until the colours fit. Flat
 * icons lose nothing visible and shrink a lot; null when even 1 bit per channel can't fit.
 */
const palettePng = (width, height, premultiplied) => {
  const rgba = Uint8Array.from(premultiplied)
  for (let at = 0; at < rgba.length; at += 4) {
    const alpha = rgba[at + 3]
    if (alpha > 0 && alpha < 255) for (const channel of [0, 1, 2]) rgba[at + channel] = Math.min(255, Math.round((rgba[at + channel] * 255) / alpha))
  }
  for (let shift = 0; shift < 8; shift++) {
    const colors = new Map()
    const indexes = new Uint8Array(width * height)
    let fits = true
    for (let pixel = 0; pixel < width * height && fits; pixel++) {
      const key = [0, 1, 2, 3].map((channel) => rgba[pixel * 4 + channel] >> shift).join(',')
      if (!colors.has(key)) {
        if (colors.size === 256) fits = false
        else colors.set(key, colors.size)
      }
      indexes[pixel] = colors.get(key) ?? 0
    }
    if (!fits) continue
    const scale = (value) => Math.round((value * 255) / (255 >> shift))
    const palette = [...colors.keys()].map((key) => key.split(',').map((value) => scale(Number(value))))
    const header = Buffer.alloc(13)
    header.writeUInt32BE(width, 0)
    header.writeUInt32BE(height, 4)
    header.set([8, 3, 0, 0, 0], 8)
    const rows = Buffer.concat(Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), indexes.subarray(y * width, (y + 1) * width)])))
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('PLTE', Buffer.from(palette.flatMap(([r, g, b]) => [r, g, b]))), pngChunk('tRNS', Buffer.from(palette.map(([, , , a]) => a))), pngChunk('IDAT', deflateSync(rows, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))])
  }
  return null
}

const xmlText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
/** Words in lines of at most `width` characters, `max` lines, the last cut with an ellipsis. */
const linesOf = (text, width, max) => {
  const lines = []
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (lines.length && `${lines.at(-1)} ${word}`.length <= width) lines[lines.length - 1] += ` ${word}`
    else lines.push(word)
  }
  return lines.length > max ? [...lines.slice(0, max - 1), `${lines[max - 1].slice(0, width - 1)}…`] : lines
}
const isLight = (hex) => {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5
}

/** The 1200×630 OG card as an SVG: the icon left, the title and description right, the accent along the top. */
const ogSvg = (brand, iconPng) => {
  const background = brand.background ?? '#ffffff'
  const [ink, muted] = isLight(background) ? ['#111827', '#4b5563'] : ['#f9fafb', '#d1d5db']
  const title = linesOf(brand.title, 22, 2)
  const description = linesOf(brand.description, 44, 3)
  // The text block centred beside the icon; y is each line's baseline
  const top = 315 - (title.length * 80 + 24 + description.length * 46) / 2
  const tspans = (lines, y, step) => lines.map((line, index) => `<tspan x="400" y="${y + index * step}">${xmlText(line)}</tspan>`).join('')
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">',
    `<rect width="1200" height="630" fill="${background}"/>`,
    `<rect width="1200" height="12" fill="${brand.accent}"/>`,
    `<image href="data:image/png;base64,${Buffer.from(iconPng).toString('base64')}" x="96" y="195" width="240" height="240"/>`,
    `<text font-family="sans-serif" font-size="68" font-weight="700" fill="${ink}">${tspans(title, top + 64, 80)}</text>`,
    `<text font-family="sans-serif" font-size="32" fill="${muted}">${tspans(description, top + title.length * 80 + 24 + 34, 46)}</text>`,
    '</svg>',
  ].join('')
}

/** Renders brand/ into src/brand.gen.ts; returns what to say about it. */
const renderBrand = async (root) => {
  const files = brandFiles(root)
  for (const path of [files.brand, files.icon]) if (!existsSync(path)) fail(`no ${relative(root, path)}: \`kit add brand\` scaffolds brand/brand.ts and brand/icon.svg`)
  const Resvg = await loadResvg(root)
  const brand = loadBrand(root)
  const svg = textOf(files.icon)
  const svgDark = textOf(files.dark)
  const raster = (text, size, background) => {
    const image = new Resvg(text, { fitTo: { mode: 'width', value: size }, ...(background ? { background } : {}), font: { loadSystemFonts: true } }).render()
    if (image.width !== image.height) fail('brand/icon.svg must be square: a viewBox as wide as it is tall')
    return image
  }
  const base64 = (bytes) => Buffer.from(bytes).toString('base64')
  const warnings = []
  // The inline icon must stay under 10 KB: past it, the same picture in at most 256 colours
  const inlineOf = (text) => {
    const image = raster(text, 96)
    let png = image.asPng()
    if (png.length > INLINE_LIMIT) png = [png, palettePng(image.width, image.height, image.pixels)].filter(Boolean).sort((a, b) => a.length - b.length)[0]
    if (png.length > INLINE_LIMIT) warnings.push(`brand/icon.svg's 96 px icon is ${(png.length / 1024).toFixed(1)} KB even in 256 colours, over the 10 KB Claude shows: simplify it (flat colours, no filters, gradients or embedded images)`)
    return png
  }
  // iOS fills a transparent apple-touch icon with black: that one sits on the background
  const png = Object.fromEntries(BRAND_PNG.map((size) => [size, base64(size === 96 ? inlineOf(svg) : raster(svg, size, size === 180 ? (brand.background ?? '#ffffff') : undefined).asPng())]))
  const pngDark = svgDark ? Object.fromEntries(BRAND_DARK.map((size) => [size, base64(raster(svgDark, size).asPng())])) : undefined
  const og = base64(new Resvg(ogSvg(brand, raster(svg, 240).asPng()), { font: { loadSystemFonts: true } }).render().asPng())
  mkdirSync(dirname(files.module), { recursive: true })
  writeFileSync(files.module, brandModuleSource({ inputsHash: brandInputsHash(root), svg, svgDark, png, pngDark, og }))
  return { inline: Buffer.from(png[96], 'base64').length, dark: Boolean(svgDark), warnings }
}

// ---- Commands ----

// ---- The GitHub repository ----

/** `gh api` with a JSON body; returns the parsed answer, or `{ status }` when gh exits non-zero (404 for a switch that is off). */
const ghApi = (method, path, body) => {
  const result = spawnSync('gh', ['api', '--method', method, path, ...(body ? ['--input', '-'] : [])], { input: body ? JSON.stringify(body) : undefined, encoding: 'utf8' })
  if (result.error) fail('`kit repo` needs the GitHub CLI: install gh and run `gh auth login`')
  if (result.status !== 0) return { failed: true, status: Number(result.stdout.match(/"status":\s*"?(\d{3})/)?.[1] ?? 0), message: (result.stdout + result.stderr).trim() }
  return result.stdout.trim() ? JSON.parse(result.stdout) : {}
}

/**
 * The jobs in a workflow that run on every event (no `if:`), by the name their check reports; a matrix job's name can't
 * be known here. A job that calls a reusable workflow (`uses:`) reports one check per job of that workflow, named
 * `<job> / <its job>`: `readCalled` returns the called workflow's text.
 */
const alwaysJobsOf = (workflow, readCalled, file = 'ci.yml') => {
  const body = workflow.split(/^jobs:\s*$/m)[1] ?? ''
  return [...body.matchAll(/^  ([A-Za-z0-9_-]+):\s*$([\s\S]*?)(?=^  [A-Za-z0-9_-]+:\s*$|(?![\s\S]))/gm)].flatMap(([, id, block]) => {
    if (/^    if:/m.test(block)) return []
    const name = block.match(/^    name:\s*(.+?)\s*$/m)?.[1]
    if (name?.includes('${{')) fail(`${file}'s job "${id}" names its checks from a matrix (${name}); say which checks to require with --checks`)
    const called = block.match(/^    uses:\s*([^\s#]+)/m)?.[1]
    if (!called) return [name ?? id]
    return alwaysJobsOf(readCalled(called), readCalled, called).map((inner) => `${name ?? id} / ${inner}`)
  })
}

/** A reusable workflow's text: `./path` or `$/path` from the app folder, `owner/repo/path@ref` from GitHub through `gh`. */
const calledWorkflowReader = (app) => (called) => {
  if (/^[.$]\//.test(called)) return existsSync(join(app, called.slice(2))) ? readFileSync(join(app, called.slice(2)), 'utf8') : fail(`ci.yml calls ${called}, which isn't in ${app}`)
  const [, owner, repo, path, ref] = called.match(/^([^/]+)\/([^/]+)\/(.+)@(.+)$/) ?? fail(`ci.yml calls "${called}", which is neither ./path nor owner/repo/path@ref`)
  const file = ghApi('GET', `repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`)
  if (file.failed || typeof file.content !== 'string') fail(`can't read ${called} to name its checks (${file.message ?? 'not a file'}); name them with --checks`)
  return Buffer.from(file.content, 'base64').toString('utf8')
}

/** What the standard (§20) asks of a repository: the settings, the Actions token, and the rules for main and release tags. */
const repoPlan = ({ merge, release, checks }) => ({
  settings: {
    allow_squash_merge: merge === 'squash',
    allow_rebase_merge: merge === 'rebase',
    allow_merge_commit: false,
    ...(merge === 'squash' ? { squash_merge_commit_title: 'PR_TITLE', squash_merge_commit_message: 'BLANK' } : {}),
    allow_auto_merge: true,
    allow_update_branch: true,
    delete_branch_on_merge: true,
  },
  // release-please opens its pull request with the workflow's token, which needs "create and approve pull requests"
  workflow: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: release },
  rulesets: [
    {
      name: 'main',
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        { type: 'required_linear_history' },
        { type: 'pull_request', parameters: { allowed_merge_methods: [merge], dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_approving_review_count: 0, required_review_thread_resolution: false } },
        { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: checks.map((context) => ({ context })) } },
      ],
    },
    ...(release
      ? [{ name: 'release tags', target: 'tag', enforcement: 'active', bypass_actors: [], conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } }, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }] }]
      : []),
  ],
})

/** A ruleset as the comparison sees it: what it covers, its rule types, merge methods and required checks. */
const rulesetShape = (ruleset) => ({
  target: ruleset.target,
  enforcement: ruleset.enforcement,
  include: ruleset.conditions?.ref_name?.include ?? [],
  rules: (ruleset.rules ?? []).map((rule) => rule.type).sort(),
  merge: (ruleset.rules ?? []).find((rule) => rule.type === 'pull_request')?.parameters?.allowed_merge_methods ?? [],
  checks: ((ruleset.rules ?? []).find((rule) => rule.type === 'required_status_checks')?.parameters?.required_status_checks ?? []).map((check) => check.context).sort(),
})

/** Every difference between the repository and its plan, one line each, with what fixes it; and what the plan can't reach. */
const repoFindings = (repo, plan) => {
  const findings = []
  const notes = []
  const current = ghApi('GET', `repos/${repo}`)
  if (current.failed) fail(`can't read ${repo}: ${current.message}`)
  const rulesets = ghApi('GET', `repos/${repo}/rulesets`)
  // Auto-merge waits for required checks, so GitHub turns it on only where rules can exist
  if (rulesets.failed && rulesets.status === 403) delete plan.settings.allow_auto_merge
  for (const [key, want] of Object.entries(plan.settings)) if (current[key] !== want) findings.push({ what: `setting ${key}`, has: current[key], want, fix: 'settings' })
  const workflow = ghApi('GET', `repos/${repo}/actions/permissions/workflow`)
  for (const [key, want] of Object.entries(plan.workflow)) if (workflow[key] !== want) findings.push({ what: `actions ${key}`, has: workflow[key], want, fix: 'workflow' })
  if (ghApi('GET', `repos/${repo}/vulnerability-alerts`).failed) findings.push({ what: 'vulnerability alerts', has: 'off', want: 'on', fix: 'alerts' })
  if (!ghApi('GET', `repos/${repo}/automated-security-fixes`).enabled) findings.push({ what: 'Dependabot security updates', has: 'off', want: 'on', fix: 'fixes' })
  if (rulesets.failed) notes.push(rulesets.status === 403 ? 'rules for main and auto-merge: GitHub offers them on a private repository only with a paid plan; nothing enforces green checks but the person merging' : `rules for main: can't read them (${rulesets.message})`)
  else
    for (const wanted of plan.rulesets) {
      const found = rulesets.find((ruleset) => ruleset.name === wanted.name)
      const full = found ? ghApi('GET', `repos/${repo}/rulesets/${found.id}`) : null
      if (!full) {
        findings.push({ what: `ruleset "${wanted.name}"`, has: 'missing', want: 'present', fix: 'ruleset', ruleset: wanted })
        continue
      }
      const [has, want] = [rulesetShape(full), rulesetShape(wanted)]
      for (const key of Object.keys(want)) if (JSON.stringify(has[key]) !== JSON.stringify(want[key])) findings.push({ what: `ruleset "${wanted.name}" ${key}`, has: has[key], want: want[key], fix: 'ruleset', ruleset: wanted, id: found.id })
    }
  return { findings, notes }
}

const applyFinding = (repo, plan, finding) => {
  const answer =
    finding.fix === 'settings' ? ghApi('PATCH', `repos/${repo}`, plan.settings)
    : finding.fix === 'workflow' ? ghApi('PUT', `repos/${repo}/actions/permissions/workflow`, plan.workflow)
    : finding.fix === 'alerts' ? ghApi('PUT', `repos/${repo}/vulnerability-alerts`)
    : finding.fix === 'fixes' ? ghApi('PUT', `repos/${repo}/automated-security-fixes`)
    : finding.id ? ghApi('PUT', `repos/${repo}/rulesets/${finding.id}`, finding.ruleset)
    : ghApi('POST', `repos/${repo}/rulesets`, finding.ruleset)
  if (answer.failed) fail(`couldn't set ${finding.what} on ${repo}: ${answer.message}`)
}

// ---- The deploy button ----

/** The deploy form's words for the settings every new app reads (src/app.ts `Env`); all are optional. */
const DEPLOY_FORM = {
  PUBLIC_HOST: { description: 'The host this Worker answers on: `<name>.<your-subdomain>.workers.dev`, or a custom domain such as `api.example.com`. MCP accepts requests for this host only.' },
  API_KEYS: { description: 'Optional. Keys as `name:sha256` pairs, comma-separated: the hash of each key, never the key (`printf \'my-key\' | shasum -a 256`).' },
  OAUTH_SIGNING_KEY: { description: 'Optional. Turns on OAuth sign-in for agents: an ES256 private key as JWK JSON. Make one in a clone: `pnpm exec tsx -e "import(\'./src/kit/oauth/index.ts\').then(async (m) => console.log(await m.generateOAuthKey()))"`.' },
  ACCESS_TEAM: { description: 'Optional, with ACCESS_AUD. Your Cloudflare Access team name, to let people in through Access.' },
  ACCESS_AUD: { description: 'Optional, with ACCESS_TEAM. The Application Audience (AUD) tag of the Access application in front of this Worker.' },
}

/** Cloudflare's Deploy to Cloudflare button: the page it opens and its badge. */
const BUTTON_PAGE = 'https://deploy.workers.cloudflare.com/'
const BUTTON_IMAGE = 'https://deploy.workers.cloudflare.com/button'
/** The README block `kit button --write` keeps current. */
const BUTTON_START = '<!-- deploy-button -->'
const BUTTON_END = '<!-- /deploy-button -->'
/** Bindings whose ids the button creates when the config leaves them out, by config key and the id field to leave out. */
const PROVISIONED = { d1_databases: ['database_id', 'preview_database_id'], kv_namespaces: ['id', 'preview_id'], hyperdrive: ['id'] }
/** Config keys Cloudflare's button documents no provisioning for: a stranger's deploy needs them made by hand. */
const NOT_PROVISIONED = ['services', 'dispatch_namespaces', 'mtls_certificates', 'analytics_engine_datasets', 'browser', 'images', 'workflows']

/** A JSONC file as data: comments and trailing commas removed, never inside a string. */
const parseJsonc = (text) => {
  let out = ''
  for (let i = 0, inString = false; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      out += char
      if (char === '\\') out += text[++i] ?? ''
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1
    } else out += char
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** The names a `.dev.vars.example` (dotenv) defines, which the deploy page asks for as secrets. */
const dotenvNames = (text) => [...text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map(([, name]) => name)

/**
 * The button's link for a GitHub repository; a branch and a folder go in the repository's own URL
 * (`…/tree/<branch>/<dir>`), which is how the button takes them.
 */
const buttonUrl = ({ repo, branch, dir }) => {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`--repo is owner/name, not "${repo}"`)
  if (dir && !branch) fail('--dir needs --branch: the button reads a folder from …/tree/<branch>/<dir>')
  const path = branch ? `/tree/${branch}${dir ? `/${dir.replace(/^\/+|\/+$/g, '')}` : ''}` : ''
  return `${BUTTON_PAGE}?url=https://github.com/${repo}${path}`
}

/** The badge as Markdown and as HTML. */
const buttonSnippets = (url) => ({
  markdown: `[![Deploy to Cloudflare](${BUTTON_IMAGE})](${url})`,
  html: `<a href="${url}"><img src="${BUTTON_IMAGE}" alt="Deploy to Cloudflare"/></a>`,
})

/** What would stop a stranger's deploy from this app folder, each with its fix; and notes that don't fail it. */
const buttonFindings = (app) => {
  const findings = []
  const notes = []
  const configPath = ['wrangler.jsonc', 'wrangler.json'].map((name) => join(app, name)).find(existsSync)
  if (!configPath) return { findings: [{ what: 'no wrangler.jsonc', fix: 'the button deploys Workers only: start from `init --runtime cloudflare` or add a wrangler.jsonc' }], notes, config: null }
  const config = parseJsonc(readFileSync(configPath, 'utf8'))
  const pkg = existsSync(join(app, 'package.json')) ? JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) : {}
  if (config.account_id) findings.push({ what: 'wrangler.jsonc pins account_id', fix: 'remove it: a stranger deploys to their own account, and `deploy:env` takes yours from CLOUDFLARE_ACCOUNT_ID' })
  if (!config.compatibility_date) findings.push({ what: 'wrangler.jsonc has no compatibility_date', fix: 'set one (`init` uses the date of the pinned Workers types)' })
  for (const [key, fields] of Object.entries(PROVISIONED))
    for (const binding of config[key] ?? [])
      for (const field of fields)
        if (binding[field]) findings.push({ what: `${key} ${binding.binding ?? binding.database_name ?? ''} sets ${field}`, fix: `remove it: the button makes the resource in the deployer's account (and \`deploy:env\` fills yours)` })
  for (const key of NOT_PROVISIONED) if (config[key]?.length ?? (config[key] && Object.keys(config[key]).length)) notes.push(`${key} in wrangler.jsonc: the button makes none, so a stranger sets it up by hand before deploying`)
  const secrets = existsSync(join(app, '.dev.vars.example')) ? dotenvNames(readFileSync(join(app, '.dev.vars.example'), 'utf8')) : []
  const blankVars = Object.entries(config.vars ?? {}).filter(([, value]) => value === '').map(([name]) => name)
  const described = pkg.cloudflare?.bindings ?? {}
  for (const name of [...new Set([...secrets, ...blankVars])])
    if (!described[name]?.description?.trim()) findings.push({ what: `${name} has no description for the deploy form`, fix: `add "cloudflare": { "bindings": { "${name}": { "description": "…" } } } to package.json: what it is, and where to get its value` })
  const migrations = (config.d1_databases ?? []).filter((database) => existsSync(join(app, database.migrations_dir ?? 'migrations')))
  const deploy = pkg.scripts?.deploy
  if (!deploy) findings.push({ what: 'package.json has no deploy script', fix: 'the button then runs a bare `npx wrangler deploy`: add one that applies the migrations and deploys' })
  else
    for (const database of migrations)
      if (!new RegExp(`d1 migrations apply ${database.binding}\\b[^&]*--remote`).test(deploy)) findings.push({ what: `the deploy script never applies ${database.binding}'s migrations`, fix: `add \`wrangler d1 migrations apply ${database.binding} --remote\` before \`wrangler deploy\`` })
  if ((config.assets || existsSync(join(app, 'vite.config.ts'))) && !pkg.scripts?.build) findings.push({ what: 'the app serves built files but has no build script', fix: 'add "build" (the button runs it before deploy)' })
  return { findings, notes, config }
}

/** The README with the button block set to `markdown`: in place between the markers, else after the title. */
const readmeWithButton = (readme, markdown) => {
  const block = `${BUTTON_START}\n${markdown}\n${BUTTON_END}`
  const start = readme.indexOf(BUTTON_START)
  const end = readme.indexOf(BUTTON_END)
  if (start >= 0 && end > start) return readme.slice(0, start) + block + readme.slice(end + BUTTON_END.length)
  // A button pasted by hand becomes the block, so there is never a second one
  const pasted = readme.split('\n').findIndex((line) => line.includes(BUTTON_IMAGE))
  if (pasted >= 0) return readme.split('\n').toSpliced(pasted, 1, block).join('\n')
  const [title, ...rest] = readme.split('\n')
  return [title, '', block, ...rest].join('\n')
}

/** Cloudflare's REST API with the token wrangler would use; throws with Cloudflare's own message. */
const cloudflareApi = async (method, path, body) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const answer = await response.json().catch(() => ({}))
  if (!response.ok || answer.success === false) {
    const said = (answer.errors ?? []).map((error) => error.message).join('; ')
    const rights = /authentication error/i.test(said) ? ' (the token needs Workers Scripts, D1, Workers KV, R2 and Queues edit rights on the account)' : ''
    throw new Error(`${method} ${path.replace(/accounts\/[^/]+/, 'accounts/<account>')}: ${response.status} ${said}${rights}`)
  }
  return answer.result
}

/**
 * A stranger's deploy, for real: this app copied to a temporary folder, its resources made in the account under names
 * ending `-smoke-<random>` (as the button makes them before it runs the scripts), its build and deploy scripts run as
 * the button runs them, then its health answered on workers.dev. Everything it made is deleted afterwards, whatever
 * happened. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
 */
const smokeDeploy = async (app, config, pkg) => {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  if (!account || !process.env.CLOUDFLARE_API_TOKEN) fail('--smoke needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (run it under your secret store)')
  const suffix = `smoke-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 6)}`
  const named = (name) => `${name}-${suffix}`.slice(0, 63)
  const made = []
  const work = join(tmpdir(), `kit-${suffix}`)
  try {
    const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: app, encoding: 'utf8' })
    if (listed.status !== 0) fail('--smoke copies what git tracks: run it in a git repository')
    for (const file of listed.stdout.split('\0').filter(Boolean)) {
      mkdirSync(dirname(join(work, file)), { recursive: true })
      // A link (init makes .claude/skills one) stays a link
      if (lstatSync(join(app, file)).isSymbolicLink()) symlinkSync(readlinkSync(join(app, file)), join(work, file))
      else writeFileSync(join(work, file), readFileSync(join(app, file)), { mode: statSync(join(app, file)).mode })
    }
    const deployed = structuredClone(config)
    deployed.name = named(config.name)
    for (const database of deployed.d1_databases ?? []) {
      database.database_name = named(database.database_name)
      database.database_id = (await cloudflareApi('POST', `/accounts/${account}/d1/database`, { name: database.database_name })).uuid
      made.push({ kind: 'D1 database', name: database.database_name, path: `/accounts/${account}/d1/database/${database.database_id}` })
    }
    for (const namespace of deployed.kv_namespaces ?? []) {
      namespace.id = (await cloudflareApi('POST', `/accounts/${account}/storage/kv/namespaces`, { title: named(namespace.binding) })).id
      made.push({ kind: 'KV namespace', name: named(namespace.binding), path: `/accounts/${account}/storage/kv/namespaces/${namespace.id}` })
    }
    for (const bucket of deployed.r2_buckets ?? []) {
      bucket.bucket_name = named(bucket.bucket_name)
      await cloudflareApi('POST', `/accounts/${account}/r2/buckets`, { name: bucket.bucket_name })
      made.push({ kind: 'R2 bucket', name: bucket.bucket_name, path: `/accounts/${account}/r2/buckets/${bucket.bucket_name}` })
    }
    const queueNames = new Map()
    for (const queue of [...(deployed.queues?.producers ?? []), ...(deployed.queues?.consumers ?? [])]) {
      if (!queueNames.has(queue.queue)) {
        const name = named(queue.queue)
        const created = await cloudflareApi('POST', `/accounts/${account}/queues`, { queue_name: name })
        made.push({ kind: 'queue', name, path: `/accounts/${account}/queues/${created.queue_id}`, queueId: created.queue_id })
        queueNames.set(queue.queue, name)
      }
      queue.queue = queueNames.get(queue.queue)
    }
    // What the deploy form asks for, filled from the examples: secrets as plain vars, which the Worker reads the same way
    const examples = existsSync(join(app, '.dev.vars.example')) ? Object.fromEntries([...readFileSync(join(app, '.dev.vars.example'), 'utf8').matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*"?([^"\n]*)"?/gm)].map(([, name, value]) => [name, value])) : {}
    deployed.vars = { ...examples, ...Object.fromEntries(Object.entries(deployed.vars ?? {}).map(([name, value]) => [name, value === '' ? (examples[name] ?? 'smoke') : value])) }
    const subdomain = (await cloudflareApi('GET', `/accounts/${account}/workers/subdomain`)).subdomain
    const host = `${deployed.name}.${subdomain}.workers.dev`
    if ('PUBLIC_HOST' in deployed.vars) deployed.vars.PUBLIC_HOST = host
    writeFileSync(join(work, 'wrangler.jsonc'), `${JSON.stringify(deployed, null, 2)}\n`)
    made.push({ kind: 'Worker', name: deployed.name, path: `/accounts/${account}/workers/scripts/${deployed.name}` })
    const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: account, CI: 'true' }
    for (const script of [null, 'build', 'deploy']) {
      if (script && !pkg.scripts?.[script]) continue
      const args = script ? ['run', script] : ['install', '--frozen-lockfile']
      console.log(`$ pnpm ${args.join(' ')}`)
      const ran = spawnSync('pnpm', args, { cwd: work, env, stdio: 'inherit' })
      if (ran.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed (exit ${ran.status})`)
    }
    // A new workers.dev name can take a few seconds to answer
    let health = null
    for (let tries = 0; tries < 30 && health?.status !== 200; tries++) {
      health = await fetch(`https://${host}/api/health`).catch(() => null)
      if (health?.status !== 200) await new Promise((done) => setTimeout(done, 3000))
    }
    if (health?.status !== 200) throw new Error(`https://${host}/api/health answered ${health?.status ?? 'nothing'} after 90 seconds`)
    const guide = await fetch(`https://${host}/llms.txt`)
    if (guide.status !== 200) throw new Error(`https://${host}/llms.txt answered ${guide.status}`)
    console.log(`deployed as a stranger would: https://${host} answers /api/health and /llms.txt`)
  } catch (error) {
    console.error(`kit: the smoke deploy failed: ${error.message}`)
    process.exitCode = 1
  } finally {
    // A queue's consumers first (Cloudflare keeps a Worker that consumes a queue, and a queue a Worker is bound to), then
    // the Worker, then what it was bound to; each delete is tried, and what stays is named
    const kept = []
    for (const queue of made.filter((resource) => resource.queueId))
      for (const consumer of await cloudflareApi('GET', `/accounts/${account}/queues/${queue.queueId}/consumers`).catch(() => []))
        await cloudflareApi('DELETE', `/accounts/${account}/queues/${queue.queueId}/consumers/${consumer.consumer_id}`).catch((error) => kept.push(`the consumer of queue ${queue.name} (${error.message})`))
    for (const resource of made.reverse()) {
      await cloudflareApi('DELETE', resource.path).then(
        () => console.log(`deleted ${resource.kind} ${resource.name}`),
        (error) => kept.push(`${resource.kind} ${resource.name} (${error.message})`),
      )
    }
    rmSync(work, { recursive: true, force: true })
    if (kept.length) {
      console.error(`could not delete, remove by hand: ${kept.join('; ')}`)
      process.exitCode = 1
    }
  }
}

// ---- License keys ----

const base64url = (value) => Buffer.from(value).toString('base64url')
const jsonOfFile = (path) => JSON.parse(readFileSync(resolve(process.cwd(), path), 'utf8'))

/** A license key: an ES256 JWT over the claims, signed with the product's private JWK. Kept byte-compatible with the kit's `verifyLicense` (jose). */
const mintLicense = (privateJwk, claims) => {
  const signed = `${base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`
  const signature = sign('sha256', Buffer.from(signed), { key: createPrivateKey({ key: privateJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' })
  return `${signed}.${signature.toString('base64url')}`
}

/** What a key says and whether its signature, product, deployment and date hold; for the command line, not for apps. */
const readLicense = (key, publicJwk, { product, instance, now = Date.now() }) => {
  const [header, payload, signature] = key.trim().split('.')
  if (!header || !payload || !signature) return { ok: false, why: 'not a key: it should be three parts joined by dots' }
  const signed = verify('sha256', Buffer.from(`${header}.${payload}`), { key: createPublicKey({ key: publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  if (!signed) return { ok: false, why: 'not signed by this key' }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  if (claims.iss !== product) return { ok: false, why: `for ${claims.iss}, not ${product}`, claims }
  if (claims.exp && claims.exp * 1000 < now) return { ok: false, why: `expired ${new Date(claims.exp * 1000).toISOString()}`, claims }
  const audience = [claims.aud ?? []].flat()
  if (audience.length && !audience.includes(instance)) return { ok: false, why: `for deployment ${audience.join(', ')}`, claims }
  return { ok: true, why: `licensed to ${claims.sub} (${claims.plan})`, claims }
}

const DAY_SECONDS = 86_400

const licenseCommand = () => {
  const [mode, key] = names
  if (mode === 'keys') {
    const out = resolve(process.cwd(), valueOf('--out') ?? '.')
    const target = join(out, 'license-private.jwk')
    if (existsSync(target)) fail(`${relative(process.cwd(), target)} already exists: a new pair would void every key minted with it`)
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    mkdirSync(out, { recursive: true })
    writeFileSync(target, `${JSON.stringify(privateKey.export({ format: 'jwk' }))}\n`, { mode: 0o600 })
    console.log(`Private key: ${relative(process.cwd(), target) || target} (0600). Put it in a secret store and delete the file; it never goes in a repository.`)
    console.log(`Public key, for the app's code (licenseOf({ publicKey })):\n${JSON.stringify(publicKey.export({ format: 'jwk' }))}`)
    return
  }
  if (mode === 'mint') {
    const [privatePath, product, licensee, plan] = ['--private', '--product', '--licensee', '--plan'].map(valueOf)
    if (!privatePath || !product || !licensee || !plan) fail('kit license mint --private <file> --product <name> --licensee <who> --plan <plan> [--grants a,b] [--days 365] [--instance <id>]')
    const days = Number(valueOf('--days') ?? 365)
    if (!Number.isInteger(days) || days < 1) fail('--days is a whole number of days from 1')
    const now = Math.floor(Date.now() / 1000)
    const grants = (valueOf('--grants') ?? '').split(',').map((grant) => grant.trim()).filter(Boolean)
    const instance = valueOf('--instance')
    console.log(mintLicense(jsonOfFile(privatePath), { iss: product, sub: licensee, plan, ...(grants.length ? { grants } : {}), ...(instance ? { aud: instance } : {}), iat: now, exp: now + days * DAY_SECONDS }))
    return
  }
  if (mode === 'verify') {
    const [publicPath, product] = ['--public', '--product'].map(valueOf)
    if (!key || !publicPath || !product) fail('kit license verify <key> --public <file> --product <name> [--instance <id>]')
    const { ok, why, claims } = readLicense(key, jsonOfFile(publicPath), { product, instance: valueOf('--instance') })
    console.log(ok ? `valid: ${why}, until ${new Date(claims.exp * 1000).toISOString()}; grants ${[claims.plan, ...(claims.grants ?? [])].join(', ')}` : `refused: ${why}`)
    process.exitCode = ok ? 0 : 1
    return
  }
  fail('kit license keys|mint|verify')
}

/** This file's header: every command, its flags and what it does. */
const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '').trim()

/** One command's lines of the header: its `kit <name>` lines and the lines indented under them. */
const usageOf = (name) => {
  let inside = false
  const lines = []
  for (const line of HELP.split('\n')) {
    if (line.startsWith('  kit ')) inside = line === `  kit ${name}` || line.startsWith(`  kit ${name} `)
    else if (!line.startsWith('      ')) inside = false
    if (inside) lines.push(line.slice(2))
  }
  return lines.join('\n')
}

/** The heading of a part README's section on wiring it into an app made by `init`, as a feature of its own. */
const WRAPPER_HEADING = '### In an app made by `kit init`'

/**
 * What `add` tells an app to wire for parts that keep tables or bring routes: the feature that wraps one (its README),
 * and the line `scripts/migrations.ts` lacks for its D1 files (an app made before the script found the parts itself).
 */
const wiringOf = (parts) => {
  const root = appRootOf()
  const migrations = root ? textOf(join(root, 'scripts/migrations.ts')) : null
  const inFeatures = root !== null && existsSync(join(root, 'src/features/index.ts'))
  return parts.flatMap((name) => {
    const readme = REGISTRY[name].files.find((file) => file.endsWith('README.md'))
    const constant = `${name.toUpperCase()}_MIGRATIONS`
    const keepsTables = REGISTRY[name].files.some((file) => upstreamOf(file).includes(`export const ${constant} =`))
    const wrapped = inFeatures && upstreamOf(readme).includes(WRAPPER_HEADING)
    // An entry part's tables are exported from its own folder, never the kit's index
    const from = `../${relative(root ?? dir, dir).split('\\').join('/')}/${REGISTRY[name].entry ? `${name}/` : ''}index.js`
    return [
      ...wiringStepsOf(name, root),
      ...(wrapped ? [`Wire ${name}: a feature in src/features/${name}/ listed in src/features/index.ts${keepsTables ? ' (its migrations reach migrations/ through it: add no line to scripts/migrations.ts)' : ''}, and the lines in src/app.ts: ${dirArg}/${readme} › ${WRAPPER_HEADING.slice(4)}`] : []),
      // A wrapped part's feature lists its steps: a line here too wrote every step twice
      ...(keepsTables && !wrapped && migrations !== null && !migrations.includes(constant) ? [`scripts/migrations.ts lacks ${name}'s tables: \`import { ${constant} } from '${from}'\` and \`['${name}', ${constant}]\` in its sets, then \`pnpm migrations\` writes their D1 files`] : []),
    ]
  })
}

/** Where an app made by `init` lists a setting, each file named as the step says it. */
const SETTING_FILES = [
  ['src/app.ts', 'Env in src/app.ts'],
  ['.dev.vars.example', '.dev.vars.example'],
  ['container/entrypoint.sh', 'container/entrypoint.sh'],
  ['vitest.config.ts', "vitest.config.ts's miniflare bindings"],
]

/**
 * The steps a part's `meta.wiring` (registry.json) asks of an app made by `init`, each only where the app lacks it: its
 * settings in every file that lists the app's settings, a schedule for its scheduled work, and its README's code.
 */
const wiringStepsOf = (name, root) => {
  const wiring = REGISTRY[name].wiring
  if (!wiring || !root || !existsSync(join(root, 'src/app.ts'))) return []
  const readme = REGISTRY[name].files.find((file) => file.endsWith('README.md'))
  const lacking = (path, text) => existsSync(join(root, path)) && !textOf(join(root, path)).includes(text)
  const settings = (wiring.settings ?? []).flatMap(({ name: setting, what, test, testImport }) => {
    // The workerd tests get a value that works there: their origin, a key made as they start
    const files = SETTING_FILES.filter(([path]) => lacking(path, setting)).map(([path, where]) => (path === 'vitest.config.ts' && test ? `${where} as ${setting}: ${test}${testImport ? ` (${testImport})` : ''}` : where))
    return files.length ? [`Setting ${setting} (${what}): add it to ${files.join(', ')}`] : []
  })
  const cron = wiring.cron
  const schedules = cron
    ? [
        ...(lacking('wrangler.jsonc', '"crons"') ? [`Schedule: "triggers": { "crons": ["${cron.schedule}"] } in wrangler.jsonc, and a scheduled handler in src/worker.ts that calls ${name}'s ${cron.calls}`] : []),
        ...(lacking('src/server.ts', cron.calls) ? [`Schedule: src/server.ts calls ${name}'s ${cron.calls} on a timer (hourly is enough)`] : []),
      ]
    : []
  return [`Wire ${name}: ${dirArg}/${readme} › ${wiring.code}`, ...settings, ...schedules]
}

/** Runs each pnpm step in a new app until one fails; returns the steps left, that one first. Without pnpm, all of them. */
const runFirst = (root, steps) => {
  if (spawnSync('pnpm', ['--version'], { encoding: 'utf8' }).status !== 0) {
    console.log('pnpm is not on the PATH (`corepack enable` gives you the one package.json names), so nothing was installed')
    return steps
  }
  for (const [at, args] of steps.entries()) {
    console.log(`$ pnpm ${args.join(' ')}`)
    // Never waits on a prompt: stdin is closed
    if (spawnSync('pnpm', args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'] }).status !== 0) {
      console.log(`pnpm ${args.join(' ')} failed: run it again from the Next line`)
      return steps.slice(at)
    }
  }
  return []
}

const commands = {
  help: () => console.log(HELP),

  list: () => {
    const installed = new Set(readLock()?.modules ?? [])
    for (const [name, module] of Object.entries(REGISTRY)) {
      const needs = [...(module.requires ?? []), ...Object.keys(module.dependencies ?? {})]
      console.log(`${installed.has(name) ? '●' : '○'} ${name.padEnd(11)} ${module.description}${needs.length ? `\n  ${''.padEnd(11)} needs: ${needs.join(', ')}` : ''}`)
    }
    for (const { name, description } of ROOT_ITEMS) console.log(`◇ ${name.padEnd(11)} ${description}\n  ${''.padEnd(11)} at the repo root: ${shadcnAdd(name)}`)
  },

  add: () => {
    if (!names.length) fail('name the modules to add, e.g. `add core guide mcp`')
    const lock = readLock()
    const webDir = webDirArg ?? lock?.webDir
    const modules = withRequired([...(lock?.modules ?? []), ...names])
    const expected = expectedFiles(modules, webDir)
    const hashes = { ...(lock?.files ?? {}) }
    const skipped = []
    for (const [file, text] of Object.entries(expected)) {
      const path = pathOf(file, webDir)
      mkdirSync(dirname(path), { recursive: true })
      const local = existsSync(path) ? readFileSync(path, 'utf8') : null
      const yours = local !== null && local !== text && sha(local) !== hashes[file]
      if (yours && !flags.has('--force')) {
        skipped.push(file)
        continue
      }
      writeFileSync(path, text)
      hashes[file] = sha(text)
    }
    writeLock(modules, hashes, webDir, VERSION, keptOf(lock))
    console.log(`Copied ${modules.join(', ')} (kit ${VERSION}) into ${relative(process.cwd(), dir) || '.'}`)
    if (skipped.length) console.log(`Kept your version of ${skipped.join(', ')} (it differs from the kit); --force overwrites`)
    const root = names.includes('brand') ? appRootOf() : null
    if (names.includes('brand') && !root) console.log(`Brand: no package.json above ${dirArg}, so brand/ was not made: \`kit add brand --dir ${dirArg} --app <app>\` names the app`)
    if (root) {
      const pkg = existsSync(join(root, 'package.json')) ? JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) : {}
      const name = basename(pkg.name ?? basename(root))
      const written = scaffoldBrand(root, { name, title: name.split(/[-_.]/).filter(Boolean).map(capital).join(' '), part: join(dir, 'brand') })
      if (written.length) console.log(`Made ${written.join(' and ')}: a monogram of the name on the accent; make them yours`)
      const ignored = ignoreBrandModule(root)
      if (ignored.done.length) console.log(`Ignored ${BRAND_MODULE} in ${ignored.done.join(', ').replace(/, ([^,]*)$/, ' and $1')}: it is generated`)
      for (const line of ignored.todo) console.log(line)
      console.log(`Brand: ${RESVG_INSTALL} && \`kit brand\` renders ${BRAND_MODULE}, then createAgentApi({ …, brand: createBrand(BRAND, BRAND_ASSETS) }) (src/kit/brand/README.md)`)
    }
    for (const line of wiringOf(names.filter((name) => !lock?.modules.includes(name)))) console.log(line)
    if (flags.has('--install')) install(modules)
    else console.log(`Dependencies: ${installCommand(modules)}`)
    const entries = modules.filter((name) => REGISTRY[name].entry).map((name) => keyOf(name, REGISTRY[name].files.find((file) => file.endsWith('/index.ts')) ?? REGISTRY[name].files[0], webDir))
    const importOf = (key) => `'./${relative(process.cwd(), pathOf(key, webDir)).replace(/\.tsx?$/, '.js')}'`
    console.log(`Import from ${[...(expected['index.ts'] ? ['index.ts'] : []), ...entries].map(importOf).join(', ')}`)
  },

  guide: () => {
    const from = resolve(process.cwd(), valueOf('--from') ?? 'guide')
    const out = resolve(process.cwd(), valueOf('--out') ?? 'src/guide.gen.ts')
    if (!existsSync(from)) fail(`no guide folder at ${relative(process.cwd(), from)}; pass --from <dir>`)
    console.log(`Wrote ${writeGuideModule(from, out)} guide files to ${relative(process.cwd(), out)}`)
  },

  diff: () => {
    const lock = readLock() ?? fail(`no kit.json in ${dirArg}; add modules first`)
    const statuses = statusOf(lock, expectedFiles(lock.modules, lock.webDir))
    console.log(`Kit ${lock.version} in ${dirArg} → kit ${VERSION}`)
    for (const { file, state } of statuses) console.log(`  ${state.padEnd(15)} ${file}`)
    if (flags.has('--patch'))
      for (const { file, changed } of statuses.filter((status) => status.state !== 'unchanged' && status.state !== 'missing')) {
        if (!changed && file === 'index.ts') continue
        const upstream = file === 'index.ts' ? null : join(KIT, 'src', sourceOf(file))
        if (upstream) spawnSync('git', ['--no-pager', 'diff', '--no-index', '--no-color', upstream, pathOf(file, lock.webDir)], { stdio: 'inherit' })
      }
    const changed = statuses.filter((status) => status.state !== 'unchanged')
    process.exitCode = changed.length ? 1 : 0
  },

  init: () => {
    const [target] = names
    if (!target) fail('name the folder: init <dir>')
    const preset = valueOf('--preset') ?? 'api'
    if (preset === 'selfhosted') fail('the selfhosted preset arrives with escalay/selfhost-kit; use --preset api')
    if (!PRESETS.includes(preset)) fail(`--preset is one of ${PRESETS.join(', ')}`)
    const root = resolve(process.cwd(), target)
    if (existsSync(root) && readdirSync(root).length) fail(`${target} is not empty`)
    const name = basename(root)
    const title = valueOf('--title') ?? name.split(/[-_]/).map(capital).join(' ')
    const runtime = valueOf('--runtime') ?? (preset === 'app' ? 'cloudflare' : 'both')
    if (!RUNTIMES.includes(runtime)) fail(`--runtime is one of ${RUNTIMES.join(', ')}`)
    if (preset === 'app' && runtime !== 'cloudflare') fail('the app preset runs on Cloudflare Workers; leave --runtime out or use --runtime cloudflare')
    // __title_quoted__ sits inside a double-quoted YAML value (a skill's description), so its \ and " are escaped
    const vars = { __name__: name, __title__: title, __title_quoted__: title.replaceAll('\\', '\\\\').replaceAll('"', '\\"'), __kit__: VERSION, __date__: COMPATIBILITY_DATE }
    copyTemplate(join(KIT, 'templates/app'), root, vars, (file) => (['gitignore', 'oxlintrc.json', 'oxfmtrc.json', 'github', 'githooks', 'node-version', 'gitleaks.toml'].includes(file) ? `.${file}` : file === 'agents-skills' ? '.agents/skills' : file))
    if (runtime !== 'node') {
      copyTemplate(join(KIT, 'templates/runtime-cloudflare'), root, vars, (file) => (file === 'dev.vars.example' ? '.dev.vars.example' : file))
      mkdirSync(join(root, 'migrations'), { recursive: true })
    }
    if (preset === 'app') copyTemplate(join(KIT, 'templates/preset-app'), root, vars)
    if (runtime === 'cloudflare') for (const path of ['src/server.ts', 'Dockerfile', 'container']) rmSync(join(root, path), { recursive: true, force: true })
    // Lines marked for one runtime or preset stay only in apps that have it
    const keeps = { 'runtime:node': runtime !== 'cloudflare', 'runtime:workers': runtime !== 'node', 'preset:api': preset === 'api', 'preset:app': preset === 'app' }
    for (const file of ['AGENTS.md', 'README.md', 'src/app.ts', 'wrangler.jsonc', 'vitest.config.ts', '.github/workflows/ci.yml'].map((path) => join(root, path)).filter(existsSync))
      writeFileSync(file, keepMarked(readFileSync(file, 'utf8'), keeps).replaceAll('__worker_dev__', runtime === 'both' ? 'dev:worker' : 'dev'))
    // npm may drop the executable bit when it packs the kit
    chmodSync(join(root, '.githooks/pre-push'), 0o755)
    // A repository from the start, so `pnpm install` can point git at .githooks; never one inside another
    const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' })
    if (inside.status !== 0 && !flags.has('--no-git')) spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    // Coding agents that read .claude/skills find the repository's developer skills through this link
    mkdirSync(join(root, '.claude'), { recursive: true })
    try {
      symlinkSync('../.agents/skills', join(root, '.claude/skills'), 'dir')
    } catch {
      console.warn('Could not link .claude/skills to .agents/skills (needs permission to make links): make it by hand.')
    }
    writeGuideModule(join(root, 'guide'), join(root, 'src/guide.gen.ts'))
    // The starter brand, a monogram of the title, before `add brand` would name it after the folder
    scaffoldBrand(root, { name, title, part: join(root, 'src/kit/brand') })
    // The app preset's browser asks the switches too: their client and hooks go to web/kit, under the same kit.json
    const appModules = preset === 'app' ? [...APP_MODULES, ...WEB_APP_MODULES] : APP_MODULES
    const added = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'add', ...appModules, '--dir', 'src/kit', ...(preset === 'app' ? ['--web-dir', '../../web/kit'] : [])], { cwd: root, encoding: 'utf8' })
    if (added.status !== 0) fail(`copying the kit failed: ${added.stderr}`)
    const modules = withRequired(appModules)
    // Served as SVG until `kit brand` renders the PNGs (that needs @resvg/resvg-js)
    writeSvgOnlyBrand(root)
    const runtimeDeps = { ...(runtime === 'cloudflare' ? {} : RUNTIME), ...(preset === 'app' ? WEB_DEPS : {}) }
    const devDeps = { ...DEV, ...LINT_DEV, ...(runtime === 'node' ? {} : WORKERS_DEV), ...(runtime === 'cloudflare' ? { tsx: RUNTIME.tsx } : {}), ...(preset === 'app' ? WEB_DEV : {}) }
    const sorted = (deps) => Object.fromEntries(Object.entries(deps).sort())
    // What the Deploy to Cloudflare form says about each setting (kit button --check wants one for each it asks)
    const cloudflare = runtime === 'node' ? {} : { cloudflare: { bindings: DEPLOY_FORM } }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', packageManager: KIT_PACKAGE_MANAGER, engines: { node: '>=22.16.0' }, scripts: scriptsFor(runtime, preset), dependencies: sorted({ ...dependenciesOf(modules), ...runtimeDeps }), devDependencies: sorted(devDeps), ...cloudflare }, null, 2) + '\n')
    if (!flags.has('--bare')) addFeature(root, 'notes', { singular: 'note' })
    console.log(`Made ${title} in ${relative(process.cwd(), root)} for ${runtime === 'both' ? 'Node and Cloudflare Workers' : runtime === 'node' ? 'Node' : 'Cloudflare Workers'}${preset === 'app' ? ', with a browser app in web/,' : ''} with kit ${VERSION} (${modules.join(', ')})`)
    // What makes the app pass its own gate as made: what init writes is in the kit's long-line style, and D1 needs migrations/
    const firstRun = [['install'], ['format'], ...(runtime === 'node' ? [] : [['migrations']])]
    const left = flags.has('--no-install') ? firstRun : runFirst(root, firstRun)
    // First, so a coding agent has the kit's skills before it builds; -y: the installer otherwise stops to ask, and an agent's shell never answers
    console.log(`Skills first: npx skills add ${REPO} -y gives your coding agent the kit's skills: build on the kit, add a feature, review it, its command line`)
    console.log(`Next: cd ${relative(process.cwd(), root)} && ${[...left.map((args) => `pnpm ${args.join(' ')}`), 'pnpm test', 'pnpm dev'].join(' && ')}`)
    console.log(`Brand: make brand/ yours, then ${RESVG_INSTALL} && \`npx @escalay/kit brand\` renders the favicon, PNG icons and OG card into ${BRAND_MODULE}`)
  },

  adopt,

  doctor: async () => {
    if (flags.has('--adopt') && !existsSync(lockPath)) adopt()
    if (flags.has('--keep')) keepEdits(readLock() ?? fail(`no kit.json in ${dirArg}; add modules first`))
    const lock = readLock()
    const root = lock ? appRootOf() : null
    const brand = root ? brandFindings(root, lock.modules.includes('brand')) : { findings: [], notes: lock?.modules.includes('brand') ? [`note     brand: no package.json above ${dirArg}: \`--app <app>\` names the app whose brand/ to check`] : [] }
    const skills = root ? await skillFindings(root) : { findings: [], notes: [] }
    const findings = lock ? [...findingsOf(lock), ...cliFindings(), ...brand.findings, ...skills.findings, ...(root ? starterFindings(root) : [])] : [`no record  ${dirArg} has no kit.json: \`kit adopt --dir ${dirArg}\` writes it from the parts on disk, \`kit add <part> --dir ${dirArg}\` copies new ones`]
    const texts = lock ? appTexts() : []
    const behindNotes = lock && isVersion(lock.version) && compareVersions(lock.version, VERSION) < 0 ? [`note     kit.json says kit ${lock.version}: ${upgradingCommand(lock.version)} prints what changed for its parts since, and what to do`] : []
    const kept = lock ? keptEditsOf(lock) : []
    const keptLines = kept.map((file) => `kept     ${file}: an edit kit.json records as kept; \`kit diff --dir ${dirArg} --patch\` shows it`)
    for (const line of [...(lock ? [...addressNotes(texts), ...oauthNotes(texts, lock.modules), ...sharingNotes(texts, lock.modules)] : []), ...brand.notes, ...skills.notes, ...behindNotes, ...keptLines, ...findings]) console.log(line)
    const withKept = kept.length ? `, with ${kept.length} kept ${kept.length === 1 ? 'edit' : 'edits'}` : ''
    console.log(findings.length ? `${findings.length} to fix in ${dirArg}` : `${dirArg} matches kit ${VERSION}${withKept}: ${lock.modules.join(', ')}`)
    process.exitCode = findings.length ? 1 : 0
  },

  sdk: () => {
    const root = resolve(process.cwd(), valueOf('--app') ?? '.')
    const manifest = join(root, 'package.json')
    if (!existsSync(manifest) || !existsSync(join(root, 'src/app.ts'))) fail(`no package.json and src/app.ts in ${relative(process.cwd(), root) || '.'}: run it inside an app made by init, or pass --app <dir>`)
    for (const path of ['sdk', 'scripts/openapi.ts']) if (existsSync(join(root, path))) fail(`${path} already exists`)
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    const vars = sdkVarsOf(root)
    copyTemplate(join(KIT, 'templates/sdk'), root, vars)
    const scripts = { ...pkg.scripts, 'sdk:types': `tsx scripts/openapi.ts && pnpm dlx openapi-typescript@${OPENAPI_TYPESCRIPT} sdk/openapi.json -o sdk/src/schema.gen.ts` }
    if (scripts.typecheck && !scripts.typecheck.includes('sdk/tsconfig.json')) scripts.typecheck += ' && tsc --noEmit -p sdk/tsconfig.json'
    writeFileSync(manifest, JSON.stringify({ ...pkg, scripts }, null, 2) + '\n')
    typecheckCli(root)
    ignoreGenerated(root)
    const methods = sdkMethods(root)
    if (methods) console.log(`Wrote ${methods} methods, one per operation in the API's document`)
    else console.warn('Could not build the API document (dependencies installed?): only getHealth is written; run `kit sdk` again after `pnpm install`, or add methods by hand')
    console.log(`Made sdk/ (${vars.__package__}: create${vars.__Pascal__}, a fetch-only core, a coverage test, and the \`${vars.__bin__}\` command in sdk/cli) and scripts/openapi.ts, and added \`sdk:types\` to package.json.
Next: \`pnpm sdk:types\` (the types and sdk/cli/commands.json), then shape sdk/src/index.ts for its callers; a new route needs a method there and a line in sdk/test/client.test.ts.
If createApp takes more than { db, env }, pass it in scripts/openapi.ts and sdk/test/client.test.ts. Tests under sdk/test must be in vitest's include.`)
  },

  cli: () => {
    const root = resolve(process.cwd(), valueOf('--app') ?? '.')
    const sdkManifest = join(root, 'sdk/package.json')
    if (!existsSync(sdkManifest)) fail(`no sdk/package.json in ${relative(process.cwd(), root) || '.'}: \`kit sdk\` makes the client and the command line together`)
    const engine = join(KIT, 'templates/sdk/sdk/cli/engine')
    if (flags.has('--update')) {
      if (!existsSync(join(root, 'sdk/cli/engine'))) fail('no sdk/cli/engine to update: `kit cli` adds the command line first')
      rmSync(join(root, 'sdk/cli/engine'), { recursive: true, force: true })
      copyTemplate(engine, join(root, 'sdk/cli/engine'), {})
      console.log(`Replaced sdk/cli/engine with kit ${VERSION}'s; sdk/cli/bin.ts, jobs/ and commands.json are yours and were left alone`)
      return
    }
    if (existsSync(join(root, 'sdk/cli'))) fail('sdk/cli already exists; `kit cli --update` takes this kit\'s engine')
    const sdk = JSON.parse(readFileSync(sdkManifest, 'utf8'))
    const vars = sdkVarsOf(root, sdk.name)
    copyTemplate(join(KIT, 'templates/sdk/sdk/cli'), join(root, 'sdk/cli'), vars)
    const test = join(root, 'sdk/test/cli.test.ts')
    if (!existsSync(test)) {
      mkdirSync(dirname(test), { recursive: true })
      copyTemplate(join(KIT, 'templates/sdk/sdk/test'), join(root, '.kit-cli-test'), vars)
      writeFileSync(test, readFileSync(join(root, '.kit-cli-test/cli.test.ts'), 'utf8'))
      rmSync(join(root, '.kit-cli-test'), { recursive: true, force: true })
    }
    // The bin beside the library: built by its own tsconfig, Node 20.10 for JSON imports
    const build = (script) => (script && !script.includes('cli/tsconfig.json') ? `${script} && tsc -p cli/tsconfig.json` : (script ?? 'tsc -p tsconfig.json && tsc -p cli/tsconfig.json'))
    writeFileSync(sdkManifest, JSON.stringify({ ...sdk, bin: { ...sdk.bin, [vars.__bin__]: './dist/cli/bin.js' }, scripts: { ...sdk.scripts, build: build(sdk.scripts?.build), prepack: build(sdk.scripts?.prepack) }, engines: { ...sdk.engines, node: '>=20.10' } }, null, 2) + '\n')
    typecheckCli(root)
    ignoreGenerated(root)
    const writes = existsSync(join(root, 'scripts/openapi.ts')) && readFileSync(join(root, 'scripts/openapi.ts'), 'utf8').includes('cliSnapshot')
    console.log(`Made sdk/cli: the \`${vars.__bin__}\` command (bin of ${sdk.name}), its engine, jobs/, commands.json, and sdk/test/cli.test.ts.`)
    if (!writes)
      console.log(`Next: write the commands in scripts/openapi.ts (what \`pnpm sdk:types\` runs), then run it:

import { jobs } from '../sdk/cli/jobs/index.js'
import { mountedMcp } from '../src/kit/mcp/index.js'
import { cliSnapshot } from '../src/kit/testing/index.js'

const { tools, resources } = mountedMcp(app)
const snapshot = cliSnapshot({ app: '${vars.__bin__}', version: VERSION, tools, resources, jobs })
writeFileSync(fileURLToPath(new URL('../sdk/cli/commands.json', import.meta.url)), \`\${JSON.stringify(snapshot, null, 2)}\\n\`)`)
    console.log('Then name every tool (`cli` on mcpTool) until cliGaps in sdk/test/cli.test.ts is [].')
  },

  repo: () => {
    const [mode = 'check'] = names
    if (!['check', 'apply'].includes(mode)) fail('kit repo check|apply')
    const app = resolve(process.cwd(), valueOf('--app') ?? '.')
    const merge = valueOf('--merge') ?? 'squash'
    if (!['squash', 'rebase'].includes(merge)) fail('--merge is squash or rebase')
    const ciPath = join(app, '.github/workflows/ci.yml')
    const checks = valueOf('--checks')?.split(',').map((check) => check.trim()).filter(Boolean) ?? (existsSync(ciPath) ? alwaysJobsOf(readFileSync(ciPath, 'utf8'), calledWorkflowReader(app)) : [])
    if (!checks.length) fail('no checks to require: add .github/workflows/ci.yml (kit init writes one) or name them with --checks')
    const repo = valueOf('--repo') ?? spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: app, encoding: 'utf8' }).stdout?.trim()
    if (!repo) fail('no GitHub repository here: run it in a clone, or pass --repo owner/name')
    const plan = repoPlan({ merge, release: existsSync(join(app, '.github/workflows/release.yml')), checks })
    let { findings, notes } = repoFindings(repo, plan)
    if (mode === 'apply' && findings.length) {
      const fixes = [...new Map(findings.map((finding) => [finding.fix === 'ruleset' ? finding.ruleset.name : finding.fix, finding])).values()]
      for (const finding of fixes) applyFinding(repo, plan, finding)
      const named = { settings: 'settings', workflow: 'the Actions token', alerts: 'vulnerability alerts', fixes: 'security updates' }
      console.log(`Set ${fixes.map((finding) => named[finding.fix] ?? `ruleset "${finding.ruleset.name}"`).join(', ')} on ${repo}`)
      ;({ findings, notes } = repoFindings(repo, plan))
    }
    for (const finding of findings) console.log(`differs  ${finding.what}: has ${JSON.stringify(finding.has)}, wants ${JSON.stringify(finding.want)}`)
    for (const note of notes) console.log(`note     ${note}`)
    const again = ['kit repo apply', ...(merge === 'squash' ? [] : ['--merge', merge]), ...(valueOf('--checks') ? ['--checks', JSON.stringify(valueOf('--checks'))] : [])].join(' ')
    console.log(findings.length ? `${findings.length} to fix on ${repo}: \`${again}\`` : `${repo} is set up as the standard says (${merge} merges; required: ${checks.join(', ')})`)
    process.exitCode = findings.length ? 1 : 0
  },

  button: async () => {
    const app = resolve(process.cwd(), valueOf('--app') ?? '.')
    const repo = valueOf('--repo') ?? (spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: app, encoding: 'utf8' }).stdout?.trim() || undefined)
    const url = repo ? buttonUrl({ repo, branch: valueOf('--branch'), dir: valueOf('--subdir') }) : null
    const checking = flags.has('--check') || flags.has('--smoke')
    if (!checking && !flags.has('--write')) {
      if (!url) fail('no GitHub repository here: run it in a clone, or pass --repo owner/name')
      const { markdown, html } = buttonSnippets(url)
      console.log(`Link:     ${url}\nMarkdown: ${markdown}\nHTML:     ${html}`)
      return
    }
    const readmePath = join(app, 'README.md')
    if (flags.has('--write')) {
      if (!url) fail('--write needs the repository: run it in a clone, or pass --repo owner/name')
      const before = existsSync(readmePath) ? readFileSync(readmePath, 'utf8') : `# ${basename(app)}\n`
      const after = readmeWithButton(before, buttonSnippets(url).markdown)
      if (after !== before) writeFileSync(readmePath, after)
      console.log(after === before ? 'README.md already has this button' : `README.md: the button now deploys ${url.split('?url=')[1]}`)
    }
    if (!checking) return
    const { findings, notes, config } = buttonFindings(app)
    if (url && existsSync(readmePath)) {
      const readme = readFileSync(readmePath, 'utf8')
      if (readme.includes(BUTTON_START) && !readme.includes(buttonSnippets(url).markdown)) findings.push({ what: "README.md's button deploys something else", fix: '`kit button --write` sets it to this repository' })
    }
    const visibility = repo ? spawnSync('gh', ['repo', 'view', repo, '--json', 'visibility', '-q', '.visibility'], { encoding: 'utf8' }).stdout?.trim() : ''
    if (!repo) notes.push('not on GitHub yet: the button needs a public github.com or gitlab.com repository')
    else if (visibility && visibility !== 'PUBLIC') notes.push(`${repo} is ${visibility.toLowerCase()}: the button works for strangers once it is public`)
    for (const finding of findings) console.log(`fix   ${finding.what}: ${finding.fix}`)
    for (const note of notes) console.log(`note  ${note}`)
    if (findings.length) {
      console.log(`${findings.length} to fix before the button can deploy this app`)
      process.exitCode = 1
      return
    }
    console.log(`${basename(app)} is ready for the Deploy to Cloudflare button${url ? `: ${url}` : ''}`)
    if (flags.has('--smoke')) await smokeDeploy(app, config, existsSync(join(app, 'package.json')) ? JSON.parse(readFileSync(join(app, 'package.json'), 'utf8')) : {})
  },

  license: licenseCommand,

  brand: async () => {
    const root = resolve(process.cwd(), valueOf('--app') ?? '.')
    if (flags.has('--check')) {
      if (!existsSync(brandFiles(root).brand) || !existsSync(brandFiles(root).icon)) fail('no brand/brand.ts and brand/icon.svg: `kit add brand` scaffolds them')
      const { findings, notes } = brandFindings(root, true)
      for (const line of [...notes, ...findings]) console.log(line)
      if (!findings.length) console.log(`${BRAND_MODULE} matches brand/`)
      process.exitCode = findings.length ? 1 : 0
      return
    }
    const { inline, dark, warnings } = await renderBrand(root)
    for (const warning of warnings) console.warn(`kit: ${warning}`)
    console.log(`Wrote ${BRAND_MODULE}: PNGs at ${BRAND_PNG.join(', ')} px (the inline 96 is ${(inline / 1024).toFixed(1)} KB)${dark ? `, dark ones at ${BRAND_DARK.join(', ')}` : ''}, and the OG card, whose text uses this machine's sans-serif font (none is bundled)`)
    for (const note of brandFindings(root, true).notes) console.log(note)
  },

  feature: () => {
    const [name] = names
    if (!name) fail('name the feature, plural and kebab-case: feature reading-lists')
    addFeature(resolve(process.cwd(), valueOf('--app') ?? '.'), name, { switchable: flags.has('--switch'), fieldSpec: valueOf('--fields'), singular: valueOf('--singular'), remove: !flags.has('--no-remove') })
  },

  update: () => {
    const lock = readLock() ?? fail(`no kit.json in ${dirArg}; add modules first`)
    // `kit` names the generated index.ts (for --force), never a module
    const modules = withRequired([...lock.modules, ...names.filter((name) => name !== 'kit')])
    const expected = expectedFiles(modules, lock.webDir)
    const hashes = { ...lock.files }
    const kept = []
    // --force takes the kit's file over an edit only in the parts it names; naming none, only with --all or when no edit would go
    const forced = (file) => flags.has('--force') && (!names.length || names.includes(partOf(file, modules)))
    const scope = names.length ? `--force names ${names.join(', ')}` : '--force --all'
    const statuses = statusOf(lock, expected)
    const edits = statuses.filter(({ state }) => state === 'both changed' || state === 'you edited').map(({ file }) => file)
    if (flags.has('--force') && !names.length && !flags.has('--all') && edits.length) {
      const parts = [...new Set(edits.map((file) => partOf(file, modules)))]
      fail(
        [
          `update --force names no part, and would overwrite ${edits.length} ${edits.length === 1 ? 'edit' : 'edits'}:`,
          ...edits.map((file) => `  ${file} (${partOf(file, modules)})`),
          `Take the kit's part by part: ${parts.map((part) => `\`${forceCommand([part])}\``).join(', ')}; or every part's, these edits too: \`kit update --dir ${dirArg} --force --all\``,
        ].join('\n'),
      )
    }
    for (const { file, state } of statuses) {
      if (state === 'dropped by kit') {
        delete hashes[file]
        console.log(`  dropped       ${file} (no longer in the kit; delete it when nothing imports it)`)
        continue
      }
      if (state === 'unchanged') {
        hashes[file] = sha(expected[file])
        continue
      }
      const edited = state === 'both changed' || state === 'you edited'
      if (edited && !forced(file)) {
        if (state === 'both changed') kept.push(file)
        // The kit's hash, as adopt records it: a wrong record would read as a kit change once the kit moves on
        if (state === 'you edited' && lock.version === VERSION) hashes[file] = sha(expected[file])
        if (flags.has('--force')) {
          const part = partOf(file, modules)
          console.log(state === 'both changed' ? `  kept          ${file}: your edit, and the kit changed it; ${scope}, not ${part}: \`${forceCommand([part])}\` takes the kit's` : `  kept          ${file}: your edit; ${scope}, not ${part}`)
        }
        continue
      }
      mkdirSync(dirname(pathOf(file, lock.webDir)), { recursive: true })
      writeFileSync(pathOf(file, lock.webDir), expected[file])
      hashes[file] = sha(expected[file])
      console.log(edited ? `  overwrote     ${file} (your edit: ${scope})` : `  updated       ${file}`)
    }
    // A kept file still holds the older kit's code, so kit.json keeps the older version until none is left
    writeLock(modules, hashes, lock.webDir, kept.length ? lock.version : VERSION, keptOf(lock))
    // kit.json may now record this kit, so the command names the version the app came from
    if (isVersion(lock.version) && compareVersions(lock.version, VERSION) < 0) console.log(`What changed for these parts since kit ${lock.version}: ${upgradingCommand(lock.version, true)}`)
    if (kept.length) {
      console.log(`${kept.length} ${kept.length === 1 ? 'file' : 'files'} kept at kit ${lock.version}: ${kept.join(', ')}. ${keptFix([...new Set(kept.map((file) => partOf(file, modules)))])}`)
      console.log(`Dependencies: ${installCommand(modules)}`)
      process.exitCode = 1
      return
    }
    console.log(`kit.json → ${VERSION}. Dependencies: ${installCommand(modules)}`)
  },

  upgrading: () => {
    const lock = readLock() ?? fail(`no kit.json in ${dirArg}; add modules first`)
    const since = valueOf('--from') ?? lock.version
    if (!isVersion(since)) fail(`--from is a version, like 1.29.0`)
    const markdown = readFileSync(join(KIT, 'docs/upgrading.md'), 'utf8')
    const folders = [...new Set(lock.modules.filter((name) => REGISTRY[name]).map(notesFolderOf))]
    const sections = folders.map((folder) => [folder, notesSince(markdown, folder, since)]).filter(([, notes]) => notes.length)
    if (!sections.length) return console.log(`No upgrade notes for ${folders.join(', ')} after kit ${since} (this is kit ${VERSION})`)
    console.log(`Upgrade notes for ${folders.join(', ')} after kit ${since}, up to kit ${VERSION} (the kit's docs/upgrading.md):`)
    // An edit kept over a fix holds the bug: the notes mark a fix `**Fixed` or `**Security`, per part, never per file
    const fixed = new Set(sections.filter(([, notes]) => notes.some((note) => /\*\*(Fixed|Security)\b/.test(note))).map(([folder]) => folder))
    // Only the parts this kit knows: a kit.json may name one a later kit added
    const known = lock.modules.filter((name) => REGISTRY[name])
    // The generated index.ts is no part's, so no part's notes name a fix in it
    const overFixes = fixed.size ? statusOf(lock, expectedFiles(known, lock.webDir)).filter(({ file, state }) => state === 'both changed' && partOf(file, known) !== 'kit' && fixed.has(notesFolderOf(partOf(file, known)))) : []
    if (overFixes.length) console.log('')
    for (const { file } of overFixes) console.log(`fix      ${file}: your edit, and the kit changed it since; ${notesFolderOf(partOf(file, known))}'s notes below name a fix: ${keptFix([partOf(file, known)])}`)
    for (const [folder, notes] of sections) console.log(`\n## ${folder}\n\n${notes.join('\n\n')}`)
  },
}

if (commands[command] && (flags.has('--help') || rest.includes('-h'))) console.log(usageOf(command) || HELP)
else (commands[command] ?? (() => fail(`unknown command "${command}". Commands: ${Object.keys(commands).join(', ')}`)))()
