/** The stored switches' queries, and the provider that reads them. */
import { and, eq, inArray } from 'drizzle-orm'
import { migrate, type Db } from '../db/index.js'
import type { FlagAnswer, FlagProvider } from './providers.js'
import { featureSwitches, SWITCH_MIGRATIONS, type FeatureSwitchRow } from './schema.js'

export const switchesRepo = (db: Db) => ({
  all: (): Promise<FeatureSwitchRow[]> => db.select().from(featureSwitches),
  put: (row: FeatureSwitchRow) =>
    db
      .insert(featureSwitches)
      .values(row)
      .onConflictDoUpdate({ target: [featureSwitches.key, featureSwitches.scope], set: { on: row.on, changedBy: row.changedBy, changedAt: row.changedAt } }),
  /** Removes a scope's switch under every name the feature had. */
  remove: (keys: string[], scope: string) => db.delete(featureSwitches).where(and(inArray(featureSwitches.key, keys), eq(featureSwitches.scope, scope))),
})

export type SwitchesRepo = ReturnType<typeof switchesRepo>

/**
 * databaseProvider reads and writes switches in the app's own database: per feature, one for everyone and any number
 * for one person or one API key, the caller's own winning over everyone's. The table is small, so all of it is read at
 * once and kept for `cacheMs` per isolate (rows, never answers, so one caller's switch never reaches another).
 *
 * @example
 * switches({ catalog: CATALOG, providers: [databaseProvider(db)] })
 */
export const databaseProvider = (db: Db, { cacheMs = 5000 }: { cacheMs?: number } = {}): FlagProvider => {
  const repo = switchesRepo(db)
  let kept: { at: number; rows: FeatureSwitchRow[] } | undefined
  let migrated: Promise<void> | undefined
  const ready = () => (migrated ??= migrate(db, 'switches', SWITCH_MIGRATIONS))
  const rows = async (fresh = false) => {
    await ready()
    if (fresh || !kept || Date.now() - kept.at >= cacheMs) kept = { at: Date.now(), rows: await repo.all() }
    return kept.rows
  }
  const namesOf = (key: string, oldNames: Readonly<Record<string, readonly string[]>> = {}) => [key, ...(oldNames[key] ?? [])]

  return {
    name: 'database',
    resolve: async (keys, context, { fresh, oldNames } = {}) => {
      const stored = await rows(fresh)
      const answerFor = (key: string): FlagAnswer | undefined => {
        const names = namesOf(key, oldNames)
        const find = (scope: string) => names.map((name) => stored.find((row) => row.key === name && row.scope === scope)).find(Boolean)
        const own = context.targetingKey ? find(context.targetingKey) : undefined
        const row = own ?? find('everyone')
        return row && { value: row.on, reason: own ? 'TARGETING_MATCH' : 'STATIC', scope: row.scope, by: row.changedBy, at: row.changedAt }
      }
      return Object.fromEntries(keys.map((key) => [key, answerFor(key)]))
    },
    write: async ({ key, scope, on, by }, { oldNames } = {}) => {
      await ready()
      await repo.remove(namesOf(key, oldNames), scope)
      if (on !== null) await repo.put({ key, scope, on, changedBy: by, changedAt: new Date().toISOString() })
      kept = undefined
    },
    overrides: async ({ oldNames = {} } = {}) => {
      const currentKeyOf = (name: string) => Object.entries(oldNames).find(([, old]) => old.includes(name))?.[0] ?? name
      return (await rows(true)).map((row) => ({ key: currentKeyOf(row.key), scope: row.scope, on: row.on, changedBy: row.changedBy, changedAt: row.changedAt }))
    },
  }
}
