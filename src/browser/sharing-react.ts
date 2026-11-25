/**
 * A React hook over `sharing-client.ts`: the owner's view of one space (how it is shared, its invites and members, a
 * page at a time) and every change to it, with no markup: each app draws its own Share panel, or takes `sharing-block.tsx`.
 *
 * @example
 * const sharing = useMemo(() => createSharingClient(), [])
 * const { invites, members, createInvite, removeMember } = useSharing(sharing, 'soups')
 * const invite = await createInvite({ label: 'Sam' })
 * showOnce(invite.message) // the code is in this answer only: the hook never keeps it
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Invite, InviteInput, Member, SharingClient, SharingError, SharingView, ShownOnceOptions } from './sharing-client'

/** `idle` without a space; `error` when its last load failed (the lists it had are kept). */
type Status = 'idle' | 'loading' | 'ready' | 'error'

type Loaded = { sharing: SharingView | null; invites: Invite[]; members: Member[]; nextInvites: string | null; nextMembers: string | null }
const NOTHING: Loaded = { sharing: null, invites: [], members: [], nextInvites: null, nextMembers: null }

/**
 * One space's sharing as its owner sees it: reloaded from the first page after each change made through it, and when
 * `space` changes (an answer for a space it left is dropped). Changes throw the client's `SharingError`; `createInvite`
 * and `inviteAgain` answer the new invite with its code, which the hook never keeps.
 *
 * @example
 * const { status, sharing, invites, moreInvites, loadMoreInvites, revokeInvite, inviteAgain } = useSharing(client, space, { limit: 20 })
 */
export const useSharing = (client: SharingClient, space: string | null | undefined, { limit }: { limit?: number } = {}) => {
  const [loaded, setLoaded] = useState<Loaded>(NOTHING)
  const [status, setStatus] = useState<Status>(space ? 'loading' : 'idle')
  const [error, setError] = useState<SharingError | null>(null)
  const current = useRef(space)
  current.current = space
  const stillAt = (asked: string) => current.current === asked

  const reload = useCallback(async () => {
    if (!space) {
      setLoaded(NOTHING)
      setStatus('idle')
      return
    }
    try {
      const [sharing, invites, members] = await Promise.all([client.sharing(space), client.invites(space, { limit }), client.members(space, { limit })])
      if (!stillAt(space)) return
      setLoaded({ sharing, invites: invites.items, members: members.items, nextInvites: invites.next, nextMembers: members.next })
      setStatus('ready')
      setError(null)
    } catch (caught) {
      if (!stillAt(space)) return
      setStatus('error')
      setError(caught as SharingError)
    }
  }, [client, space, limit])

  useEffect(() => {
    setLoaded(NOTHING)
    setStatus(space ? 'loading' : 'idle')
    void reload()
  }, [reload])

  // A page whose cursor is no longer the next one (asked twice, or a reload since) is dropped
  const loadMoreInvites = async () => {
    const cursor = loaded.nextInvites
    if (!space || !cursor) return
    const page = await client.invites(space, { limit, cursor })
    if (!stillAt(space)) return
    setLoaded((before) => (before.nextInvites === cursor ? { ...before, invites: [...before.invites, ...page.items], nextInvites: page.next } : before))
  }
  const loadMoreMembers = async () => {
    const cursor = loaded.nextMembers
    if (!space || !cursor) return
    const page = await client.members(space, { limit, cursor })
    if (!stillAt(space)) return
    setLoaded((before) => (before.nextMembers === cursor ? { ...before, members: [...before.members, ...page.items], nextMembers: page.next } : before))
  }

  /** Runs a change at this space, then reloads it; without a space it refuses. */
  const atSpace =
    <Args extends unknown[], Result>(change: (space: string, ...args: Args) => Promise<Result>) =>
    async (...args: Args) => {
      if (!space) throw new Error('useSharing: no space to change.')
      const result = await change(space, ...args)
      await reload()
      return result
    }

  return {
    status,
    error,
    sharing: loaded.sharing,
    invites: loaded.invites,
    members: loaded.members,
    moreInvites: loaded.nextInvites !== null,
    moreMembers: loaded.nextMembers !== null,
    loadMoreInvites,
    loadMoreMembers,
    reload,
    createInvite: atSpace((at, input: InviteInput, options?: ShownOnceOptions) => client.createInvite(at, input, options)),
    revokeInvite: atSpace((at, id: string) => client.revokeInvite(at, id)),
    removeMember: atSpace((at, id: string) => client.removeMember(at, id)),
    inviteAgain: atSpace((at, id: string, options?: ShownOnceOptions) => client.inviteAgain(at, id, options)),
  }
}
