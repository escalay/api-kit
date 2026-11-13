#!/usr/bin/env node
/**
 * The `__bin__` command: every MCP tool of __Title__ as `__bin__ <noun> <verb>`, plus the jobs in `jobs/`. The engine
 * in `engine/` is the kit's; this file, `jobs/` and `commands.json` (written by `pnpm sdk:types`) are the app's.
 *
 * @example
 * npx __package__ auth login https://api.example.com
 * npx __package__ help
 */
import { readFileSync } from 'node:fs'
import snapshot from './commands.json' with { type: 'json' }
import { createCli } from './engine/index.js'
import { jobs } from './jobs/index.js'

// The package's own version, read where it is installed (dist/cli/bin.js → package.json)
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
const cli = createCli({ name: '__bin__', envPrefix: '__PREFIX__', version, snapshot, jobs })
process.exitCode = await cli.run(process.argv.slice(2))
