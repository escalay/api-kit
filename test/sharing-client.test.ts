/** The owner's sharing in the browser, without a framework: `sharing-client.ts` against the sharing part's real routes. */
import { describe, expect, expectTypeOf, it } from 'vitest'
import { createSharingClient, SharingError, ShownOnceError, type EndedReason, type Lifetime, type Scope, type Via } from '../src/browser/sharing-client.js'
import { ENDED_REASONS, LIFETIMES, SCOPES, VIAS } from '../src/sharing/schema.js'
import { approveSignIn, connectAgent } from '../src/testing/index.js'
import { CLIENT_A, OWNER_KEY, READER_KEY, recipeBox, type RecipeBox } from './sharing-fixture.js'

/** A client for the recipe box in this process, signed in with `key`, counting the requests it makes. */
const clientFor = (box: RecipeBox, key = OWNER_KEY) => {
  const calls: string[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    return box.app.request(url, init)
  }) as typeof fetch
  return { client: createSharingClient({ fetchImpl, headers: { authorization: `Bearer ${key}` } }), calls }
}

/** Sam's app joining at the invite's address with its code, typed on the part's page. */
const joinWithCode = (box: RecipeBox, address: string, code: string) =>
  connectAgent(box.app, { address, redirect: CLIENT_A, name: 'Sample', approve: (query) => approveSignIn(box.app, query, { form: { action: '/sharing/join', fields: { code } } }) })

describe('the sharing client', () => {
  it('makes, reads, pages through and revokes a space’s invites', async () => {
    const box = await recipeBox()
    const { client, calls } = clientFor(box)
    const sam = await client.createInvite('soups', { label: 'Sam' })
    expect(sam).toMatchObject({ label: 'Sam', scope: 'read', lifetime: '30d', state: 'open', address: 'http://localhost/box/soups/mcp' })
    expect(sam.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(sam.message).toContain(sam.code)
    await client.createInvite('soups', { label: 'Ada', scope: 'write', lifetime: '7d' })
    await client.createInvite('soups', { label: 'Lee' })
    expect(await client.sharing('soups')).toMatchObject({ space: 'soups', title: 'Soups', openInvites: 3 })

    // One invite a page, newest first, each page from the cursor of the one before
    const first = await client.invites('soups', { limit: 1 })
    const second = await client.invites('soups', { limit: 1, cursor: first.next! })
    const third = await client.invites('soups', { limit: 1, cursor: second.next! })
    expect([...first.items, ...second.items, ...third.items].map((invite) => invite.label)).toEqual(['Lee', 'Ada', 'Sam'])
    expect(third.next).toBeNull()
    // A listed invite never carries its code: it was shown once
    expect(JSON.stringify(third)).not.toContain(sam.code)

    await client.revokeInvite('soups', sam.id)
    expect(await client.invite('soups', sam.id)).toMatchObject({ id: sam.id, state: 'revoked' })
    expect((await client.sharing('soups')).openInvites).toBe(2)
    expect(calls.slice(0, 4)).toEqual(['POST /api/spaces/soups/invites', 'POST /api/spaces/soups/invites', 'POST /api/spaces/soups/invites', 'GET /api/spaces/soups/sharing'])
  })

  it('answers a retry with the same Idempotency-Key as a ShownOnceError, never the code again', async () => {
    const box = await recipeBox()
    const { client } = clientFor(box)
    const made = await client.createInvite('soups', { label: 'Sam' }, { idempotencyKey: 'invite-sam-1' })
    const retried = await client.createInvite('soups', { label: 'Sam' }, { idempotencyKey: 'invite-sam-1' }).catch((caught: unknown) => caught)
    expect(retried).toBeInstanceOf(ShownOnceError)
    expect(retried).toBeInstanceOf(SharingError)
    expect(retried).toMatchObject({ status: 409, code: 'shown_once' })
    expect((retried as ShownOnceError).detail).toContain(made.id)
    expect(JSON.stringify(retried) + (retried as Error).message).not.toContain(made.code)
    // No second invite was made
    expect((await client.invites('soups')).items.map((invite) => invite.id)).toEqual([made.id])
  })

  it('throws the API’s problem as a SharingError: the same 404 for a missing space and one the caller may not share', async () => {
    const box = await recipeBox()
    const { client } = clientFor(box)
    const { client: reader } = clientFor(box, READER_KEY)
    const missing = await client.sharing('pies').catch((caught: unknown) => caught)
    const hidden = await reader.sharing('soups').catch((caught: unknown) => caught)
    expect(missing).toBeInstanceOf(SharingError)
    expect(missing).not.toBeInstanceOf(ShownOnceError)
    expect([missing, hidden]).toMatchObject([{ status: 404, code: 'not_found' }, { status: 404, code: 'not_found' }])
    expect((missing as SharingError).detail).toMatch(/^No space pies here/)
    await expect(client.createInvite('soups', { label: '' })).rejects.toMatchObject({ status: 400 })
  })

  it('lists, reads, invites again and removes a member who joined', async () => {
    const box = await recipeBox()
    const { client } = clientFor(box)
    const invite = await client.createInvite('soups', { label: 'Sam' })
    const joined = await joinWithCode(box, invite.address, invite.code)
    expect(joined.tokens).not.toBeNull()

    const { items: [sam], next } = await client.members('soups')
    expect(next).toBeNull()
    expect(sam).toMatchObject({ label: 'Sam', appName: 'Sample', returnsTo: 'client-a.example.test', via: 'invite', scope: 'read', lifetime: '30d', state: 'active', endedAt: null })
    expect(await client.member('soups', sam!.id)).toMatchObject({ id: sam!.id, state: 'active' })
    // A used invite cannot be revoked: remove its member instead
    await expect(client.revokeInvite('soups', invite.id)).rejects.toMatchObject({ status: 409, code: 'conflict' })

    const again = await client.inviteAgain('soups', sam!.id)
    expect(again).toMatchObject({ label: 'Sam', scope: 'read', lifetime: '30d', state: 'open' })
    expect(again.code).not.toBe(invite.code)

    await client.removeMember('soups', sam!.id)
    expect((await client.members('soups')).items).toEqual([])
    await expect(client.member('soups', sam!.id)).rejects.toMatchObject({ status: 404 })
    // Its invite again never works either
    expect((await client.invite('soups', again.id)).state).toBe('revoked')
  })

  it('follows only the cursor of a next link, on its own path, origin and headers', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(`${url} ${new Headers(init?.headers).get('authorization')}`)
      const page = { count: 0, _links: { self: { href: url }, next: { href: 'https://elsewhere.example.test/steal?cursor=abc%3D' } }, _embedded: { members: [] } }
      return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/hal+json' } })
    }) as typeof fetch
    const client = createSharingClient({ path: '/api/shelves', fetchImpl, headers: { authorization: 'Bearer owner-key' } })
    const first = await client.members('soups pot', { limit: 10 })
    expect(first.next).toBe('abc=')
    await client.members('soups pot', { limit: 10, cursor: first.next! })
    expect(urls).toEqual(['/api/shelves/soups%20pot/members?limit=10 Bearer owner-key', '/api/shelves/soups%20pot/members?limit=10&cursor=abc%3D Bearer owner-key'])
  })

  it('names the same scopes, lifetimes, ways in and endings as the server', () => {
    expectTypeOf<Scope>().toEqualTypeOf<(typeof SCOPES)[number]>()
    expectTypeOf<Lifetime>().toEqualTypeOf<(typeof LIFETIMES)[number]>()
    expectTypeOf<Via>().toEqualTypeOf<(typeof VIAS)[number]>()
    expectTypeOf<EndedReason>().toEqualTypeOf<(typeof ENDED_REASONS)[number]>()
  })
})
