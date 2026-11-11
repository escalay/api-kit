/**
 * The guards' state (`core/guards.ts`) in the app's database, so every instance shares it: on Workers each isolate has
 * its own memory, and a rate limit or an idempotency key kept there holds for that isolate alone. Each method is one
 * atomic statement (an upsert with `returning`, or an insert that does nothing on conflict), on node:sqlite and D1
 * alike.
 *
 * @example
 * const guards = await dbGuardStore(db)
 * const app = createAgentApi({ …, guards: { store: guards } })
 */
import { and, eq, lte, sql } from 'drizzle-orm'
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import type { GuardStore, StoredAnswer } from '../core/guards.js'
import { migrate, type Db } from './index.js'

/** One row per rate window (`rate`) or idempotency key (`key`); `value` is empty while a key's request runs. */
export const kitGuards = sqliteTable('kit_guards', {
  kind: text('kind').notNull(),
  id: text('id').notNull(),
  start: integer('start').notNull(),
  used: integer('used').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, (table) => [primaryKey({ columns: [table.kind, table.id] })])

export const GUARD_MIGRATIONS = ['create table if not exists kit_guards (kind text not null, id text not null, start integer not null, used integer not null, value text not null, expires_at integer not null, primary key (kind, id))'] as const

/** Makes the guards' table if needed and drops expired rows (epoch ms throughout). */
export const dbGuardStore = async (db: Db): Promise<GuardStore> => {
  await migrate(db, 'guards', GUARD_MIGRATIONS)
  await db.delete(kitGuards).where(lte(kitGuards.expiresAt, Date.now()))
  const key = (id: string) => and(eq(kitGuards.kind, 'key'), eq(kitGuards.id, id))
  return {
    count: async (id, windowMs, now) => {
      // SQLite evaluates every `set` against the row as it was, so `start` and `used` restart together
      const stale = sql`${kitGuards.start} <= ${now - windowMs}`
      const [window] = await db.insert(kitGuards).values({ kind: 'rate', id, start: now, used: 1, value: '', expiresAt: now + windowMs })
        .onConflictDoUpdate({
          target: [kitGuards.kind, kitGuards.id],
          set: {
            used: sql`case when ${stale} then 1 else ${kitGuards.used} + 1 end`,
            start: sql`case when ${stale} then ${now} else ${kitGuards.start} end`,
            expiresAt: sql`case when ${stale} then ${now + windowMs} else ${kitGuards.expiresAt} end`,
          },
        })
        .returning({ start: kitGuards.start, used: kitGuards.used })
      return window!
    },
    claim: async (id, lockMs, now) => {
      // An expired answer, or a lock whose request died, no longer holds the key
      await db.delete(kitGuards).where(and(key(id), lte(kitGuards.expiresAt, now)))
      const taken = await db.insert(kitGuards).values({ kind: 'key', id, start: now, used: 0, value: '', expiresAt: now + lockMs }).onConflictDoNothing().returning({ id: kitGuards.id })
      if (taken.length) return null
      const [row] = await db.select({ value: kitGuards.value }).from(kitGuards).where(key(id))
      if (!row) return null
      return row.value ? (JSON.parse(row.value) as StoredAnswer) : 'running'
    },
    save: async (id, answer, expiresAt) => void (await db.update(kitGuards).set({ value: JSON.stringify(answer), expiresAt }).where(key(id))),
    release: async (id) => void (await db.delete(kitGuards).where(and(key(id), eq(kitGuards.value, '')))),
  }
}
