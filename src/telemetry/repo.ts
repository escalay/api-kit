/** The telemetry row's queries: made once, read, switched, stamped. */
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { telemetryState, type TelemetryRow } from './schema.js'

export const telemetryRepo = (db: Db) => {
  const at = eq(telemetryState.id, 1)
  return {
    /** The row, made on the first call with a new random instance id. */
    state: async (): Promise<TelemetryRow> => {
      await db.insert(telemetryState).values({ id: 1, instance: crypto.randomUUID(), since: new Date().toISOString(), enabled: true }).onConflictDoNothing()
      const [row] = await db.select().from(telemetryState).where(at)
      return row!
    },
    setEnabled: (enabled: boolean) => db.update(telemetryState).set({ enabled }).where(at),
    /** Stamps today's try unless one is stamped already (another replica's): true when this call stamped it. */
    markSent: async (lastSentAt: string) => {
      const today = lastSentAt.slice(0, 10)
      const notToday = or(isNull(telemetryState.lastSentAt), lt(telemetryState.lastSentAt, today))
      return (await db.update(telemetryState).set({ lastSentAt }).where(and(at, notToday)).returning({ id: telemetryState.id })).length > 0
    },
    setLatest: (latest: string) => db.update(telemetryState).set({ latest }).where(at),
  }
}

export type TelemetryRepo = ReturnType<typeof telemetryRepo>
