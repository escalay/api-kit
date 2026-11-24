/** The sharing part's grants: which grants become members, which tokens fit which request, and what ends them. */
import { decodeJwt } from 'jose'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { testDb, type SignInAsk, type SignInGrant, type TokenCaller } from '../src/index.js'
import { appNameOf, createSharing } from '../src/sharing/index.js'
import { BAKES, grantOf, grantsApp, ORIGIN, OWNER, sharingGrantsContract, SOUPS } from './sharing-grants-contract.js'
import { HOUR } from './sharing-rows.js'

sharingGrantsContract('node:sqlite', testDb)

const box = async (options: Parameters<typeof grantsApp>[1] = {}) => grantsApp(await testDb(), options)
/** What a 401 says, from its challenge. */
const refusalOf = (answer: Response) => /error_description="([^"]*)"/.exec(answer.headers.get('www-authenticate') ?? '')?.[1] ?? null
const ONLY_ITS_SPACE = 'This sign-in works only at its own space: connect again from the address you were given.'

describe('the space addresses', () => {
  it('are issued for by a pure check of the path: one plain name between the address’s two halves (probe T6)', async () => {
    const { sharing } = await box()
    const issued = ['/s/soups/mcp', '/s/bakes/mcp', '/s/a-1/mcp', '/s/Soups/mcp', '/s/%73oups/mcp', '/s/soups%2Fx/mcp', '/s/../mcp', '/s/-soups/mcp', '/s//mcp', '/s/soups/mcp/x', '/s/soups', '/mcp', ''].map((path) => [path, sharing.oauth.resources(path)])
    expect(issued).toEqual([
      ['/s/soups/mcp', true], ['/s/bakes/mcp', true], ['/s/a-1/mcp', true],
      ['/s/Soups/mcp', false], ['/s/%73oups/mcp', false], ['/s/soups%2Fx/mcp', false], ['/s/../mcp', false], ['/s/-soups/mcp', false], ['/s//mcp', false],
      ['/s/soups/mcp/x', false], ['/s/soups', false], ['/mcp', false], ['', false],
    ])
    const moved = await createSharing({ db: await testDb(), secret: 'a sharing secret of thirty-two bytes or more, for tests only', spaces: { byName: async () => null, byId: async () => null }, owner: async () => null, resourcePath: '/box/{space}/tools/mcp' })
    expect([moved.oauth.resources('/box/soups/tools/mcp'), moved.oauth.resources('/box/soups/mcp'), moved.oauth.resources('/s/soups/mcp')]).toEqual([true, false, false])
  })

  it('refuse a cased, encoded or dotted space at authorize, and serve no metadata for it (probe T6)', async () => {
    const { app } = await box()
    for (const resource of [`${ORIGIN}/s/Soups/mcp`, `${ORIGIN}/s/%73oups/mcp`, `${ORIGIN}/s/soups%2Fx/mcp`, `${ORIGIN}/s/%2e%2e/mcp`]) {
      const client_id = (await (await app.request('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Sample', redirect_uris: ['https://client-a.example.test/callback'] }) })).json()).client_id
      const page = await app.request(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://client-a.example.test/callback', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource })}`)
      expect([resource, page.status, page.headers.get('location')]).toEqual([resource, 400, null])
    }
    expect((await app.request('/.well-known/oauth-protected-resource/s/soups/mcp')).status).toBe(200)
    expect((await app.request('/.well-known/oauth-protected-resource/s/Soups/mcp')).status).toBe(404)
  })

  it('point a 401 at the space a request is for, under publicOrigin whatever the host header says', async () => {
    const { app } = await box({ publicOrigin: 'https://sample.example.test' })
    const pointer = async (path: string) => /resource_metadata="([^"]+)"/.exec((await app.request(`http://forged.example.test${path}`, { headers: { 'x-forwarded-host': 'forged.example.test' } })).headers.get('www-authenticate') ?? '')?.[1]
    const at = 'https://sample.example.test/.well-known/oauth-protected-resource'
    expect([await pointer('/s/soups/mcp'), await pointer('/s/soups/mcp/member'), await pointer('/mcp'), await pointer('/api/shelves/soups/recipes')]).toEqual([`${at}/s/soups/mcp`, `${at}/s/soups/mcp`, `${at}/mcp`, at])
  })

  it('are what handles answers for: a space, the root and the root MCP, never another resource', async () => {
    const { sharing } = await box()
    const handles = (resource: string) => sharing.handles({ resource } as SignInAsk)
    expect([handles(SOUPS), handles(ORIGIN), handles(`${ORIGIN}/mcp`), handles(`${ORIGIN}/s/Soups/mcp`), handles(`${ORIGIN}/docs/mcp`)]).toEqual([true, true, true, false, false])
  })
})

describe('onGrant', () => {
  it('makes an invite work once, in time, at its space only', async () => {
    const { makeInvite, join, inviteState, byKey, ageInvite } = await box()
    const used = await makeInvite()
    expect((await join(used)).status).toBe(200)
    const again = await join(used)
    expect([again.status, again.tokens.error]).toEqual([400, 'invalid_grant'])

    const revoked = await makeInvite()
    expect((await byKey(`/api/spaces/soups/invites/${revoked.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await join(revoked)).status).toBe(400)

    const late = await makeInvite()
    await ageInvite(late.id, new Date(Date.now() - HOUR).toISOString())
    expect((await join(late)).status).toBe(400)

    // A Bakes invite at Soups gives nothing and spends nothing; nor does a Soups invite at Bakes
    const bakes = await makeInvite('bakes')
    expect((await join(bakes)).status).toBe(400)
    expect(await inviteState(bakes.id, 'bakes')).toBe('open')
    const soups = await makeInvite()
    expect((await join(soups, { resource: BAKES, asked: BAKES })).status).toBe(400)
    expect(await inviteState(soups.id)).toBe('open')
  })

  it('withdraws a space grant made around the part: a device grant, a code from the kit’s page, data it does not know', async () => {
    const { deviceSignsIn, ownerSignsIn, makeInvite, signIn, revoked } = await box()
    const device = await deviceSignsIn(SOUPS)
    expect([device.status, device.tokens.error]).toEqual([400, 'invalid_grant'])
    const consent = await ownerSignsIn(SOUPS)
    expect([consent.status, consent.tokens.error]).toEqual([400, 'invalid_grant'])
    const invite = await makeInvite()
    for (const sharing of ['request', 'guest']) {
      const { exchange } = await signIn({ resource: SOUPS, decision: { approver: `invite:${invite.id}`, scopes: ['read'], data: { sharing, invite: invite.id } } })
      expect((await exchange()).status).toBe(400)
    }
    expect(revoked.filter((told) => told.reason === 'withdrawn')).toHaveLength(4)

    // A resource of the app's own beside the spaces is no space: its grant is withdrawn too
    const docs = `${ORIGIN}/docs/mcp`
    const own = await box({ oauth: { resources: (path) => path === '/docs/mcp' } })
    const answer = await own.ownerSignsIn(docs)
    expect([answer.status, answer.tokens.error]).toEqual([400, 'invalid_grant'])
  })

  it('never lets a sharing approval make a root grant', async () => {
    const { signIn, inviteDecision, makeInvite, inviteState } = await box()
    const invite = await makeInvite()
    const { resource: _space, ...unbound } = inviteDecision(invite) as Exclude<ReturnType<typeof inviteDecision>, 'deny'>
    // A client that named nothing, completed without the space; and one that named the root
    for (const asked of [undefined, ORIGIN, `${ORIGIN}/mcp`]) {
      const { exchange } = await signIn({ resource: asked, decision: unbound })
      const answer = await exchange()
      expect([asked, answer.status]).toEqual([asked, 400])
    }
    expect(await inviteState(invite.id)).toBe('open')
  })

  it('gives no more than the invite, and only under its own approver', async () => {
    const { join, makeInvite, inviteState, memberOfToken } = await box()
    const read = await makeInvite()
    expect((await join(read, { scopes: ['read', 'write'] })).status).toBe(400)
    expect((await join(read, { approver: OWNER })).status).toBe(400)
    const other = await makeInvite()
    expect((await join(read, { approver: `invite:${other.id}` })).status).toBe(400)
    expect(await inviteState(read.id)).toBe('open')

    const write = await makeInvite('soups', { label: 'Ada', scope: 'write', lifetime: '7d' })
    const narrowed = await join(write, { scopes: ['read'] })
    expect(narrowed.status).toBe(200)
    expect(await memberOfToken(narrowed.tokens.access_token)).toMatchObject({ label: 'Ada', scope: 'read', lifetime: '7d', via: 'invite', inviteId: write.id, spaceId: 'sp_soups', returnsTo: 'client-a.example.test' })
  })

  it('keeps the client’s name after the character rule: no control, bidi or zero-width characters, 80 at most', async () => {
    const { makeInvite, join, memberOfToken } = await box()
    const joined = await join(await makeInvite(), { name: `Sam\u202Eppa\u200B\u0007 ${'x'.repeat(100)}` })
    const { appName } = (await memberOfToken(joined.tokens.access_token))!
    // The kit keeps 80 characters of a registered name; the rule then drops the hidden ones
    expect(appName).toBe(`Samppa ${'x'.repeat(70)}`)
    expect([appNameOf('y'.repeat(100)), appNameOf('\u200B\u202E')]).toEqual(['y'.repeat(80), 'An unnamed client'])
  })

  it('makes the owner’s approval at a space a member, never an owner token', async () => {
    const { signIn, call, memberOfToken } = await box()
    const ownerDecision = (change: Record<string, string> = {}) => ({ approver: change.approver ?? `owner:${OWNER}`, scopes: ['read', 'write'], resource: SOUPS, data: { sharing: 'owner', space: change.space ?? 'sp_soups', lifetime: change.lifetime ?? '30d', returnsTo: 'client-a.example.test' } })
    const approved = await (await (await signIn({ resource: SOUPS, decision: ownerDecision() })).exchange()).json()
    expect(decodeJwt(approved.access_token).sub).toBe(`owner:${OWNER}`)
    expect(await memberOfToken(approved.access_token)).toMatchObject({ via: 'owner', scope: 'write', lifetime: '30d', label: 'Sample', inviteId: null })
    expect((await call('/s/soups/mcp', approved.access_token)).status).toBe(200)
    for (const elsewhere of ['/mcp', '/api/elsewhere', '/api/spaces/soups/invites']) expect([elsewhere, (await call(elsewhere, approved.access_token)).status]).toEqual([elsewhere, 401])
    // The bare email as approver, another space's id, a lifetime the part has not: withdrawn
    for (const change of [{ approver: OWNER }, { space: 'sp_bakes' }, { lifetime: 'forever' }] as Record<string, string>[]) {
      const answer = await (await signIn({ resource: SOUPS, decision: ownerDecision(change) })).exchange()
      expect([change, answer.status]).toEqual([change, 400])
    }
  })

  it('leaves the owner’s root sign-in, a device grant and an aud-less token working everywhere', async () => {
    const { ownerSignsIn, deviceSignsIn, call, app, sharing } = await box()
    app.get('/probe/aud-less', async (c) => c.json({ judged: await sharing.oauth.accepts({ kind: 'agent', name: 'Old', client: 'client-old', scopes: ['read'], owner: OWNER }, c) }))
    const root = await ownerSignsIn()
    const mcp = await ownerSignsIn(`${ORIGIN}/mcp`)
    const device = await deviceSignsIn()
    for (const signedIn of [root, mcp, device]) {
      expect(signedIn.status).toBe(200)
      for (const path of ['/mcp', '/api/elsewhere', '/s/soups/mcp', '/api/shelves/bakes/recipes']) expect([path, (await call(path, signedIn.tokens.access_token)).status]).toEqual([path, 200])
    }
    expect(await (await app.request('/probe/aud-less', { headers: { authorization: 'Bearer owner-key' } })).json()).toEqual({ judged: true })
  })

  it('leaves the invite open when the app’s veto comes after the claim (probe T7)', async () => {
    let veto = true
    // The app chained the wrong way round: the part claims, then the app says no; the kit withdraws the grant
    const chained: Awaited<ReturnType<typeof grantsApp>> = await box({ oauth: { onGrant: async (grant, c) => (await chained.sharing.oauth.onGrant(grant, c)) && !veto } })
    const invite = await chained.makeInvite()
    const refused = await chained.join(invite)
    expect([refused.status, refused.tokens.error_description]).toEqual([400, 'This sign-in was withdrawn: start again.'])
    expect(chained.revoked.at(-1)?.reason).toBe('withdrawn')
    expect(await chained.membersOfInvite(invite.id)).toEqual([])
    expect(await chained.inviteState(invite.id)).toBe('open')
    veto = false
    expect((await chained.join(invite)).status).toBe(200)
  })

  it('spends the invite when the exchange throws after the claim, and a retried exchange ends its member', async () => {
    // The app chained the wrong way round, and its hook threw: the kit issues nothing and tells no one
    const chained: Awaited<ReturnType<typeof grantsApp>> = await box({
      oauth: { onGrant: async (grant, c) => (await chained.sharing.oauth.onGrant(grant, c)) && Promise.reject(new Error('the app’s store is down')) },
    })
    const invite = await chained.makeInvite()
    const { exchange } = await chained.signIn({ resource: SOUPS, decision: chained.inviteDecision(invite) })
    expect((await exchange()).status).toBe(500)
    const [member] = await chained.membersOfInvite(invite.id)
    expect([await chained.inviteState(invite.id), member?.endedReason, chained.revoked]).toEqual(['redeemed', null, []])
    // The code is spent, so the client's retry is a replay: the kit ends the grant and the part its row
    expect((await exchange()).status).toBe(400)
    const [ended] = await chained.membersOfInvite(invite.id)
    expect([await chained.inviteState(invite.id), ended?.endedReason]).toEqual(['redeemed', 'replayed'])
  })

  it('leaves no live member after a retried exchange while onGrant runs (race.mts)', async () => {
    const { makeInvite, signIn, inviteDecision, membersOfInvite, revoked } = await box({ byNameDelay: 50 })
    const invite = await makeInvite()
    const { exchange } = await signIn({ resource: SOUPS, decision: inviteDecision(invite) })
    const first = exchange()
    await new Promise((done) => setTimeout(done, 10))
    const answers = await Promise.all([first, exchange()])
    expect(answers.map((answer) => answer.status)).toEqual([400, 400])
    const [member] = await membersOfInvite(invite.id)
    expect(member?.endedReason).toBe('replayed')
    expect(revoked.filter((told) => told.grant === member?.grantId).map((told) => told.reason)).toEqual(['replayed', 'replayed'])
  })

  it('races revokeInvite either way round to one outcome: joined and not revoked, or revoked and not joined', async () => {
    for (const order of ['exchange first', 'revoke first']) {
      const { makeInvite, signIn, inviteDecision, byKey, inviteState, membersOfInvite } = await box()
      const invite = await makeInvite()
      const { exchange } = await signIn({ resource: SOUPS, decision: inviteDecision(invite) })
      const revoke = () => byKey(`/api/spaces/soups/invites/${invite.id}`, { method: 'DELETE' })
      const [exchanged, revokedAnswer] = order === 'exchange first' ? await Promise.all([exchange(), revoke()]) : (await Promise.all([revoke(), exchange()])).reverse()
      const outcome = [exchanged!.status, revokedAnswer!.status, await inviteState(invite.id), (await membersOfInvite(invite.id)).length]
      expect([[200, 409, 'redeemed', 1], [400, 204, 'revoked', 0]]).toContainEqual(outcome)
    }
  })
})

describe('accepts', () => {
  it('opens a member token at its space and nothing else, alike for a real and a missing space', async () => {
    const { makeInvite, join, call } = await box()
    const token = (await join(await makeInvite())).tokens.access_token
    for (const path of ['/s/soups/mcp', '/s/soups/mcp/member', '/api/shelves/soups/recipes']) expect([path, (await call(path, token)).status]).toEqual([path, 200])
    const refused = await Promise.all(['/s/bakes/mcp', '/s/pies/mcp', '/mcp', '/api/elsewhere', '/api/shelves/bakes/recipes', '/api/spaces/soups/invites'].map(async (path) => {
      const answer = await call(path, token)
      return [path, answer.status, refusalOf(answer)]
    }))
    for (const [path, status, sentence] of refused) expect([path, status, sentence]).toEqual([path, 401, ONLY_ITS_SPACE])
  })

  it('judges the path the router serves: an encoded name is its space, a cased, dotted or slashed one is not (probe T6)', async () => {
    const { makeInvite, join, call } = await box()
    const token = (await join(await makeInvite())).tokens.access_token
    const statuses = await Promise.all(['/s/%73oups/mcp', '/s/Soups/mcp', '/s/soups%2Fx/mcp', '/s/%2e%2e/mcp', '/s/soups/../bakes/mcp'].map(async (path) => [path, (await call(path, token)).status]))
    expect(statuses).toEqual([['/s/%73oups/mcp', 200], ['/s/Soups/mcp', 401], ['/s/soups%2Fx/mcp', 401], ['/s/%2e%2e/mcp', 401], ['/s/soups/../bakes/mcp', 401]])
  })

  it('follows a renamed space by its id, and refuses its old name even once another space takes it', async () => {
    const { makeInvite, join, call, shelves } = await box()
    const token = (await join(await makeInvite())).tokens.access_token
    shelves[0]!.name = 'broths'
    expect([(await call('/s/broths/mcp', token)).status, (await call('/s/soups/mcp', token)).status]).toEqual([200, 401])
    shelves[1]!.name = 'soups'
    expect((await call('/s/soups/mcp', token)).status).toBe(401)
  })

  it('refuses a member of a space the app no longer has', async () => {
    const { makeInvite, join, call, shelves } = await box()
    const token = (await join(await makeInvite())).tokens.access_token
    shelves.splice(0, 1)
    const answer = await call('/s/soups/mcp', token)
    expect([answer.status, refusalOf(answer)]).toEqual([401, ONLY_ITS_SPACE])
  })

  it('notes a member’s use at most once an hour', async () => {
    const { makeInvite, join, call, memberOfToken, ageMember } = await box()
    const token = (await join(await makeInvite())).tokens.access_token
    const grant = grantOf(token)
    const recent = new Date(Date.now() - HOUR / 2).toISOString()
    await ageMember(grant, { lastSeenAt: recent })
    await call('/s/soups/mcp', token)
    expect((await memberOfToken(token))?.lastSeenAt).toBe(recent)
    await ageMember(grant, { lastSeenAt: new Date(Date.now() - 2 * HOUR).toISOString() })
    await call('/s/soups/mcp', token)
    expect(Date.parse((await memberOfToken(token))!.lastSeenAt)).toBeGreaterThan(Date.now() - 60_000)
  })

  it('names the day an access ended', async () => {
    const { makeInvite, join, call, ageMember } = await box()
    const token = (await join(await makeInvite())).tokens.access_token
    await ageMember(grantOf(token), { expiresAt: '2026-03-12T08:00:00.000Z' })
    // Its own token, so wherever it is used it hears why it ended, never the out-of-place sentence
    for (const path of ['/s/soups/mcp', '/s/bakes/mcp', '/mcp']) expect([path, refusalOf(await call(path, token))]).toEqual([path, 'This access ended on 12 March 2026 (UTC): ask the owner for a new invite.'])
  })
})

describe('onRevoke', () => {
  it('stops a member whose grant the app revokes on its next request, its row ended and kept', async () => {
    const { makeInvite, join, call, oauth, memberOfToken, inviteState } = await box()
    const invite = await makeInvite()
    const token = (await join(invite)).tokens.access_token
    await oauth.revokeGrant(grantOf(token))
    expect((await call('/s/soups/mcp', token)).status).toBe(401)
    expect((await memberOfToken(token))?.endedReason).toBe('revoked')
    // The row stays, so the invite never reopens
    expect(await inviteState(invite.id)).toBe('redeemed')
  })

  it('revokes an ended agent’s open invites, and the people who joined through them keep access', async () => {
    const { ownerSignsIn, makeInvite, join, call, as, oauth, inviteState } = await box()
    const agent = (await ownerSignsIn()).tokens.access_token
    const joinedThrough = await makeInvite('soups', { label: 'Sam', lifetime: '7d' }, as(agent))
    const stillOpen = await makeInvite('soups', { label: 'Ada' }, as(agent))
    const member = (await join(joinedThrough)).tokens.access_token
    await oauth.revokeGrant(grantOf(agent))
    expect([await inviteState(stillOpen.id), await inviteState(joinedThrough.id)]).toEqual(['revoked', 'redeemed'])
    expect((await join(stillOpen)).status).toBe(400)
    expect((await call('/s/soups/mcp', member)).status).toBe(200)
  })

  it('races an agent’s revoke against a redemption of its invite to one outcome, either way round', async () => {
    for (const order of ['exchange first', 'revoke first']) {
      const { ownerSignsIn, makeInvite, signIn, inviteDecision, as, oauth, inviteState, membersOfInvite } = await box()
      const agent = (await ownerSignsIn()).tokens.access_token
      const invite = await makeInvite('soups', { label: 'Sam', lifetime: '7d' }, as(agent))
      const { exchange } = await signIn({ resource: SOUPS, decision: inviteDecision(invite) })
      const revoke = () => oauth.revokeGrant(grantOf(agent))
      const exchanged = order === 'exchange first' ? (await Promise.all([exchange(), revoke()]))[0] : (await Promise.all([revoke(), exchange()]))[1]
      const outcome = [exchanged.status, await inviteState(invite.id), (await membersOfInvite(invite.id)).length]
      expect([[200, 'redeemed', 1], [400, 'revoked', 0]]).toContainEqual(outcome)
    }
  })
})

describe('memberOf', () => {
  it('names the member behind a space token, and no one behind a root token', async () => {
    const { makeInvite, join, call, ownerSignsIn } = await box()
    const invite = await makeInvite()
    const token = (await join(invite)).tokens.access_token
    const { member } = (await (await call('/s/soups/mcp/member', token)).json()) as { member: Record<string, unknown> }
    expect(member).toMatchObject({ space: { id: 'sp_soups', name: 'soups', title: 'Soups' }, label: 'Sam', appName: 'Sample', via: 'invite', scope: 'read', lifetime: '30d', returnsTo: 'client-a.example.test' })
    expect(member.id).toMatch(/^mem_/)
    expect(JSON.stringify(member)).not.toContain(grantOf(token))
    const root = (await ownerSignsIn()).tokens.access_token
    expect(await (await call('/s/soups/mcp/member', root)).json()).toEqual({ member: null })
  })
})

describe('before bind', () => {
  it('refuses safely: onGrant says no, and accepts takes only a token with no audience', async () => {
    const sharing = await createSharing({ db: await testDb(), secret: 'a sharing secret of thirty-two bytes or more, for tests only', spaces: { byName: async () => ({ id: 'sp_soups', name: 'soups', title: 'Soups' }), byId: async () => null }, owner: async () => null })
    const probe = new Hono()
    const grant: SignInGrant = { kind: 'code', grant: 'grant-1', client: { id: 'client-1', name: 'Sample' }, approver: 'invite:inv_1', scopes: ['read'], resource: SOUPS, data: { sharing: 'invite', invite: 'inv_1' } }
    const caller = (resource?: string): TokenCaller => ({ kind: 'agent', name: 'Sample', client: 'client-1', grant: 'grant-1', scopes: ['read'], owner: OWNER, ...(resource ? { resource } : {}) })
    probe.get('/s/soups/mcp', async (c) => c.json({ granted: await sharing.oauth.onGrant(grant, c), space: await sharing.oauth.accepts(caller(SOUPS), c), root: await sharing.oauth.accepts(caller(ORIGIN), c), none: await sharing.oauth.accepts(caller(), c) }))
    const judged = await (await probe.request('/s/soups/mcp')).json()
    expect(judged).toMatchObject({ granted: false, space: expect.stringContaining('not ready'), root: expect.stringContaining('not ready'), none: true })
  })
})
