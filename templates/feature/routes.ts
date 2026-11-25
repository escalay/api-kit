/** The __labels__ routes as OpenAPI contracts: paths, parameters, bodies and answers. */
import { createRoute, z } from '@hono/zod-openapi'
import { cursorQuery, HAL_JSON, limitQuery, LinksSchema, pageSchema, problemResponses } from '../../kit/index.js'

export const PATH = '/api/__name__'
/** Where the __labels__ of one __parent_label__ are listed and made. */ // feature:under
export const pathUnder = (__parent_param__: string) => `/api/__parent__/${encodeURIComponent(__parent_param__)}/__name__` // feature:under
export const TAG = '__Pascal__'

export const __Singular__Schema = z
  .object({ id: z.string(), __out_fields__ createdAt: z.string(), updatedAt: z.string(), _links: LinksSchema })
  .openapi('__Singular__', { description: 'A __label__.' })
const __Singular__PageSchema = pageSchema('__Singular__Page', '__camel__', __Singular__Schema, '__Pascal__, the newest first.')
const __Singular__InputSchema = z.object({ __in_fields__ }).openapi('__Singular__Input', { description: 'A new __label__.' })
// partial, never .default(): a field a PATCH leaves out must stay as it is, and a default would overwrite it
const __Singular__PatchSchema = __Singular__InputSchema.partial().openapi('__Singular__Patch', { description: 'The fields to change; the others stay.' })
const id = z.string().min(1).max(80).openapi({ description: 'The __label__’s id.' })
const __parent_param__ = z.string().min(1).max(80).openapi({ description: 'The __parent_label__’s id.' }) // feature:under
const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({ content: { [HAL_JSON]: { schema } }, description })

export const routes = {
  list: createRoute({
    method: 'get', path: PATH, operationId: 'list__Pascal__', tags: [TAG], summary: '__Pascal__', description: 'Every __label__, the newest first, a page at a time: follow `_links.next` until it is absent.', // feature:flat
    method: 'get', path: '/api/__parent__/{__parent_param__}/__name__', operationId: 'list__Pascal__', tags: [TAG], summary: '__Pascal__', description: 'Every __label__ of a __parent_label__, the newest first, a page at a time: follow `_links.next` until it is absent.', // feature:under
    request: { query: z.object({ limit: limitQuery({ fallback: 50, max: 100 }), cursor: cursorQuery }) }, // feature:flat
    request: { params: z.object({ __parent_param__ }), query: z.object({ limit: limitQuery({ fallback: 50, max: 100 }), cursor: cursorQuery }) }, // feature:under
    responses: { 200: ok('A page of __labels__.', __Singular__PageSchema), ...problemResponses(400, 401) }, // feature:flat
    responses: { 200: ok('A page of __labels__.', __Singular__PageSchema), ...problemResponses(400, 401, 404) }, // feature:under
  }),
  get: createRoute({
    method: 'get', path: `${PATH}/{id}`, operationId: 'get__Singular__', tags: [TAG], summary: 'One __label__', description: 'A __label__ with all its fields.',
    request: { params: z.object({ id }) },
    responses: { 200: ok('The __label__.', __Singular__Schema), ...problemResponses(401, 404) },
  }),
  create: createRoute({
    method: 'post', path: PATH, operationId: 'create__Singular__', tags: [TAG], summary: 'Make a __label__', description: 'A new __label__. Answers 201 with its address in `Location`.', // feature:flat
    method: 'post', path: '/api/__parent__/{__parent_param__}/__name__', operationId: 'create__Singular__', tags: [TAG], summary: 'Make a __label__', description: 'A new __label__ of a __parent_label__. Answers 201 with its address in `Location`.', // feature:under
    request: { body: { required: true, content: { 'application/json': { schema: __Singular__InputSchema } } } }, // feature:flat
    request: { params: z.object({ __parent_param__ }), body: { required: true, content: { 'application/json': { schema: __Singular__InputSchema } } } }, // feature:under
    responses: { 201: ok('The new __label__.', __Singular__Schema), ...problemResponses(400, 401, 403) }, // feature:flat
    responses: { 201: ok('The new __label__.', __Singular__Schema), ...problemResponses(400, 401, 403, 404) }, // feature:under
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
