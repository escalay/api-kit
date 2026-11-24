/** The __labels__ table, and the SQL that makes it: one migration step per change, never edited once it has run. */
import { __column_imports__ } from 'drizzle-orm/sqlite-core'

export const __camel__ = sqliteTable('__table__', {
  id: text('id').primaryKey(),
__columns__
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const __CONST___MIGRATIONS = ['create table if not exists __table__ (id text primary key, __sql_columns__, created_at text not null, updated_at text not null)'] as const

export type __Singular__Row = typeof __camel__.$inferSelect
/** What a new __label__ is made of; the kit fills its id and times. */
export type __Singular__Input = Omit<typeof __camel__.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>
