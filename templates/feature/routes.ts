/** The __labels__ routes as OpenAPI contracts: paths, parameters, bodies and answers. */
import { createRoute, z } from '@hono/zod-openapi'
import { cursorQuery, HAL_JSON, limitQuery, LinksSchema, pageSchema, problemResponses } from '../../kit/index.js'

export const PATH = '/api/__name__'
export const TAG = '__Pascal__'

export const __Singular__Schema = z
  .object({ id: z.string(), __out_fields__ createdAt: z.string(), updatedAt: z.string(), _links: LinksSchema })
  .openapi('__Singular__', { description: 'A __label__.' })
const __Singular__PageSchema = pageSchema('__Singular__Page', '__camel__', __Singular__Schema, '__Pascal__, the newest first.')
const __Singular__InputSchema = z.object({ __in_fields__ }).openapi('__Singular__Input', { description: 'A new __label__.' })
// partial, never .default(): a field a PATCH leaves out must stay as it is, and a default would overwrite it
const __Singular__PatchSchema = __Singular__InputSchema.partial().openapi('__Singular__Patch', { description: 'The fields to change; the others stay.' })
const id = z.string().min(1).max(80).openapi({ description: 'The __label__’s id.' })
const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({ content: { [HAL_JSON]: { schema } }, description })

export const routes = {
  list: createRoute({
    method: 'get', path: PATH, operationId: 'list__Pascal__', tags: [TAG], summary: '__Pascal__', description: 'Every __label__, the newest first, a page at a time: follow `_links.next` until it is absent.',
    request: { query: z.object({ limit: limitQuery({ fallback: 50, max: 100 }), cursor: cursorQuery }) },
    responses: { 200: ok('A page of __labels__.', __Singular__PageSchema), ...problemResponses(400, 401) },
  }),
  get: createRoute({
    method: 'get', path: `${PATH}/{id}`, operationId: 'get__Singular__', tags: [TAG], summary: 'One __label__', description: 'A __label__ with all its fields.',
    request: { params: z.object({ id }) },
    responses: { 200: ok('The __label__.', __Singular__Schema), ...problemResponses(401, 404) },
  }),
  create: createRoute({
    method: 'post', path: PATH, operationId: 'create__Singular__', tags: [TAG], summary: 'Make a __label__', description: 'A new __label__. Answers 201 with its address in `Location`.',
    request: { body: { required: true, content: { 'application/json': { schema: __Singular__InputSchema } } } },
    responses: { 201: ok('The new __label__.', __Singular__Schema), ...problemResponses(400, 401, 403) },
  }),
  update: createRoute({
    method: 'patch', path: `${PATH}/{id}`, operationId: 'update__Singular__', tags: [TAG], summary: 'Change a __label__', description: 'Changes the fields sent; the others stay as they are.',
    request: { params: z.object({ id }), body: { required: true, content: { 'application/json': { schema: __Singular__PatchSchema } } } },
    responses: { 200: ok('The __label__.', __Singular__Schema), ...problemResponses(400, 401, 403, 404) },
  }),
  remove: createRoute({ // feature:remove
    method: 'delete', path: `${PATH}/{id}`, operationId: 'delete__Singular__', tags: [TAG], summary: 'Delete a __label__', description: 'Deletes the __label__ for good.', // feature:remove
    request: { params: z.object({ id }) }, // feature:remove
    responses: { 204: { description: 'Deleted.' }, ...problemResponses(401, 403, 404) }, // feature:remove
  }), // feature:remove
}
