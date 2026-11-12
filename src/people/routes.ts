/** The people routes as OpenAPI contracts: signing in with a passkey, the session, and the team. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema } from '../core/hal.js'
import { problemResponses } from '../core/problem.js'

const role = z.enum(['owner', 'member']).openapi({ description: '`owner` may do everything; `member` everything but admin (team, keys, setup).', example: 'member' })

export const PersonSchema = z
  .object({
    id: z.string().openapi({ example: 'prs_0mh2k1x9zabcdefghjk' }),
    email: z.string().openapi({ example: 'ana@example.com' }),
    role,
    name: z.string().nullable(),
    createdAt: z.string(),
    lastSeenAt: z.string().nullable(),
  })
  .openapi('Person', { description: 'Someone on the team: the owner, or a member.' })

const SessionSchema = z
  .object({
    signedIn: z.boolean().openapi({ description: 'Whether this browser has a session.' }),
    person: z.union([PersonSchema, z.null()]),
    passkeys: z.number().int().openapi({ description: 'How many passkeys this person has.' }),
    _links: LinksSchema,
  })
  .openapi('Session', { description: 'Who this browser is signed in as, if anyone.' })

const WebAuthnOptionsSchema = z
  .object({
    challengeId: z.string().openapi({ description: 'Send it back with the response.' }),
    options: z.record(z.string(), z.unknown()).openapi({ description: 'Hand to `navigator.credentials.create` (register) or `.get` (sign in), through @simplewebauthn/browser.' }),
  })
  .openapi('WebAuthnOptions', { description: 'A WebAuthn challenge for the browser to answer.' })

const PasskeySchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    deviceType: z.string().openapi({ description: '`singleDevice` or `multiDevice` (synced).' }),
    backedUp: z.boolean(),
    rpId: z.string().openapi({ description: 'The host it was made on: a passkey works only there.', example: 'mail.example.com' }),
    createdAt: z.string(),
    lastUsedAt: z.string().nullable(),
  })
  .openapi('Passkey', { description: 'A passkey that signs this person in.' })

const TeamSchema = z
  .object({
    people: z.array(PersonSchema),
    domains: z.array(z.object({ domain: z.string(), createdAt: z.string(), createdBy: z.string() })).openapi({ description: 'Email domains whose people are members without being listed.' }),
    _links: LinksSchema,
  })
  .openapi('Team', { description: 'Who may sign in, and with which role.' })

const TeamInputSchema = z
  .object({
    email: z.email().optional().openapi({ description: 'A person to let in.', example: 'ana@example.com' }),
    domain: z
      .string()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
      .optional()
      .openapi({ description: 'Or a whole email domain, as members.', example: 'example.com' }),
    role: role.optional().openapi({ description: 'For a person: `member` unless given.' }),
    name: z.string().max(80).optional(),
  })
  .openapi('TeamInput', { description: 'A person (email, role) or an email domain to add to the team.' })

const json = <Schema extends z.ZodTypeAny>(description: string, schema: Schema) => ({ content: { [HAL_JSON]: { schema } }, description })
const body = <Schema extends z.ZodTypeAny>(schema: Schema) => ({ body: { required: true, content: { 'application/json': { schema } } } })
const id = z.string().min(1).max(200).openapi({ description: 'The id from the list.', example: 'prs_0mh2k1x9zabcdefghjk' })

export const peopleRoutes = ({ sessionPath, teamPath, tag }: { sessionPath: string; teamPath: string; tag: string }) => ({
  session: createRoute({
    method: 'get',
    path: sessionPath,
    operationId: 'getSession',
    tags: [tag],
    summary: 'This browser’s session',
    description: 'Who this browser is signed in as, or `signedIn: false`. Never needs a key: a page asks it to decide between the app and the sign-in screen.',
    security: [],
    responses: { 200: json('The session.', SessionSchema) },
  }),
  signOut: createRoute({
    method: 'delete',
    path: sessionPath,
    operationId: 'signOut',
    tags: [tag],
    summary: 'Sign out',
    description: 'Ends this browser’s session and clears its cookie. Other browsers stay signed in.',
    security: [],
    responses: { 204: { description: 'Signed out.' } },
  }),
  registerOptions: createRoute({
    method: 'post',
    path: `${sessionPath}/passkeys/register/options`,
    operationId: 'passkeyRegisterOptions',
    tags: [tag],
    summary: 'Start adding a passkey',
    description: 'A WebAuthn registration challenge. Signed in, it adds a passkey to you; with an `enrolment` (from claiming or recovering a deployment) it makes your first one.',
    security: [],
    request: body(z.object({ enrolment: z.string().optional().openapi({ description: 'The enrolment from setup, when not signed in.' }) }).openapi('PasskeyRegisterInput', { description: 'An enrolment, or nothing when signed in.' })),
    responses: { 200: json('The challenge.', WebAuthnOptionsSchema), ...problemResponses(400, 401) },
  }),
  registerVerify: createRoute({
    method: 'post',
    path: `${sessionPath}/passkeys/register/verify`,
    operationId: 'passkeyRegisterVerify',
    tags: [tag],
    summary: 'Finish adding a passkey',
    description: 'Checks the browser’s answer, stores the passkey, and signs this browser in.',
    security: [],
    request: body(
      z
        .object({
          challengeId: z.string(),
          response: z.record(z.string(), z.unknown()).openapi({ description: 'What `navigator.credentials.create` gave back, as JSON.' }),
          enrolment: z.string().optional(),
          name: z.string().max(60).optional().openapi({ description: 'A name to tell this passkey apart, e.g. "MacBook".' }),
        })
        .openapi('PasskeyRegisterAnswer', { description: 'The browser’s answer to a registration challenge.' }),
    ),
    responses: { 200: json('Signed in.', SessionSchema), ...problemResponses(400, 401) },
  }),
  loginOptions: createRoute({
    method: 'post',
    path: `${sessionPath}/passkeys/login/options`,
    operationId: 'passkeyLoginOptions',
    tags: [tag],
    summary: 'Start signing in with a passkey',
    description: 'A WebAuthn sign-in challenge any passkey made on this host can answer.',
    security: [],
    responses: { 200: json('The challenge.', WebAuthnOptionsSchema), ...problemResponses(400) },
  }),
  loginVerify: createRoute({
    method: 'post',
    path: `${sessionPath}/passkeys/login/verify`,
    operationId: 'passkeyLoginVerify',
    tags: [tag],
    summary: 'Finish signing in with a passkey',
    description: 'Checks the browser’s answer and signs it in for 30 days.',
    security: [],
    request: body(
      z
        .object({ challengeId: z.string(), response: z.record(z.string(), z.unknown()).openapi({ description: 'What `navigator.credentials.get` gave back, as JSON.' }) })
        .openapi('PasskeyLoginAnswer', { description: 'The browser’s answer to a sign-in challenge.' }),
    ),
    responses: { 200: json('Signed in.', SessionSchema), ...problemResponses(400, 401) },
  }),
  passkeys: createRoute({
    method: 'get',
    path: `${sessionPath}/passkeys`,
    operationId: 'listPasskeys',
    tags: [tag],
    summary: 'Your passkeys',
    description: 'The passkeys that sign you in, and the host each works on.',
    responses: { 200: json('Your passkeys.', z.object({ _embedded: z.object({ passkeys: z.array(PasskeySchema) }), _links: LinksSchema }).openapi('PasskeyList', { description: 'Your passkeys.' })), ...problemResponses(401, 403) },
  }),
  removePasskey: createRoute({
    method: 'delete',
    path: `${sessionPath}/passkeys/{id}`,
    operationId: 'removePasskey',
    tags: [tag],
    summary: 'Remove one of your passkeys',
    description: 'It no longer signs you in. Your last passkey can be removed only when you can sign in another way (Cloudflare Access).',
    request: { params: z.object({ id }) },
    responses: { 204: { description: 'Removed.' }, ...problemResponses(401, 403, 404, 409) },
  }),
  team: createRoute({
    method: 'get',
    path: teamPath,
    operationId: 'getTeam',
    tags: [tag],
    summary: 'The team',
    description: 'Everyone who may sign in, with their role, and the email domains let in as members.',
    responses: { 200: json('The team.', TeamSchema), ...problemResponses(401) },
  }),
  addToTeam: createRoute({
    method: 'post',
    path: teamPath,
    operationId: 'addToTeam',
    tags: [tag],
    summary: 'Add someone to the team',
    description: 'Lets a person (by email) or a whole email domain sign in through Cloudflare Access. Owner only.',
    request: body(TeamInputSchema),
    responses: { 201: json('The team as it is now.', TeamSchema), ...problemResponses(400, 401, 403, 409) },
  }),
  changeRole: createRoute({
    method: 'patch',
    path: `${teamPath}/people/{id}`,
    operationId: 'changeTeamRole',
    tags: [tag],
    summary: 'Change someone’s role',
    description: 'Makes a member an owner or the other way round. The last owner stays an owner. Owner only.',
    request: { params: z.object({ id }), ...body(z.object({ role }).openapi('RoleInput', { description: 'The new role.' })) },
    responses: { 200: json('The person.', PersonSchema), ...problemResponses(400, 401, 403, 404, 409) },
  }),
  removeFromTeam: createRoute({
    method: 'delete',
    path: `${teamPath}/people/{id}`,
    operationId: 'removeFromTeam',
    tags: [tag],
    summary: 'Remove someone from the team',
    description: 'Signs them out everywhere and deletes their passkeys. The last owner cannot be removed. Owner only.',
    request: { params: z.object({ id }) },
    responses: { 204: { description: 'Removed.' }, ...problemResponses(401, 403, 404, 409) },
  }),
  removeDomain: createRoute({
    method: 'delete',
    path: `${teamPath}/domains/{domain}`,
    operationId: 'removeTeamDomain',
    tags: [tag],
    summary: 'Stop letting a domain in',
    description: 'People of this email domain no longer sign in, unless listed one by one. Owner only.',
    request: { params: z.object({ domain: z.string().openapi({ description: 'The domain, as listed.', example: 'example.com' }) }) },
    responses: { 204: { description: 'Removed.' }, ...problemResponses(401, 403, 404) },
  }),
})

export type PeopleRoutes = ReturnType<typeof peopleRoutes>
