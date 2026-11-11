#!/usr/bin/env node
/** Makes an app with `create-escalay` in the OS temp folder, installs it and runs its own typecheck and tests. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const create = fileURLToPath(new URL('../packages/create-escalay/index.mjs', import.meta.url))
const parent = mkdtempSync(join(tmpdir(), 'starter-'))
const app = join(parent, 'starter-api')
const run = (command, args, cwd) => {
  console.log(`$ ${command} ${args.join(' ')}`)
  const { status } = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (status !== 0) process.exit(status ?? 1)
}
run(process.execPath, [create, 'starter-api', '--preset', 'api', '--yes'], parent)
run('pnpm', ['install'], app)
run('pnpm', ['migrations'], app)
run('pnpm', ['typecheck'], app)
run('pnpm', ['test'], app)
rmSync(parent, { recursive: true, force: true })
