/** The key routes' handlers: request → repo → HAL answer. */
import type { RouteHandler } from '@hono/zod-openapi'
import { mintApiKey, type Caller } from '../core/auth.js'
import { linksOf, originOf } from '../core/hal.js'
import { newId } from '../core/ids.js'
import { ProblemError } from '../core/problem.js'
import type { KeysRepo } from './repo.js'
import type { KeyRoutes } from './routes.js'
import type { KeyRow } from './schema.js'

const NO_STORE = { 'cache-control': 'no-store' }

/**
 * holderOf names who is asking to make or revoke a key: a key set in the deployment (`API_KEYS`) or a signed-in
 * person. A key made through the API may not, so a leaked app key can't make itself a spare; nor may an OAuth token.
 */
export const holderOf = (caller: Caller | undefined, fixedKeys: string[]) => {
  if (caller?.kind === 'key' && fixedKeys.includes(caller.name)) return caller.name
  // A member of a team may not; a person with no role (an app without a team) keeps today's rights
  if (caller?.kind === 'person' && caller.role !== 'member') return caller.email
  throw new ProblemError('forbidden', { detail: 'Only a key set in the deployment (API_KEYS) or a signed-in person can make or revoke keys. Keys made through the API and OAuth tokens cannot: ask the owner.' })
}

export const keyHandlers = (repo: KeysRepo, { path, mePath, fixedKeys, keyPrefix }: { path: string; mePath: string; fixedKeys: string[]; keyPrefix: string }) => {
  const cardOf = (origin: string, { hash: _hash, ...row }: KeyRow) => ({ ...row, _links: linksOf(origin, { self: `${path}/${row.id}`, list: path }) })
  const missing = (id: string) => new ProblemError('not_found', { detail: `No key ${id}. GET ${path} lists them.` })

  const list: RouteHandler<KeyRoutes['list']> = async (c) => {
    const rows = await repo.list()
    const origin = originOf(c)
    return c.json({ count: rows.length, fixedKeys, _links: linksOf(origin, { self: path }), _embedded: { keys: rows.map((row) => cardOf(origin, row)) } }, 200, NO_STORE)
  }
  const get: RouteHandler<KeyRoutes['get']> = async (c) => {
    const { id } = c.req.valid('param')
    const row = await repo.get(id)
    if (!row) throw missing(id)
    return c.json(cardOf(originOf(c), row), 200, NO_STORE)
  }
  const me: RouteHandler<KeyRoutes['me']> = async (c) => {
    const caller = c.get('caller' as never) as Caller
    const name = caller.kind === 'person' ? caller.email : caller.name
    const fixed = caller.kind === 'key' && fixedKeys.includes(name)
    const stored = caller.kind === 'key' && !fixed ? await repo.named(name) : undefined
    return c.json(
      { kind: caller.kind, name, keyId: stored?.id ?? null, canManageKeys: caller.kind === 'person' || fixed, _links: linksOf(originOf(c), { self: mePath, ...(stored ? { key: `${path}/${stored.id}` } : {}) }) },
      200,
      NO_STORE,
    )
  }
  const create: RouteHandler<KeyRoutes['create']> = async (c) => {
    const createdBy = holderOf(c.get('caller' as never), fixedKeys)
    const { name } = c.req.valid('json')
    if (fixedKeys.includes(name) || (await repo.named(name))) throw new ProblemError('conflict', { detail: `A key named ${name} already exists: pick another name.` })
    const { key, hash } = mintApiKey(keyPrefix)
    const row: KeyRow = { id: newId('key'), name, hash, start: key.slice(0, keyPrefix.length + 5), createdAt: new Date().toISOString(), createdBy, lastUsedAt: null }
    await repo.create(row)
    return c.json({ ...cardOf(originOf(c), row), key }, 201, { location: `${path}/${row.id}`, ...NO_STORE })
  }
  const remove: RouteHandler<KeyRoutes['remove']> = async (c) => {
    holderOf(c.get('caller' as never), fixedKeys)
    const { id } = c.req.valid('param')
    if (!(await repo.get(id))) throw missing(id)
    await repo.remove(id)
    return c.body(null, 204)
  }
  return { list, get, me, create, remove }
}
