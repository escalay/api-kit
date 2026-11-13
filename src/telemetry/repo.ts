/** The telemetry row's queries: made once, read, switched, stamped. */
import { eq } from 'drizzle-orm'
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
    markSent: (lastSentAt: string) => db.update(telemetryState).set({ lastSentAt }).where(at),
    setLatest: (latest: string) => db.update(telemetryState).set({ latest }).where(at),
  }
}

export type TelemetryRepo = ReturnType<typeof telemetryRepo>
