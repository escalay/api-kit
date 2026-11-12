/**
 * API keys an app makes and revokes through its own API, beside the ones it is started with (`API_KEYS`). Kept as
 * SHA-256 hashes with their first characters, maker and last use; every key sees what any key sees. Only a key from
 * `API_KEYS` or a signed-in person may make or revoke one, so a leaked app key cannot make itself a spare.
 *   GET    {path}        the keys made here, and the names of the deployment's (`fixedKeys`)
 *   POST   {path}        a new key → 201, the key shown this once
 *   GET    {path}/{id}   one key (never the key itself)
 *   DELETE {path}/{id}   revoke it at once
 *   GET    {mePath}      who is calling, and whether it may manage keys
 *
 * @example
 * const app = createAgentApi({ …, tags: [...FEATURE_TAGS, KEYS_TAG], auth: { realm, keys: parseApiKeys(env.API_KEYS), storedKeys: storedKeysOf(db) } })
 * await registerKeys(app, { db, fixedKeys: [...parseApiKeys(env.API_KEYS).values()], keyPrefix: 'mr' })
 * mcpServerFactory({ tools: [...FEATURE_TOOLS, ...keyTools()], … })
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import { migrate, type Db } from '../db/index.js'
import { keyHandlers } from './handlers.js'
import { keysRepo } from './repo.js'
import { keyRoutes } from './routes.js'
import { KEYS_MIGRATIONS } from './schema.js'

export { holderOf } from './handlers.js'
export { keysRepo, type KeysRepo } from './repo.js'
export { KeySchema, keyRoutes, type KeyRoutes } from './routes.js'
export { apiKeys, KEYS_MIGRATIONS, type KeyRow } from './schema.js'
export { keyTools } from './tools.js'

export const KEYS_TAG = { name: 'Keys', description: 'API keys: one per app, machine or person, made and revoked through the API.' }

export type KeysConfig = {
  /** The app's database; the `api_keys` table is migrated into it. */
  db: Db
  /** The names of the keys in `API_KEYS`: they alone (and signed-in people) may manage keys, and their names are taken. */
  fixedKeys: string[]
  /** What a new key starts with, e.g. `mr` gives `mr_…` (default `ak`). */
  keyPrefix?: string
  /** Default `/api/keys` and `/api/me`. */
  path?: string
  mePath?: string
  tag?: string
}

/** storedKeysOf is the lookup `createAgentApi`'s auth takes as `storedKeys`: a key's hash → its name, or undefined. */
export const storedKeysOf = (db: Db) => keysRepo(db).nameOf

/** Registers the key routes on the app, after migrating the keys table. Call it after `createAgentApi`. */
export const registerKeys = async (app: OpenAPIHono, { db, fixedKeys, keyPrefix = 'ak', path = '/api/keys', mePath = '/api/me', tag = KEYS_TAG.name }: KeysConfig) => {
  await migrate(db, 'keys', KEYS_MIGRATIONS)
  const routes = keyRoutes({ path, mePath, tag })
  const handle = keyHandlers(keysRepo(db), { path, mePath, fixedKeys, keyPrefix })
  app.openapi(routes.list, handle.list)
  app.openapi(routes.me, handle.me)
  app.openapi(routes.get, handle.get)
  app.openapi(routes.create, handle.create)
  app.openapi(routes.remove, handle.remove)
}
