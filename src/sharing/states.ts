/**
 * The named states of an invite, an ask, a member and a space's asking: pure functions of a row and the time, one rule
 * each. The part names a state only through these; the repo's once-only statements check the same rules in SQL (an
 * open invite, an unused ask, a listed member).
 *
 * @example
 * inviteStateOf(invite, member, new Date())   // 'open' | 'redeemed' | 'revoked' | 'expired'
 * memberStateOf(member, new Date())            // { state: 'pending' }, { state: 'active' } or { state: 'ended', reason: 'lapsed' }
 */
import type { EndedReason, Lifetime } from './schema.js'
import type { InviteRow, MemberRow, RequestRow, SpaceRow } from './repo.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** How long an invite can be redeemed after it is made. */
export const REDEEM_WITHIN = DAY
/** A member whose sign-in went unused this long is ended as `lapsed`, as the kit's refresh token lapses. */
export const UNSEEN_FOR = 30 * DAY
/** A pending member whose first token goes unused this long is deleted by aging: its exchange likely failed. */
export const FIRST_USE_WITHIN = HOUR
/** Asks in a row that lapse or are refused unanswered before asking pauses. */
export const UNANSWERED_PAUSE = 10
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

export type RequestState = 'waiting' | 'approved' | 'refused' | 'joined' | 'lapsed'

/** An ask's state: joined once a member holds it, refused once refused, lapsed once its held ticket ends. */
export const requestStateOf = (request: Pick<RequestRow, 'state' | 'expiresAt'>, member: Pick<MemberRow, 'id'> | null | undefined, now: Date): RequestState => {
  if (member) return 'joined'
  if (request.state === 'refused') return 'refused'
  if (isPast(request.expiresAt, now)) return 'lapsed'
  return request.state
}

export type MemberState = { state: 'pending' } | { state: 'active' } | { state: 'ended'; reason: EndedReason }

/**
 * A member's state: ended with its reason, or ended now when its lifetime passed or it went unseen (fail closed); else
 * pending until its first token is used (the kit may have issued none), then active.
 */
export const memberStateOf = (member: Pick<MemberRow, 'endedAt' | 'endedReason' | 'expiresAt' | 'lastSeenAt' | 'firstUsedAt'>, now: Date): MemberState => {
  if (member.endedAt) return { state: 'ended', reason: member.endedReason ?? 'revoked' }
  if (member.expiresAt && isPast(member.expiresAt, now)) return { state: 'ended', reason: 'expired' }
  if (Date.parse(member.lastSeenAt) <= now.getTime() - UNSEEN_FOR) return { state: 'ended', reason: 'lapsed' }
  if (!member.firstUsedAt) return { state: 'pending' }
  return { state: 'active' }
}

export type MemberListing = 'active' | 'signed_out' | 'hidden'

/** How the owner's list shows a member: a pending one as active, removed and replaced ones gone, other ended ones signed out. */
export const memberListingOf = (member: Pick<MemberRow, 'endedAt' | 'endedReason' | 'expiresAt' | 'lastSeenAt' | 'firstUsedAt'>, now: Date): MemberListing => {
  const current = memberStateOf(member, now)
  if (current.state !== 'ended') return 'active'
  if (current.reason === 'removed' || current.reason === 'replaced') return 'hidden'
  return 'signed_out'
}

export type AskingState = 'off' | 'on' | 'paused'

/** Whether a space takes asks to join: off without its row or its switch, paused after unanswered asks. */
export const askingStateOf = (space: Pick<SpaceRow, 'askToJoin' | 'askPausedAt'> | null | undefined): AskingState => {
  if (!space?.askToJoin) return 'off'
  if (space.askPausedAt) return 'paused'
  return 'on'
}

/** When an invite made at `createdAt` stops being redeemable. */
export const redeemByOf = (createdAt: Date) => new Date(createdAt.getTime() + REDEEM_WITHIN).toISOString()

/** When a member who joined at `joinedAt` with this lifetime ends; null is until revoked. */
export const memberExpiresAtOf = (lifetime: Lifetime, joinedAt: Date) => {
  if (lifetime === 'until_revoked') return null
  return new Date(joinedAt.getTime() + LIFETIME_DAYS[lifetime] * DAY).toISOString()
}
