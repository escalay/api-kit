/** Rows for the sharing part's tests, on node:sqlite and D1: an invite, an ask and a member, at a space, in fixture names. */
import type { NewInvite, NewMember, NewRequest } from '../src/sharing/index.js'

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR
export const at = (from: Date, ms: number) => new Date(from.getTime() + ms)

/** An open invite for Sam at a space, made `now`, redeemable for a day. */
export const inviteRow = (spaceId: string, now: Date, unique: string, change: Partial<NewInvite> = {}): NewInvite => ({
  spaceId,
  label: 'Sam',
  invitedBy: 'owner@example.test',
  madeByClient: null,
  madeByGrant: null,
  linkHash: `link-${unique}`,
  codeHash: `code-${unique}`,
  scope: 'read',
  lifetime: '30d',
  replacesMemberId: null,
  createdAt: now.toISOString(),
  redeemBy: at(now, DAY).toISOString(),
  ...change,
})

/** A waiting ask from Ada at a space, its ticket held for a day. */
export const requestRow = (spaceId: string, now: Date, unique: string, change: Partial<NewRequest> = {}): NewRequest => ({
  spaceId,
  ticketHash: `ticket-${unique}`,
  addressKey: `address-${unique}`,
  name: 'Ada',
  shownCode: '042917',
  appName: 'Sample',
  returnsTo: 'client-a.example.test',
  createdAt: now.toISOString(),
  expiresAt: at(now, DAY).toISOString(),
  ...change,
})

/** A member for a grant at a space, joined `now` for 30 days. */
export const memberRow = (spaceId: string, now: Date, grantId: string, change: Partial<NewMember> = {}): NewMember => ({
  grantId,
  clientId: `client-${grantId}`,
  spaceId,
  label: 'Sam',
  appName: 'Sample',
  returnsTo: 'client-a.example.test',
  scope: 'read',
  lifetime: '30d',
  joinedAt: now.toISOString(),
  expiresAt: at(now, 30 * DAY).toISOString(),
  lastSeenAt: now.toISOString(),
  ...change,
})
