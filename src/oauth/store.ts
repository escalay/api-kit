/** Where the OAuth server keeps what it issued: in memory for tests, or in the app's database. */
import { and, desc, eq, gt, lte, notInArray, sql } from 'drizzle-orm'
import type { KeyValueStore } from '../core/kv.js'
import { migrate, type Db } from '../db/index.js'
import { OAUTH_MIGRATIONS, oauthKeys } from './schema.js'

const now = () => Math.floor(Date.now() / 1000)

/**
 * Where the server keeps what it issued. Values are small JSON objects; `expiresAt` is epoch seconds. `take` and
 * `markUsed` are what make a code or a refresh token single use under concurrent requests: without them the server
 * falls back to a read then a write, which is safe only one request at a time (tests). Never Workers KV: it is
 * eventually consistent, so a fresh code can read as unknown and a revoke can be undone.
 */
export type OAuthStore = KeyValueStore & {
  /** Deletes a live row and returns its value, to exactly one caller: a single-use ticket. */
  take?: (kind: string, id: string) => Promise<Record<string, unknown> | null>
  /**
   * Marks a live, unused row used (`used: true`, `usedAt` in epoch seconds) and returns the marked value, to exactly
   * one caller. A row with no `used` key counts as unused. `keepUntil` keeps it at least that long (epoch seconds).
   */
  markUsed?: (kind: string, id: string, keepUntil?: number) => Promise<Record<string, unknown> | null>
  /**
   * Keeps the `keep` newest unused rows of a kind (`used: false`, newest by expiry, then by write) and deletes the rest:
   * what caps unused registrations and open consent tickets. A row with no `used` key (from before) is never trimmed. A
   * store without it is not capped.
   */
  trim?: (kind: string, keep: number) => Promise<void>
}

/** A store in memory, for tests and single-process scripts. */
export const memoryOAuthStore = (): OAuthStore => {
  const rows = new Map<string, { value: Record<string, unknown>; expiresAt: number }>()
  const live = (kind: string, id: string) => {
    const row = rows.get(`${kind}:${id}`)
    return row && row.expiresAt > now() ? row : null
  }
  // No await between a read and its write: each method is atomic in one process
  return {
    get: async (kind, id) => live(kind, id)?.value ?? null,
    put: async (kind, id, value, expiresAt) => void rows.set(`${kind}:${id}`, { value, expiresAt }),
    delete: async (kind, id) => void rows.delete(`${kind}:${id}`),
    take: async (kind, id) => {
      const row = live(kind, id)
      rows.delete(`${kind}:${id}`)
      return row?.value ?? null
    },
    markUsed: async (kind, id, keepUntil = 0) => {
      const row = live(kind, id)
      if (!row || row.value.used) return null
      const value = { ...row.value, used: true, usedAt: now() }
      rows.set(`${kind}:${id}`, { value, expiresAt: Math.max(row.expiresAt, keepUntil) })
      return value
    },
    trim: async (kind, keep) => {
      // The map keeps write order: among rows that expire together, the later one is the newer
      const unused = [...rows].map(([key, row], order) => ({ key, row, order })).filter(({ key, row }) => key.startsWith(`${kind}:`) && row.value.used === false)
      unused.sort((a, b) => b.row.expiresAt - a.row.expiresAt || b.order - a.order)
      for (const { key } of unused.slice(keep)) rows.delete(key)
    },
  }
}

/**
 * A store in the app's database (`openDb`), so issued tokens survive a restart and ride along in the app's backup.
 * Migrates its `oauth` table and drops expired rows when made, then on a write at most once a minute. `take`,
 * `markUsed` and `trim` are one statement each, on node:sqlite and D1 alike.
 *
 * @example
 * const store = await dbOAuthStore(await openDb(`file:${join(env.STATE_DIR, 'state.sqlite')}`))
 */
export const dbOAuthStore = async (db: Db): Promise<OAuthStore> => {
  await migrate(db, 'oauth', OAUTH_MIGRATIONS)
  await db.delete(oauthKeys).where(lte(oauthKeys.expiresAt, now()))
  // Set before each delete runs, so writes arriving together prune once
  let prunedAt = now()
  const prune = async () => {
    if (now() - prunedAt < 60) return
    prunedAt = now()
    await db.delete(oauthKeys).where(lte(oauthKeys.expiresAt, prunedAt))
  }
  const at = (kind: string, id: string) => and(eq(oauthKeys.kind, kind), eq(oauthKeys.id, id))
  const liveAt = (kind: string, id: string) => and(at(kind, id), gt(oauthKeys.expiresAt, now()))
  return {
    get: async (kind, id) => {
      const [row] = await db.select({ value: oauthKeys.value }).from(oauthKeys).where(liveAt(kind, id))
      return row ? JSON.parse(row.value) : null
    },
    put: async (kind, id, value, expiresAt) => {
      await prune()
      await db.insert(oauthKeys).values({ kind, id, value: JSON.stringify(value), expiresAt }).onConflictDoUpdate({ target: [oauthKeys.kind, oauthKeys.id], set: { value: JSON.stringify(value), expiresAt } })
    },
    delete: async (kind, id) => void (await db.delete(oauthKeys).where(at(kind, id))),
    take: async (kind, id) => {
      const [row] = await db.delete(oauthKeys).where(liveAt(kind, id)).returning({ value: oauthKeys.value })
      return row ? JSON.parse(row.value) : null
    },
    markUsed: async (kind, id, keepUntil = 0) => {
      const [row] = await db.update(oauthKeys)
        .set({ value: sql`json_set(${oauthKeys.value}, '$.used', json('true'), '$.usedAt', ${now()})`, expiresAt: sql`max(${oauthKeys.expiresAt}, ${keepUntil})` })
        // A row written before `used` existed has no such key: unused, not a replay
        .where(and(liveAt(kind, id), sql`coalesce(json_extract(${oauthKeys.value}, '$.used'), 0) = 0`))
        .returning({ value: oauthKeys.value })
      return row ? JSON.parse(row.value) : null
    },
    trim: async (kind, keep) => {
      // Strictly false: a row with no `used` key is from before, and NULL = 0 is never true
      const unused = and(eq(oauthKeys.kind, kind), sql`json_extract(${oauthKeys.value}, '$.used') = 0`)
      const kept = db.select({ id: oauthKeys.id }).from(oauthKeys).where(unused).orderBy(desc(oauthKeys.expiresAt), sql`rowid desc`).limit(keep)
      await db.delete(oauthKeys).where(and(unused, notInArray(oauthKeys.id, kept)))
    },
  }
}
