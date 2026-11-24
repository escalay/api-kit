import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { migrate, testDb, type Db } from '../src/index.js'
import {
  addressKeyOf,
  askingStateOf,
  CODE_ALPHABET,
  codeHashOf,
  inviteStateOf,
  linkHashOf,
  MAX_OPEN_INVITES,
  memberExpiresAtOf,
  memberListingOf,
  memberStateOf,
  newInviteCode,
  newLinkToken,
  newShownCode,
  normalisedCode,
  redeemByOf,
  requestStateOf,
  sharingKeys,
  sharingRepo,
  SHARING_MIGRATIONS,
  ticketHashOf,
} from '../src/sharing/index.js'
import { at, DAY, HOUR, inviteRow, memberRow, requestRow } from './sharing-rows.js'

const SECRET = 'a sharing secret of thirty-two bytes or more, for tests only'
const NOW = new Date('2026-03-12T09:00:00.000Z')

const sharingDb = async () => {
  const db = await testDb()
  await migrate(db, 'sharing', SHARING_MIGRATIONS)
  return db
}

/** The names of a kind of schema object the part made: its tables, or its indexes. */
const namesOf = async (db: Db, type: 'table' | 'index') => {
  const rows = await db.all<{ name: string } | [string]>(sql`select name from sqlite_master where type = ${type} and name like 'sharing%' order by name`)
  return rows.map((row) => (Array.isArray(row) ? row[0] : row.name))
}

describe('the sharing tables', () => {
  it('migrate into exactly the four tables and ten indexes the step names', async () => {
    const db = await sharingDb()
    expect(await namesOf(db, 'table')).toEqual(['sharing_invites', 'sharing_members', 'sharing_requests', 'sharing_spaces'])
    expect(await namesOf(db, 'index')).toEqual([
      'sharing_invites_maker', 'sharing_invites_redeem_by', 'sharing_invites_space',
      'sharing_members_client', 'sharing_members_ended', 'sharing_members_seen', 'sharing_members_space',
      'sharing_requests_address', 'sharing_requests_expires', 'sharing_requests_space',
    ])
    await migrate(db, 'sharing', SHARING_MIGRATIONS)
    expect(await namesOf(db, 'table')).toHaveLength(4)
  })

  it('hold no comment and no quote in the step, so it splits into its fourteen statements', () => {
    for (const step of SHARING_MIGRATIONS) expect(step).not.toMatch(/--|\/\*|['"`]/)
    expect(SHARING_MIGRATIONS[0].split(';')).toHaveLength(14)
  })

  it('keep an apostrophe in any value as it was given', async () => {
    const repo = sharingRepo(await sharingDb())
    const id = await repo.addInvite(inviteRow('sp_soups', NOW, 'apostrophe', { label: "Sam's phone; drop table sharing_invites" }))
    expect((await repo.inviteAt('sp_soups', id!))?.label).toBe("Sam's phone; drop table sharing_invites")
  })
})

describe('the named states', () => {
  const invite = { revokedAt: null, redeemBy: at(NOW, HOUR).toISOString() }
  it.each([
    ['open', invite, null, NOW],
    ['redeemed', invite, { id: 'mem_1' }, NOW],
    ['redeemed', { ...invite, revokedAt: NOW.toISOString() }, { id: 'mem_1' }, at(NOW, 2 * HOUR)],
    ['revoked', { ...invite, revokedAt: NOW.toISOString() }, null, NOW],
    ['revoked', { ...invite, revokedAt: NOW.toISOString() }, null, at(NOW, 2 * HOUR)],
    ['expired', invite, null, at(NOW, HOUR)],
    ['expired', invite, null, at(NOW, 2 * HOUR)],
  ] as const)('an invite is %s', (state, row, member, now) => {
    expect(inviteStateOf(row, member, now)).toBe(state)
  })

  const ask = { expiresAt: at(NOW, DAY).toISOString() }
  it.each([
    ['waiting', { ...ask, state: 'waiting' }, null, NOW],
    ['approved', { ...ask, state: 'approved' }, null, NOW],
    ['refused', { ...ask, state: 'refused' }, null, NOW],
    ['refused', { ...ask, state: 'refused' }, null, at(NOW, 2 * DAY)],
    ['joined', { ...ask, state: 'approved' }, { id: 'mem_1' }, at(NOW, 2 * DAY)],
    ['lapsed', { ...ask, state: 'waiting' }, null, at(NOW, DAY)],
    ['lapsed', { ...ask, state: 'approved' }, null, at(NOW, 2 * DAY)],
  ] as const)('an ask is %s', (state, row, member, now) => {
    expect(requestStateOf(row, member, now)).toBe(state)
  })

  const member = { endedAt: null, endedReason: null, expiresAt: at(NOW, 7 * DAY).toISOString(), lastSeenAt: NOW.toISOString() }
  it.each([
    [{ state: 'active' }, member, NOW],
    [{ state: 'active' }, { ...member, expiresAt: null }, at(NOW, 29 * DAY)],
    [{ state: 'ended', reason: 'removed' }, { ...member, endedAt: NOW.toISOString(), endedReason: 'removed' }, NOW],
    [{ state: 'ended', reason: 'expired' }, member, at(NOW, 7 * DAY)],
    [{ state: 'ended', reason: 'lapsed' }, { ...member, expiresAt: null }, at(NOW, 30 * DAY)],
  ] as const)('a member is %j', (state, row, now) => {
    expect(memberStateOf(row, now)).toEqual(state)
  })

  it.each([
    ['active', member],
    ['signed_out', { ...member, endedAt: NOW.toISOString(), endedReason: 'revoked' }],
    ['signed_out', { ...member, endedAt: NOW.toISOString(), endedReason: 'lapsed' }],
    ['hidden', { ...member, endedAt: NOW.toISOString(), endedReason: 'removed' }],
    ['hidden', { ...member, endedAt: NOW.toISOString(), endedReason: 'replaced' }],
  ] as const)('the owner sees a member as %s', (listing, row) => {
    expect(memberListingOf(row, NOW)).toBe(listing)
  })

  it.each([
    ['off', null],
    ['off', { askToJoin: false, askPausedAt: null }],
    ['off', { askToJoin: false, askPausedAt: NOW.toISOString() }],
    ['on', { askToJoin: true, askPausedAt: null }],
    ['paused', { askToJoin: true, askPausedAt: NOW.toISOString() }],
  ] as const)('asking to join is %s', (state, space) => {
    expect(askingStateOf(space)).toBe(state)
  })

  it('times an invite a day to redeem, and a member by its lifetime', () => {
    expect(redeemByOf(NOW)).toBe('2026-03-13T09:00:00.000Z')
    expect(memberExpiresAtOf('7d', NOW)).toBe('2026-03-19T09:00:00.000Z')
    expect(memberExpiresAtOf('30d', NOW)).toBe('2026-04-11T09:00:00.000Z')
    expect(memberExpiresAtOf('until_revoked', NOW)).toBeNull()
  })
})

describe('the sharing secrets', () => {
  it('make a 192-bit link token and an 8-letter code with no vowels', () => {
    const tokens = new Set(Array.from({ length: 50 }, newLinkToken))
    expect(tokens.size).toBe(50)
    for (const token of tokens) expect(Buffer.from(token, 'base64url')).toHaveLength(24)
    for (const code of Array.from({ length: 200 }, newInviteCode)) {
      expect(code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
      for (const letter of normalisedCode(code)) expect(CODE_ALPHABET).toContain(letter)
    }
    expect(CODE_ALPHABET).toBe('BCDFGHJKLMNPQRSTVWXZ')
    expect(newShownCode()).toMatch(/^\d{6}$/)
  })

  it('compare a typed code whatever its case, dashes and spaces', () => {
    const keys = sharingKeys(SECRET)
    expect(normalisedCode(' bdkm qxtw ')).toBe('BDKMQXTW')
    expect(codeHashOf(keys, 'bdkm-qxtw')).toBe(codeHashOf(keys, 'BDKMQXTW'))
    expect(codeHashOf(keys, 'BDKM-QXTW')).not.toBe(codeHashOf(keys, 'BDKM-QXTB'))
  })

  it('derive four keys of their own, so one use never opens another', () => {
    const keys = sharingKeys(SECRET)
    const all = [keys.link, keys.code, keys.cookie, keys.address].map((key) => key.toString('hex'))
    expect(new Set(all).size).toBe(4)
    for (const key of [keys.link, keys.code, keys.cookie, keys.address]) expect(key).toHaveLength(32)
    expect(linkHashOf(keys, 'same text')).not.toBe(codeHashOf(keys, 'same text'))
    expect(addressKeyOf(keys, '203.0.113.7')).not.toBe(linkHashOf(keys, '203.0.113.7'))
    expect(sharingKeys(SECRET).link.equals(keys.link)).toBe(true)
  })

  it('change every hash when the secret is rotated', () => {
    const [before, after] = [sharingKeys(SECRET), sharingKeys(`${SECRET}, rotated`)]
    expect(linkHashOf(before, 'token')).not.toBe(linkHashOf(after, 'token'))
    expect(codeHashOf(before, 'BDKM-QXTW')).not.toBe(codeHashOf(after, 'BDKM-QXTW'))
    expect(addressKeyOf(before, '203.0.113.7')).not.toBe(addressKeyOf(after, '203.0.113.7'))
  })

  it('refuse a secret shorter than 32 bytes', () => {
    expect(() => sharingKeys('too short')).toThrow(/sharing: the secret holds 9 bytes; give it 32 or more/)
    expect(() => sharingKeys('x'.repeat(32))).not.toThrow()
  })

  it('hash a consent ticket with SHA-256', () => {
    expect(ticketHashOf('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('leave no table holding a link, a code or a bare hash of either', async () => {
    const db = await sharingDb()
    const repo = sharingRepo(db)
    const keys = sharingKeys(SECRET)
    const [token, code] = [newLinkToken(), newInviteCode()]
    const inviteId = await repo.addInvite(inviteRow('sp_soups', NOW, 'unused', { linkHash: linkHashOf(keys, token), codeHash: codeHashOf(keys, code) }))
    await repo.claimInvite(inviteId!, memberRow('sp_soups', NOW, 'grant-secret'), NOW)
    await repo.addRequest(requestRow('sp_soups', NOW, 'unused', { ticketHash: ticketHashOf('a consent ticket'), addressKey: addressKeyOf(keys, '203.0.113.7') }))
    const sha256 = (text: string) => [ticketHashOf(text), Buffer.from(ticketHashOf(text), 'hex').toString('base64url')]
    const secrets = [token, code, normalisedCode(code), ...sha256(token), ...sha256(code), ...sha256(normalisedCode(code)), 'a consent ticket', '203.0.113.7']
    const dumps: string[] = []
    for (const table of ['sharing_spaces', 'sharing_invites', 'sharing_requests', 'sharing_members']) {
      const dump = JSON.stringify(await db.all(sql.raw(`select * from ${table}`)))
      for (const secret of secrets) expect(dump, `${table} holds ${secret}`).not.toContain(secret)
      dumps.push(dump)
    }
    // What is kept instead: the HMACs and the ticket's hash
    for (const kept of [linkHashOf(keys, token), codeHashOf(keys, code), addressKeyOf(keys, '203.0.113.7'), ticketHashOf('a consent ticket')]) expect(dumps.join('')).toContain(kept)
  })
})

describe('an invite claim', () => {
  const opened = async (change = {}) => {
    const repo = sharingRepo(await sharingDb())
    const inviteId = (await repo.addInvite(inviteRow('sp_soups', NOW, 'claim', change)))!
    return { repo, inviteId }
  }

  it('makes one member when two exchanges claim the invite at once', async () => {
    const { repo, inviteId } = await opened()
    const claims = await Promise.all([repo.claimInvite(inviteId, memberRow('sp_soups', NOW, 'grant-a'), NOW), repo.claimInvite(inviteId, memberRow('sp_soups', NOW, 'grant-b'), NOW)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const invite = await repo.inviteAt('sp_soups', inviteId)
    expect(invite?.memberId).toBe(claims.find(Boolean))
    expect(inviteStateOf(invite!, { id: invite!.memberId! }, NOW)).toBe('redeemed')
    expect(await repo.claimInvite(inviteId, memberRow('sp_soups', NOW, 'grant-c'), at(NOW, HOUR))).toBeNull()
  })

  it('works once, in time, at its own space, unrevoked', async () => {
    const late = await opened()
    expect(await late.repo.claimInvite(late.inviteId, memberRow('sp_soups', NOW, 'grant-late'), at(NOW, DAY))).toBeNull()
    const elsewhere = await opened()
    expect(await elsewhere.repo.claimInvite(elsewhere.inviteId, memberRow('sp_bakes', NOW, 'grant-bakes'), NOW)).toBeNull()
    const revoked = await opened()
    expect(await revoked.repo.revokeInvite('sp_soups', revoked.inviteId, NOW)).toBe(true)
    expect(await revoked.repo.claimInvite(revoked.inviteId, memberRow('sp_soups', NOW, 'grant-revoked'), NOW)).toBeNull()
    const inTime = await opened()
    expect(await inTime.repo.claimInvite(inTime.inviteId, memberRow('sp_soups', NOW, 'grant-in-time'), at(NOW, DAY - 1))).toEqual(expect.stringMatching(/^mem_/))
  })

  it('makes one member per grant', async () => {
    const { repo, inviteId } = await opened()
    const other = (await repo.addInvite(inviteRow('sp_soups', NOW, 'other')))!
    expect(await repo.claimInvite(inviteId, memberRow('sp_soups', NOW, 'grant-once'), NOW)).not.toBeNull()
    expect(await repo.claimInvite(other, memberRow('sp_soups', NOW, 'grant-once'), NOW)).toBeNull()
    expect(inviteStateOf((await repo.inviteAt('sp_soups', other))!, null, NOW)).toBe('open')
  })

  it('opens the invite again when its grant is withdrawn, and never once the member is ended', async () => {
    const { repo, inviteId } = await opened()
    await repo.claimInvite(inviteId, memberRow('sp_soups', NOW, 'grant-vetoed'), NOW)
    await repo.deleteMemberOfGrant('grant-vetoed')
    const invite = (await repo.inviteAt('sp_soups', inviteId))!
    expect(inviteStateOf(invite, invite.memberId ? { id: invite.memberId } : null, NOW)).toBe('open')
    const memberId = await repo.claimInvite(inviteId, memberRow('sp_soups', NOW, 'grant-kept'), NOW)
    expect(await repo.endMember('sp_soups', memberId!, 'removed', NOW)).toBe('grant-kept')
    expect(await repo.claimInvite(inviteId, memberRow('sp_soups', NOW, 'grant-after'), NOW)).toBeNull()
    expect(await repo.revokeInvite('sp_soups', inviteId, NOW)).toBe(false)
  })

  it('refuses a code collision on create without throwing', async () => {
    const { repo } = await opened()
    expect(await repo.addInvite(inviteRow('sp_soups', NOW, 'claim', { linkHash: 'a fresh link' }))).toBeNull()
    expect(await repo.addInvite(inviteRow('sp_bakes', NOW, 'claim', { codeHash: 'a fresh code' }))).toBeNull()
    expect(await repo.addInvite(inviteRow('sp_soups', NOW, 'fresh'))).toEqual(expect.stringMatching(/^inv_/))
  })

  it('adds no invite past 100 open at a space, even all at once, and counts only open ones', async () => {
    const { repo } = await opened()
    const redeemed = (await repo.addInvite(inviteRow('sp_soups', NOW, 'redeemed')))!
    await repo.claimInvite(redeemed, memberRow('sp_soups', NOW, 'grant-redeemed'), NOW)
    await repo.revokeInvite('sp_soups', (await repo.addInvite(inviteRow('sp_soups', NOW, 'revoked')))!, NOW)
    await repo.addInvite(inviteRow('sp_soups', at(NOW, -DAY), 'late'))
    const open = await repo.countOpenInvites('sp_soups', NOW)
    const added = await Promise.all(Array.from({ length: 110 - open }, (_, index) => repo.addInvite(inviteRow('sp_soups', NOW, `cap-${index}`))))
    expect(added.filter(Boolean)).toHaveLength(MAX_OPEN_INVITES - open)
    expect(await repo.countOpenInvites('sp_soups', NOW)).toBe(MAX_OPEN_INVITES)
    expect(await repo.addInvite(inviteRow('sp_bakes', NOW, 'elsewhere'))).toEqual(expect.stringMatching(/^inv_/))
  })
})

describe('an ask claim', () => {
  const asked = async () => {
    const repo = sharingRepo(await sharingDb())
    const requestId = (await repo.addRequest(requestRow('sp_soups', NOW, 'ask')))!
    return { repo, requestId }
  }
  const approve = (repo: ReturnType<typeof sharingRepo>, id: string, now = NOW) => repo.approveRequest('sp_soups', id, { scope: 'read', lifetime: '30d', decidedBy: 'owner@example.test' }, now)

  it('makes one member when two exchanges claim the approved ask at once', async () => {
    const { repo, requestId } = await asked()
    expect(await approve(repo, requestId)).toBe(true)
    const claims = await Promise.all([repo.claimRequest(requestId, memberRow('sp_soups', NOW, 'grant-a'), NOW), repo.claimRequest(requestId, memberRow('sp_soups', NOW, 'grant-b'), NOW)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const ask = (await repo.requestAt('sp_soups', requestId))!
    expect(requestStateOf(ask, { id: ask.memberId! }, NOW)).toBe('joined')
    expect(await repo.refuseRequest('sp_soups', requestId, 'owner@example.test', NOW)).toBe(false)
  })

  it('makes nothing before the owner approves, after a refusal, or once the ticket lapsed', async () => {
    const waiting = await asked()
    expect(await waiting.repo.claimRequest(waiting.requestId, memberRow('sp_soups', NOW, 'grant-early'), NOW)).toBeNull()
    const refused = await asked()
    await approve(refused.repo, refused.requestId)
    expect(await refused.repo.refuseRequest('sp_soups', refused.requestId, 'owner@example.test', NOW)).toBe(true)
    expect(await refused.repo.claimRequest(refused.requestId, memberRow('sp_soups', NOW, 'grant-refused'), NOW)).toBeNull()
    const lapsed = await asked()
    await approve(lapsed.repo, lapsed.requestId)
    expect(await lapsed.repo.claimRequest(lapsed.requestId, memberRow('sp_soups', NOW, 'grant-lapsed'), at(NOW, DAY))).toBeNull()
    expect(await approve(lapsed.repo, lapsed.requestId, at(NOW, DAY))).toBe(false)
  })

  it('decides once: a decided ask is not approved again, and a lapsed one is not refused', async () => {
    const { repo, requestId } = await asked()
    expect(await approve(repo, requestId)).toBe(true)
    expect(await approve(repo, requestId)).toBe(false)
    expect(await repo.refuseRequest('sp_soups', requestId, 'owner@example.test', at(NOW, DAY))).toBe(false)
  })

  it('takes one ask per ticket, and counts what waits at a space and from an address', async () => {
    const { repo } = await asked()
    expect(await repo.addRequest(requestRow('sp_soups', NOW, 'ask'))).toBeNull()
    await repo.addRequest(requestRow('sp_soups', NOW, 'second', { addressKey: 'address-ask' }))
    await repo.addRequest(requestRow('sp_bakes', NOW, 'third'))
    await repo.addRequest(requestRow('sp_bakes', NOW, 'fourth', { addressKey: 'address-ask' }))
    expect(await repo.countWaitingAt('sp_soups', NOW)).toBe(2)
    expect(await repo.countWaitingFrom('address-ask', NOW)).toBe(3)
    expect(await repo.countWaitingAt('sp_soups', at(NOW, DAY))).toBe(0)
    expect(await repo.refuseWaitingAt('sp_soups', 'owner@example.test', NOW)).toBe(2)
    expect(await repo.countWaitingAt('sp_bakes', NOW)).toBe(2)
    expect(await repo.countWaitingFrom('address-ask', NOW)).toBe(1)
  })
})

describe('finding and listing', () => {
  it('finds an invite by its link, by its code at its space, and by its code anywhere', async () => {
    const repo = sharingRepo(await sharingDb())
    const keys = sharingKeys(SECRET)
    const [token, code] = [newLinkToken(), newInviteCode()]
    const id = await repo.addInvite(inviteRow('sp_bakes', NOW, 'found', { linkHash: linkHashOf(keys, token), codeHash: codeHashOf(keys, code) }))
    expect((await repo.inviteByLink(linkHashOf(keys, token)))?.id).toBe(id)
    expect(await repo.inviteByLink(linkHashOf(keys, newLinkToken()))).toBeUndefined()
    expect((await repo.inviteByCodeAt('sp_bakes', codeHashOf(keys, code.toLowerCase())))?.id).toBe(id)
    expect(await repo.inviteByCodeAt('sp_soups', codeHashOf(keys, code))).toBeUndefined()
    expect((await repo.inviteByCodeAnywhere(codeHashOf(keys, code)))?.spaceId).toBe('sp_bakes')
  })

  it('counts only the open invites of a space', async () => {
    const repo = sharingRepo(await sharingDb())
    await repo.addInvite(inviteRow('sp_soups', NOW, 'open'))
    const redeemed = (await repo.addInvite(inviteRow('sp_soups', NOW, 'redeemed')))!
    await repo.claimInvite(redeemed, memberRow('sp_soups', NOW, 'grant-count'), NOW)
    const revoked = (await repo.addInvite(inviteRow('sp_soups', NOW, 'revoked')))!
    await repo.revokeInvite('sp_soups', revoked, NOW)
    await repo.addInvite(inviteRow('sp_soups', at(NOW, -DAY), 'late'))
    await repo.addInvite(inviteRow('sp_bakes', NOW, 'elsewhere'))
    expect(await repo.countOpenInvites('sp_soups', NOW)).toBe(1)
    expect(await repo.countOpenInvites('sp_soups', at(NOW, DAY))).toBe(0)
  })

  it('lists a space’s invites and asks newest first, by page, each with the member that used it', async () => {
    const repo = sharingRepo(await sharingDb())
    const invites: string[] = []
    const asks: string[] = []
    for (const one of ['a', 'b', 'c']) invites.push((await repo.addInvite(inviteRow('sp_soups', NOW, `invite-${one}`)))!)
    for (const one of ['a', 'b', 'c']) asks.push((await repo.addRequest(requestRow('sp_soups', NOW, `ask-${one}`)))!)
    await repo.addInvite(inviteRow('sp_bakes', NOW, 'invite-bakes'))
    await repo.addRequest(requestRow('sp_bakes', NOW, 'ask-bakes'))
    const memberId = await repo.claimInvite(invites[0]!, memberRow('sp_soups', NOW, 'grant-listed'), NOW)
    const firstInvites = await repo.listInvites('sp_soups', { limit: 2 })
    expect(firstInvites.map((row) => row.id)).toEqual([invites[2], invites[1]])
    expect((await repo.listInvites('sp_soups', { after: firstInvites.at(-1)!.id, limit: 2 })).map((row) => [row.id, row.memberId])).toEqual([[invites[0], memberId]])
    const firstAsks = await repo.listRequests('sp_soups', { limit: 2 })
    expect(firstAsks.map((row) => row.id)).toEqual([asks[2], asks[1]])
    expect((await repo.listRequests('sp_soups', { after: firstAsks.at(-1)!.id, limit: 2 })).map((row) => row.id)).toEqual([asks[0]])
  })
})

/** Bakes with an open invite, a waiting ask, an approved ask and a member: what each by-id statement is tried on. */
const bakes = async () => {
  const repo = sharingRepo(await sharingDb())
  const memberId = (await repo.addOwnerMember(memberRow('sp_bakes', NOW, 'grant-bakes')))!
  const inviteId = (await repo.addInvite(inviteRow('sp_bakes', NOW, 'bakes', { replacesMemberId: memberId })))!
  const waitingId = (await repo.addRequest(requestRow('sp_bakes', NOW, 'waiting')))!
  const approvedId = (await repo.addRequest(requestRow('sp_bakes', NOW, 'approved')))!
  await repo.approveRequest('sp_bakes', approvedId, { scope: 'read', lifetime: '30d', decidedBy: 'owner@example.test' }, NOW)
  return { repo, memberId, inviteId, waitingId, approvedId }
}
type Bakes = Awaited<ReturnType<typeof bakes>>

describe('an id from Bakes is not found at Soups', () => {
  const decided = { scope: 'read', lifetime: '30d', decidedBy: 'owner@example.test' } as const
  // Each statement, tried at Soups (nothing found, nothing changed), then at Bakes (found): the space is what refused it
  it.each<[string, (bakes: Bakes, spaceId: string) => Promise<unknown>]>([
    ['inviteAt', ({ repo, inviteId }, spaceId) => repo.inviteAt(spaceId, inviteId)],
    ['inviteByCodeAt', ({ repo }, spaceId) => repo.inviteByCodeAt(spaceId, 'code-bakes')],
    ['revokeInvite', ({ repo, inviteId }, spaceId) => repo.revokeInvite(spaceId, inviteId, NOW)],
    ['revokeInvitesReplacing', ({ repo, memberId }, spaceId) => repo.revokeInvitesReplacing(spaceId, memberId, NOW)],
    ['requestAt', ({ repo, waitingId }, spaceId) => repo.requestAt(spaceId, waitingId)],
    ['requestByTicket', ({ repo }, spaceId) => repo.requestByTicket(spaceId, 'ticket-waiting')],
    ['approveRequest', ({ repo, waitingId }, spaceId) => repo.approveRequest(spaceId, waitingId, decided, NOW)],
    ['refuseRequest', ({ repo, waitingId }, spaceId) => repo.refuseRequest(spaceId, waitingId, 'owner@example.test', NOW)],
    ['claimInvite', ({ repo, inviteId }, spaceId) => repo.claimInvite(inviteId, memberRow(spaceId, NOW, 'grant-invite'), NOW)],
    ['claimRequest', ({ repo, approvedId }, spaceId) => repo.claimRequest(approvedId, memberRow(spaceId, NOW, 'grant-request'), NOW)],
    ['memberAt', ({ repo, memberId }, spaceId) => repo.memberAt(spaceId, memberId)],
    ['endMember', ({ repo, memberId }, spaceId) => repo.endMember(spaceId, memberId, 'removed', NOW)],
  ])('%s', async (_, statement) => {
    const world = await bakes()
    expect(await statement(world, 'sp_soups')).toBeOneOf([undefined, null, false, 0])
    expect(await statement(world, 'sp_bakes')).toBeOneOf([expect.any(Object), expect.any(String), true, 1])
  })
})

describe('members', () => {
  it('end once for each reason the kit gives, told twice', async () => {
    const repo = sharingRepo(await sharingDb())
    await repo.addOwnerMember(memberRow('sp_soups', NOW, 'grant-one'))
    await repo.addOwnerMember(memberRow('sp_soups', NOW, 'grant-two', { clientId: 'client-shared' }))
    await repo.addOwnerMember(memberRow('sp_bakes', NOW, 'grant-three', { clientId: 'client-shared' }))
    expect(await repo.endMemberOfGrant('grant-one', 'revoked', NOW)).toMatchObject({ grantId: 'grant-one', spaceId: 'sp_soups' })
    expect(await repo.endMemberOfGrant('grant-one', 'replayed', NOW)).toBeNull()
    expect((await repo.memberByGrant('grant-one'))?.endedReason).toBe('revoked')
    expect((await repo.endMembersOfClient('client-shared', NOW)).map((row) => row.grantId).sort()).toEqual(['grant-three', 'grant-two'])
    expect(await repo.endMembersOfClient('client-shared', NOW)).toEqual([])
  })

  it('list newest first by page, without the removed and the replaced', async () => {
    const repo = sharingRepo(await sharingDb())
    const ids: string[] = []
    for (const grant of ['g1', 'g2', 'g3', 'g4', 'g5']) ids.push((await repo.addOwnerMember(memberRow('sp_soups', NOW, grant)))!)
    await repo.endMember('sp_soups', ids[1]!, 'removed', NOW)
    await repo.endMember('sp_soups', ids[2]!, 'replaced', NOW)
    await repo.endMember('sp_soups', ids[3]!, 'revoked', NOW)
    await repo.addOwnerMember(memberRow('sp_bakes', NOW, 'g6'))
    const first = await repo.listMembers('sp_soups', { limit: 2 })
    expect(first.map((row) => row.id)).toEqual([ids[4], ids[3]])
    expect((await repo.listMembers('sp_soups', { after: first.at(-1)!.id, limit: 2 })).map((row) => row.id)).toEqual([ids[0]])
  })

  it('note a use at most once an hour', async () => {
    const repo = sharingRepo(await sharingDb())
    await repo.addOwnerMember(memberRow('sp_soups', NOW, 'grant-seen'))
    await repo.noteSeen('grant-seen', NOW, at(NOW, 30 * 60 * 1000))
    expect((await repo.memberByGrant('grant-seen'))?.lastSeenAt).toBe(NOW.toISOString())
    await repo.noteSeen('grant-seen', at(NOW, 1), at(NOW, HOUR))
    expect((await repo.memberByGrant('grant-seen'))?.lastSeenAt).toBe(at(NOW, HOUR).toISOString())
  })
})

describe('an agent’s invites', () => {
  it('are revoked with its grant or its client, and the people who joined through them stay', async () => {
    const repo = sharingRepo(await sharingDb())
    const agent = { madeByClient: 'client-agent', madeByGrant: 'grant-agent', invitedBy: 'agent:client-agent' }
    const joined = (await repo.addInvite(inviteRow('sp_soups', NOW, 'joined', agent)))!
    await repo.addInvite(inviteRow('sp_soups', NOW, 'open', agent))
    await repo.addInvite(inviteRow('sp_bakes', NOW, 'other-grant', { ...agent, madeByGrant: 'grant-later' }))
    await repo.claimInvite(joined, memberRow('sp_soups', NOW, 'grant-sam'), NOW)
    expect(await repo.revokeInvitesMadeByGrant('grant-agent', NOW)).toBe(1)
    expect(await repo.revokeInvitesMadeByGrant('grant-agent', NOW)).toBe(0)
    expect(await repo.revokeInvitesMadeByClient('client-agent', NOW)).toBe(1)
    expect(memberStateOf((await repo.memberByGrant('grant-sam'))!, NOW)).toEqual({ state: 'active' })
  })
})

describe('a space', () => {
  it('switches asking, pauses it after ten unanswered asks, and clears the pause with the switch', async () => {
    const repo = sharingRepo(await sharingDb())
    expect(askingStateOf(await repo.spaceAt('sp_soups'))).toBe('off')
    await repo.setAskToJoin('sp_soups', true, NOW)
    for (let ask = 0; ask < 9; ask++) await repo.noteUnanswered('sp_soups', 10, NOW)
    expect(askingStateOf(await repo.spaceAt('sp_soups'))).toBe('on')
    await repo.noteAnswered('sp_soups', NOW)
    for (let ask = 0; ask < 10; ask++) await repo.noteUnanswered('sp_soups', 10, at(NOW, ask))
    expect(await repo.spaceAt('sp_soups')).toMatchObject({ askPausedAt: at(NOW, 9).toISOString(), unansweredAsks: 10 })
    expect(askingStateOf(await repo.spaceAt('sp_soups'))).toBe('paused')
    await repo.setAskToJoin('sp_soups', true, NOW)
    expect(await repo.spaceAt('sp_soups')).toMatchObject({ askToJoin: true, askPausedAt: null, unansweredAsks: 0 })
  })

  it('is forgotten: its invites revoked, its asks refused, its members ended, its settings dropped', async () => {
    const repo = sharingRepo(await sharingDb())
    await repo.setAskToJoin('sp_soups', true, NOW)
    const inviteId = (await repo.addInvite(inviteRow('sp_soups', NOW, 'gone')))!
    await repo.addRequest(requestRow('sp_soups', NOW, 'gone'))
    await repo.addOwnerMember(memberRow('sp_soups', NOW, 'grant-gone'))
    await repo.addOwnerMember(memberRow('sp_bakes', NOW, 'grant-stays'))
    expect(await repo.revokeInvitesOf('sp_soups', NOW)).toBe(1)
    expect(await repo.refuseWaitingAt('sp_soups', 'space deleted', NOW)).toBe(1)
    expect(await repo.endMembersOf('sp_soups', NOW)).toEqual(['grant-gone'])
    await repo.forgetSpace('sp_soups')
    expect(inviteStateOf((await repo.inviteAt('sp_soups', inviteId))!, null, NOW)).toBe('revoked')
    expect(await repo.spaceAt('sp_soups')).toBeUndefined()
    expect((await repo.memberByGrant('grant-gone'))?.endedReason).toBe('space_gone')
    expect((await repo.memberByGrant('grant-stays'))?.endedAt).toBeNull()
  })
})

describe('aging', () => {
  it('ends expired and lapsed members once, and deletes what closed long enough ago', async () => {
    const repo = sharingRepo(await sharingDb())
    await repo.addOwnerMember(memberRow('sp_soups', NOW, 'grant-week', { lifetime: '7d', expiresAt: at(NOW, 7 * DAY).toISOString() }))
    await repo.addOwnerMember(memberRow('sp_soups', NOW, 'grant-quiet', { lifetime: 'until_revoked', expiresAt: null }))
    await repo.addOwnerMember(memberRow('sp_soups', at(NOW, 20 * DAY), 'grant-busy', { lifetime: 'until_revoked', expiresAt: null }))
    const later = at(NOW, 31 * DAY)
    expect((await repo.endExpiredMembers(later)).map((row) => row.grantId)).toEqual(['grant-week'])
    expect((await repo.endLapsedMembers(at(later, -30 * DAY), later)).map((row) => row.grantId)).toEqual(['grant-quiet'])
    expect(await repo.endExpiredMembers(later)).toEqual([])
    expect(await repo.endLapsedMembers(at(later, -30 * DAY), later)).toEqual([])
    expect(await repo.deleteEndedMembers(at(later, -1))).toBe(0)
    expect(await repo.deleteEndedMembers(later)).toBe(2)
    expect((await repo.memberByGrant('grant-busy'))?.endedAt).toBeNull()

    await repo.addInvite(inviteRow('sp_soups', NOW, 'old'))
    const revoked = (await repo.addInvite(inviteRow('sp_soups', at(NOW, 3 * DAY), 'revoked')))!
    await repo.revokeInvite('sp_soups', revoked, at(NOW, 3 * DAY))
    expect(await repo.deleteClosedInvites(at(NOW, 2 * DAY))).toBe(1)
    expect(await repo.deleteClosedInvites(at(NOW, 3 * DAY))).toBe(1)

    const refused = (await repo.addRequest(requestRow('sp_soups', NOW, 'refused')))!
    await repo.refuseRequest('sp_soups', refused, 'owner@example.test', NOW)
    await repo.addRequest(requestRow('sp_soups', NOW, 'lapsing'))
    expect(await repo.deleteClosedRequests(NOW)).toBe(1)
    expect(await repo.deleteClosedRequests(at(NOW, DAY))).toBe(1)
  })
})
