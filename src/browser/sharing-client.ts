/**
 * The browser side of `sharing`, without a framework: a typed client for the owner's routes at one space (its sharing,
 * invites made, listed, read and revoked, members listed, read, invited again and removed), run with the page's own
 * sign-in. React apps use `sharing-react.ts`. A failed call is a `SharingError` carrying the API's problem; a retry
 * with an Idempotency-Key already used is a `ShownOnceError`, since an invite's code is shown only once.
 *
 * @example
 * const sharing = createSharingClient()
 * const invite = await sharing.createInvite('soups', { label: 'Sam' })
 * showOnce(invite.message) // the address and code to send; never shown again
 */

export type Scope = 'read' | 'write'
export type Lifetime = '7d' | '30d' | 'until_revoked'
/** How a member joined: an invite, or the owner's approval. */
export type Via = 'invite' | 'owner'
export type EndedReason = 'revoked' | 'replayed' | 'client_revoked' | 'expired' | 'lapsed' | 'replaced' | 'removed' | 'space_gone'
type Links = Record<string, { href: string } | undefined>

/** How a space is shared, as `GET {path}/{space}/sharing` says it. */
export type SharingView = { space: string; title: string; openInvites: number; _links: Links }

/** An invite as the list shows it: never its code. */
export type Invite = {
  id: string
  label: string
  /** The owner's email, a key's name, or `agent:<client>`. */
  invitedBy: string
  scope: Scope
  lifetime: Lifetime
  state: 'open' | 'redeemed' | 'revoked' | 'expired'
  createdAt: string
  redeemBy: string
  revokedAt: string | null
  _links: Links
}

/** An invite just made: the space's address, the code and a message to send, shown this once. */
export type NewInvite = Invite & { address: string; code: string; message: string }

export type InviteInput = { label: string; scope?: Scope; lifetime?: Lifetime }

/** One app signed in to a space. */
export type Member = {
  id: string
  label: string
  /** What the app calls itself: its own claim, never checked. */
  appName: string
  returnsTo: string
  via: Via
  scope: Scope
  lifetime: Lifetime
  state: 'active' | 'signed_out'
  joinedAt: string
  expiresAt: string | null
  lastSeenAt: string
  endedAt: string | null
  endedReason: EndedReason | null
  _links: Links
}

/** One page of a list, and the cursor of the next (null on the last). */
export type SharingPage<Item> = { items: Item[]; next: string | null }
export type PageQuery = { limit?: number; cursor?: string }
/** Sent as Idempotency-Key, so a retry never makes a second invite. */
export type ShownOnceOptions = { idempotencyKey?: string }

/** A failed sharing call, as the API's problem+json described it. */
export class SharingError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: string

  constructor(status: number, code: string, detail: string) {
    super(detail)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/** A retry with an Idempotency-Key that already made an invite: `detail` says which, never its code. */
export class ShownOnceError extends SharingError {}

export type SharingClient = {
  sharing: (space: string) => Promise<SharingView>
  /** A page of the space's invites, newest first. */
  invites: (space: string, page?: PageQuery) => Promise<SharingPage<Invite>>
  invite: (space: string, id: string) => Promise<Invite>
  createInvite: (space: string, input: InviteInput, options?: ShownOnceOptions) => Promise<NewInvite>
  /** Its code stops working at once; harmless to repeat. A used invite is a 409: remove its member instead. */
  revokeInvite: (space: string, id: string) => Promise<void>
  /** A page of the space's members, newest first. */
  members: (space: string, page?: PageQuery) => Promise<SharingPage<Member>>
  member: (space: string, id: string) => Promise<Member>
  /** Ends the member's sign-in at once; harmless to repeat. */
  removeMember: (space: string, id: string) => Promise<void>
  /** A fresh invite with the member's label, scope and lifetime; the earlier ones are revoked. */
  inviteAgain: (space: string, id: string, options?: ShownOnceOptions) => Promise<NewInvite>
}

/** The error a failed answer stands for: its own class for `shown_once`. */
const errorOf = (status: number, body: { code?: string; detail?: string; title?: string } | null) => {
  const code = body?.code ?? 'error'
  const detail = body?.detail ?? body?.title ?? `The sharing call failed (${status}).`
  if (code === 'shown_once') return new ShownOnceError(status, code, detail)
  return new SharingError(status, code, detail)
}

/** The cursor in a page's `next` link. Only the cursor is taken: the client never calls a host an answer names. */
const cursorOf = (links: Links) => {
  const next = links.next?.href
  if (!next) return null
  return new URL(next, 'http://next.invalid').searchParams.get('cursor')
}

const queryOf = ({ limit, cursor }: PageQuery) => {
  const query = new URLSearchParams()
  if (limit !== undefined) query.set('limit', String(limit))
  if (cursor) query.set('cursor', cursor)
  const search = query.toString()
  return search ? `?${search}` : ''
}

/**
 * A client for the owner's routes `registerSharing` serves. `fetchImpl` and `headers` are for tests and scripts; a
 * page needs neither.
 *
 * @example
 * const sharing = createSharingClient({ path: '/api/shelves' })
 * const { items, next } = await sharing.members('soups', { limit: 20 })
 * if (next) await sharing.members('soups', { limit: 20, cursor: next })
 */
export const createSharingClient = ({ path = '/api/spaces', fetchImpl = (...args) => fetch(...args), headers = {} }: { path?: string; fetchImpl?: typeof fetch; headers?: Record<string, string> } = {}): SharingClient => {
  const call = async (url: string, init: RequestInit & { idempotencyKey?: string } = {}) => {
    const { idempotencyKey, ...request } = init
    const sent = { accept: 'application/json', ...(request.body ? { 'content-type': 'application/json' } : {}), ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}), ...headers }
    const response = await fetchImpl(url, { credentials: 'same-origin', ...request, headers: sent })
    const body = response.status === 204 ? null : await response.json().catch(() => null)
    if (!response.ok) throw errorOf(response.status, body)
    return body
  }
  const at = (space: string) => `${path}/${encodeURIComponent(space)}`
  const pageOf = async <Item>(url: string, name: string): Promise<SharingPage<Item>> => {
    const page = await call(url)
    return { items: page._embedded[name] as Item[], next: cursorOf(page._links) }
  }
  return {
    sharing: async (space) => call(`${at(space)}/sharing`),
    invites: async (space, page = {}) => pageOf<Invite>(`${at(space)}/invites${queryOf(page)}`, 'invites'),
    invite: async (space, id) => call(`${at(space)}/invites/${encodeURIComponent(id)}`),
    createInvite: async (space, input, { idempotencyKey } = {}) => call(`${at(space)}/invites`, { method: 'POST', body: JSON.stringify(input), idempotencyKey }),
    revokeInvite: async (space, id) => void (await call(`${at(space)}/invites/${encodeURIComponent(id)}`, { method: 'DELETE' })),
    members: async (space, page = {}) => pageOf<Member>(`${at(space)}/members${queryOf(page)}`, 'members'),
    member: async (space, id) => call(`${at(space)}/members/${encodeURIComponent(id)}`),
    removeMember: async (space, id) => void (await call(`${at(space)}/members/${encodeURIComponent(id)}`, { method: 'DELETE' })),
    inviteAgain: async (space, id, { idempotencyKey } = {}) => call(`${at(space)}/members/${encodeURIComponent(id)}/invite-again`, { method: 'POST', idempotencyKey }),
  }
}
