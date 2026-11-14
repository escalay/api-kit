#!/usr/bin/env node
/**
 * Makes one app per preset with `create-escalay` in the OS temp folder, installs it and runs its own CI's checks: format,
 * typecheck, lint, format check and tests for both, and for `api` a client made with `kit sdk` and its command line, built and run. For the `app` preset also the build (its files must land under /app/assets/, the one prefix
 * the Worker leaves to files), a dry-run deploy, and that a formatted app still takes a new feature and passes.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const create = fileURLToPath(new URL('../packages/create-escalay/index.mjs', import.meta.url))
const parent = mkdtempSync(join(tmpdir(), 'starter-'))
const run = (command, args, cwd) => {
  console.log(`$ ${command} ${args.join(' ')}`)
  const { status } = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (status !== 0) process.exit(status ?? 1)
}
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url))
const check = (name, preset, more = []) => {
  const app = join(parent, name)
  run(process.execPath, [create, name, '--preset', preset, '--yes'], parent)
  // init's last line, then what the app's CI and its pre-push hook run: `pnpm gate`
  for (const args of [['install'], ['format'], ['migrations'], ['gate'], ...more]) run('pnpm', args, app)
  // A feature that names Cloudflare is refused by lint; the same import in a binding is allowed
  const probe = (path) => join(app, path)
  writeFileSync(probe('src/features/provider-probe.ts'), "import { env } from 'cloudflare:workers'\nexport const probe = env\n")
  const refused = spawnSync('pnpm', ['lint'], { cwd: app, encoding: 'utf8' })
  rmSync(probe('src/features/provider-probe.ts'))
  // The file is named whatever the reporter (on GitHub Actions oxlint writes annotations without the rule's message)
  if (refused.status === 0 || !`${refused.stdout}${refused.stderr}`.includes('provider-probe.ts')) {
    console.error(`lint should refuse a feature that imports cloudflare:workers, but it said:\n${refused.stdout}${refused.stderr}`)
    process.exit(1)
  }
  mkdirSync(probe('src/bindings'), { recursive: true })
  writeFileSync(probe('src/bindings/provider-probe.ts'), "import { env } from 'cloudflare:workers'\nexport const probe = env\n")
  const allowed = spawnSync('pnpm', ['lint'], { cwd: app, encoding: 'utf8' })
  rmSync(probe('src/bindings'), { recursive: true })
  if (allowed.status !== 0) {
    console.error(`lint should allow cloudflare:workers inside src/bindings/, but it said:\n${allowed.stdout}${allowed.stderr}`)
    process.exit(1)
  }
  console.log(`${name}: lint refuses a feature that names Cloudflare, and allows it in src/bindings/`)
  // Ready for the Deploy to Cloudflare button as made
  run(process.execPath, [cli, 'button', '--check'], app)
  // A repository from the start, with git pointed at the hook by `pnpm install`
  const hooks = spawnSync('git', ['config', 'core.hooksPath'], { cwd: app, encoding: 'utf8' }).stdout.trim()
  if (hooks !== '.githooks') {
    console.error(`git should run .githooks/pre-push after install, but core.hooksPath is "${hooks}"`)
    process.exit(1)
  }
  return app
}
const api = check('starter-api', 'api')
// A typed client: made, generated, and every route covered from the start
run(process.execPath, [cli, 'sdk'], api)
for (const args of [['sdk:types'], ['typecheck'], ['lint'], ['test']]) run('pnpm', args, api)
// The command line as it is published: built into sdk/dist/cli, then run by node with the packaged commands
run('pnpm', ['--dir', 'sdk', 'exec', 'tsc', '-p', 'cli/tsconfig.json'], api)
// The kit's copy and the app's command names, both clean
run(process.execPath, [cli, 'doctor'], api)
run(process.execPath, ['sdk/dist/cli/bin.js', 'note', 'list', '--help'], api)
const app = check('starter-app', 'app', [['exec', 'oxfmt', '--check', 'web', 'vite.config.ts', 'tsconfig.web.json', 'index.html'], ['exec', 'wrangler', 'deploy', '--dry-run']])
const built = [...readFileSync(join(app, 'dist/client/index.html'), 'utf8').matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(([, path]) => path)
const stray = built.filter((path) => !path.startsWith('/app/assets/') || !existsSync(join(app, 'dist/client', path)))
if (!built.length || stray.length) {
  console.error(`the built page must load its files from /app/assets/: ${JSON.stringify(built.length ? stray : 'no files')}`)
  process.exit(1)
}
// Generated code is written in the kit's long-line style: the first format rewrites it, and the app must still take a feature
run('pnpm', ['format'], app)
run(process.execPath, [cli, 'feature', 'things', '--switch'], app)
for (const args of [['migrations'], ['typecheck'], ['lint'], ['test']]) run('pnpm', args, app)
rmSync(parent, { recursive: true, force: true })
