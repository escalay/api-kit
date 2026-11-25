/** The __labels__ routes' handlers: request → repo → HAL answer; a missing __label__ is a problem. No queries here. */
import { z, type RouteHandler } from '@hono/zod-openapi'
import { decodeCursor, linksOf, originOf, pageOf, ProblemError } from '../../kit/index.js'
import type { __Pascal__Repo } from './repo.js'
import { PATH, type routes } from './routes.js' // feature:flat
import { PATH, pathUnder, type routes } from './routes.js' // feature:under
import type { __Singular__Row } from './schema.js'

type Routes = typeof routes

const PositionSchema = z.object({ createdAt: z.string(), id: z.string() })

export const __camel__Handlers = (repo: __Pascal__Repo) => { // feature:flat
export const __camel__Handlers = (repo: __Pascal__Repo, parents: { get: (id: string) => Promise<unknown> }) => { // feature:under
  const rowOf = async (id: string) => {
    const row = await repo.get(id)
    if (!row) throw new ProblemError('not_found', { detail: `No __label__ ${id}. GET ${PATH} lists them.` })
    return row
  }
  const cardOf = (origin: string, row: __Singular__Row) => ({ ...row, _links: linksOf(origin, { self: `${PATH}/${row.id}`, list: PATH }) }) // feature:flat
  const cardOf = (origin: string, row: __Singular__Row) => ({ ...row, _links: linksOf(origin, { self: `${PATH}/${row.id}`, list: pathUnder(row.__parent_id__), __parent_snake_singular__: `/api/__parent__/${row.__parent_id__}` }) }) // feature:under
  /** A __parent_label__ that isn't there is a 404, as one of its __labels__ would be. */ // feature:under
  const parentOf = async (__parent_param__: string) => { // feature:under
    if (!(await parents.get(__parent_param__))) throw new ProblemError('not_found', { detail: `No __parent_label__ ${__parent_param__}. GET /api/__parent__ lists them.` }) // feature:under
  } // feature:under

  const list: RouteHandler<Routes['list']> = async (c) => {
    const query = c.req.valid('query')
    const { __parent_param__ } = c.req.valid('param') // feature:under
    await parentOf(__parent_param__) // feature:under
    const rows = await repo.list({ after: decodeCursor(query.cursor, PositionSchema), limit: query.limit }) // feature:flat
    const rows = await repo.list({ after: decodeCursor(query.cursor, PositionSchema), limit: query.limit, __parent_param__ }) // feature:under
    const last = rows[query.limit - 1]
    const origin = originOf(c)
    const next = rows.length > query.limit && last ? { createdAt: last.createdAt, id: last.id } : null
    return c.json(pageOf({ origin, path: PATH, query, name: '__camel__', items: rows.slice(0, query.limit).map((row) => cardOf(origin, row)), next }), 200) // feature:flat
    return c.json(pageOf({ origin, path: pathUnder(__parent_param__), query, name: '__camel__', items: rows.slice(0, query.limit).map((row) => cardOf(origin, row)), next }), 200) // feature:under
  }
  const get: RouteHandler<Routes['get']> = async (c) => c.json(cardOf(originOf(c), await rowOf(c.req.valid('param').id)), 200)
  const create: RouteHandler<Routes['create']> = async (c) => {
    const id = await repo.create(c.req.valid('json')) // feature:flat
    const { __parent_param__ } = c.req.valid('param') // feature:under
    await parentOf(__parent_param__) // feature:under
    const id = await repo.create({ ...c.req.valid('json'), __parent_id__: __parent_param__ }) // feature:under
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
