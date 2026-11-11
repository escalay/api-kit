/**
 * The app's database, through Drizzle: one handle every feature's repo queries, opened from where the data lives, so
 * the same queries run on a local SQLite file today and on Turso or D1 later. Only repos (`<feature>/repo.ts`) touch
 * it; handlers never do.
 *   'file:./state.sqlite', a plain path, ':memory:', or an open `DatabaseSync`  → node:sqlite (built in, no native
 *                                                                                 module), through Drizzle's proxy driver
 *   any async Drizzle SQLite database                                           → used as it is: Turso / libSQL
 *                                                                                 `drizzle(createClient({ url, authToken }))`
 *                                                                                 (`drizzle-orm/libsql`), D1 `drizzle(env.DB)`
 * The module imports on Workers: node:sqlite loads only when a path asks for it. Raw `db.all(sql…)` rows are arrays
 * on node:sqlite and objects on D1, so repos read rows through the query builder or name their columns.
 * Each feature brings its tables and its migrations: `migrate(db, 'boards', BOARDS_MIGRATIONS)` applies the steps it
 * hasn't yet, in order, and records them in `kit_migrations`. A step never changes once shipped; a change is a new step.
 *
 * @example
 * const db = await openDb(`file:${join(env.STATE_DIR, 'state.sqlite')}`)
 * registerBoards(app, { db, … })                  // migrates its own tables
 * const rows = await db.select().from(notes).where(eq(notes.owner, id))
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { is, sql } from 'drizzle-orm'
import { DrizzleD1Database } from 'drizzle-orm/d1'
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import { drizzle } from 'drizzle-orm/sqlite-proxy'

/** Any async Drizzle SQLite database: node:sqlite through the proxy, libSQL, D1. */
export type Db = BaseSQLiteDatabase<'async', unknown>

/** Where the data lives: a URL or path, an open node:sqlite database, or a Drizzle database already made. */
export type DbSource = string | DatabaseSync | Db

// node:sqlite is loaded only when a source needs it, so the module imports on Workers (where it is a stub)
const isDb = (source: DbSource): source is Db => typeof source === 'object' && 'select' in source
const isDatabaseSync = (source: DbSource): source is DatabaseSync => typeof source === 'object' && 'prepare' in source && 'exec' in source

/** What migrate needs of a D1 binding (typed here so the module needs no Workers types). */
type D1Statement = { bind: (...values: unknown[]) => D1Statement }
type D1Client = { prepare: (query: string) => D1Statement; batch: (statements: D1Statement[]) => Promise<unknown> }

/** Drizzle over node:sqlite: rows come back as arrays, so columns with the same name in a join stay apart. */
export const nodeSqlite = (sqlite: DatabaseSync): Db => {
  sqlite.exec('pragma foreign_keys = on')
  return drizzle(async (query, params, method) => {
    const statement = sqlite.prepare(query)
    const values = params as SQLInputValue[]
    if (method === 'run') {
      statement.run(...values)
      return { rows: [] }
    }
    statement.setReturnArrays(true)
    return method === 'get' ? { rows: statement.get(...values) as unknown as unknown[] } : { rows: statement.all(...values) as unknown as unknown[] }
  }) as unknown as Db
}

/** Opens the database a source names (see the module comment). */
export const openDb = async (source: DbSource): Promise<Db> => {
  if (isDb(source)) return source
  if (isDatabaseSync(source)) return nodeSqlite(source)
  if (/^[a-z]+:\/\//.test(source)) throw new Error(`openDb: ${source.split('//')[0]}// is not a file; open it with its Drizzle driver and pass the database in (Turso: drizzle-orm/libsql, D1: drizzle(env.DB) from drizzle-orm/d1)`)
  const { DatabaseSync } = await import('node:sqlite')
  return nodeSqlite(new DatabaseSync(source === ':memory:' ? source : source.replace(/^file:/, '')))
}

/**
 * A database for tests: empty and in memory on Node; inside workerd (the Workers test project) the `DB` D1 binding,
 * whose storage is kept apart per test file, not per test, so tests there use their own ids.
 */
export const testDb = async () => {
  if (globalThis.navigator?.userAgent !== 'Cloudflare-Workers') return openDb(':memory:')
  const runtime = 'cloudflare:workers'
  const { env } = (await import(runtime)) as { env: { DB?: unknown } }
  if (!env.DB) throw new Error('testDb: the Workers test project has no D1 binding named DB; add one to its wrangler config')
  const { drizzle } = await import('drizzle-orm/d1')
  return openDb(drizzle(env.DB as never) as unknown as Db)
}

/** A step's statements: split on every `;` outside quotes (a prepared statement runs only the first of several). */
const statementsOf = (step: string) => {
  const statements: string[] = []
  let current = ''
  let quote: string | null = null
  for (const char of step) {
    if (quote) quote = char === quote ? null : quote
    else if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === ';') {
      statements.push(current)
      current = ''
      continue
    }
    current += char
  }
  return [...statements, current].map((statement) => statement.trim()).filter(Boolean)
}

/**
 * Applies a feature's migration steps it hasn't applied yet, in order, each in a transaction with its record in
 * `kit_migrations (feature, step)`. Steps are SQL; one step may hold several statements separated by `;` (not
 * triggers: their bodies hold `;`, so give each its own step and no other statement). On D1, which refuses `begin`,
 * a step and its record go as one batch: D1 runs a batch as a single transaction.
 */
export const migrate = async (db: Db, feature: string, steps: readonly string[]) => {
  await db.run(sql`create table if not exists kit_migrations (feature text not null, step integer not null, applied_at text not null, primary key (feature, step))`)
  const done = await db.all<{ step: number }>(sql`select step from kit_migrations where feature = ${feature}`)
  const applied = new Set(done.map((row) => Number(Array.isArray(row) ? row[0] : row.step)))
  for (const [index, step] of steps.entries()) {
    if (applied.has(index + 1)) continue
    const appliedAt = new Date().toISOString()
    if (is(db, DrizzleD1Database)) {
      const d1 = (db as unknown as { $client: D1Client }).$client
      const record = d1.prepare('insert into kit_migrations (feature, step, applied_at) values (?, ?, ?)').bind(feature, index + 1, appliedAt)
      await d1.batch([...statementsOf(step).map((statement) => d1.prepare(statement)), record])
      continue
    }
    await db.transaction(async (tx) => {
      for (const statement of statementsOf(step)) await tx.run(sql.raw(statement))
      await tx.run(sql`insert into kit_migrations (feature, step, applied_at) values (${feature}, ${index + 1}, ${appliedAt})`)
    })
  }
}

// An app's generated kit index re-exports each module's own index.ts, so the module's other parts go out from here
export { dbGuardStore, kitGuards, GUARD_MIGRATIONS } from './guards.js'
