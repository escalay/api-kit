/** The __labels__ table, and the SQL that makes it: one migration step per change, never edited once it has run. */
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const __camel__ = sqliteTable('__table__', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const __CONST___MIGRATIONS = ['create table if not exists __table__ (id text primary key, title text not null, body text, created_at text not null, updated_at text not null)'] as const

export type __Singular__Row = typeof __camel__.$inferSelect
