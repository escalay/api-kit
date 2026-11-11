/**
 * Cursor paging for lists of any size: a page is HAL with its items under `_embedded.<name>`, `count` on the page,
 * `total` only when it is cheap, and `_links.next` until there is no more. The cursor is opaque (base64url JSON the
 * route chooses, usually the last row's sort key), so rows inserted mid-read never shift a page.
 *
 * @example
 * const after = decodeCursor(query.cursor, z.object({ id: z.string() }))
 * const rows = db.prepare('select … where id > ? order by id limit ?').all(after?.id ?? '', limit + 1)
 * return c.json(pageOf({ origin, path: c.req.path, query, name: 'recipes', items: rows.slice(0, limit).map(card),
 *   next: rows.length > limit ? { id: rows[limit - 1].id } : null }))
 */
import { z } from '@hono/zod-openapi'
import { linksOf, LinksSchema, pathWith } from '../core/hal.js'
import { ProblemError } from '../core/problem.js'

export const limitQuery = ({ fallback = 20, max = 200 } = {}) =>
  z.coerce.number().int().min(1).max(max).default(fallback).openapi({ description: `How many items per page (1–${max}, default ${fallback}).`, example: fallback })

export const cursorQuery = z.string().max(2048).optional().openapi({ description: 'Where to continue: copy it from `_links.next`, never build it yourself.' })

export const encodeCursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

export const decodeCursor = <T>(cursor: string | undefined, schema: z.ZodType<T>): T | undefined => {
  if (!cursor) return undefined
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  } catch {
    throw new ProblemError('bad_request', { detail: 'The cursor is not one this API issued (or it belongs to another list). Start again without `cursor`.', errors: [{ in: 'query', path: 'cursor', message: 'invalid cursor' }] })
  }
}

type Query = Record<string, string | number | boolean | string[] | null | undefined>

/**
 * `sortBy` (one of the documented fields) and `order` (`asc` or `desc`; omitted, each field's natural order), for a
 * list's query schema.
 *
 * @example
 * query: z.object({ ...sortQuery(['saves', 'name'], 'saves'), ...pageQuery() })
 */
export const sortQuery = <Field extends string>(fields: [Field, ...Field[]], fallback: Field) => ({
  sortBy: z.enum(fields).default(fallback as never).openapi({ description: `Order by: ${fields.join(', ')}.` }),
  order: z.enum(['asc', 'desc']).optional().openapi({ description: 'Ascending or descending; omitted, each field’s natural order (counts high to low, names A to Z).' }),
})

export const pageOf = <Item>({ origin, path, query, name, items, next, total }: { origin: string; path: string; query: Query; name: string; items: Item[]; next: unknown; total?: number }) => ({
  count: items.length,
  ...(total === undefined ? {} : { total }),
  _links: linksOf(origin, {
    self: pathWith(path, query),
    next: next === null || next === undefined ? null : pathWith(path, { ...query, cursor: encodeCursor(next) }),
  }),
  _embedded: { [name]: items },
})

/** The OpenAPI schema of a page whose items live under `_embedded.<name>`. */
export const pageSchema = <Item extends z.ZodTypeAny>(component: string, name: string, item: Item, description: string) =>
  z
    .object({
      count: z.number().int().openapi({ description: 'Items on this page.' }),
      total: z.number().int().optional().openapi({ description: 'Items in the whole list, when it is cheap to count.' }),
      _links: LinksSchema.openapi({ description: '`self`, and `next` while there is more: keep following `next.href` until it is absent.' }),
      _embedded: z.object({ [name]: z.array(item) }),
    })
    .openapi(component, { description })
