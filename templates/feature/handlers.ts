/** The __labels__ routes' handlers: request → repo → HAL answer; a missing __label__ is a problem. No queries here. */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf, ProblemError } from '../../kit/index.js'
import type { __Pascal__Repo } from './repo.js'
import { PATH, type routes } from './routes.js'
import type { __Singular__Row } from './schema.js'

type Routes = typeof routes

export const __camel__Handlers = (repo: __Pascal__Repo) => {
  const rowOf = async (id: string) => {
    const row = await repo.get(id)
    if (!row) throw new ProblemError('not_found', { detail: `No __label__ ${id}. GET ${PATH} lists them.` })
    return row
  }
  const cardOf = (origin: string, row: __Singular__Row) => ({ ...row, _links: linksOf(origin, { self: `${PATH}/${row.id}`, list: PATH }) })

  const list: RouteHandler<Routes['list']> = async (c) => {
    const rows = await repo.list(c.req.valid('query').limit)
    const origin = originOf(c)
    return c.json({ count: rows.length, _links: linksOf(origin, { self: PATH }), _embedded: { __camel__: rows.map((row) => cardOf(origin, row)) } }, 200)
  }
  const get: RouteHandler<Routes['get']> = async (c) => c.json(cardOf(originOf(c), await rowOf(c.req.valid('param').id)), 200)
  const create: RouteHandler<Routes['create']> = async (c) => {
    const { title, body } = c.req.valid('json')
    const id = await repo.create({ title: title.trim(), body: body ?? null })
    return c.json(cardOf(originOf(c), await rowOf(id)), 201, { location: `${PATH}/${id}` })
  }
  const update: RouteHandler<Routes['update']> = async (c) => {
    const { id } = c.req.valid('param')
    await rowOf(id)
    const { title, body } = c.req.valid('json')
    await repo.update(id, { ...(title === undefined ? {} : { title: title.trim() }), ...(body === undefined ? {} : { body }) })
    return c.json(cardOf(originOf(c), await rowOf(id)), 200)
  }
  const remove: RouteHandler<Routes['remove']> = async (c) => {
    const { id } = c.req.valid('param')
    await rowOf(id)
    await repo.remove(id)
    return c.body(null, 204)
  }
  return { list, get, create, update, remove }
}
