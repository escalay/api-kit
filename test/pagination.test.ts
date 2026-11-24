import { z } from '@hono/zod-openapi'
import { and, asc, desc, eq, gt, lt, or } from 'drizzle-orm'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, migrate, ProblemError, testDb, type Db } from '../src/index.js'

// The pagination README's keyset example, as written
const recipes = sqliteTable('recipes', { id: text('id').primaryKey(), name: text('name').notNull(), createdAt: text('created_at').notNull() })
type Recipe = typeof recipes.$inferSelect

const SORTS = {
  newest: { column: recipes.createdAt, natural: 'desc', valueOf: (row: Recipe) => row.createdAt },
  name: { column: recipes.name, natural: 'asc', valueOf: (row: Recipe) => row.name },
} as const
type SortBy = keyof typeof SORTS

const recipesAfter = (db: Db, { sortBy, order, after, limit }: { sortBy: SortBy; order?: 'asc' | 'desc'; after?: { sortValue: string; id: string }; limit: number }) => {
  const { column, natural } = SORTS[sortBy]
  const [past, by] = (order ?? natural) === 'desc' ? [lt, desc] : [gt, asc]
  return db
    .select()
    .from(recipes)
    .where(after ? or(past(column, after.sortValue), and(eq(column, after.sortValue), past(recipes.id, after.id))) : undefined)
    .orderBy(by(column), by(recipes.id))
    .limit(limit + 1)
}

const pageAt = async (db: Db, query: { sortBy: SortBy; order?: 'asc' | 'desc'; cursor?: string; limit: number }) => {
  const sort = `${query.sortBy}:${query.order ?? ''}`
  const after = decodeCursor(query.cursor, z.object({ sort: z.literal(sort), sortValue: z.string(), id: z.string() }))
  const rows = await recipesAfter(db, { sortBy: query.sortBy, order: query.order, after, limit: query.limit })
  const last = rows[query.limit - 1]
  return { items: rows.slice(0, query.limit), next: rows.length > query.limit && last ? { sort, sortValue: SORTS[query.sortBy].valueOf(last), id: last.id } : null }
}

describe('pagination', () => {
  it('pages a keyset cursor through every row once, under every sort, ties included', async () => {
    const db = await testDb()
    await migrate(db, 'recipes-keyset', ['create table recipes (id text primary key, name text not null, created_at text not null)'])
    // Few names and few times, so most rows tie on the sort value and only the id tells them apart
    const rows = Array.from({ length: 23 }, (_, n) => ({ id: `r${String(n).padStart(2, '0')}`, name: ['soup', 'bread', 'salad'][n % 3]!, createdAt: `2026-11-0${(n % 4) + 1}` }))
    await db.insert(recipes).values(rows)

    for (const sortBy of ['newest', 'name'] as const)
      for (const order of [undefined, 'asc', 'desc'] as const) {
        const direction = (order ?? SORTS[sortBy].natural) === 'desc' ? -1 : 1
        const expected = [...rows].sort((a, b) => direction * (SORTS[sortBy].valueOf(a).localeCompare(SORTS[sortBy].valueOf(b)) || a.id.localeCompare(b.id))).map((row) => row.id)
        const seen: string[] = []
        let cursor: string | undefined
        do {
          const page = await pageAt(db, { sortBy, order, cursor, limit: 4 })
          seen.push(...page.items.map((row) => row.id))
          cursor = page.next ? encodeCursor(page.next) : undefined
        } while (cursor)
        expect(seen, `${sortBy} ${order ?? 'natural'}`).toEqual(expected)
      }
  })

  it('refuses a cursor made under another sort (a 400 bad_request)', async () => {
    const db = await testDb()
    const cursor = encodeCursor({ sort: 'name:', sortValue: 'soup', id: 'r01' })
    await expect(pageAt(db, { sortBy: 'newest', cursor, limit: 4 })).rejects.toMatchObject({ code: 'bad_request' } satisfies Partial<ProblemError>)
  })
})
