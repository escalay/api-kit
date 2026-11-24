/** The OAuth server's table (a key-value store with expiry), and the SQL that makes it. */
import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const oauthKeys = sqliteTable('oauth', { kind: text('kind').notNull(), id: text('id').notNull(), value: text('value').notNull(), expiresAt: integer('expires_at').notNull() }, (table) => [primaryKey({ columns: [table.kind, table.id] }), index('oauth_expires_at').on(table.expiresAt)])

/** The table as SQL, one step per change; step 1 is what every app's state already holds, step 2 indexes expiry for pruning. */
export const OAUTH_MIGRATIONS = [
  'create table if not exists oauth (kind text not null, id text not null, value text not null, expires_at integer not null, primary key (kind, id))',
  'create index if not exists oauth_expires_at on oauth (expires_at)',
] as const
