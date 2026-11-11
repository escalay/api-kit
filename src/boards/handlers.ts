/** The board routes' handlers: request → repo → HAL answer; a missing board or item is a problem. No queries here. */
import type { RouteHandler } from '@hono/zod-openapi'
import { linksOf, originOf } from '../core/hal.js'
import { ProblemError } from '../core/problem.js'
import type { BoardsConfig } from './index.js'
import type { BoardRow, BoardsRepo } from './repo.js'
import type { BoardRoutes } from './routes.js'

export const boardHandlers = (config: BoardsConfig, repo: BoardsRepo) => {
  const path = config.path ?? '/api/boards'
  const rowOf = async (boardId: string) => {
    const row = await repo.get(boardId)
    if (!row) throw new ProblemError('not_found', { detail: `No board ${boardId}. GET ${path} lists them.` })
    return row
  }
  const boardOf = async (origin: string, row: BoardRow, withItems = false) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    items: row.items,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    _links: linksOf(origin, {
      self: `${path}/${row.id}`,
      item: { path: `${path}/${row.id}/items/{ref}`, templated: true, title: 'PUT to add, DELETE to remove' },
      suggestions: config.suggestions ? { path: `${path}/${row.id}/suggestions`, title: 'More like what is on it' } : null,
    }),
    ...(withItems ? { _embedded: { items: (await repo.items(row.id)).map((item) => ({ ...item, item: config.itemOf(item.ref, origin) ?? null })) } } : {}),
  })

  const list: RouteHandler<BoardRoutes['list']> = async (c) => {
    const { item } = c.req.valid('query')
    const rows = await repo.list(item)
    const origin = originOf(c)
    return c.json({ count: rows.length, _links: linksOf(origin, { self: `${path}${item ? `?item=${encodeURIComponent(item)}` : ''}`, create: { path, title: 'POST { name } to make one' } }), _embedded: { boards: await Promise.all(rows.map((row) => boardOf(origin, row))) } }, 200)
  }

  const create: RouteHandler<BoardRoutes['create']> = async (c) => {
    const { name, description } = c.req.valid('json')
    const boardId = await repo.create({ name: name.trim(), description: description?.trim() || null })
    return c.json(await boardOf(originOf(c), await rowOf(boardId)), 201, { location: `${path}/${boardId}` })
  }

  const get: RouteHandler<BoardRoutes['get']> = async (c) => c.json(await boardOf(originOf(c), await rowOf(c.req.valid('param').id), true), 200)

  const update: RouteHandler<BoardRoutes['update']> = async (c) => {
    const { id: boardId } = c.req.valid('param')
    const { name, description } = c.req.valid('json')
    const row = await rowOf(boardId)
    await repo.update(boardId, { name: name?.trim() || row.name, description: description === undefined ? row.description : description.trim() || null })
    return c.json(await boardOf(originOf(c), await rowOf(boardId)), 200)
  }

  const remove: RouteHandler<BoardRoutes['remove']> = async (c) => {
    const { id: boardId } = c.req.valid('param')
    await rowOf(boardId)
    await repo.remove(boardId)
    return c.body(null, 204)
  }

  const save: RouteHandler<BoardRoutes['save']> = async (c) => {
    const { id: boardId, ref: itemRef } = c.req.valid('param')
    const { note } = ((await c.req.json().catch(() => ({}))) ?? {}) as { note?: string }
    await rowOf(boardId)
    if (config.itemOf(itemRef, originOf(c)) == null) throw new ProblemError('not_found', { detail: `No item ${itemRef} in the catalog. Add items by the ref their search results and links give.` })
    const saved = await repo.save(boardId, itemRef, note?.trim() || null)
    return c.json(await boardOf(originOf(c), await rowOf(boardId)), saved === 'added' ? 201 : 200)
  }

  const unsave: RouteHandler<BoardRoutes['unsave']> = async (c) => {
    const { id: boardId, ref: itemRef } = c.req.valid('param')
    await rowOf(boardId)
    await repo.unsave(boardId, itemRef)
    return c.body(null, 204)
  }

  const suggestions: RouteHandler<BoardRoutes['suggestions']> = async (c) => {
    const { id: boardId } = c.req.valid('param')
    await rowOf(boardId)
    const refs = await repo.refs(boardId)
    const origin = originOf(c)
    const items = refs.length && config.suggestions ? config.suggestions(refs, c.req.valid('query').limit, origin) : []
    return c.json({ count: items.length, _links: linksOf(origin, { self: `${path}/${boardId}/suggestions`, board: `${path}/${boardId}` }), _embedded: { items } }, 200)
  }

  return { list, create, get, update, remove, save, unsave, suggestions }
}
