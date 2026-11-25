/** The owner's sharing routes as OpenAPI contracts: a space's sharing, its invites made, listed, read and revoked, and its members listed, read, removed and invited again. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema } from '../core/hal.js'
import { problemResponses } from '../core/problem.js'
import { cursorQuery, limitQuery, pageSchema } from '../pagination/index.js'
import { ENDED_REASONS, LIFETIMES, SCOPES, VIAS } from './schema.js'

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
      openInvites: z.number().int().openapi({ description: 'Invites not yet used, revoked or expired.' }),
      _links: LinksSchema,
    })
    .openapi('Sharing', { description: 'How a space is shared: how many invites are open.' })
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
    .openapi('Invite', { description: 'An invite to one space for one person: single use, within a day. Its code is never shown again.' })
  const NewInviteSchema = InviteSchema.extend({
    address: z.string().openapi({ description: 'The space’s address: the invitee connects their app here, then types the code on the page it opens.', example: 'https://sample.example.test/s/soups/mcp' }),
    code: z.string().openapi({ description: 'The code the invitee types on the sign-in page, shown only in this answer.', example: 'BDKM-QXTW' }),
    message: z.string().openapi({ description: 'The address and code in words, ready for the owner to send. Never sent by the app.' }),
  }).openapi('NewInvite', { description: 'An invite just made, with its code, shown this once.' })
  const InviteInputSchema = z
    .object({
      label: z.string().trim().min(1).max(80).regex(PLAIN_TEXT, 'no control, bidi or zero-width characters').openapi({ description: 'Who it is for, as the owner will recognise them (80 characters at most).', example: 'Sam' }),
      scope: z.enum(SCOPES).default('read').openapi({ description: '`read` (the default) or `write`.' }),
      lifetime: z.enum(LIFETIMES).default('30d').openapi({ description: '`7d`, `30d` (the default) or `until_revoked`; an agent may give only `7d` or `30d`.' }),
    })
    .openapi('InviteInput', { description: 'Who an invite is for, what it allows and for how long.' })
  const InvitePageSchema = pageSchema('InvitePage', 'invites', InviteSchema, 'A page of a space’s invites, newest first.')
  const memberId = z.string().min(1).max(80).openapi({ description: 'The member’s id, from the list.', example: 'mem_0mh2k1x9zabcdefghjk' })
  const MemberSchema = z
    .object({
      id: z.string().openapi({ example: 'mem_0mh2k1x9zabcdefghjk' }),
      label: z.string().openapi({ description: 'Who it is: the invite’s label, or the app’s name when the owner approved it.', example: 'Sam' }),
      appName: z.string().openapi({ description: 'What the app calls itself: its own claim, never checked.' }),
      returnsTo: z.string().openapi({ description: 'Where the app returns: a host, a custom scheme, or `this computer`.' }),
      via: z.enum(VIAS).openapi({ description: 'How it joined: an `invite`, or the `owner`’s approval.' }),
      scope: z.enum(SCOPES),
      lifetime: z.enum(LIFETIMES),
      state: z.enum(['active', 'signed_out']).openapi({ description: '`signed_out` once its sign-in ended (revoked, expired, unused for 30 days, its app or space gone): invite it again.' }),
      joinedAt: z.string(),
      expiresAt: z.string().nullable().openapi({ description: 'When its access ends; null is until revoked.' }),
      lastSeenAt: z.string().openapi({ description: 'Its last use, to the hour.' }),
      endedAt: z.string().nullable(),
      endedReason: z.enum(ENDED_REASONS).nullable(),
      _links: LinksSchema,
    })
    .openapi('Member', { description: 'One app signed in to a space, by invite or by the owner’s approval. Removed and replaced members are not shown.' })
  const MemberPageSchema = pageSchema('MemberPage', 'members', MemberSchema, 'A page of a space’s members, newest first.')

  return {
    get: createRoute({
      method: 'get', path: `${at}/sharing`, operationId: 'getSharing', tags: [tag], summary: 'How a space is shared',
      description: 'The space’s name and title, and how many invites are open. Only those who may share see it; to anyone else every space is 404.',
      request: { params: z.object({ space }) },
      responses: { 200: ok('The space’s sharing.', SharingSchema), ...problemResponses(401, 404) },
    }),
    createInvite: createRoute({
      method: 'post', path: `${at}/invites`, operationId: 'createInvite', tags: [tag], summary: 'Invite someone to a space',
      description: 'Makes an invite for one person: a typed code, single use, within a day, shown only in this answer, with the space’s address and a message to send them (connect there, then type the code). An agent may invite for 7 or 30 days only. A retry with the same Idempotency-Key answers 409 `shown_once`, never the code again.',
      request: { params: z.object({ space }), body: { required: true, content: { 'application/json': { schema: InviteInputSchema } } } },
      responses: { 201: ok('The invite, its code shown this once.', NewInviteSchema), ...problemResponses(400, 401, 403, 404, 409) },
    }),
    listInvites: createRoute({
      method: 'get', path: `${at}/invites`, operationId: 'listInvites', tags: [tag], summary: 'A space’s invites',
      description: 'The space’s invites, newest first, each with its state. Never a code: each was shown once.',
      request: { params: z.object({ space }), query: z.object({ limit: limitQuery({ fallback: 50, max: 100 }), cursor: cursorQuery }) },
      responses: { 200: ok('A page of invites.', InvitePageSchema), ...problemResponses(400, 401, 404) },
    }),
    getInvite: createRoute({
      method: 'get', path: `${at}/invites/{id}`, operationId: 'getInvite', tags: [tag], summary: 'One invite',
      description: 'One of the space’s invites and its state. Never its code: it was shown once.',
      request: { params: z.object({ space, id }) },
      responses: { 200: ok('The invite.', InviteSchema), ...problemResponses(401, 404) },
    }),
    revokeInvite: createRoute({
      method: 'delete', path: `${at}/invites/{id}`, operationId: 'revokeInvite', tags: [tag], summary: 'Revoke an invite',
      description: 'Revokes an invite no one has used: its code stops working at once. Revoking it again is harmless; 409 when it was already used.',
      request: { params: z.object({ space, id }) },
      responses: { 204: { description: 'Revoked.' }, ...problemResponses(401, 403, 404, 409) },
    }),
    listMembers: createRoute({
      method: 'get', path: `${at}/members`, operationId: 'listMembers', tags: [tag], summary: 'A space’s members',
      description: 'The apps signed in to the space, newest first: active, or signed out (invite them again). Removed and replaced ones are not shown.',
      request: { params: z.object({ space }), query: z.object({ limit: limitQuery({ fallback: 50, max: 100 }), cursor: cursorQuery }) },
      responses: { 200: ok('A page of members.', MemberPageSchema), ...problemResponses(400, 401, 404) },
    }),
    getMember: createRoute({
      method: 'get', path: `${at}/members/{id}`, operationId: 'getMember', tags: [tag], summary: 'One member',
      description: 'One of the space’s members, as the list shows it. A removed or replaced member is 404.',
      request: { params: z.object({ space, id: memberId }) },
      responses: { 200: ok('The member.', MemberSchema), ...problemResponses(401, 404) },
    }),
    removeMember: createRoute({
      method: 'delete', path: `${at}/members/{id}`, operationId: 'removeMember', tags: [tag], summary: 'Remove a member',
      description: 'Ends the member’s sign-in at once (its next request is 401) and takes it off the list, signed out ones too. Its invite, and any Invite again made for it, never works again. Removing it again is harmless.',
      request: { params: z.object({ space, id: memberId }) },
      responses: { 204: { description: 'Removed.' }, ...problemResponses(401, 403, 404) },
    }),
    inviteAgain: createRoute({
      method: 'post', path: `${at}/members/{id}/invite-again`, operationId: 'inviteAgain', tags: [tag], summary: 'Invite a member again',
      description: 'A fresh invite with the member’s label, scope and lifetime, for a lost sign-in: shown once, as createInvite’s. Its earlier invites again are revoked, so only the newest works; once it is used, the old member is ended and its sign-in revoked. An agent may not re-invite a member who had until revoked. A retry with the same Idempotency-Key answers 409 `shown_once`.',
      request: { params: z.object({ space, id: memberId }) },
      responses: { 201: ok('The invite, its code shown this once.', NewInviteSchema), ...problemResponses(400, 401, 403, 404, 409) },
    }),
  }
}

export type SharingRoutes = ReturnType<typeof sharingRoutes>
