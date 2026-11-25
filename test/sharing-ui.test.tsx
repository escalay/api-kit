// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SharePanel } from '../src/browser/sharing-block.js'
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

  it('keeps only the newest reload’s answer when an older one of the same space arrives late', async () => {
    const { box } = await ownerOf()
    const { fetchImpl, holding, held, releaseAll } = holdingReads(box)
    const client = createSharingClient({ fetchImpl, headers: { authorization: `Bearer ${OWNER_KEY}` } })
    const sam = await client.createInvite('soups', { label: 'Sam' })
    const { result } = renderHook(() => useSharing(client, 'soups'))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    holding(true)
    let older!: Promise<void>
    act(() => void (older = result.current.reload()))
    await waitFor(() => expect(held).toHaveLength(3))
    holding(false)
    await act(() => result.current.revokeInvite(sam.id))
    expect(result.current.invites.map((invite) => invite.state)).toEqual(['revoked'])

    await act(async () => {
      releaseAll()
      await older
    })
    expect(result.current.invites.map((invite) => invite.state)).toEqual(['revoked'])
    expect(result.current.sharing?.openInvites).toBe(0)
  })

  it('drops a page asked for before a reload that started after it', async () => {
    const { box } = await ownerOf()
    const { fetchImpl, holding, held, releaseAll } = holdingReads(box)
    const client = createSharingClient({ fetchImpl, headers: { authorization: `Bearer ${OWNER_KEY}` } })
    const sam = await client.createInvite('soups', { label: 'Sam' })
    for (const label of ['Ada', 'Lee']) await client.createInvite('soups', { label })
    const { result } = renderHook(() => useSharing(client, 'soups', { limit: 2 }))
    await waitFor(() => expect(result.current.invites).toHaveLength(2))

    holding(true)
    let page!: Promise<void>
    act(() => void (page = result.current.loadMoreInvites()))
    await waitFor(() => expect(held).toHaveLength(1))
    holding(false)
    await act(() => result.current.revokeInvite(sam.id))

    await act(async () => {
      releaseAll()
      await page
    })
    // The page holding Sam as open was asked before the revoke's reload: it is not appended
    expect(result.current.invites.map((invite) => [invite.label, invite.state])).toEqual([['Lee', 'open'], ['Ada', 'open']])
    await act(() => result.current.loadMoreInvites())
    expect(result.current.invites.map((invite) => [invite.label, invite.state])).toEqual([['Lee', 'open'], ['Ada', 'open'], ['Sam', 'revoked']])
  })
})

/** A fetch over the recipe box that, while holding, answers each read as it was then, but only at `releaseAll`. */
const holdingReads = (box: RecipeBox) => {
  let hold = false
  const held: (() => void)[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const answer = await box.app.request(url, init)
    if (hold && (init?.method ?? 'GET') === 'GET') await new Promise<void>((release) => held.push(release))
    return answer
  }) as typeof fetch
  return {
    fetchImpl,
    held,
    holding: (on: boolean) => void (hold = on),
    releaseAll: () => held.splice(0).forEach((release) => release()),
  }
}

/** The row of a list that names `label`. */
const rowOf = (list: string, label: string) => within(screen.getByRole('list', { name: list })).getAllByRole('listitem').find((row) => within(row).queryByText(label) !== null)!

/** Types a label into the panel's invite form and makes the invite. */
const makeInvite = async (label: string) => {
  fireEvent.change(screen.getByLabelText('Who it is for'), { target: { value: label } })
  fireEvent.click(screen.getByRole('button', { name: 'Make an invite' }))
  return within(await screen.findByRole('region', { name: 'Send this once' })).getByText(/[A-Z]{4}-[A-Z]{4}/).textContent ?? ''
}

describe('SharePanel', () => {
  it('makes an invite with the owner page’s defaults, read for 30 days, and shows its code once', async () => {
    const { client } = await ownerOf()
    render(<SharePanel client={client} space="soups" />)
    expect(await screen.findByRole('heading', { name: 'Share Soups' })).toBeTruthy()
    expect(screen.getByText('No invites yet.')).toBeTruthy()
    expect(screen.getByText('Whoever uses it can read Soups for 30 days.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Make an invite' }) as HTMLButtonElement).disabled).toBe(true)

    const message = await makeInvite('Sam')
    const sam = (await client.invites('soups')).items[0]!
    expect([sam.label, sam.scope, sam.lifetime]).toEqual(['Sam', 'read', '30d'])
    expect(message).toMatch(/[A-Z]{4}-[A-Z]{4}/)
    await waitFor(() => expect(within(rowOf('Invites out', 'Sam')).getByText('Open')).toBeTruthy())
    expect(within(rowOf('Invites out', 'Sam')).getByText('Can read, for 30 days')).toBeTruthy()
    // The form starts over for the next invite
    expect((screen.getByLabelText('Who it is for') as HTMLInputElement).value).toBe('')

    // Once dismissed, the code is nowhere on the page
    const code = message.match(/[A-Z]{4}-[A-Z]{4}/)![0]
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('region', { name: 'Send this once' })).toBeNull()
    expect(document.body.textContent).not.toContain(code)
  })

  it('gives changes and until revoked only when the owner ticks them, in the owner page’s words', async () => {
    const { client } = await ownerOf()
    render(<SharePanel client={client} space="soups" />)
    await screen.findByRole('heading', { name: 'Share Soups' })
    fireEvent.click(screen.getByRole('switch', { name: 'Allow changes' }))
    fireEvent.click(screen.getByRole('switch', { name: 'Until revoked, not 30 days' }))
    expect(screen.getByText('Whoever uses it can read and make changes to Soups until revoked.')).toBeTruthy()
    await makeInvite('Ada')
    const ada = (await client.invites('soups')).items[0]!
    expect([ada.scope, ada.lifetime]).toEqual(['write', 'until_revoked'])
    await waitFor(() => expect(within(rowOf('Invites out', 'Ada')).getByText('Can read and make changes, until revoked')).toBeTruthy())
  })

  it('revokes an open invite, and offers no revoke on one that is not open', async () => {
    const { client } = await ownerOf()
    await client.createInvite('soups', { label: 'Sam' })
    render(<SharePanel client={client} space="soups" />)
    await waitFor(() => expect(within(rowOf('Invites out', 'Sam')).getByText('Open')).toBeTruthy())
    fireEvent.click(within(rowOf('Invites out', 'Sam')).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(within(rowOf('Invites out', 'Sam')).getByText('Revoked')).toBeTruthy())
    expect(within(rowOf('Invites out', 'Sam')).queryByRole('button', { name: 'Revoke' })).toBeNull()
    expect((await client.invites('soups')).items[0]!.state).toBe('revoked')
  })

  it('lists members by the app’s own words as text, invites one again and removes one after asking', async () => {
    const { box, client } = await ownerOf()
    const invite = await client.createInvite('soups', { label: 'Sam' })
    const now = new Date()
    expect(await sharingRepo(box.db).claimInvite(invite.id, memberRow('sp_soups', now, 'grant-sam', { appName: '<b>Sample</b>', returnsTo: 'sample-app:/callback' }), now)).not.toBeNull()
    render(<SharePanel client={client} space="soups" />)
    await waitFor(() => expect(within(rowOf('Members', 'Sam')).getByText('Active')).toBeTruthy())
    const sam = rowOf('Members', 'Sam')
    // What the app calls itself and where it returns are its own claim: text, never markup or a link
    expect(within(sam).getByText('<b>Sample</b>, returns to sample-app:/callback')).toBeTruthy()
    expect(sam.querySelector('b, a')).toBeNull()

    fireEvent.click(within(sam).getByRole('button', { name: 'Invite again' }))
    const shown = await screen.findByRole('region', { name: 'Send this once' })
    expect(within(shown).getByText(/[A-Z]{4}-[A-Z]{4}/)).toBeTruthy()
    expect((await client.invites('soups')).items.map((one) => [one.label, one.state])).toEqual([['Sam', 'open'], ['Sam', 'redeemed']])

    fireEvent.click(within(rowOf('Members', 'Sam')).getByRole('button', { name: 'Remove' }))
    const asking = within(rowOf('Members', 'Sam')).getByRole('alert')
    expect(asking.textContent).toContain('Remove Sam? Their app stops working at once.')
    fireEvent.click(within(asking).getByRole('button', { name: 'Keep' }))
    expect(within(rowOf('Members', 'Sam')).queryByRole('alert')).toBeNull()
    fireEvent.click(within(rowOf('Members', 'Sam')).getByRole('button', { name: 'Remove' }))
    fireEvent.click(within(within(rowOf('Members', 'Sam')).getByRole('alert')).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.getByText('Nobody has joined yet.')).toBeTruthy())
    expect((await client.members('soups')).items).toEqual([])
  })

  it('keeps asking on a member’s row when the removal failed, so Remove can be tried again there', async () => {
    const { box } = await ownerOf()
    let failNextDelete = true
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method !== 'DELETE' || !failNextDelete) return box.app.request(url, init)
      failNextDelete = false
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    const client = createSharingClient({ fetchImpl, headers: { authorization: `Bearer ${OWNER_KEY}` } })
    await joinByInvite(box, (await client.createInvite('soups', { label: 'Sam' })).id)
    render(<SharePanel client={client} space="soups" />)
    await waitFor(() => expect(within(rowOf('Members', 'Sam')).getByText('Active')).toBeTruthy())

    fireEvent.click(within(rowOf('Members', 'Sam')).getByRole('button', { name: 'Remove' }))
    fireEvent.click(within(within(rowOf('Members', 'Sam')).getByRole('alert')).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'People' })).getByText('Failed to fetch')).toBeTruthy())
    const asking = within(rowOf('Members', 'Sam')).getByRole('alert')
    expect(asking.textContent).toContain('Remove Sam?')

    fireEvent.click(within(asking).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.getByText('Nobody has joined yet.')).toBeTruthy())
  })

  it('retries a lost answer with the same Idempotency-Key, and says the invite it made cannot be shown again', async () => {
    const { box } = await ownerOf()
    const keys: string[] = []
    let dropNext = true
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return box.app.request(url, init)
      keys.push((init.headers as Record<string, string>)['idempotency-key'] ?? '')
      const answer = await box.app.request(url, init)
      if (!dropNext) return answer
      dropNext = false
      throw new TypeError('Failed to fetch')
    }) as typeof fetch
    const client = createSharingClient({ fetchImpl, headers: { authorization: `Bearer ${OWNER_KEY}` } })
    render(<SharePanel client={client} space="soups" />)
    await screen.findByRole('heading', { name: 'Share Soups' })

    fireEvent.change(screen.getByLabelText('Who it is for'), { target: { value: 'Sam' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make an invite' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Failed to fetch')
    fireEvent.click(screen.getByRole('button', { name: 'Make an invite' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('That invite was made, but its code cannot be shown again: revoke it and make another.'))
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    expect(screen.queryByRole('region', { name: 'Send this once' })).toBeNull()
    expect((await client.invites('soups')).items.map((one) => one.label)).toEqual(['Sam'])

    // That key is spent: the next try is a new invite
    fireEvent.click(screen.getByRole('button', { name: 'Make an invite' }))
    await screen.findByRole('region', { name: 'Send this once' })
    expect(keys[2]).not.toBe(keys[0])
    expect((await client.invites('soups')).items.map((one) => one.label)).toEqual(['Sam', 'Sam'])
  })

  it('drops a shown code when the space changes', async () => {
    const { client } = await ownerOf()
    const { rerender } = render(<SharePanel client={client} space="soups" />)
    await screen.findByRole('heading', { name: 'Share Soups' })
    const code = (await makeInvite('Sam')).match(/[A-Z]{4}-[A-Z]{4}/)![0]
    rerender(<SharePanel client={client} space="bakes" />)
    await screen.findByRole('heading', { name: 'Share Bakes' })
    expect(screen.queryByRole('region', { name: 'Send this once' })).toBeNull()
    expect(document.body.textContent).not.toContain(code)
  })

  it('shows more invites and members a page at a time', async () => {
    const { box, client } = await ownerOf()
    for (const label of ['Sam', 'Ada', 'Lee']) await client.createInvite('soups', { label })
    const now = new Date()
    for (const grant of ['g1', 'g2', 'g3']) await sharingRepo(box.db).claimInvite((await client.createInvite('soups', { label: grant })).id, memberRow('sp_soups', now, grant, { label: `Member ${grant}` }), now)
    render(<SharePanel client={client} space="soups" limit={2} />)
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Members' })).getAllByRole('listitem')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Show more members' }))
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Members' })).getAllByRole('listitem')).toHaveLength(3))
    expect(screen.queryByRole('button', { name: 'Show more members' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Show more invites' }))
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Invites out' })).getAllByRole('listitem')).toHaveLength(4))
  })

  it('says why a space could not load, and what a failed change answered', async () => {
    const { client } = await ownerOf()
    const { rerender } = render(<SharePanel client={client} space="pies" />)
    expect((await screen.findByRole('alert')).textContent).toContain('No space pies here that you may share.')
    expect(screen.queryByRole('button', { name: 'Make an invite' })).toBeNull()

    for (let made = 0; made < 100; made++) await client.createInvite('bakes', { label: `Guest ${made}` })
    rerender(<SharePanel client={client} space="bakes" />)
    await screen.findByRole('heading', { name: 'Share Bakes' })
    fireEvent.change(screen.getByLabelText('Who it is for'), { target: { value: 'One too many' } })
    fireEvent.click(screen.getByRole('button', { name: 'Make an invite' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Bakes has 100 open invites')
    expect(screen.queryByRole('region', { name: 'Send this once' })).toBeNull()

    // An answered failure spends nothing: once there is room, the same form makes the invite
    fireEvent.click(within(rowOf('Invites out', 'Guest 99')).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(within(rowOf('Invites out', 'Guest 99')).getByText('Revoked')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Make an invite' }))
    await screen.findByRole('region', { name: 'Send this once' })
    expect((await client.invites('bakes', { limit: 1 })).items[0]!.label).toBe('One too many')
  })

  it('shows a member whose sign-in ended as signed out, and invites them again', async () => {
    const { box, client } = await ownerOf()
    const invite = await client.createInvite('soups', { label: 'Sam' })
    const joined = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    await sharingRepo(box.db).claimInvite(invite.id, memberRow('sp_soups', joined, 'grant-sam', { expiresAt: new Date(Date.now() - 60_000).toISOString() }), joined)
    render(<SharePanel client={client} space="soups" />)
    await waitFor(() => expect(within(rowOf('Members', 'Sam')).getByText('Signed out')).toBeTruthy())
    fireEvent.click(within(rowOf('Members', 'Sam')).getByRole('button', { name: 'Invite again' }))
    const shown = await screen.findByRole('region', { name: 'Send this once' })
    expect(within(shown).getByText(/[A-Z]{4}-[A-Z]{4}/)).toBeTruthy()
    expect(within(shown).getByText('Send this to Sam. Its code is shown only this once.')).toBeTruthy()
  })
})
