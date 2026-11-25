#!/usr/bin/env node
/** `npm create escalay@latest <name>` runs the kit's `init <name>` with the same arguments; `--help` says which. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const cli = createRequire(import.meta.url).resolve('@escalay/kit/cli.mjs')
const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) console.log('Usage: npm create escalay@latest <dir> [-- options]\n\nThe options are those of the kit\'s init:\n')
const { status } = spawnSync(process.execPath, [cli, 'init', ...args], { stdio: 'inherit' })
process.exit(status ?? 1)
