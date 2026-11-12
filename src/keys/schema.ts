/** The API keys an app makes through its own API. Only a key's hash is kept: the key itself is shown once, when made. */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  /** Who or what holds it; also the caller's name wherever a key is counted (rate limits, logs). */
  name: text('name').notNull().unique(),
  hash: text('hash').notNull().unique(),
  /** The key's first characters, so a person can tell which key is which. */
  start: text('start').notNull(),
  createdAt: text('created_at').notNull(),
  /** The caller that made it: a key's name or a person's email. */
  createdBy: text('created_by').notNull(),
  /** When it was last used, to the hour. */
  lastUsedAt: text('last_used_at'),
})

export const KEYS_MIGRATIONS = [
  'create table if not exists api_keys (id text primary key, name text not null unique, hash text not null unique, start text not null, created_at text not null, created_by text not null, last_used_at text)',
] as const

export type KeyRow = typeof apiKeys.$inferSelect
