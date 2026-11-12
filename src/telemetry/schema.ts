/** The usage report's state: one row, made on the first run. */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const telemetryState = sqliteTable('telemetry', {
  /** Always 1: one row. */
  id: integer('id').primaryKey(),
  /** A random v4 UUID made on the first run: the only thing that ties one day's report to the next. */
  instance: text('instance').notNull(),
  /** When the row was made; nothing is sent in the first 24 hours. */
  since: text('since').notNull(),
  /** The owner's switch (`PATCH /api/telemetry`). */
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  lastSentAt: text('last_sent_at'),
  /** The newest version of the product the collector named in its last answer. */
  latest: text('latest'),
})

export const TELEMETRY_MIGRATIONS = ['create table if not exists telemetry (id integer primary key, instance text not null, since text not null, enabled integer not null default 1, last_sent_at text, latest text)'] as const

export type TelemetryRow = typeof telemetryState.$inferSelect
