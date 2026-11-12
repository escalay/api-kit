/** Whether the deployment is claimed, by whom, and the hash of the setup code that last opened it. */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const setupState = sqliteTable('setup_state', {
  /** Always 1: one row. */
  id: integer('id').primaryKey(),
  claimedAt: text('claimed_at').notNull(),
  ownerId: text('owner_id').notNull(),
  /** The SHA-256 of the code used last. A different code in the environment means it was rotated: recovery is open. */
  codeHash: text('code_hash').notNull(),
  recoveredAt: text('recovered_at'),
})

export const SETUP_MIGRATIONS = [
  'create table if not exists setup_state (id integer primary key, claimed_at text not null, owner_id text not null, code_hash text not null, recovered_at text)',
] as const

export type SetupStateRow = typeof setupState.$inferSelect
