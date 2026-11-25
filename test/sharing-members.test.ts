/** The sharing part's members: listed, removed and invited again by the owner, aged by sweep, forgotten with their space. */
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { testDb } from '../src/index.js'
import { createSharing, sharingInvites, sharingMembers } from '../src/sharing/index.js'
import { BAKES, grantOf, grantsApp, SOUPS } from './sharing-grants-contract.js'
import { DAY, HOUR } from './sharing-rows.js'

const KEY = 'owner-key'

type Card = { id: string; label: string; appName: string; state: string; via: string; scope: string; lifetime: string; _links: Record<string, { href: string } | undefined> }
type Page = { _embedded: { members: Card[] }; _links: { next?: { href: string } | null } }
type NewInvite = { id: string; label: string; scope: string; lifetime: string; link: string; code: string }

const box = async () => {
  const db = await testDb()
  const made = await grantsApp(db)
  const { byKey } = made
  const membersAt = async (space = 'soups', query = '') => (await (await byKey(`/api/spaces/${space}/members${query}`)).json()) as Page
  const listed = async (space = 'soups') => (await membersAt(space))._embedded.members
  const memberIdOf = async (token: string) => (await made.memberOfToken(token))!.id
  const inviteAgain = async (id: string, call = byKey, space = 'soups') => call(`/api/spaces/${space}/members/${id}/invite-again`, { method: 'POST' })
  const remove = (id: string, space = 'soups') => byKey(`/api/spaces/${space}/members/${id}`, { method: 'DELETE' })
  /** How many times the kit told the part a grant ended, for one grant. */
  const toldFor = (grant: string) => made.revoked.filter((told) => told.grant === grant).map((told) => told.reason)
  return { ...made, db, membersAt, listed, memberIdOf, inviteAgain, remove, toldFor }
}

describe('members', () => {
  it('are listed newest first, a page at a time, each with a self; signed out ones shown, removed and replaced hidden', async () => {
    const { makeInvite, join, oauth, membersAt, listed, byKey, memberIdOf } = await box()
    const sam = (await join(await makeInvite('soups', { label: 'Sam' }))).tokens.access_token
    const ada = (await join(await makeInvite('soups', { label: 'Ada', scope: 'write' }), { scopes: ['read', 'write'] })).tokens.access_token
    await oauth.revokeGrant(grantOf(sam))
    const first = await membersAt('soups', '?limit=1')
    expect(first._embedded.members.map((card) => [card.label, card.state, card.scope])).toEqual([['Ada', 'active', 'write']])
    const next = first._links.next!.href
    const rest = (await (await byKey(new URL(next).pathname + new URL(next).search)).json()) as Page
    expect(rest._embedded.members.map((card) => [card.label, card.state])).toEqual([['Sam', 'signed_out']])
    // A card's self answers the same card, and names no grant or client
    for (const card of await listed()) {
      const self = await byKey(new URL(card._links.self!.href).pathname)
      expect([self.status, await self.json()]).toEqual([200, card])
      expect(card).not.toHaveProperty('grantId')
      expect(card).not.toHaveProperty('clientId')
    }
    expect(JSON.stringify(await listed())).not.toContain(grantOf(ada))
    // Removed is hidden, from the list and from its self
    const adaId = await memberIdOf(ada)
    await byKey(`/api/spaces/soups/members/${adaId}`, { method: 'DELETE' })
    expect((await listed()).map((card) => card.label)).toEqual(['Sam'])
    expect((await byKey(`/api/spaces/soups/members/${adaId}`)).status).toBe(404)
  })

  it('are removed: the member is stopped on its next request, its row ended and hidden, and its invite never reopens', async () => {
    const { makeInvite, join, call, remove, memberIdOf, memberOfToken, inviteState, toldFor } = await box()
    const invite = await makeInvite()
    const token = (await join(invite)).tokens.access_token
    expect((await call('/s/soups/mcp', token)).status).toBe(200)
    const id = await memberIdOf(token)
    expect((await remove(id)).status).toBe(204)
    expect((await call('/s/soups/mcp', token)).status).toBe(401)
    expect((await memberOfToken(token))?.endedReason).toBe('removed')
    expect(toldFor(grantOf(token))).toEqual(['revoked'])
    expect(await inviteState(invite.id)).toBe('redeemed')
    // Removing it again is harmless; a made-up id is not found
    expect((await remove(id)).status).toBe(204)
    expect((await remove('mem_made_up')).status).toBe(404)
  })

  it('are removed for good: a refresh after Remove is refused, and one racing it, either way round, opens nothing', async () => {
    const { makeInvite, join, call, app, remove, memberIdOf } = await box()
    const refresh = (joined: Awaited<ReturnType<typeof join>>) =>
      app.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: joined.tokens.refresh_token, client_id: joined.client_id }).toString() })
    const after = await join(await makeInvite())
    await remove(await memberIdOf(after.tokens.access_token))
    expect((await refresh(after)).status).toBe(400)
    for (const order of ['refresh first', 'remove first']) {
      const joined = await join(await makeInvite())
      const id = await memberIdOf(joined.tokens.access_token)
      const refreshed = order === 'refresh first' ? (await Promise.all([refresh(joined), remove(id)]))[0] : (await Promise.all([remove(id), refresh(joined)]))[1]
      const token = refreshed.status === 200 ? ((await refreshed.json()) as { access_token: string }).access_token : null
      for (const bearer of [joined.tokens.access_token, token].filter((one): one is string => one !== null)) expect([order, (await call('/s/soups/mcp', bearer)).status]).toEqual([order, 401])
    }
  })

  it('are removed for good while their join is still in onGrant: the withdrawn join leaves the invite revoked', async () => {
    let removing = false
    const made: Awaited<ReturnType<typeof grantsApp>> = await grantsApp(await testDb(), {
      oauth: {
        onGrant: async (grant, c) => {
          const yes = await made.sharing.oauth.onGrant(grant, c)
          if (removing) await made.byKey(`/api/spaces/soups/members/${(await made.repo.memberByGrant(grant.grant))!.id}`, { method: 'DELETE' })
          return yes
        },
      },
    })
    const { makeInvite, join, inviteState, membersOfInvite } = made
    const invite = await makeInvite()
    removing = true
    expect((await join(invite)).status).toBe(400)
    removing = false
    expect([await membersOfInvite(invite.id), await inviteState(invite.id)]).toEqual([[], 'revoked'])
    expect((await join(invite)).status).toBe(400)
  })

  it('are removed with their outstanding Invite again, so a re-invite made before Remove lets no one back in', async () => {
    const { makeInvite, join, inviteAgain, remove, memberIdOf, inviteState } = await box()
    const id = await memberIdOf((await join(await makeInvite())).tokens.access_token)
    const again = (await (await inviteAgain(id)).json()) as NewInvite
    expect((await remove(id)).status).toBe(204)
    expect(await inviteState(again.id)).toBe('revoked')
    expect((await join(again)).status).toBe(400)
  })

  it('are removed when signed out too, which hides them', async () => {
    const { makeInvite, join, oauth, remove, listed, memberIdOf, memberOfToken } = await box()
    const token = (await join(await makeInvite())).tokens.access_token
    await oauth.revokeGrant(grantOf(token))
    expect((await listed()).map((card) => card.state)).toEqual(['signed_out'])
    expect((await remove(await memberIdOf(token))).status).toBe(204)
    expect(await listed()).toEqual([])
    expect((await memberOfToken(token))?.endedReason).toBe('removed')
  })

  it('answer an id from Bakes at Soups with the same 404 as a made-up id, and leave the Bakes member as it was', async () => {
    const { makeInvite, join, byKey, memberIdOf, call } = await box()
    const bakes = await makeInvite('bakes')
    const token = (await join(bakes, { resource: BAKES, asked: BAKES })).tokens.access_token
    const id = await memberIdOf(token)
    const problem = async (answer: Response) => {
      const { instance: _instance, ...body } = (await answer.json()) as Record<string, unknown>
      return { status: answer.status, body: { ...body, detail: String(body.detail).replace(id, 'ID').replace('mem_made_up', 'ID') } }
    }
    for (const [method, suffix] of [['GET', ''], ['DELETE', ''], ['POST', '/invite-again']] as const) {
      const fromBakes = await problem(await byKey(`/api/spaces/soups/members/${id}${suffix}`, { method }))
      const madeUp = await problem(await byKey(`/api/spaces/soups/members/mem_made_up${suffix}`, { method }))
      expect([method, suffix, fromBakes]).toEqual([method, suffix, madeUp])
      expect(fromBakes.status).toBe(404)
    }
    expect((await call('/s/bakes/mcp', token)).status).toBe(200)
  })

  it('are listed, removed and invited again only by those who may share', async () => {
    const { makeInvite, join, call, as, memberIdOf } = await box()
    const token = (await join(await makeInvite())).tokens.access_token
    const id = await memberIdOf(token)
    expect((await call('/api/spaces/soups/members', token)).status).toBe(401)
    expect((await as('not-a-key')(`/api/spaces/soups/members/${id}`, { method: 'DELETE' })).status).toBe(401)
    expect((await call('/s/soups/mcp', token)).status).toBe(200)
  })
})

describe('invite again', () => {
  it('twice: only the newest invite works, and joining ends the old sign-in', async () => {
    const { makeInvite, join, call, inviteAgain, inviteState, memberIdOf, memberOfToken, listed, toldFor } = await box()
    const old = (await join(await makeInvite('soups', { label: 'Sam', scope: 'write', lifetime: '7d' }), { scopes: ['read', 'write'] })).tokens.access_token
    const oldId = await memberIdOf(old)
    const firstAnswer = await inviteAgain(oldId)
    expect(firstAnswer.status).toBe(201)
    const first = (await firstAnswer.json()) as NewInvite
    expect(first).toMatchObject({ label: 'Sam', scope: 'write', lifetime: '7d', link: expect.stringContaining('/sharing/join/'), code: expect.any(String) })
    const second = (await (await inviteAgain(oldId)).json()) as NewInvite
    expect([await inviteState(first.id), await inviteState(second.id)]).toEqual(['revoked', 'open'])
    expect((await join(first)).status).toBe(400)
    // Still live until the new one joins
    expect((await call('/s/soups/mcp', old)).status).toBe(200)
    const fresh = (await join(second)).tokens.access_token
    expect((await call('/s/soups/mcp', fresh)).status).toBe(200)
    expect((await call('/s/soups/mcp', old)).status).toBe(401)
    expect((await memberOfToken(old))?.endedReason).toBe('replaced')
    expect(toldFor(grantOf(old))).toEqual(['revoked'])
    expect((await listed()).map((card) => [card.id === oldId, card.label, card.state])).toEqual([[false, 'Sam', 'active']])
  })

  it('gives a signed-out member a fresh invite, and the old row goes once the new one joins', async () => {
    const { makeInvite, join, oauth, inviteAgain, memberIdOf, memberOfToken, listed } = await box()
    const old = (await join(await makeInvite())).tokens.access_token
    await oauth.revokeGrant(grantOf(old))
    const again = (await (await inviteAgain(await memberIdOf(old))).json()) as NewInvite
    const fresh = (await join(again)).tokens.access_token
    expect((await memberOfToken(old))?.endedReason).toBe('replaced')
    expect((await listed()).map((card) => [card.id, card.state])).toEqual([[await memberIdOf(fresh), 'active']])
  })

  it('opens its invite again when the join is withdrawn after the claim, though the old sign-in has ended', async () => {
    let vetoing = false
    const made: Awaited<ReturnType<typeof grantsApp>> = await grantsApp(await testDb(), { oauth: { onGrant: async (grant, c) => (await made.sharing.oauth.onGrant(grant, c)) && !vetoing } })
    const { makeInvite, join, memberOfToken, inviteState, byKey } = made
    const old = (await join(await makeInvite())).tokens.access_token
    const again = (await (await byKey(`/api/spaces/soups/members/${(await memberOfToken(old))!.id}/invite-again`, { method: 'POST' })).json()) as NewInvite
    vetoing = true
    expect((await join(again)).status).toBe(400)
    // Its own claim never revoked it, so it opens again; the member it replaced was closed in the claim
    expect([await inviteState(again.id), (await memberOfToken(old))?.endedReason]).toEqual(['open', 'replaced'])
    vetoing = false
    expect((await join(again)).status).toBe(200)
  })

  it('never answers the link and code twice: a retry with the same Idempotency-Key is a 409 shown_once', async () => {
    const { makeInvite, join, app, byKey, memberIdOf } = await box()
    const invitesAt = async () => ((await (await byKey('/api/spaces/soups/invites')).json()) as { _embedded: { invites: unknown[] } })._embedded.invites
    const id = await memberIdOf((await join(await makeInvite())).tokens.access_token)
    const post = () => app.request(`/api/spaces/soups/members/${id}/invite-again`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': 'again-1' } })
    const first = await post()
    expect([first.status, first.headers.get('shown-once')]).toEqual([201, 'true'])
    const { code, link } = (await first.json()) as NewInvite
    const retried = await post()
    const text = await retried.text()
    expect([retried.status, JSON.parse(text).code]).toEqual([409, 'shown_once'])
    for (const secret of [code, link]) expect(text).not.toContain(secret)
    expect(await invitesAt()).toHaveLength(2)
  })

  it('lets an agent re-invite for 7 or 30 days only, its client and grant on the record', async () => {
    const { makeInvite, join, ownerSignsIn, as, inviteAgain, memberIdOf, repo } = await box()
    const agent = (await ownerSignsIn()).tokens.access_token
    const forever = await memberIdOf((await join(await makeInvite('soups', { label: 'Sam', lifetime: 'until_revoked' }))).tokens.access_token)
    const month = await memberIdOf((await join(await makeInvite('soups', { label: 'Ada' }))).tokens.access_token)
    const refused = await inviteAgain(forever, as(agent))
    expect([refused.status, ((await refused.json()) as { detail: string }).detail]).toEqual([400, expect.stringContaining('7 or 30 days')])
    const made = (await (await inviteAgain(month, as(agent))).json()) as NewInvite
    expect(await repo.inviteAt('sp_soups', made.id)).toMatchObject({ lifetime: '30d', madeByGrant: grantOf(agent), replacesMemberId: month })
  })
})

describe('sweep', () => {
  it('ends a member past its lifetime or unseen for 30 days once, revokes its grant, and deletes what closed long ago', async () => {
    const { makeInvite, join, call, sharing, ageMember, memberOfToken, toldFor, db, repo } = await box()
    const week = (await join(await makeInvite('soups', { label: 'Sam', lifetime: '7d' }))).tokens.access_token
    const quiet = (await join(await makeInvite('soups', { label: 'Ada', lifetime: 'until_revoked' }))).tokens.access_token
    const busy = (await join(await makeInvite('soups', { label: 'Lee' }))).tokens.access_token
    await ageMember(grantOf(week), { expiresAt: new Date(Date.now() - HOUR).toISOString() })
    await ageMember(grantOf(quiet), { lastSeenAt: new Date(Date.now() - 31 * DAY).toISOString() })
    // Refused before sweep writes anything
    for (const token of [week, quiet]) expect((await call('/s/soups/mcp', token)).status).toBe(401)
    expect(await sharing.sweep()).toEqual({ ended: 2, deleted: 0 })
    expect([(await memberOfToken(week))?.endedReason, (await memberOfToken(quiet))?.endedReason, (await memberOfToken(busy))?.endedReason]).toEqual(['expired', 'lapsed', null])
    expect([toldFor(grantOf(week)), toldFor(grantOf(quiet)), toldFor(grantOf(busy))]).toEqual([['revoked'], ['revoked'], []])
    expect(await sharing.sweep()).toEqual({ ended: 0, deleted: 0 })

    // 90 days after it ended a member goes; an invite 7 days after it stopped being open
    const longAgo = new Date(Date.now() - 91 * DAY).toISOString()
    const weekMember = (await memberOfToken(week))!
    await db.update(sharingMembers).set({ endedAt: longAgo }).where(eq(sharingMembers.grantId, grantOf(week)))
    await db.update(sharingInvites).set({ redeemBy: longAgo }).where(eq(sharingInvites.id, weekMember.inviteId!))
    const stale = await makeInvite()
    await db.update(sharingInvites).set({ redeemBy: new Date(Date.now() - 8 * DAY).toISOString() }).where(eq(sharingInvites.id, stale.id))
    expect(await sharing.sweep()).toEqual({ ended: 0, deleted: 3 })
    expect([await memberOfToken(week), await repo.inviteAt('sp_soups', weekMember.inviteId!), await repo.inviteAt('sp_soups', stale.id)]).toEqual([undefined, undefined, undefined])
  })

  it('and forget refuse to run before registerSharing binds the part', async () => {
    const sharing = await createSharing({ db: await testDb(), secret: 'a sharing secret of thirty-two bytes or more, for tests only', spaces: { byName: async () => null, byId: async () => null }, owner: async () => null })
    await expect(sharing.sweep()).rejects.toThrow(/registerSharing/)
    await expect(sharing.forget('sp_soups')).rejects.toThrow(/registerSharing/)
  })
})

describe('forget', () => {
  it('refuses a deleted space’s members at once, then ends them, revokes their grants and invites, and leaves other spaces be', async () => {
    const { makeInvite, join, call, sharing, shelves, memberOfToken, toldFor, repo } = await box()
    const soups = (await join(await makeInvite())).tokens.access_token
    const bakesInvite = await makeInvite('bakes')
    const bakes = (await join(bakesInvite, { resource: BAKES, asked: BAKES })).tokens.access_token
    const open = await makeInvite()
    shelves.splice(0, 1)
    expect((await call('/s/soups/mcp', soups)).status).toBe(401)
    await sharing.forget('sp_soups')
    expect((await memberOfToken(soups))?.endedReason).toBe('space_gone')
    expect(toldFor(grantOf(soups))).toEqual(['revoked'])
    expect((await repo.inviteAt('sp_soups', open.id))?.revokedAt).toEqual(expect.any(String))
    expect([(await memberOfToken(bakes))?.endedAt, toldFor(grantOf(bakes)), (await repo.inviteAt('sp_bakes', bakesInvite.id))?.revokedAt]).toEqual([null, [], null])
    // Told twice, nothing moves
    await sharing.forget('sp_soups')
    expect(toldFor(grantOf(soups))).toEqual(['revoked'])
  })

  it('racing an exchange of the space’s invite leaves no live member', async () => {
    const db = await testDb()
    const { makeInvite, signIn, inviteDecision, sharing, shelves, repo } = await grantsApp(db, { byNameDelay: 5 })
    const invite = await makeInvite()
    const { exchange } = await signIn({ resource: SOUPS, decision: inviteDecision(invite) })
    // The space found inside onGrant, then deleted and forgotten while the claim runs: either order ends with no live member
    const exchanged = exchange()
    await new Promise((done) => setTimeout(done, 8))
    shelves.splice(0, 1)
    await Promise.all([exchanged, sharing.forget('sp_soups')])
    const live = (await repo.listMembers('sp_soups', { limit: 10 })).filter((row) => row.endedAt === null)
    expect(live).toEqual([])
  })
})
