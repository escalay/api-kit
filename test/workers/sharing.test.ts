import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { migrate, testDb } from '../../src/index.js'
import { codeHashOf, MAX_OPEN_INVITES, newInviteCode, sharingKeys, sharingRepo, SHARING_MIGRATIONS } from '../../src/sharing/index.js'
import { at, DAY, inviteRow, memberRow, requestRow } from '../sharing-rows.js'

const NOW = new Date('2026-03-12T09:00:00.000Z')

// D1 keeps one database per test file, so each test uses its own ids
const sharingDb = async () => {
  const db = await testDb()
  await migrate(db, 'sharing', SHARING_MIGRATIONS)
  return db
}

describe('the sharing tables on D1', () => {
  it('migrate into exactly the four tables and ten indexes the step names', async () => {
    const db = await sharingDb()
    const rows = await db.all<{ type: string; name: string }>(sql`select type, name from sqlite_master where name like 'sharing%' order by name`)
    expect(rows.filter((row) => row.type === 'table').map((row) => row.name)).toEqual(['sharing_invites', 'sharing_members', 'sharing_requests', 'sharing_spaces'])
    expect(rows.filter((row) => row.type === 'index')).toHaveLength(10)
  })

  it('make one member when two exchanges claim one invite at once', async () => {
    const repo = sharingRepo(await sharingDb())
    const inviteId = (await repo.addInvite(inviteRow('sp_soups', NOW, 'd1-invite')))!
    const claims = await Promise.all([repo.claimInvite(inviteId, memberRow('sp_soups', NOW, 'd1-grant-a'), NOW), repo.claimInvite(inviteId, memberRow('sp_soups', NOW, 'd1-grant-b'), NOW)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect((await repo.inviteAt('sp_soups', inviteId))?.memberId).toBe(claims.find(Boolean))
    expect(await repo.claimInvite(inviteId, memberRow('sp_bakes', NOW, 'd1-grant-c'), NOW)).toBeNull()
  })

  it('make one member when two exchanges claim one approved ask at once', async () => {
    const repo = sharingRepo(await sharingDb())
    const requestId = (await repo.addRequest(requestRow('sp_soups', NOW, 'd1-ask')))!
    await repo.approveRequest('sp_soups', requestId, { scope: 'read', lifetime: '30d', decidedBy: 'owner@example.test' }, NOW)
    const claims = await Promise.all([repo.claimRequest(requestId, memberRow('sp_soups', NOW, 'd1-grant-d'), NOW), repo.claimRequest(requestId, memberRow('sp_soups', NOW, 'd1-grant-e'), NOW)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(await repo.claimRequest(requestId, memberRow('sp_soups', NOW, 'd1-grant-f'), at(NOW, DAY))).toBeNull()
  })

  it('add no invite past 100 open at a space when many are made at once', async () => {
    const repo = sharingRepo(await sharingDb())
    const added = await Promise.all(Array.from({ length: 110 }, (_, index) => repo.addInvite(inviteRow('sp_d1_cap', NOW, `d1-cap-${index}`))))
    expect(added.filter(Boolean)).toHaveLength(MAX_OPEN_INVITES)
    expect(await repo.countOpenInvites('sp_d1_cap', NOW)).toBe(MAX_OPEN_INVITES)
  })

  it('derive the keys and hash a code inside workerd', () => {
    const keys = sharingKeys('a sharing secret of thirty-two bytes or more, for tests only')
    const code = newInviteCode()
    expect(codeHashOf(keys, code.toLowerCase())).toBe(codeHashOf(keys, code))
  })
})
