#!/usr/bin/env node
/**
 * kit: copy the kit's parts into an app (shadcn-style), then keep them in step with the kit.
 * The app owns the copies; `kit.json` beside them records the kit version and the hash of every file as copied, so
 * `diff` can tell your edits from the kit's changes and `update` never overwrites an edit without `--force`.
 * `--web-dir` (relative to `--dir`, remembered in kit.json) puts the browser parts in their own folder, still
 * tracked by the one kit.json (as `@web/<file>`).
 *
 *   kit list                                  parts, what they need, which are installed; then the root items
 *   kit add core guide mcp testing [--dir src/kit] [--web-dir ../web] [--install]
 *   kit diff [--dir src/kit] [--patch]        per file: unchanged, you edited, kit changed, both
 *   kit update [part…] [--dir src/kit] [--force]
 *   kit doctor [--dir src/kit] [--adopt]      missing files, edited files, parts behind this kit; exits 1 with a fix per line
 *   kit adopt [--dir src/kit]                 write kit.json for parts copied without it (by the shadcn CLI)
 *   kit init <dir> [--preset api|app] [--title "My API"] [--runtime both|cloudflare|node] [--bare] [--no-git] [--yes]
 *                                             a new app: features/, the kit in src/kit, tests; Node (server.ts, a
 *                                             container) and/or Workers (worker.ts, D1). It never asks; --yes is accepted
 *   kit feature <plural-name> [--app .]       a new feature folder (schema, repo, routes, handlers, tools), listed
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
 *
 * @example
 * npx @escalay/kit add core pagination guide mcp testing --dir apps/api/src/kit --install
 * import { createAgentApi } from './kit/index.js'      // in the app
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
const VALUE_FLAGS = new Set(['--dir', '--web-dir', '--title', '--runtime', '--preset', '--app', '--from', '--out', '--package', '--bin', '--repo', '--merge', '--checks', '--branch', '--subdir'])
const names = rest.filter((arg, index) => !arg.startsWith('--') && !VALUE_FLAGS.has(rest[index - 1]))
const dir = resolve(process.cwd(), dirArg)
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
const writeLock = (modules, hashes, webDir) =>
  writeFileSync(lockPath, JSON.stringify({ $comment: 'Written by @escalay/kit; hashes are of the files as the kit last wrote them.', source: SOURCE, version: VERSION, modules, ...(webDir ? { webDir } : {}), files: Object.fromEntries(Object.entries(hashes).sort()) }, null, 2) + '\n')

const dependenciesOf = (modules) => Object.assign({}, ...modules.map((name) => REGISTRY[name].dependencies ?? {}))
const installCommand = (modules) => {
  const deps = Object.entries(dependenciesOf(modules)).map(([name, range]) => `${name}@${range}`)
  return deps.length ? `pnpm add ${deps.join(' ')}` : 'none'
}

const install = (modules) => {
  if (installCommand(modules) === 'none') return
  const result = spawnSync('pnpm', installCommand(modules).split(' ').slice(1), { stdio: 'inherit', cwd: process.cwd() })
  if (result.status !== 0) fail('pnpm add failed; run it yourself: ' + installCommand(modules))
}

/** Each file's state against kit.json: did you edit it, did the kit change it. */
const statusOf = (lock, expected) =>
  Object.keys({ ...lock.files, ...expected }).sort().map((file) => {
    const path = pathOf(file, lock.webDir)
    const local = existsSync(path) ? sha(readFileSync(path, 'utf8')) : null
    const recorded = lock.files[file] ?? null
    const kit = expected[file] === undefined ? null : sha(expected[file])
    const edited = local !== null && recorded !== null && local !== recorded
    const changed = kit !== recorded
    const state = local === null ? 'missing' : recorded === null ? 'new in kit' : kit === null ? 'dropped by kit' : edited && changed ? 'both changed' : edited ? 'you edited' : changed ? 'kit changed' : 'unchanged'
    return { file, state, edited, changed }
  })

/** The part a recorded file came with (`index.ts` is the kit's own). */
const partOf = (key, modules) => modules.find((name) => REGISTRY[name].files.includes(sourceOf(key))) ?? 'kit'

/** One line per thing wrong with the copy, each saying how to fix it. */
const findingsOf = (lock) => {
  const statuses = statusOf(lock, expectedFiles(lock.modules, lock.webDir))
  const behind = [...new Set(statuses.filter(({ state }) => ['kit changed', 'both changed', 'new in kit', 'dropped by kit'].includes(state)).map(({ file }) => partOf(file, lock.modules)))]
  return [
    ...statuses.filter(({ state }) => state === 'missing').map(({ file }) => `missing  ${file}: \`kit update --dir ${dirArg}\` writes it again`),
    ...statuses.filter(({ edited }) => edited).map(({ file }) => `edited   ${file}: yours to keep; \`kit diff --dir ${dirArg} --patch\` shows the change, \`kit update --dir ${dirArg} --force\` takes the kit's`),
    ...behind.map((part) => `behind   ${part} was copied from kit ${lock.version} and kit ${VERSION} changed it: \`kit diff --dir ${dirArg} --patch\`, then \`kit update --dir ${dirArg}\``),
    ...(lock.version !== VERSION && !behind.length ? [`behind   kit.json says kit ${lock.version}, this is ${VERSION} with the same files: \`kit update --dir ${dirArg}\` records it`] : []),
  ]
}

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
const APP_MODULES = ['core', 'db', 'oauth', 'guide', 'mcp', 'testing']
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
    check: ['pnpm typecheck', 'pnpm lint', 'oxfmt --check', ...more].join(' && '),
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

/** Every spelling a feature's files need, from its plural kebab-case name (`reading-lists`). */
export const namesOf = (name) => {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) fail(`"${name}" isn't a plural kebab-case name like notes or reading-lists`)
  const many = name.split('-')
  const one = [...many.slice(0, -1), singularOf(many.at(-1))]
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

const addFeature = (root, name) => {
  const vars = namesOf(name)
  const list = join(root, 'src/features/index.ts')
  if (!existsSync(list)) fail(`no src/features/index.ts in ${relative(process.cwd(), root) || '.'}: run it inside an app made by init, or pass --app <dir>`)
  const folder = join(root, 'src/features', name)
  if (existsSync(folder)) fail(`src/features/${name} already exists`)
  const text = readFileSync(list, 'utf8')
  if (!text.includes('// kit:imports') || !text.includes('  // kit:features')) fail('src/features/index.ts lost its `// kit:imports` or `// kit:features` line; add the feature there by hand')
  copyTemplate(join(KIT, 'templates/feature'), folder, vars, (file) => (file === 'feature.test.ts' ? `${name}.test.ts` : file))
  writeFileSync(list, text.replace('// kit:imports', `import { feature as ${vars.__camel__} } from './${name}/index.js'\n// kit:imports`).replace('  // kit:features', `  ${vars.__camel__},\n  // kit:features`))
  console.log(`Made src/features/${name}/ (schema, repo, routes, handlers, tools, index, test) and listed it in src/features/index.ts`)
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

/** The names the SDK and CLI templates fill: the package, its title, its bin (`mailroom`) and env prefix (`MAILROOM`). */
const sdkVarsOf = (root, packageName) => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const words = basename(pkg.name ?? basename(root)).split(/[-_.]/).filter(Boolean)
  const bin = valueOf('--bin') ?? words.join('-')
  if (!/^[a-z][a-z0-9-]*$/.test(bin)) fail(`--bin is one lowercase word or kebab-case name, like mailroom`)
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

const commands = {
  help: () => console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, '').trim()),

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
    writeLock(modules, hashes, webDir)
    console.log(`Copied ${modules.join(', ')} (kit ${VERSION}) into ${relative(process.cwd(), dir) || '.'}`)
    if (skipped.length) console.log(`Kept your version of ${skipped.join(', ')} (it differs from the kit); --force overwrites`)
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
    const vars = { __name__: name, __title__: title, __kit__: VERSION, __date__: COMPATIBILITY_DATE }
    copyTemplate(join(KIT, 'templates/app'), root, vars, (file) => (['gitignore', 'oxlintrc.json', 'oxfmtrc.json', 'github', 'githooks', 'node-version', 'gitleaks.toml'].includes(file) ? `.${file}` : file === 'agents-skills' ? '.agents/skills' : file))
    if (runtime !== 'node') {
      copyTemplate(join(KIT, 'templates/runtime-cloudflare'), root, vars, (file) => (file === 'dev.vars.example' ? '.dev.vars.example' : file))
      mkdirSync(join(root, 'migrations'), { recursive: true })
    }
    if (preset === 'app') copyTemplate(join(KIT, 'templates/preset-app'), root, vars)
    if (runtime === 'cloudflare') for (const path of ['src/server.ts', 'Dockerfile', 'container']) rmSync(join(root, path), { recursive: true, force: true })
    // Lines marked for one runtime or preset (`<!-- runtime:node -->`, `// preset:app`, `# runtime:workers`, several at a line's end) stay only in apps that have it
    const keeps = { 'runtime:node': runtime !== 'cloudflare', 'runtime:workers': runtime !== 'node', 'preset:api': preset === 'api', 'preset:app': preset === 'app' }
    const MARK = /^(.*?) (?:<!-- ((?:runtime|preset):\w+) -->|\/\/ ((?:runtime|preset):\w+)|# ((?:runtime|preset):\w+))$/
    const unmarked = (line) => {
      const marked = line.match(MARK)
      return !marked ? [line] : keeps[marked[2] ?? marked[3] ?? marked[4]] ? unmarked(marked[1]) : []
    }
    for (const file of ['AGENTS.md', 'README.md', 'src/app.ts', 'wrangler.jsonc', 'vitest.config.ts', '.github/workflows/ci.yml'].map((path) => join(root, path)).filter(existsSync))
      writeFileSync(file, readFileSync(file, 'utf8').split('\n').flatMap(unmarked).join('\n').replaceAll('__worker_dev__', runtime === 'both' ? 'dev:worker' : 'dev'))
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
    const added = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'add', ...APP_MODULES, '--dir', 'src/kit'], { cwd: root, encoding: 'utf8' })
    if (added.status !== 0) fail(`copying the kit failed: ${added.stderr}`)
    const modules = withRequired(APP_MODULES)
    const runtimeDeps = { ...(runtime === 'cloudflare' ? {} : RUNTIME), ...(preset === 'app' ? WEB_DEPS : {}) }
    const devDeps = { ...DEV, ...LINT_DEV, ...(runtime === 'node' ? {} : WORKERS_DEV), ...(runtime === 'cloudflare' ? { tsx: RUNTIME.tsx } : {}), ...(preset === 'app' ? WEB_DEV : {}) }
    const sorted = (deps) => Object.fromEntries(Object.entries(deps).sort())
    // What the Deploy to Cloudflare form says about each setting (kit button --check wants one for each it asks)
    const cloudflare = runtime === 'node' ? {} : { cloudflare: { bindings: DEPLOY_FORM } }
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', packageManager: KIT_PACKAGE_MANAGER, engines: { node: '>=22.16.0' }, scripts: scriptsFor(runtime, preset), dependencies: sorted({ ...dependenciesOf(modules), ...runtimeDeps }), devDependencies: sorted(devDeps), ...cloudflare }, null, 2) + '\n')
    if (!flags.has('--bare')) addFeature(root, 'notes')
    console.log(`Made ${title} in ${relative(process.cwd(), root)} for ${runtime === 'both' ? 'Node and Cloudflare Workers' : runtime === 'node' ? 'Node' : 'Cloudflare Workers'}${preset === 'app' ? ', with a browser app in web/,' : ''} with kit ${VERSION} (${modules.join(', ')})`)
    console.log(`Next: cd ${relative(process.cwd(), root)} && pnpm install && pnpm format${runtime === 'node' ? '' : ' && pnpm migrations'} && pnpm test && pnpm dev`)
  },

  adopt,

  doctor: () => {
    if (flags.has('--adopt') && !existsSync(lockPath)) adopt()
    const lock = readLock()
    const findings = lock ? [...findingsOf(lock), ...cliFindings()] : [`no record  ${dirArg} has no kit.json: \`kit adopt --dir ${dirArg}\` writes it from the parts on disk, \`kit add <part> --dir ${dirArg}\` copies new ones`]
    for (const finding of findings) console.log(finding)
    console.log(findings.length ? `${findings.length} to fix in ${dirArg}` : `${dirArg} matches kit ${VERSION}: ${lock.modules.join(', ')}`)
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

  feature: () => {
    const [name] = names
    if (!name) fail('name the feature, plural and kebab-case: feature reading-lists')
    addFeature(resolve(process.cwd(), valueOf('--app') ?? '.'), name)
  },

  update: () => {
    const lock = readLock() ?? fail(`no kit.json in ${dirArg}; add modules first`)
    const modules = withRequired([...lock.modules, ...names])
    const expected = expectedFiles(modules, lock.webDir)
    const hashes = { ...lock.files }
    const kept = []
    for (const { file, state } of statusOf(lock, expected)) {
      if (state === 'dropped by kit') {
        delete hashes[file]
        console.log(`  dropped       ${file} (no longer in the kit; delete it when nothing imports it)`)
        continue
      }
      if (state === 'unchanged') continue
      if ((state === 'both changed' || state === 'you edited') && !flags.has('--force')) {
        if (state === 'both changed') kept.push(file)
        continue
      }
      mkdirSync(dirname(pathOf(file, lock.webDir)), { recursive: true })
      writeFileSync(pathOf(file, lock.webDir), expected[file])
      hashes[file] = sha(expected[file])
      console.log(`  updated       ${file}`)
    }
    writeLock(modules, hashes, lock.webDir)
    if (kept.length) console.log(`Kept your edits to ${kept.join(', ')} although the kit changed them: \`diff --patch\` shows both, merge by hand, or --force`)
    console.log(`kit.json → ${VERSION}. Dependencies: ${installCommand(modules)}`)
  },
}

;(commands[command] ?? (() => fail(`unknown command "${command}". Commands: ${Object.keys(commands).join(', ')}`)))()
