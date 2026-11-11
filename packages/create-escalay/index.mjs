#!/usr/bin/env node
/** `npm create escalay <name>` runs the kit's `init <name>` with the same arguments. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const cli = createRequire(import.meta.url).resolve('@escalay/kit/cli.mjs')
const { status } = spawnSync(process.execPath, [cli, 'init', ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(status ?? 1)
