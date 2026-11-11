/** The __labels__ routes as OpenAPI contracts: paths, parameters, bodies and answers. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema, problemResponses } from '../../kit/index.js'

export const PATH = '/api/__name__'
export const TAG = '__Pascal__'

export const __Singular__Schema = z
  .object({ id: z.string(), title: z.string(), body: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), _links: LinksSchema })
  .openapi('__Singular__', { description: 'A __label__.' })
const __Singular__ListSchema = z.object({ count: z.number().int(), _links: LinksSchema, _embedded: z.object({ __camel__: z.array(__Singular__Schema) }) }).openapi('__Singular__List', { description: '__Pascal__, the newest changed first.' })
const __Singular__InputSchema = z.object({ title: z.string().min(1).max(200).openapi({ example: 'First __label__' }), body: z.string().max(10_000).optional().openapi({ description: 'Its text.' }) }).openapi('__Singular__Input', { description: 'A __label__’s title and text.' })
const __Singular__PatchSchema = __Singular__InputSchema.partial().openapi('__Singular__Patch', { description: 'A new title or text.' })
const id = z.string().min(1).max(80).openapi({ description: 'The __label__’s id.' })
const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({ content: { [HAL_JSON]: { schema } }, description })

export const routes = {
  list: createRoute({
    method: 'get', path: PATH, operationId: 'list__Pascal__', tags: [TAG], summary: '__Pascal__', description: 'Every __label__, the newest changed first, each with its link.',
    request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50).openapi({ description: 'At most this many (1–100, default 50).' }) }) },
    responses: { 200: ok('__Pascal__.', __Singular__ListSchema), ...problemResponses(400, 401) },
  }),
  get: createRoute({
    method: 'get', path: `${PATH}/{id}`, operationId: 'get__Singular__', tags: [TAG], summary: 'One __label__', description: 'A __label__ with its title and text.',
    request: { params: z.object({ id }) },
    responses: { 200: ok('The __label__.', __Singular__Schema), ...problemResponses(401, 404) },
  }),
  create: createRoute({
    method: 'post', path: PATH, operationId: 'create__Singular__', tags: [TAG], summary: 'Make a __label__', description: 'A new __label__. Answers 201 with its address in `Location`.',
    request: { body: { required: true, content: { 'application/json': { schema: __Singular__InputSchema } } } },
    responses: { 201: ok('The new __label__.', __Singular__Schema), ...problemResponses(400, 401, 403) },
  }),
  update: createRoute({
    method: 'patch', path: `${PATH}/{id}`, operationId: 'update__Singular__', tags: [TAG], summary: 'Change a __label__', description: 'Changes a __label__’s title, its text, or both.',
    request: { params: z.object({ id }), body: { required: true, content: { 'application/json': { schema: __Singular__PatchSchema } } } },
    responses: { 200: ok('The __label__.', __Singular__Schema), ...problemResponses(400, 401, 403, 404) },
  }),
  remove: createRoute({
    method: 'delete', path: `${PATH}/{id}`, operationId: 'delete__Singular__', tags: [TAG], summary: 'Delete a __label__', description: 'Deletes the __label__ for good.',
    request: { params: z.object({ id }) },
    responses: { 204: { description: 'Deleted.' }, ...problemResponses(401, 403, 404) },
  }),
}
