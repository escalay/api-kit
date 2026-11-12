#!/usr/bin/env node
/**
 * Makes one app per preset with `create-escalay` in the OS temp folder, installs it and runs its own checks: typecheck,
 * lint and tests for both. For the `app` preset also the build (its files must land under /app/assets/, the one prefix
 * the Worker leaves to files), a dry-run deploy, and that a formatted app still takes a new feature and passes.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  for (const args of [['install'], ['migrations'], ['typecheck'], ['lint'], ['test'], ...more]) run('pnpm', args, app)
  return app
}
check('starter-api', 'api')
const app = check('starter-app', 'app', [['build'], ['exec', 'oxfmt', '--check', 'web', 'vite.config.ts', 'tsconfig.web.json', 'index.html'], ['exec', 'wrangler', 'deploy', '--dry-run']])
const built = [...readFileSync(join(app, 'dist/client/index.html'), 'utf8').matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(([, path]) => path)
const stray = built.filter((path) => !path.startsWith('/app/assets/') || !existsSync(join(app, 'dist/client', path)))
if (!built.length || stray.length) {
  console.error(`the built page must load its files from /app/assets/: ${JSON.stringify(built.length ? stray : 'no files')}`)
  process.exit(1)
}
// Generated code is written in the kit's long-line style: the first format rewrites it, and the app must still take a feature
run('pnpm', ['format'], app)
run(process.execPath, [cli, 'feature', 'things'], app)
for (const args of [['migrations'], ['typecheck'], ['lint'], ['test']]) run('pnpm', args, app)
rmSync(parent, { recursive: true, force: true })
