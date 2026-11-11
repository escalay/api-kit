/**
 * Boards: the owner's own collections of the app's items for a project, the part of a catalog you can write. An item
 * is addressed by a ref the app chooses (`recipe:<slug>`, `cook:<id>`); adding is idempotent (`PUT`) and every item
 * can carry a note. Kept in the app's database (`db`, the same one as its OAuth state), read and written through:
 *   GET    {path}                     every board, newest change first; `?item=<ref>` only the boards holding it
 *   POST   {path}                     a new board → 201 with `Location`
 *   GET    {path}/{id}                a board with its items (each resolved to the app's card, null if it left)
 *   PATCH  {path}/{id}                rename or describe it
 *   DELETE {path}/{id}                delete it (its items are only references)
 *   PUT    {path}/{id}/items/{ref}    add an item, or change its note
 *   DELETE {path}/{id}/items/{ref}    take it off
 *   GET    {path}/{id}/suggestions    more like what is on it (when the app gives `suggestions`)
 * Writes need the `write` scope (an OAuth token with it, a key, or the owner's browser on the same site).
 *
 * @example
 * await registerBoards(app, { db: await openDb(`file:${stateFile}`), item: RecipeCardSchema, refExample: 'recipe:soup', itemOf: (ref, origin) => cardOfRef(ref, origin) })
 * mcpServerFactory({ tools: [...boardTools({ noun: 'recipes', label: (recipe) => recipe.title }), …], … })
 */
import type { OpenAPIHono, z } from '@hono/zod-openapi'
import { migrate, type Db } from '../db/index.js'
import { boardHandlers } from './handlers.js'
import { boardsRepo } from './repo.js'
import { boardRoutes } from './routes.js'
import { BOARDS_MIGRATIONS } from './schema.js'

export { BOARD_REF, boardRef, parseBoardRef } from './refs.js'
export { boardsRepo, type BoardRow, type BoardsRepo } from './repo.js'
export { boardRoutes, type BoardRoutes } from './routes.js'
export { boardItems, boards, BOARDS_MIGRATIONS } from './schema.js'
export { boardTools } from './tools.js'

export type BoardsConfig = {
  /** Default `/api/boards`. */
  path?: string
  /** The app's database (`openDb`); the boards tables are migrated into it. */
  db: Db
  /** The OpenAPI schema of an item's card. */
  item: z.ZodTypeAny
  /** A ref → the app's card for it, or null when it left the catalog. */
  itemOf: (ref: string, origin: string) => unknown
  /** What a ref looks like (default `BOARD_REF`, `<type>:<id>`). */
  refPattern?: RegExp
  refExample: string
  tag?: string
  /** Cards for refs like those on a board, best first, leaving out what is on it. */
  suggestions?: (refs: string[], limit: number, origin: string) => unknown[]
}

/**
 * Registers the board routes on the app, after migrating the boards tables. Call it after `createAgentApi`.
 */
export const registerBoards = async (app: OpenAPIHono, config: BoardsConfig) => {
  await migrate(config.db, 'boards', BOARDS_MIGRATIONS)
  const routes = boardRoutes(config)
  const handle = boardHandlers(config, boardsRepo(config.db))
  app.openapi(routes.list, handle.list)
  app.openapi(routes.create, handle.create)
  app.openapi(routes.get, handle.get)
  app.openapi(routes.update, handle.update)
  app.openapi(routes.remove, handle.remove)
  app.openapi(routes.save, handle.save)
  app.openapi(routes.unsave, handle.unsave)
  if (config.suggestions) app.openapi(routes.suggestions, handle.suggestions)
}
