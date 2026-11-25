/**
 * The named states of an invite and a member: pure functions of a row and the time, one rule each. The part names a
 * state only through these; the repo's once-only statements check the same rules in SQL (an open invite, a listed
 * member).
 *
 * @example
 * inviteStateOf(invite, member, new Date())   // 'open' | 'redeemed' | 'revoked' | 'expired'
 * memberStateOf(member, new Date())            // { state: 'active' } or { state: 'ended', reason: 'lapsed' }
 */
import type { EndedReason, Lifetime } from './schema.js'
import type { InviteRow, MemberRow } from './repo.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** How long an invite can be redeemed after it is made. */
export const REDEEM_WITHIN = DAY
/** A member whose sign-in went unused this long is ended as `lapsed`, as the kit's refresh token lapses. */
export const UNSEEN_FOR = 30 * DAY
/** Open invites a space may hold at once. */
export const MAX_OPEN_INVITES = 100

const LIFETIME_DAYS: Record<Exclude<Lifetime, 'until_revoked'>, number> = { '7d': 7, '30d': 30 }

const isPast = (at: string, now: Date) => at <= now.toISOString()

export type InviteState = 'open' | 'redeemed' | 'revoked' | 'expired'

/** An invite's state: redeemed once a member holds it, else revoked, else expired once `redeem_by` passes. */
export const inviteStateOf = (invite: Pick<InviteRow, 'revokedAt' | 'redeemBy'>, member: Pick<MemberRow, 'id'> | null | undefined, now: Date): InviteState => {
  if (member) return 'redeemed'
  if (invite.revokedAt) return 'revoked'
  if (isPast(invite.redeemBy, now)) return 'expired'
  return 'open'
}

export type MemberState = { state: 'active' } | { state: 'ended'; reason: EndedReason }

/** A member's state: ended with its reason, or ended now when its lifetime passed or it went unseen (fail closed). */
export const memberStateOf = (member: Pick<MemberRow, 'endedAt' | 'endedReason' | 'expiresAt' | 'lastSeenAt'>, now: Date): MemberState => {
  if (member.endedAt) return { state: 'ended', reason: member.endedReason ?? 'revoked' }
  if (member.expiresAt && isPast(member.expiresAt, now)) return { state: 'ended', reason: 'expired' }
  if (Date.parse(member.lastSeenAt) <= now.getTime() - UNSEEN_FOR) return { state: 'ended', reason: 'lapsed' }
  return { state: 'active' }
}

export type MemberListing = 'active' | 'signed_out' | 'hidden'

/** How the owner's list shows a member: removed and replaced ones are gone, other ended ones are signed out. */
export const memberListingOf = (member: Pick<MemberRow, 'endedAt' | 'endedReason' | 'expiresAt' | 'lastSeenAt'>, now: Date): MemberListing => {
  const current = memberStateOf(member, now)
  if (current.state === 'active') return 'active'
  if (current.reason === 'removed' || current.reason === 'replaced') return 'hidden'
  return 'signed_out'
}

/** When an invite made at `createdAt` stops being redeemable. */
export const redeemByOf = (createdAt: Date) => new Date(createdAt.getTime() + REDEEM_WITHIN).toISOString()

/** When a member who joined at `joinedAt` with this lifetime ends; null is until revoked. */
export const memberExpiresAtOf = (lifetime: Lifetime, joinedAt: Date) => {
  if (lifetime === 'until_revoked') return null
  return new Date(joinedAt.getTime() + LIFETIME_DAYS[lifetime] * DAY).toISOString()
}
