/** The boards tables, and the SQL that makes them (one migration step per change, never edited once shipped). */
import { index, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const boardItems = sqliteTable(
  'board_items',
  {
    boardId: text('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    note: text('note'),
    addedAt: text('added_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.boardId, table.ref] }), index('board_items_ref').on(table.ref)],
)

/** The tables as SQL, one step per change, never edited once shipped. Step 1 is what every app's state already holds. */
export const BOARDS_MIGRATIONS = [
  `create table if not exists boards (id text primary key, name text not null, description text, created_at text not null, updated_at text not null);
create table if not exists board_items (board_id text not null references boards(id) on delete cascade, ref text not null, note text, added_at text not null, primary key (board_id, ref));
create index if not exists board_items_ref on board_items(ref)`,
] as const
