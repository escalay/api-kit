/** API keys in the database: the only place they are queried. */
import { asc, eq } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { apiKeys, type KeyRow } from './schema.js'

const HOUR = 60 * 60 * 1000

export const keysRepo = (db: Db) => ({
  list: () => db.select().from(apiKeys).orderBy(asc(apiKeys.createdAt), asc(apiKeys.id)),
  get: async (id: string) => (await db.select().from(apiKeys).where(eq(apiKeys.id, id)))[0],
  named: async (name: string) => (await db.select().from(apiKeys).where(eq(apiKeys.name, name)))[0],
  create: (row: KeyRow) => db.insert(apiKeys).values(row),
  remove: (id: string) => db.delete(apiKeys).where(eq(apiKeys.id, id)),
  /** nameOf returns the name of the key with this hash, or undefined; it notes the use at most once an hour. */
  nameOf: async (hash: string) => {
    const row = (await db.select().from(apiKeys).where(eq(apiKeys.hash, hash)))[0]
    if (!row) return undefined
    const now = new Date()
    if (!row.lastUsedAt || now.getTime() - Date.parse(row.lastUsedAt) >= HOUR) await db.update(apiKeys).set({ lastUsedAt: now.toISOString() }).where(eq(apiKeys.id, row.id))
    return row.name
  },
})

export type KeysRepo = ReturnType<typeof keysRepo>
