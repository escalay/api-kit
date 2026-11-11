/** Where the OAuth server keeps what it issued: in memory for tests, or in the app's database. */
import { and, eq, gt, lte } from 'drizzle-orm'
import { memoryStore, type KeyValueStore } from '../core/kv.js'
import { migrate, type Db } from '../db/index.js'
import { OAUTH_MIGRATIONS, oauthKeys } from './schema.js'

const now = () => Math.floor(Date.now() / 1000)

/** Where the server keeps what it issued. Values are small JSON objects; `expiresAt` is epoch seconds. */
export type OAuthStore = KeyValueStore

/** A store in memory, for tests and single-process scripts. */
export const memoryOAuthStore = memoryStore

/**
 * A store in the app's database (`openDb`), so issued tokens survive a restart and ride along in the app's backup.
 * Migrates its `oauth` table and drops expired rows when made.
 *
 * @example
 * const store = await dbOAuthStore(await openDb(`file:${join(env.STATE_DIR, 'state.sqlite')}`))
 */
export const dbOAuthStore = async (db: Db): Promise<OAuthStore> => {
  await migrate(db, 'oauth', OAUTH_MIGRATIONS)
  await db.delete(oauthKeys).where(lte(oauthKeys.expiresAt, now()))
  const at = (kind: string, id: string) => and(eq(oauthKeys.kind, kind), eq(oauthKeys.id, id))
  return {
    get: async (kind, id) => {
      const [row] = await db.select({ value: oauthKeys.value }).from(oauthKeys).where(and(at(kind, id), gt(oauthKeys.expiresAt, now())))
      return row ? JSON.parse(row.value) : null
    },
    put: async (kind, id, value, expiresAt) => void (await db.insert(oauthKeys).values({ kind, id, value: JSON.stringify(value), expiresAt }).onConflictDoUpdate({ target: [oauthKeys.kind, oauthKeys.id], set: { value: JSON.stringify(value), expiresAt } })),
    delete: async (kind, id) => void (await db.delete(oauthKeys).where(at(kind, id))),
  }
}
