/** Boards in the database: the only place they are queried, and nothing about HTTP. */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, exists, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { boardItems, boards } from './schema.js'

export type BoardRow = typeof boards.$inferSelect & { items: number }

export const boardsRepo = (db: Db) => {
  const columns = { id: boards.id, name: boards.name, description: boards.description, createdAt: boards.createdAt, updatedAt: boards.updatedAt, items: sql<number>`(select count(*) from ${boardItems} where ${boardItems.boardId} = ${boards.id})`.mapWith(Number) }
  const now = () => new Date().toISOString()
  const touch = (id: string) => db.update(boards).set({ updatedAt: now() }).where(eq(boards.id, id))
  return {
    /** Every board, newest change first; with a ref, only those holding it. */
    list: (holding?: string): Promise<BoardRow[]> =>
      db
        .select(columns)
        .from(boards)
        .where(holding ? exists(db.select({ one: sql`1` }).from(boardItems).where(and(eq(boardItems.boardId, boards.id), eq(boardItems.ref, holding)))) : undefined)
        .orderBy(desc(boards.updatedAt)),
    get: async (id: string): Promise<BoardRow | undefined> => (await db.select(columns).from(boards).where(eq(boards.id, id)))[0],
    create: async ({ name, description }: { name: string; description: string | null }) => {
      const id = randomUUID()
      const at = now()
      await db.insert(boards).values({ id, name, description, createdAt: at, updatedAt: at })
      return id
    },
    update: (id: string, change: { name: string; description: string | null }) => db.update(boards).set({ ...change, updatedAt: now() }).where(eq(boards.id, id)),
    remove: async (id: string) => {
      await db.delete(boardItems).where(eq(boardItems.boardId, id))
      await db.delete(boards).where(eq(boards.id, id))
    },
    items: (id: string) => db.select({ ref: boardItems.ref, note: boardItems.note, addedAt: boardItems.addedAt }).from(boardItems).where(eq(boardItems.boardId, id)).orderBy(desc(boardItems.addedAt)),
    refs: async (id: string) => (await db.select({ ref: boardItems.ref }).from(boardItems).where(eq(boardItems.boardId, id))).map((row) => row.ref),
    /** Puts an item on a board, or changes its note; 'added' or 'noted'. */
    save: async (id: string, ref: string, note: string | null): Promise<'added' | 'noted'> => {
      const existed = (await db.select({ ref: boardItems.ref }).from(boardItems).where(and(eq(boardItems.boardId, id), eq(boardItems.ref, ref)))).length > 0
      if (existed) await db.update(boardItems).set({ note: sql`coalesce(${note}, ${boardItems.note})` }).where(and(eq(boardItems.boardId, id), eq(boardItems.ref, ref)))
      else await db.insert(boardItems).values({ boardId: id, ref, note, addedAt: now() })
      await touch(id)
      return existed ? 'noted' : 'added'
    },
    unsave: async (id: string, ref: string) => {
      await db.delete(boardItems).where(and(eq(boardItems.boardId, id), eq(boardItems.ref, ref)))
      await touch(id)
    },
  }
}

export type BoardsRepo = ReturnType<typeof boardsRepo>
