/** __Pascal__ in the database: the only place they are queried, and nothing about HTTP. */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, lt, or } from 'drizzle-orm'
import type { Db } from '../../kit/index.js'
import { __camel__, type __Singular__Input } from './schema.js'

/** Where a page ends: the last __label__'s time and id, so two made at once never swap pages. */
export type __Singular__Position = { createdAt: string; id: string }

export const __camel__Repo = (db: Db) => {
  const now = () => new Date().toISOString()
  return {
    /** The newest first, after `after`: `limit` and one more, which says there is a next page. */
    list: ({ after, limit }: { after?: __Singular__Position; limit: number }) =>
      db
        .select()
        .from(__camel__)
        .where(after ? or(lt(__camel__.createdAt, after.createdAt), and(eq(__camel__.createdAt, after.createdAt), lt(__camel__.id, after.id))) : undefined)
        .orderBy(desc(__camel__.createdAt), desc(__camel__.id))
        .limit(limit + 1),
    get: async (id: string) => (await db.select().from(__camel__).where(eq(__camel__.id, id)))[0],
    create: async (input: __Singular__Input) => {
      const id = randomUUID()
      const at = now()
      await db.insert(__camel__).values({ ...input, id, createdAt: at, updatedAt: at })
      return id
    },
    /** Sets only the fields `change` has: one left out stays as it is. */
    update: (id: string, change: Partial<__Singular__Input>) => db.update(__camel__).set({ ...change, updatedAt: now() }).where(eq(__camel__.id, id)),
    remove: (id: string) => db.delete(__camel__).where(eq(__camel__.id, id)),
  }
}

export type __Pascal__Repo = ReturnType<typeof __camel__Repo>
