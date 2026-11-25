/**
 * Aging and a deleted space: what the app calls outside a request. `sweep` (from its scheduled handler, hourly is
 * enough) ends the members `accepts` already refuses, revokes their grants, and deletes what closed long ago; `forget`
 * ends everything a deleted space had. Each row is ended by a conditional update that returns it, so two instances
 * sweeping at once end and revoke each member once, and running either again changes nothing.
 *
 * @example
 * const { ended, deleted } = await sharing.sweep()
 * await sharing.forget(shelf.id)
 */
import type { Binding, Bound } from './grants.js'
import type { SharingRepo } from './repo.js'
import { UNSEEN_FOR } from './states.js'

const DAY = 24 * 60 * 60 * 1000
/** How long an ended member stays on the record (shown signed out, or hidden). */
const ENDED_KEPT = 90 * DAY
/** How long an invite stays after it stopped being open (revoked, or past `redeem_by`). */
const CLOSED_INVITE_KEPT = 7 * DAY

const before = (now: Date, ms: number) => new Date(now.getTime() - ms)

/** What `sweep` and `forget` work from. */
type Aging = { repo: SharingRepo; binding: Binding }

/** The server the part is bound to; throws before `registerSharing`, since an ended member's grant must be revoked too. */
const boundFor = (binding: Binding, what: string): Bound => {
  if (!binding.bound) throw new Error(`sharing: ${what} needs the part bound to the app's OAuth server: call registerSharing first.`)
  return binding.bound
}

/** Revokes each grant, one after another. */
const revokeAll = async (bound: Bound, grants: string[]) => {
  for (const grant of grants) await bound.revokeGrant(grant)
}

/**
 * `sweep`: ends live members past their lifetime (`expired`) or unseen for 30 days (`lapsed`) and revokes their grants;
 * deletes members ended 90 days ago, and invites 7 days after they stopped being open.
 * Returns how many members it ended and how many rows it deleted.
 *
 * @example
 * const sweep = sweepFor({ repo, binding })   // what sharing.sweep is
 */
export const sweepFor = ({ repo, binding }: Aging) => async () => {
  const bound = boundFor(binding, 'sweep')
  const now = new Date()
  const expired = await repo.endExpiredMembers(now)
  const lapsed = await repo.endLapsedMembers(before(now, UNSEEN_FOR), now)
  const ended = [...expired, ...lapsed].map((row) => row.grantId)
  await revokeAll(bound, ended)
  const members = await repo.deleteEndedMembers(before(now, ENDED_KEPT))
  const invites = await repo.deleteClosedInvites(before(now, CLOSED_INVITE_KEPT))
  return { ended: ended.length, deleted: members + invites }
}

/**
 * `forget`: a space the app deleted. Its invites are revoked first, so no claim lands after its members end; then its
 * waiting asks refused, its members ended (`space_gone`) and their grants revoked, its settings dropped.
 *
 * @example
 * const forget = forgetFor({ repo, binding })   // what sharing.forget is
 */
export const forgetFor = ({ repo, binding }: Aging) => async (spaceId: string) => {
  const bound = boundFor(binding, 'forget')
  const now = new Date()
  await repo.revokeInvitesOf(spaceId, now)
  await repo.refuseWaitingAt(spaceId, 'space deleted', now)
  await revokeAll(bound, await repo.endMembersOf(spaceId, now))
  await repo.forgetSpace(spaceId)
}
