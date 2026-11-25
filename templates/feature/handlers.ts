/** The __labels__ routes' handlers: request → repo → HAL answer; a missing __label__ is a problem. No queries here. */
import { z, type RouteHandler } from '@hono/zod-openapi'
import { decodeCursor, linksOf, originOf, pageOf, ProblemError } from '../../kit/index.js'
import type { __Pascal__Repo } from './repo.js'
import { PATH, type routes } from './routes.js'
import type { __Singular__Row } from './schema.js'

type Routes = typeof routes

const PositionSchema = z.object({ createdAt: z.string(), id: z.string() })

export const __camel__Handlers = (repo: __Pascal__Repo) => {
  const rowOf = async (id: string) => {
    const row = await repo.get(id)
    if (!row) throw new ProblemError('not_found', { detail: `No __label__ ${id}. GET ${PATH} lists them.` })
    return row
  }
  const cardOf = (origin: string, row: __Singular__Row) => ({ ...row, _links: linksOf(origin, { self: `${PATH}/${row.id}`, list: PATH }) })

  const list: RouteHandler<Routes['list']> = async (c) => {
    const query = c.req.valid('query')
    const rows = await repo.list({ after: decodeCursor(query.cursor, PositionSchema), limit: query.limit })
    const last = rows[query.limit - 1]
    const origin = originOf(c)
    const next = rows.length > query.limit && last ? { createdAt: last.createdAt, id: last.id } : null
    return c.json(pageOf({ origin, path: PATH, query, name: '__camel__', items: rows.slice(0, query.limit).map((row) => cardOf(origin, row)), next }), 200)
  }
  const get: RouteHandler<Routes['get']> = async (c) => c.json(cardOf(originOf(c), await rowOf(c.req.valid('param').id)), 200)
  const create: RouteHandler<Routes['create']> = async (c) => {
    const id = await repo.create(c.req.valid('json'))
    return c.json(cardOf(originOf(c), await rowOf(id)), 201, { location: `${PATH}/${id}` })
  }
  const update: RouteHandler<Routes['update']> = async (c) => {
    const { id } = c.req.valid('param')
    await rowOf(id)
    await repo.update(id, c.req.valid('json'))
    return c.json(cardOf(originOf(c), await rowOf(id)), 200)
  }
  const remove: RouteHandler<Routes['remove']> = async (c) => { // feature:remove
    const { id } = c.req.valid('param') // feature:remove
    await rowOf(id) // feature:remove
    await repo.remove(id) // feature:remove
    return c.body(null, 204) // feature:remove
  } // feature:remove
  return { list, get, create, update, remove } // feature:remove
  return { list, get, create, update } // feature:no-remove
}
