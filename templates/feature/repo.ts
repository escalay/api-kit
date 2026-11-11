/** __Pascal__ in the database: the only place they are queried, and nothing about HTTP. */
import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import { __camel__ } from './schema.js'

export const __camel__Repo = (db: Db) => {
  const now = () => new Date().toISOString()
  return {
    /** The newest changed first. */
    list: (limit: number) => db.select().from(__camel__).orderBy(desc(__camel__.updatedAt)).limit(limit),
    get: async (id: string) => (await db.select().from(__camel__).where(eq(__camel__.id, id)))[0],
    create: async ({ title, body }: { title: string; body?: string | null }) => {
      const id = randomUUID()
      const at = now()
      await db.insert(__camel__).values({ id, title, body: body ?? null, createdAt: at, updatedAt: at })
      return id
    },
    update: (id: string, change: { title?: string; body?: string | null }) => db.update(__camel__).set({ ...change, updatedAt: now() }).where(eq(__camel__.id, id)),
    remove: (id: string) => db.delete(__camel__).where(eq(__camel__.id, id)),
  }
}

export type __Pascal__Repo = ReturnType<typeof __camel__Repo>
