/**
 * The sharing part's grants on any database: a recipe box whose shelves are spaces, wired with `sharing.oauth`, and the
 * checks that must hold wherever the tables live. `test/sharing-grants.test.ts` runs them on node:sqlite,
 * `test/workers/sharing.test.ts` on D1. The sign-in pages come later: a bare page here posts the decision a test gives
 * to `oauth.complete`, as the part's pages will.
 */
import { createHash, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { decodeJwt } from 'jose'
import { describe, expect, it } from 'vitest'
import { createAgentApi, createOAuth, generateOAuthKey, hashApiKey, memoryOAuthStore, parseApiKeys, type Db, type OAuthConfig, type SignInDecision, type SignInRevoked } from '../src/index.js'
import { createSharing, registerSharing, sharingInvites, sharingMembers, sharingRepo, type SharingOptions, type Space } from '../src/sharing/index.js'
import { approveSignIn } from '../src/testing/index.js'
import { DAY, HOUR, inviteRow, memberRow } from './sharing-rows.js'

export const ORIGIN = 'http://localhost'
export const OWNER = 'owner@example.test'
export const SOUPS = `${ORIGIN}/s/soups/mcp`
export const BAKES = `${ORIGIN}/s/bakes/mcp`
export const REDIRECT = 'https://client-a.example.test/callback'
const KEY = 'owner-key'
const SECRET = 'a sharing secret of thirty-two bytes or more, for tests only'
const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code'

const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
/** A run's own suffix: D1 keeps one database per test file. */
export const unique = () => randomBytes(6).toString('hex')

type Invite = { id: string; label: string; scope: string; lifetime: string; state: string }
type Tokens = { access_token: string; refresh_token: string; error?: string; error_description?: string }

/** The grant an access token came from. */
export const grantOf = (token: string) => String(decodeJwt(token).grant)

/**
 * A recipe box with two shelves (Soups, Bakes) as spaces, `sharing.oauth` spread into `createOAuth`, and a bare sign-in
 * page, under `publicOrigin` (the part needs one). The owner (the `x-test-owner` header) gets the kit's own consent page. `byNameDelay` slows `spaces.byName`, as a
 * slow lookup inside `onGrant` would be.
 */
export const grantsApp = async (db: Db, { options = {}, oauth: oauthOptions = {}, byNameDelay = 0, publicOrigin = ORIGIN }: { options?: Partial<SharingOptions>; oauth?: Partial<OAuthConfig>; byNameDelay?: number; publicOrigin?: string } = {}) => {
  // Each app its own shelves, so a test may rename or delete one
  const shelves: Space[] = [{ id: 'sp_soups', name: 'soups', title: 'Soups' }, { id: 'sp_bakes', name: 'bakes', title: 'Bakes' }]
  const spaces = {
    byName: async (name: string) => (await pause(byNameDelay), shelves.find((shelf) => shelf.name === name) ?? null),
    byId: async (id: string) => shelves.find((shelf) => shelf.id === id) ?? null,
  }
  const owner = async (c: { req: { header: (name: string) => string | undefined } }) => c.req.header('x-test-owner') ?? null
  const sharing = await createSharing({ db, secret: SECRET, spaces, owner, fixedKeys: ['owner'], spaceOfPath: (path) => /^\/api\/shelves\/([^/]+)(\/|$)/.exec(path)?.[1] ?? null, ...options })
  const revoked: SignInRevoked[] = []
  const oauth = createOAuth({
    name: 'Sample', signingKey: await generateOAuthKey(), store: memoryOAuthStore(), owner, owners: [OWNER], publicOrigin,
    ...sharing.oauth,
    approve: async (c, ask) => (c.req.header('x-test-owner') ? null : c.html(`<form method="post" action="/test/join"><input type="hidden" name="ticket" value="${ask.ticket}"></form>`)),
    onRevoke: async (told) => {
      revoked.push(told)
      await sharing.oauth.onRevoke(told)
    },
    ...oauthOptions,
  })
  const app = createAgentApi({
    title: 'Sample', version: '1.0.0', description: 'A recipe box.', tags: [],
    auth: { realm: 'sample', keys: parseApiKeys(`owner:${hashApiKey(KEY)}`), open: ['/test/join'], relay: ['/mcp', '/a2a', sharing.relay] },
    oauth,
  })
  app.post('/test/join', async (c) => {
    const body = await c.req.parseBody()
    return oauth.complete(c, String(body.ticket ?? ''), JSON.parse(String(body.decision)) as SignInDecision)
  })
  const seen = (c: { req: { path: string }; json: (body: unknown) => Response }) => c.json({ path: c.req.path })
  app.get('/s/:space/mcp', seen)
  app.get('/s/:space/mcp/member', async (c) => c.json({ member: await sharing.memberOf(c) }))
  app.get('/mcp', seen)
  app.get('/api/shelves/:shelf/recipes', seen)
  app.get('/api/elsewhere', seen)
  await registerSharing(app, sharing, { oauth })
  const repo = sharingRepo(db)

  /** Calls the API with a bearer: a key or a token. */
  const as = (bearer: string) => (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
  const byKey = as(KEY)
  const makeInvite = async (space = 'soups', body: Record<string, unknown> = { label: 'Sam' }, call = byKey) => {
    const made = await call(`/api/spaces/${space}/invites`, { method: 'POST', body })
    expect(made.status, await made.clone().text()).toBe(201)
    return (await made.json()) as Invite
  }
  const inviteState = async (id: string, space = 'soups') => ((await (await byKey(`/api/spaces/${space}/invites/${id}`)).json()) as Invite).state

  /** A client registered with `name` and `redirect`, signed in at the bare page with `decision`: what exchanges its code. */
  const signIn = async ({ decision, resource, scope = 'read write', name = 'Sample', redirect = REDIRECT }: { decision: SignInDecision; resource?: string; scope?: string; name?: string; redirect?: string }) => {
    const client_id = (await (await app.request('/oauth/register', json({ client_name: name, redirect_uris: [redirect] }))).json()).client_id as string
    const verifier = randomBytes(32).toString('base64url')
    const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope, ...(resource === undefined ? {} : { resource }) })
    const page = await approveSignIn(app, query, { form: { action: '/test/join', fields: { decision: JSON.stringify(decision) } } })
    expect(page.status, await page.clone().text()).toBe(302)
    const code = new URL(page.headers.get('location')!).searchParams.get('code')!
    const exchange = () => app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier }))
    return { client_id, exchange }
  }
  /** The decision the invite page makes: the invite's approver, read, its space, and the part's data. */
  const inviteDecision = (invite: Pick<Invite, 'id'>, change: { scopes?: string[]; resource?: string; approver?: string } = {}): SignInDecision => ({
    approver: change.approver ?? `invite:${invite.id}`,
    scopes: change.scopes ?? ['read'],
    resource: change.resource ?? SOUPS,
    data: { sharing: 'invite', invite: invite.id, returnsTo: 'client-a.example.test' },
  })
  /** Joins with an invite at Soups: the token answer and its client. */
  const join = async (invite: Pick<Invite, 'id'>, change: { scopes?: string[]; resource?: string; approver?: string; asked?: string; name?: string } = {}) => {
    const { client_id, exchange } = await signIn({ decision: inviteDecision(invite, change), resource: change.asked ?? SOUPS, name: change.name })
    const answer = await exchange()
    return { status: answer.status, tokens: (await answer.json()) as Tokens, client_id }
  }
  /** The owner signs in at the kit's own page: a root token (or one for `resource`). */
  const ownerSignsIn = async (resource?: string) => {
    const client_id = (await (await app.request('/oauth/register', json({ client_name: 'Sample', redirect_uris: [REDIRECT] }))).json()).client_id as string
    const verifier = randomBytes(32).toString('base64url')
    const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope: 'read write', ...(resource === undefined ? {} : { resource }) })
    const page = await approveSignIn(app, query, { headers: { 'x-test-owner': OWNER } })
    const code = new URL(page.headers.get('location')!).searchParams.get('code')!
    const answer = await app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier }))
    return { status: answer.status, tokens: (await answer.json()) as Tokens, client_id }
  }
  /** A device signs in, the owner approving its code at the kit's page: the token answer. */
  const deviceSignsIn = async (resource?: string) => {
    const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [DEVICE] }))).json()
    const { device_code, user_code } = await (await app.request('/oauth/device_authorization', form({ client_id, ...(resource === undefined ? {} : { resource }) }))).json()
    await app.request('/oauth/device', { ...form({ user_code, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
    const answer = await app.request('/oauth/token', form({ grant_type: DEVICE, device_code, client_id }))
    return { status: answer.status, tokens: (await answer.json()) as Tokens }
  }
  const call = (path: string, token: string) => app.request(path, { headers: { authorization: `Bearer ${token}` } })
  const memberOfToken = (token: string) => repo.memberByGrant(grantOf(token))
  const membersOfInvite = (inviteId: string) => db.select().from(sharingMembers).where(eq(sharingMembers.inviteId, inviteId))
  /** Moves a member's times, as days passing would. */
  const ageMember = (grantId: string, change: { expiresAt?: string; lastSeenAt?: string }) => db.update(sharingMembers).set(change).where(eq(sharingMembers.grantId, grantId))
  const ageInvite = (id: string, redeemBy: string) => db.update(sharingInvites).set({ redeemBy }).where(eq(sharingInvites.id, id))

  return { app, oauth, sharing, repo, shelves, revoked, as, byKey, makeInvite, inviteState, signIn, inviteDecision, join, ownerSignsIn, deviceSignsIn, call, memberOfToken, membersOfInvite, ageMember, ageInvite }
}

/** The checks that hold on every database the part runs on. */
export const sharingGrantsContract = (name: string, makeDb: () => Promise<Db>) =>
  describe(`sharing grants (${name})`, () => {
    it('make one member when two exchanges claim one invite at once', async () => {
      const box = await grantsApp(await makeDb())
      const invite = await box.makeInvite()
      const first = await box.signIn({ decision: box.inviteDecision(invite), resource: SOUPS })
      const second = await box.signIn({ decision: box.inviteDecision(invite), resource: SOUPS })
      const answers = await Promise.all([first.exchange(), second.exchange()])
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400])
      const loser = answers.find((answer) => answer.status === 400)!
      expect((await loser.json()).error).toBe('invalid_grant')
      expect(await box.membersOfInvite(invite.id)).toHaveLength(1)
      expect(await box.inviteState(invite.id)).toBe('redeemed')
    })

    it('end the right rows for every onRevoke reason, the same when told twice', async () => {
      const db = await makeDb()
      const { sharing } = await grantsApp(db)
      const repo = sharingRepo(db)
      const now = new Date()
      const run = unique()
      const grant = (label: string) => `${label}-${run}`
      const client = `client-gone-${run}`
      for (const one of ['revoked', 'replayed', 'withdrawn', 'bystander']) await repo.addOwnerMember(memberRow('sp_soups', now, grant(one)))
      await repo.addOwnerMember(memberRow('sp_soups', now, grant('client-a'), { clientId: client }))
      await repo.addOwnerMember(memberRow('sp_bakes', now, grant('client-b'), { clientId: client }))
      // Invites an agent made: open ones end with its grant or client, a redeemed one stays redeemed
      const byAgent = (label: string, change: Parameters<typeof inviteRow>[3]) => repo.addInvite(inviteRow('sp_soups', now, `${label}-${run}`, change))
      const madeUnderRevoked = (await byAgent('agent-open', { madeByGrant: grant('revoked'), madeByClient: `agent-${run}` }))!
      const madeUnderWithdrawn = (await byAgent('agent-withdrawn', { madeByGrant: grant('withdrawn'), madeByClient: `agent-w-${run}` }))!
      const madeByGoneClient = (await byAgent('client-open', { madeByGrant: `other-${run}`, madeByClient: client }))!
      const redeemed = (await byAgent('agent-redeemed', { madeByGrant: grant('revoked'), madeByClient: `agent-${run}` }))!
      await repo.claimInvite(redeemed, memberRow('sp_soups', now, grant('joined')), now)

      const tell = async () => {
        await sharing.oauth.onRevoke({ grant: grant('revoked'), reason: 'revoked' })
        await sharing.oauth.onRevoke({ grant: grant('replayed'), client: `client-${grant('replayed')}`, reason: 'replayed' })
        await sharing.oauth.onRevoke({ grant: grant('withdrawn'), client: `client-${grant('withdrawn')}`, reason: 'withdrawn' })
        await sharing.oauth.onRevoke({ client, reason: 'client_revoked' })
      }
      const rows = async () => {
        const members = await Promise.all(['revoked', 'replayed', 'withdrawn', 'bystander', 'client-a', 'client-b', 'joined'].map(async (one) => (await repo.memberByGrant(grant(one))) ?? null))
        const invites = await Promise.all([madeUnderRevoked, madeUnderWithdrawn, madeByGoneClient, redeemed].map(async (id) => (await repo.inviteAt('sp_soups', id))?.revokedAt ?? null))
        return { members: members.map((row) => row && { endedReason: row.endedReason, endedAt: row.endedAt }), invites }
      }
      await tell()
      const once = await rows()
      expect(once.members.map((row) => (row ? row.endedReason : 'deleted'))).toEqual(['revoked', 'replayed', 'deleted', null, 'client_revoked', 'client_revoked', null])
      expect(once.invites.map(Boolean)).toEqual([true, false, true, false])
      await tell()
      expect(await rows()).toEqual(once)
    })

    it('accept a member token at its space only, then refuse it once its lifetime or 30 unseen days pass', async () => {
      const box = await grantsApp(await makeDb())
      const joined = await box.join(await box.makeInvite())
      expect(joined.status).toBe(200)
      const token = joined.tokens.access_token
      expect((await box.call('/s/soups/mcp', token)).status).toBe(200)
      expect((await box.call('/s/bakes/mcp', token)).status).toBe(401)

      const grant = grantOf(token)
      const past = new Date(Date.now() - HOUR).toISOString()
      await box.ageMember(grant, { expiresAt: past })
      const expired = await box.call('/s/soups/mcp', token)
      expect([expired.status, expired.headers.get('www-authenticate')]).toEqual([401, expect.stringContaining('This access ended on')])

      // Unseen for 30 days: refused, and the refused request never counts as a use
      const unseen = new Date(Date.now() - 31 * DAY).toISOString()
      await box.ageMember(grant, { expiresAt: new Date(Date.now() + DAY).toISOString(), lastSeenAt: unseen })
      const lapsed = await box.call('/s/soups/mcp', token)
      expect([lapsed.status, lapsed.headers.get('www-authenticate')]).toEqual([401, expect.stringContaining('unused for 30 days')])
      expect((await box.memberOfToken(token))?.lastSeenAt).toBe(unseen)
    })

    it('end every member a client made when the client is revoked, and its tokens stop', async () => {
      const box = await grantsApp(await makeDb())
      const joined = await box.join(await box.makeInvite())
      await box.oauth.revokeClient(joined.client_id)
      expect((await box.memberOfToken(joined.tokens.access_token))?.endedReason).toBe('client_revoked')
      expect((await box.call('/s/soups/mcp', joined.tokens.access_token)).status).toBe(401)
    })
  })
