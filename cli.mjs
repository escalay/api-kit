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
 *   kit init <dir> [--preset api|app] [--title "My API"] [--runtime both|cloudflare|node] [--bare] [--yes]
 *                                             a new app: features/, the kit in src/kit, tests; Node (server.ts, a
 *                                             container) and/or Workers (worker.ts, D1). It never asks; --yes is accepted
 *   kit feature <plural-name> [--app .]       a new feature folder (schema, repo, routes, handlers, tools), listed
 *   kit guide [--from guide] [--out src/guide.gen.ts]  the guide folder as a module (GUIDE_FILES), for Workers
 *   kit sdk [--app .] [--package name]      a typed TypeScript client in sdk/: generated types, a fetch-only core,
 *                                             a coverage test that fails until every route has a method; `pnpm sdk:types`
 *
 * @example
 * npx @escalay/kit add core pagination guide mcp testing --dir apps/api/src/kit --install
 * import { createAgentApi } from './kit/index.js'      // in the app
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const VALUE_FLAGS = new Set(['--dir', '--web-dir', '--title', '--runtime', '--preset', '--app', '--from', '--out'])
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
const RUNTIME = { '@hono/node-server': '^2.1.5', tsx: '^4.23.15' }
const DEV = { '@types/node': '^24.19.2', typescript: '^7.0.2', vitest: '^5.0.5' }
/** What the Cloudflare side adds, at the versions the kit tests with. */
const KIT_DEV = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')).devDependencies
const WORKERS_DEV = Object.fromEntries(['wrangler', '@cloudflare/vitest-plugin', '@cloudflare/workers-types'].map((name) => [name, KIT_DEV[name]]))
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
  const lint = { lint: 'oxlint', format: 'oxfmt' }
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
      ...lint,
    }
  return {
    ...(runtime === 'cloudflare' ? { dev: 'wrangler dev' } : node),
    ...(runtime === 'both' ? { 'dev:worker': 'wrangler dev' } : {}),
    guide: 'tsx scripts/guide.ts',
    ...(runtime === 'node' ? {} : workers),
    test: 'vitest run',
    typecheck,
    ...lint,
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

// ---- Commands ----

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
    copyTemplate(join(KIT, 'templates/app'), root, vars, (file) => (['gitignore', 'oxlintrc.json', 'oxfmtrc.json'].includes(file) ? `.${file}` : file === 'agents-skills' ? '.agents/skills' : file))
    if (runtime !== 'node') {
      copyTemplate(join(KIT, 'templates/runtime-cloudflare'), root, vars, (file) => (file === 'dev.vars.example' ? '.dev.vars.example' : file))
      mkdirSync(join(root, 'migrations'), { recursive: true })
    }
    if (preset === 'app') copyTemplate(join(KIT, 'templates/preset-app'), root, vars)
    if (runtime === 'cloudflare') for (const path of ['src/server.ts', 'Dockerfile', 'container']) rmSync(join(root, path), { recursive: true, force: true })
    // Lines marked for one runtime or preset (`<!-- runtime:node -->`, `// preset:app`, several at a line's end) stay only in apps that have it
    const keeps = { 'runtime:node': runtime !== 'cloudflare', 'runtime:workers': runtime !== 'node', 'preset:api': preset === 'api', 'preset:app': preset === 'app' }
    const MARK = /^(.*?) (?:<!-- ((?:runtime|preset):\w+) -->|\/\/ ((?:runtime|preset):\w+))$/
    const unmarked = (line) => {
      const marked = line.match(MARK)
      return !marked ? [line] : keeps[marked[2] ?? marked[3]] ? unmarked(marked[1]) : []
    }
    for (const file of ['AGENTS.md', 'src/app.ts', 'wrangler.jsonc', 'vitest.config.ts'].map((path) => join(root, path)).filter(existsSync))
      writeFileSync(file, readFileSync(file, 'utf8').split('\n').flatMap(unmarked).join('\n').replaceAll('__worker_dev__', runtime === 'both' ? 'dev:worker' : 'dev'))
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
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, version: '0.1.0', private: true, type: 'module', engines: { node: '>=22.16.0' }, scripts: scriptsFor(runtime, preset), dependencies: sorted({ ...dependenciesOf(modules), ...runtimeDeps }), devDependencies: sorted(devDeps) }, null, 2) + '\n')
    if (!flags.has('--bare')) addFeature(root, 'notes')
    console.log(`Made ${title} in ${relative(process.cwd(), root)} for ${runtime === 'both' ? 'Node and Cloudflare Workers' : runtime === 'node' ? 'Node' : 'Cloudflare Workers'}${preset === 'app' ? ', with a browser app in web/,' : ''} with kit ${VERSION} (${modules.join(', ')})`)
    console.log(`Next: cd ${relative(process.cwd(), root)} && pnpm install${runtime === 'node' ? '' : ' && pnpm migrations'} && pnpm test && pnpm dev`)
  },

  adopt,

  doctor: () => {
    if (flags.has('--adopt') && !existsSync(lockPath)) adopt()
    const lock = readLock()
    const findings = lock ? findingsOf(lock) : [`no record  ${dirArg} has no kit.json: \`kit adopt --dir ${dirArg}\` writes it from the parts on disk, \`kit add <part> --dir ${dirArg}\` copies new ones`]
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
    const words = basename(pkg.name ?? basename(root)).split(/[-_.]/).filter(Boolean)
    const vars = { __package__: valueOf('--package') ?? `${words.join('-')}-client`, __Title__: words.map(capital).join(' '), __Pascal__: words.map(capital).join(''), __camel__: words[0] + words.slice(1).map(capital).join('') }
    copyTemplate(join(KIT, 'templates/sdk'), root, vars)
    const scripts = { ...pkg.scripts, 'sdk:types': `tsx scripts/openapi.ts && pnpm dlx openapi-typescript@${OPENAPI_TYPESCRIPT} sdk/openapi.json -o sdk/src/schema.gen.ts` }
    if (scripts.typecheck && !scripts.typecheck.includes('sdk/tsconfig.json')) scripts.typecheck += ' && tsc --noEmit -p sdk/tsconfig.json'
    writeFileSync(manifest, JSON.stringify({ ...pkg, scripts }, null, 2) + '\n')
    // Lint and format leave what is generated alone
    for (const file of ['.oxlintrc.json', '.oxfmtrc.json'].map((name) => join(root, name)).filter(existsSync)) {
      const config = JSON.parse(readFileSync(file, 'utf8'))
      config.ignorePatterns = [...new Set([...(config.ignorePatterns ?? []), 'sdk/src/schema.gen.ts', 'sdk/openapi.json', 'sdk/dist/**'])]
      writeFileSync(file, JSON.stringify(config, null, 2) + '\n')
    }
    const methods = sdkMethods(root)
    if (methods) console.log(`Wrote ${methods} methods, one per operation in the API's document`)
    else console.warn('Could not build the API document (dependencies installed?): only getHealth is written; run `kit sdk` again after `pnpm install`, or add methods by hand')
    console.log(`Made sdk/ (${vars.__package__}: create${vars.__Pascal__}, a fetch-only core, a coverage test) and scripts/openapi.ts, and added \`sdk:types\` to package.json.
Next: \`pnpm sdk:types\` (the types), then shape sdk/src/index.ts for its callers; a new route needs a method there and a line in sdk/test/client.test.ts.
If createApp takes more than { db, env }, pass it in scripts/openapi.ts and sdk/test/client.test.ts. Tests under sdk/test must be in vitest's include.`)
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
