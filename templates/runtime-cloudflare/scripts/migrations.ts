/**
 * Writes migrations/ for D1 from the kit's tables and every feature's steps, one file per step with its kit_migrations
 * record, so `wrangler d1 migrations apply DB --remote` brings the database up at deploy and `migrate()` finds every
 * step done at runtime. Files are only added; a step that changed after it was written stops the script (a change is a
 * new step at the end of the feature's list). Run `wrangler d1 migrations apply` before the first `wrangler dev`: a step
 * `migrate()` already ran is replayed, and only `create … if not exists` steps replay cleanly. `--check` writes nothing and
 * exits 1 when a file is missing (what `pnpm check` and CI run).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FEATURES } from '../src/features/index.js'
import { GUARD_MIGRATIONS, OAUTH_MIGRATIONS } from '../src/kit/index.js'

const checking = process.argv.includes('--check')
const dir = fileURLToPath(new URL('../migrations', import.meta.url))
const sets: [string, readonly string[]][] = [['oauth', OAUTH_MIGRATIONS], ['guards', GUARD_MIGRATIONS], ...FEATURES.map((feature): [string, readonly string[]] => [feature.name, feature.migrations])]
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const HEADER = /^-- kit: (\S+) step (\d+) sha256 ([0-9a-f]{64})$/m

mkdirSync(dir, { recursive: true })
const files = readdirSync(dir).filter((file) => file.endsWith('.sql')).sort()
const written = new Map(files.flatMap((file) => {
  const match = readFileSync(join(dir, file), 'utf8').match(HEADER)
  return match ? [[`${match[1]} ${match[2]}`, { file, hash: match[3] }] as const] : []
}))
let next = files.length
const missing: string[] = []
const write = (name: string, text: string) => checking ? missing.push(name) : writeFileSync(join(dir, `${String(next++).padStart(4, '0')}_${name}.sql`), text)

if (!files.length) write('kit_migrations', 'create table if not exists kit_migrations (feature text not null, step integer not null, applied_at text not null, primary key (feature, step));\n')
let added = 0
for (const [feature, steps] of sets)
  for (const [index, step] of steps.entries()) {
    const shipped = written.get(`${feature} ${index + 1}`)
    if (shipped) {
      if (shipped.hash !== sha(step)) throw new Error(`${feature} step ${index + 1} changed after ${shipped.file} was written; shipped steps never change, add a new step instead`)
      continue
    }
    // `or ignore`: in local dev `migrate()` may have run the step and recorded it first
    const record = `insert or ignore into kit_migrations (feature, step, applied_at) values ('${feature}', ${index + 1}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));`
    write(`${feature}_${index + 1}`, `-- kit: ${feature} step ${index + 1} sha256 ${sha(step)}\n${step.trim().replace(/;?$/, ';')}\n${record}\n`)
    added++
  }
if (checking && missing.length) {
  console.error(`migrations/ is behind by ${missing.length} (${missing.join(', ')}): run pnpm migrations`)
  process.exitCode = 1
} else console.log(added ? `Wrote ${added} migration files to migrations/` : 'migrations/ is current')
