/** The owner's sharing routes as OpenAPI contracts: a space's settings, and its invites made, listed and revoked. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema } from '../core/hal.js'
import { problemResponses } from '../core/problem.js'
import { cursorQuery, limitQuery, pageSchema } from '../pagination/index.js'
import { LIFETIMES, SCOPES } from './schema.js'

/** No control, bidi or zero-width character (Unicode Cc and Cf): what a label shown to people may hold. */
export const PLAIN_TEXT = /^[^\p{Cc}\p{Cf}]*$/u

export const sharingRoutes = ({ path, tag }: { path: string; tag: string }) => {
  const at = `${path}/{space}`
  const space = z.string().min(1).max(200).openapi({ description: 'The space’s name, as in its address.', example: 'soups' })
  const id = z.string().min(1).max(80).openapi({ description: 'The invite’s id, from the list.', example: 'inv_0mh2k1x9zabcdefghjk' })
  const ok = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({ content: { [HAL_JSON]: { schema } }, description })

  const SharingSchema = z
    .object({
      space: z.string().openapi({ description: 'The space’s name.', example: 'soups' }),
      title: z.string().openapi({ example: 'Soups' }),
      askToJoin: z.enum(['off', 'on', 'paused']).openapi({ description: 'Whether people may ask to join: `paused` after 10 asks in a row went unanswered, until the switch is set again.' }),
      askToJoinOffered: z.boolean().openapi({ description: 'Whether this app offers asking to join at all; when false, the switch answers 409.' }),
      openInvites: z.number().int().openapi({ description: 'Invites not yet used, revoked or expired.' }),
      _links: LinksSchema,
    })
    .openapi('Sharing', { description: 'How a space is shared: asking to join, and how many invites are open.' })
  const SharingPatchSchema = z.object({ askToJoin: z.boolean().openapi({ description: 'true lets people ask to join (and clears a pause); false refuses everyone waiting.' }) }).openapi('SharingPatch', { description: 'Asking to join, on or off.' })
  const InviteSchema = z
    .object({
      id: z.string().openapi({ example: 'inv_0mh2k1x9zabcdefghjk' }),
      label: z.string().openapi({ description: 'Who it is for.', example: 'Sam' }),
      invitedBy: z.string().openapi({ description: 'Who made it: the owner’s email, a key’s name, or `agent:<client>`.' }),
      scope: z.enum(SCOPES).openapi({ description: '`read`, or `write` to make changes too.' }),
      lifetime: z.enum(LIFETIMES).openapi({ description: 'How long the access lasts once used: `7d`, `30d` or `until_revoked`.' }),
      state: z.enum(['open', 'redeemed', 'revoked', 'expired']).openapi({ description: '`open` until it is used (`redeemed`), revoked, or a day passes (`expired`).' }),
      createdAt: z.string(),
      redeemBy: z.string().openapi({ description: 'When it stops working if unused: a day after it was made.' }),
      revokedAt: z.string().nullable(),
      _links: LinksSchema,
    })
    .openapi('Invite', { description: 'An invite to one space for one person: single use, within a day. Its link and code are never shown again.' })
  const NewInviteSchema = InviteSchema.extend({
    link: z.string().openapi({ description: 'The invite’s link, shown only in this answer: open it in a browser.', example: 'https://sample.example.test/sharing/join/…' }),
    code: z.string().openapi({ description: 'The code an app asks for, shown only in this answer.', example: 'BDKM-QXTW' }),
    message: z.string().openapi({ description: 'The link and code in words, ready for the owner to send. Never sent by the app.' }),
  }).openapi('NewInvite', { description: 'An invite just made, with its link and code, shown this once.' })
  const InviteInputSchema = z
    .object({
      label: z.string().trim().min(1).max(80).regex(PLAIN_TEXT, 'no control, bidi or zero-width characters').openapi({ description: 'Who it is for, as the owner will recognise them (80 characters at most).', example: 'Sam' }),
      scope: z.enum(SCOPES).default('read').openapi({ description: '`read` (the default) or `write`.' }),
      lifetime: z.enum(LIFETIMES).default('30d').openapi({ description: '`7d`, `30d` (the default) or `until_revoked`; an agent may give only `7d` or `30d`.' }),
    })
    .openapi('InviteInput', { description: 'Who an invite is for, what it allows and for how long.' })
  const InvitePageSchema = pageSchema('InvitePage', 'invites', InviteSchema, 'A page of a space’s invites, newest first.')

  return {
    get: createRoute({
      method: 'get', path: `${at}/sharing`, operationId: 'getSharing', tags: [tag], summary: 'How a space is shared',
      description: 'Whether people may ask to join the space, and how many invites are open. Only those who may share see it; to anyone else every space is 404.',
      request: { params: z.object({ space }) },
      responses: { 200: ok('The space’s sharing.', SharingSchema), ...problemResponses(401, 404) },
    }),
    update: createRoute({
      method: 'patch', path: `${at}/sharing`, operationId: 'updateSharing', tags: [tag], summary: 'Switch asking to join',
      description: 'Switches asking to join for the space. On clears a pause; off refuses everyone waiting. 409 when the app does not offer asking.',
      request: { params: z.object({ space }), body: { required: true, content: { 'application/json': { schema: SharingPatchSchema } } } },
      responses: { 200: ok('The space’s sharing.', SharingSchema), ...problemResponses(400, 401, 403, 404, 409) },
    }),
    createInvite: createRoute({
      method: 'post', path: `${at}/invites`, operationId: 'createInvite', tags: [tag], summary: 'Invite someone to a space',
      description: 'Makes an invite for one person: a link and a typed code, single use, within a day, shown only in this answer, with a message to send them. An agent may invite for 7 or 30 days only. A retry with the same Idempotency-Key answers 409 `shown_once`, never the link again.',
      request: { params: z.object({ space }), body: { required: true, content: { 'application/json': { schema: InviteInputSchema } } } },
      responses: { 201: ok('The invite, its link and code shown this once.', NewInviteSchema), ...problemResponses(400, 401, 403, 404, 409) },
    }),
    listInvites: createRoute({
      method: 'get', path: `${at}/invites`, operationId: 'listInvites', tags: [tag], summary: 'A space’s invites',
      description: 'The space’s invites, newest first, each with its state. Never a link or a code: those were shown once.',
      request: { params: z.object({ space }), query: z.object({ limit: limitQuery({ fallback: 50, max: 100 }), cursor: cursorQuery }) },
      responses: { 200: ok('A page of invites.', InvitePageSchema), ...problemResponses(400, 401, 404) },
    }),
    revokeInvite: createRoute({
      method: 'delete', path: `${at}/invites/{id}`, operationId: 'revokeInvite', tags: [tag], summary: 'Revoke an invite',
      description: 'Revokes an invite no one has used: its link and code stop working at once. Revoking it again is harmless; 409 when it was already used.',
      request: { params: z.object({ space, id }) },
      responses: { 204: { description: 'Revoked.' }, ...problemResponses(401, 403, 404, 409) },
    }),
  }
}

export type SharingRoutes = ReturnType<typeof sharingRoutes>
