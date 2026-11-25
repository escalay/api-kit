// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createSharingClient } from '../src/browser/sharing-client.js'
import { useSharing } from '../src/browser/sharing-react.js'
import { sharingRepo } from '../src/sharing/index.js'
import { OWNER_KEY, recipeBox, type RecipeBox } from './sharing-fixture.js'
import { memberRow } from './sharing-rows.js'

/** The recipe box in this process, and a sharing client signed in as the owner's key. */
const ownerOf = async () => {
  const box = await recipeBox()
  const fetchImpl = ((url: string, init?: RequestInit) => box.app.request(url, init)) as typeof fetch
  return { box, client: createSharingClient({ fetchImpl, headers: { authorization: `Bearer ${OWNER_KEY}` } }) }
}

/**
 * Sam joining by the invite, written by the part's own claim. happy-dom's Response hides `set-cookie`, so the sign-in
 * pages cannot be driven here; `test/sharing-client.test.ts` joins through them.
 */
const joinByInvite = async (box: RecipeBox, inviteId: string) => {
  const now = new Date()
  expect(await sharingRepo(box.db).claimInvite(inviteId, memberRow('sp_soups', now, 'grant-sam'), now)).not.toBeNull()
}

afterEach(cleanup)

describe('useSharing', () => {
  it('loads a space’s sharing, invites and members, and reloads after each change', async () => {
    const { client } = await ownerOf()
    const { result } = renderHook(() => useSharing(client, 'soups'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect([result.current.sharing?.title, result.current.invites, result.current.members]).toEqual(['Soups', [], []])

    let made = await act(() => result.current.createInvite({ label: 'Sam' }))
    expect(made.code).toMatch(/^[A-Z]{4}-[A-Z]{4}$/)
    expect(result.current.invites.map((invite) => [invite.label, invite.state])).toEqual([['Sam', 'open']])
    expect(result.current.sharing?.openInvites).toBe(1)
    // The code is the caller's to show once: the hook never keeps it
    expect(JSON.stringify(result.current)).not.toContain(made.code)

    await act(() => result.current.revokeInvite(made.id))
    expect(result.current.invites.map((invite) => invite.state)).toEqual(['revoked'])
    expect(result.current.sharing?.openInvites).toBe(0)
    made = await act(() => result.current.createInvite({ label: 'Ada', lifetime: '7d' }))
    expect(result.current.invites.map((invite) => invite.label)).toEqual(['Ada', 'Sam'])
  })

  it('invites a member again and removes one', async () => {
    const { box, client } = await ownerOf()
    const invite = await client.createInvite('soups', { label: 'Sam' })
    await joinByInvite(box, invite.id)
    const { result } = renderHook(() => useSharing(client, 'soups'))
    await waitFor(() => expect(result.current.members.map((member) => member.label)).toEqual(['Sam']))
    const sam = result.current.members[0]!

    const again = await act(() => result.current.inviteAgain(sam.id))
    expect(again).toMatchObject({ label: 'Sam', state: 'open' })
    expect(result.current.invites.map((one) => [one.label, one.state])).toEqual([['Sam', 'open'], ['Sam', 'redeemed']])

    await act(() => result.current.removeMember(sam.id))
    expect(result.current.members).toEqual([])
    expect(result.current.invites.map((one) => one.state)).toEqual(['revoked', 'redeemed'])
  })

  it('loads more invites by cursor, a page at a time, and starts over on reload', async () => {
    const { client } = await ownerOf()
    for (const label of ['Sam', 'Ada', 'Lee']) await client.createInvite('soups', { label })
    const { result } = renderHook(() => useSharing(client, 'soups', { limit: 2 }))
    await waitFor(() => expect(result.current.invites.map((invite) => invite.label)).toEqual(['Lee', 'Ada']))
    expect(result.current.moreInvites).toBe(true)
    await act(() => result.current.loadMoreInvites())
    expect(result.current.invites.map((invite) => invite.label)).toEqual(['Lee', 'Ada', 'Sam'])
    expect(result.current.moreInvites).toBe(false)
    expect(result.current.moreMembers).toBe(false)
    await act(() => result.current.reload())
    expect(result.current.invites.map((invite) => invite.label)).toEqual(['Lee', 'Ada'])
  })

  it('appends a page asked for twice only once', async () => {
    const { client } = await ownerOf()
    for (const label of ['Sam', 'Ada', 'Lee']) await client.createInvite('soups', { label })
    const { result } = renderHook(() => useSharing(client, 'soups', { limit: 2 }))
    await waitFor(() => expect(result.current.invites).toHaveLength(2))
    await act(async () => void (await Promise.all([result.current.loadMoreInvites(), result.current.loadMoreInvites()])))
    expect(result.current.invites.map((invite) => invite.label)).toEqual(['Lee', 'Ada', 'Sam'])
  })

  it('keeps the lists it had when a reload after a change fails, and says why', async () => {
    const { box } = await ownerOf()
    let down = false
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (down && (init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ code: 'unavailable', detail: 'The API is down.' }), { status: 503, headers: { 'content-type': 'application/problem+json' } })
      return box.app.request(url, init)
    }) as typeof fetch
    const client = createSharingClient({ fetchImpl, headers: { authorization: `Bearer ${OWNER_KEY}` } })
    const { result } = renderHook(() => useSharing(client, 'soups'))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => void (await result.current.createInvite({ label: 'Sam' })))
    down = true
    await act(async () => void (await result.current.createInvite({ label: 'Ada' })))
    expect([result.current.status, result.current.error?.status]).toEqual(['error', 503])
    expect(result.current.invites.map((invite) => invite.label)).toEqual(['Sam'])
    expect(result.current.sharing?.title).toBe('Soups')
  })

  it('stays idle without a space, follows a new one, and says why a space could not load', async () => {
    const { client } = await ownerOf()
    await client.createInvite('bakes', { label: 'Ada' })
    const { result, rerender } = renderHook(({ space }: { space: string | null }) => useSharing(client, space), { initialProps: { space: null as string | null } })
    expect([result.current.status, result.current.sharing]).toEqual(['idle', null])

    rerender({ space: 'bakes' })
    await waitFor(() => expect(result.current.sharing?.title).toBe('Bakes'))
    expect(result.current.invites.map((invite) => invite.label)).toEqual(['Ada'])

    rerender({ space: 'pies' })
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.error).toMatchObject({ status: 404, code: 'not_found' })
    // Nothing of the space it left is shown as this one's
    expect([result.current.sharing, result.current.invites, result.current.members]).toEqual([null, [], []])
  })

  it('keeps only the newest space’s answer when an older one arrives late', async () => {
    const { box } = await ownerOf()
    const held: { url: string; release: () => void }[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (url.includes('/soups/')) await new Promise<void>((release) => held.push({ url, release }))
      return box.app.request(url, init)
    }) as typeof fetch
    const client = createSharingClient({ fetchImpl, headers: { authorization: `Bearer ${OWNER_KEY}` } })
    const { result, rerender } = renderHook(({ space }: { space: string }) => useSharing(client, space), { initialProps: { space: 'soups' } })
    rerender({ space: 'bakes' })
    await waitFor(() => expect(result.current.sharing?.title).toBe('Bakes'))
    await waitFor(() => expect(held.length).toBe(3))
    await act(async () => {
      for (const one of held) one.release()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(result.current.sharing?.title).toBe('Bakes')
  })
})
