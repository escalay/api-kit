/** The board routes as OpenAPI contracts: paths, parameters, bodies and answers, built around the app's item card. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema } from '../core/hal.js'
import { problemResponses } from '../core/problem.js'
import type { BoardsConfig } from './index.js'
import { BOARD_REF } from './refs.js'

export const boardRoutes = (config: BoardsConfig) => {
  const { path = '/api/boards', tag = 'Boards' } = config
  const BoardItemSchema = z
    .object({
      ref: z.string().openapi({ description: 'The item’s address, e.g. `' + config.refExample + '`.', example: config.refExample }),
      note: z.string().nullable().openapi({ description: 'Why it is here.' }),
      addedAt: z.string(),
      item: config.item.nullable().openapi({ description: 'The item’s card (null if it left the catalog).' }),
    })
    .openapi('BoardItem', { description: 'Something on a board, with its note.' })
  const BoardSchema = z
    .object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      items: z.number().int().openapi({ description: 'How many items are on it.' }),
      createdAt: z.string(),
      updatedAt: z.string(),
      _links: LinksSchema,
      _embedded: z.object({ items: z.array(BoardItemSchema) }).optional(),
    })
    .openapi('Board', { description: 'A board: a collection of items for a project, with notes.' })
  const BoardListSchema = z.object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ boards: z.array(BoardSchema) }) }).openapi('BoardList', { description: 'Boards, most recently changed first.' })
  const BoardInputSchema = z.object({ name: z.string().min(1).max(120).openapi({ example: 'Bank identity references' }), description: z.string().max(1000).optional().openapi({ description: 'What the board is for.' }) }).openapi('BoardInput', { description: 'A board’s name and what it is for.' })
  const BoardPatchSchema = BoardInputSchema.partial().openapi('BoardPatch', { description: 'A new name or description.' })
  const NoteSchema = z.object({ note: z.string().max(1000).optional().openapi({ description: 'Why it is here.' }) }).openapi('BoardItemInput', { description: 'An optional note for the item.' })
  const SuggestionsSchema = z.object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ items: z.array(config.item) }) }).openapi('BoardSuggestions', { description: 'Items like those on a board, best first.' })
  const id = z.string().min(1).max(80).openapi({ description: 'The board’s id.', example: '0b2e4c1a-5d1f-4b3e-9a51-7c8f2e6d1a90' })
  const ref = z.string().regex(config.refPattern ?? BOARD_REF).openapi({ description: 'The item’s ref, e.g. `' + config.refExample + '`.', example: config.refExample })
  const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({ content: { [HAL_JSON]: { schema } }, description })

  return {
    list: createRoute({
      method: 'get', path, operationId: 'listBoards', tags: [tag], summary: 'Boards', description: 'Every board with how many items it holds, most recently changed first. `item` keeps only the boards that hold that item (to show where something is saved).',
      request: { query: z.object({ item: ref.optional().openapi({ description: 'Only boards holding this ref.' }) }) },
      responses: { 200: ok('Boards.', BoardListSchema), ...problemResponses(400, 401) },
    }),
    create: createRoute({
      method: 'post', path, operationId: 'createBoard', tags: [tag], summary: 'Make a board', description: 'A new, empty board with a name and what it is for. Answers 201 with its address in `Location`.',
      request: { body: { required: true, content: { 'application/json': { schema: BoardInputSchema } } } },
      responses: { 201: ok('The new board.', BoardSchema), ...problemResponses(400, 401, 403) },
    }),
    get: createRoute({
      method: 'get', path: `${path}/{id}`, operationId: 'getBoard', tags: [tag], summary: 'One board with its items', description: 'A board and everything on it, newest first, each with its note and the item’s card (null if it left the catalog).',
      request: { params: z.object({ id }) },
      responses: { 200: ok('The board.', BoardSchema), ...problemResponses(401, 404) },
    }),
    update: createRoute({
      method: 'patch', path: `${path}/{id}`, operationId: 'updateBoard', tags: [tag], summary: 'Rename or describe a board', description: 'Changes a board’s name, its description, or both.',
      request: { params: z.object({ id }), body: { required: true, content: { 'application/json': { schema: BoardPatchSchema } } } },
      responses: { 200: ok('The board.', BoardSchema), ...problemResponses(400, 401, 403, 404) },
    }),
    remove: createRoute({
      method: 'delete', path: `${path}/{id}`, operationId: 'deleteBoard', tags: [tag], summary: 'Delete a board', description: 'Deletes the board and its notes. The items themselves stay in the catalog.',
      request: { params: z.object({ id }) },
      responses: { 204: { description: 'Deleted.' }, ...problemResponses(401, 403, 404) },
    }),
    save: createRoute({
      method: 'put', path: `${path}/{id}/items/{ref}`, operationId: 'putBoardItem', tags: [tag], summary: 'Add an item to a board', description: 'Adds the item, or changes its note when it is already there; doing it twice is harmless. 201 when added, 200 when only the note changed.',
      request: { params: z.object({ id, ref }), body: { required: false, content: { 'application/json': { schema: NoteSchema } } } },
      responses: { 200: ok('The board.', BoardSchema), 201: ok('The board.', BoardSchema), ...problemResponses(400, 401, 403, 404) },
    }),
    unsave: createRoute({
      method: 'delete', path: `${path}/{id}/items/{ref}`, operationId: 'deleteBoardItem', tags: [tag], summary: 'Take an item off a board', description: 'Removes the item and its note from the board; harmless when it was not there.',
      request: { params: z.object({ id, ref }) },
      responses: { 204: { description: 'Removed.' }, ...problemResponses(400, 401, 403, 404) },
    }),
    suggestions: createRoute({
      method: 'get', path: `${path}/{id}/suggestions`, operationId: 'listBoardSuggestions', tags: [tag], summary: 'More like what is on a board', description: 'Items like the ones on the board, best first, leaving out what is already on it. Free.',
      request: { params: z.object({ id }), query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(24).openapi({ description: 'At most this many (1–100, default 24).' }) }) },
      responses: { 200: ok('Suggestions.', SuggestionsSchema), ...problemResponses(400, 401, 404) },
    }),
  }
}

export type BoardRoutes = ReturnType<typeof boardRoutes>
