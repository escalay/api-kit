/** The key routes as OpenAPI contracts: list, make, read and revoke the keys that open the API, and who is calling. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema } from '../core/hal.js'
import { problemResponses } from '../core/problem.js'

const name = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
  .openapi({ description: 'Who or what holds the key, in lowercase letters, digits and hyphens: one key per app, machine or person.', example: 'billing-app' })

export const KeySchema = z
  .object({
    id: z.string().openapi({ example: 'key_0mh2k1x9zabcdefghjk' }),
    name: z.string(),
    start: z.string().openapi({ description: 'The key’s first characters, to tell keys apart.', example: 'ak_Xk3p' }),
    createdAt: z.string(),
    createdBy: z.string().openapi({ description: 'The key or person that made it.' }),
    lastUsedAt: z.string().nullable().openapi({ description: 'When it was last used, to the hour. Null: never.' }),
    _links: LinksSchema,
  })
  .openapi('Key', { description: 'A key that opens this API.' })

export const keyRoutes = ({ path, mePath, tag }: { path: string; mePath: string; tag: string }) => {
  const NewKeySchema = KeySchema.extend({
    key: z.string().openapi({ description: 'The key itself, shown only in this answer: only its hash is kept. Send it as `Authorization: Bearer <key>`.', example: 'ak_Xk3p…' }),
  }).openapi('NewKey', { description: 'A key just made, with the key itself, shown this once.' })
  const KeyListSchema = z
    .object({
      count: z.number().int(),
      fixedKeys: z.array(z.string()).openapi({ description: 'The names of the keys set in the deployment (`API_KEYS`). They work beside these, and only a deploy changes them.', example: ['owner'] }),
      _links: LinksSchema,
      _embedded: z.object({ keys: z.array(KeySchema) }),
    })
    .openapi('KeyList', { description: 'The keys made through the API, the oldest first.' })
  const MeSchema = z
    .object({
      kind: z.enum(['key', 'person', 'agent']).openapi({ description: '`key` for an API key, `person` for someone signed in, `agent` for an OAuth token.' }),
      name: z.string().openapi({ description: 'The key’s name, the person’s email or the agent’s name.', example: 'billing-app' }),
      keyId: z.string().nullable().openapi({ description: 'For a key made through the API: its id, to revoke it.' }),
      canManageKeys: z.boolean().openapi({ description: 'Whether this caller may make and revoke keys.' }),
      _links: LinksSchema,
    })
    .openapi('Me', { description: 'Who is calling: the key, person or agent this request was made as.' })
  const KeyInputSchema = z.object({ name }).openapi('KeyInput', { description: 'The name of the key to make.' })
  const id = z.string().min(1).max(80).openapi({ description: 'The key’s id, from the list.', example: 'key_0mh2k1x9zabcdefghjk' })
  return {
    list: createRoute({
      method: 'get',
      path,
      operationId: 'listKeys',
      tags: [tag],
      summary: 'API keys',
      description: 'The keys made through the API, with when each was last used, and the names of the keys the deployment was started with. The keys themselves are never shown again.',
      responses: { 200: { content: { [HAL_JSON]: { schema: KeyListSchema } }, description: 'The keys.' }, ...problemResponses(401) },
    }),
    get: createRoute({
      method: 'get',
      path: `${path}/{id}`,
      operationId: 'getKey',
      tags: [tag],
      summary: 'One API key',
      description: 'A key made through the API: its name, start, maker and when it was last used. Never the key itself.',
      request: { params: z.object({ id }) },
      responses: { 200: { content: { [HAL_JSON]: { schema: KeySchema } }, description: 'The key.' }, ...problemResponses(401, 404) },
    }),
    me: createRoute({
      method: 'get',
      path: mePath,
      operationId: 'getMe',
      tags: [tag],
      summary: 'Who am I',
      description: 'Who this request is made as, and whether it may manage keys: the way to check that a key works and which one it is.',
      responses: { 200: { content: { [HAL_JSON]: { schema: MeSchema } }, description: 'The caller.' }, ...problemResponses(401) },
    }),
    create: createRoute({
      method: 'post',
      path,
      operationId: 'createKey',
      tags: [tag],
      summary: 'Make an API key',
      description: 'Makes a key for one app, machine or person, and returns it once. Give each holder its own and revoke it when they are done. Only a key set in the deployment (`API_KEYS`) or a signed-in person can make keys: a key made here cannot make another, and neither can an OAuth token.',
      request: { body: { required: true, content: { 'application/json': { schema: KeyInputSchema } } } },
      responses: { 201: { content: { [HAL_JSON]: { schema: NewKeySchema } }, description: 'The key, shown this once.' }, ...problemResponses(400, 401, 403, 409, 422) },
    }),
    remove: createRoute({
      method: 'delete',
      path: `${path}/{id}`,
      operationId: 'deleteKey',
      tags: [tag],
      summary: 'Revoke an API key',
      description: 'Revokes a key at once: its next request is refused. Only a key set in the deployment or a signed-in person can revoke keys. Keys set in `API_KEYS` are revoked by a deploy, not here.',
      request: { params: z.object({ id }) },
      responses: { 204: { description: 'Revoked.' }, ...problemResponses(401, 403, 404) },
    }),
  }
}

export type KeyRoutes = ReturnType<typeof keyRoutes>
