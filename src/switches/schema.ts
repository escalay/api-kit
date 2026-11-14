/** Stored switches: one row per feature and scope. A feature with no row is at its catalog default. */
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const featureSwitches = sqliteTable(
  'feature_switches',
  {
    /** The feature's key in the catalog (or an old name, until it is switched again). */
    key: text('key').notNull(),
    /** Who it applies to: `everyone`, `person:<email>` or `key:<name>`. The most specific one for a caller decides. */
    scope: text('scope').notNull(),
    on: integer('on', { mode: 'boolean' }).notNull(),
    /** Who switched it: an email or a key's name. */
    changedBy: text('changed_by').notNull(),
    changedAt: text('changed_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.key, table.scope] })],
)

export const SWITCH_MIGRATIONS = ['create table if not exists feature_switches (key text not null, scope text not null, "on" integer not null, changed_by text not null, changed_at text not null, primary key (key, scope))'] as const

export type FeatureSwitchRow = typeof featureSwitches.$inferSelect
