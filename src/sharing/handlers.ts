/**
 * The owner's sharing routes' handlers: who is asking, the space they named, then the repo. Anyone who may not share,
 * and a space the app doesn't have, get the same 404 with the same body, so nothing says whether a space exists. A
 * member is closed before its grant is revoked, so the reason the owner gave (`removed`) is the one it keeps.
 */
import { z, type RouteHandler } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { Caller } from '../core/auth.js'
import { showOnce } from '../core/guards.js'
import { linksOf, originOf } from '../core/hal.js'
import { ProblemError } from '../core/problem.js'
import { decodeCursor, pageOf } from '../pagination/index.js'
import { isRootAudience, type Bound } from './grants.js'
import type { SharingConfig, Space } from './index.js'
import type { InviteWithMember, MemberRow, NewInvite, SharingRepo } from './repo.js'
import type { SharingRoutes } from './routes.js'
import type { Lifetime, Scope } from './schema.js'
import { codeHashOf, linkHashOf, newInviteCode, newLinkToken } from './secrets.js'
import { inviteStateOf, MAX_OPEN_INVITES, memberListingOf, memberStateOf, redeemByOf } from './states.js'

const NO_STORE = { 'cache-control': 'no-store' }
/** Fresh links and codes tried when the code made is taken. */
const CODE_TRIES = 3
/** What an agent may give: never until revoked, which is the owner's alone. */
const AGENT_LIFETIMES: readonly Lifetime[] = ['7d', '30d']

/** Who may share, and as whom the invites they make are recorded. */
export type Sharer = { kind: 'owner'; by: string } | { kind: 'key'; by: string } | { kind: 'agent'; by: string; client: string; grant: string }

/** What `sharerOf` decides by: the owner `owner(c)` named (null when none), the deployment's keys, the root resource and the root MCP path. */
export type SharerFacts = { owner: string | null; fixedKeys: string[]; root: string; mcpPath: string }

/** A signed-in person shares only when the app calls them the owner, and never as a team member. */
const personSharer = (caller: Extract<Caller, { kind: 'person' }>, owner: string | null): Sharer | null => {
  if (caller.role === 'member') return null
  if (!owner) return null
  return { kind: 'owner', by: owner }
}

/** An agent shares only with a root token from a known grant, so its invites can be revoked with that grant. */
const agentSharer = (caller: Extract<Caller, { kind: 'agent' }>, { root, mcpPath }: SharerFacts): Sharer | null => {
  if (!caller.client || !caller.grant) return null
  if (!isRootAudience(caller.resource, root, mcpPath)) return null
  return { kind: 'agent', by: `agent:${caller.client}`, client: caller.client, grant: caller.grant }
}

/**
 * Who may share: the owner signed in, a key from `API_KEYS` (`fixedKeys`), or an agent whose token is for the whole
 * app. A key made through the API, a team member, a space's own token and anyone else may not (null).
 *
 * @example
 * sharerOf({ kind: 'key', name: 'owner' }, { owner: null, fixedKeys: ['owner'], root, mcpPath: '/mcp' })   // { kind: 'key', by: 'owner' }
 * sharerOf(spaceAgent, facts)                                                                          // null
 */
export const sharerOf = (caller: Caller | undefined, facts: SharerFacts): Sharer | null => {
  if (caller?.kind === 'key') return facts.fixedKeys.includes(caller.name) ? { kind: 'key', by: caller.name } : null
  if (caller?.kind === 'person') return personSharer(caller, facts.owner)
  if (caller?.kind === 'agent') return agentSharer(caller, facts)
  return null
}

/** The lifetime an invite gets: what was asked, but an agent may give only 7 or 30 days. */
const lifetimeFor = (sharer: Sharer, asked: Lifetime) => {
  if (sharer.kind !== 'agent' || AGENT_LIFETIMES.includes(asked)) return asked
  throw new ProblemError('bad_request', { detail: 'An agent may invite for 7 or 30 days only (`lifetime`: `7d` or `30d`): until revoked is the owner’s to give.' })
}

/** The columns that say an agent made an invite: its client and grant, so its open invites end with them. */
const makerOf = (sharer: Sharer) => (sharer.kind === 'agent' ? { madeByClient: sharer.client, madeByGrant: sharer.grant } : { madeByClient: null, madeByGrant: null })

/** The time an invite stops working, as people read it. */
const whenOf = (at: string) => `${at.slice(0, 16).replace('T', ' ')} UTC`

/** The invite in words, ready for the owner to send: where to connect, then the code to type. */
const messageOf = (space: Space, address: string, code: string, redeemBy: string) =>
  `I've invited you to ${space.title}. Before ${whenOf(redeemBy)}, connect your app to ${address}, then type ${code} on the page it opens. The invite works once.`

/** What an invite is made of besides its code. */
type InviteWanted = { label: string; scope: Scope; lifetime: Lifetime; replacesMemberId: string | null }

export const sharingHandlers = (config: SharingConfig, bound: Bound, repo: SharingRepo) => {
  const spacePath = (space: Space) => `${config.path}/${encodeURIComponent(space.name)}`
  /** The space's address on the pinned origin, where an invitee's app connects. */
  const addressOf = (space: Space) => bound.root + config.resourcePath.replace('{space}', encodeURIComponent(space.name))
  const invitesPath = (space: Space) => `${spacePath(space)}/invites`
  const invitePath = (space: Space, id: string) => `${invitesPath(space)}/${encodeURIComponent(id)}`
  const noSuchSpace = (name: string) => new ProblemError('not_found', { detail: `No space ${name} here that you may share. Check the name in its address, or ask its owner.` })
  const noSuchInvite = (space: Space, id: string) => new ProblemError('not_found', { detail: `No invite ${id} at ${space.title}. GET ${invitesPath(space)} lists them.` })
  const membersPath = (space: Space) => `${spacePath(space)}/members`
  const memberPath = (space: Space, id: string) => `${membersPath(space)}/${encodeURIComponent(id)}`
  const noSuchMember = (space: Space, id: string) => new ProblemError('not_found', { detail: `No member ${id} at ${space.title}. GET ${membersPath(space)} lists them.` })

  /** Who is asking and the space they named; the same 404 for anyone who may not share and for a space not found. */
  const sharingAt = async (c: Context, name: string) => {
    const caller = c.get('caller' as never) as Caller | undefined
    const owner = caller?.kind === 'person' ? await config.owner(c) : null
    const sharer = sharerOf(caller, { owner, fixedKeys: config.fixedKeys, root: bound.root, mcpPath: bound.mcpPath })
    if (!sharer) throw noSuchSpace(name)
    if (!config.spaceName.test(name)) throw noSuchSpace(name)
    const space = await config.spaces.byName(name)
    if (!space) throw noSuchSpace(name)
    return { sharer, space }
  }

  const cardOf = (origin: string, space: Space, invite: Omit<InviteWithMember, 'linkHash' | 'codeHash'>, now: Date) => {
    const state = inviteStateOf(invite, invite.memberId ? { id: invite.memberId } : null, now)
    const revoke = state === 'open' ? { path: invitePath(space, invite.id), title: 'DELETE to revoke' } : null
    return {
      id: invite.id,
      label: invite.label,
      invitedBy: invite.invitedBy,
      scope: invite.scope,
      lifetime: invite.lifetime,
      state,
      createdAt: invite.createdAt,
      redeemBy: invite.redeemBy,
      revokedAt: invite.revokedAt,
      _links: linksOf(origin, { self: invitePath(space, invite.id), list: invitesPath(space), revoke }),
    }
  }

  /** A member as the owner's list shows it: active or signed out, why it ended, and its links; never its grant or client. */
  const memberCardOf = (origin: string, space: Space, member: MemberRow, now: Date) => {
    const current = memberStateOf(member, now)
    const self = memberPath(space, member.id)
    return {
      id: member.id,
      label: member.label,
      appName: member.appName,
      returnsTo: member.returnsTo,
      via: member.via,
      scope: member.scope,
      lifetime: member.lifetime,
      state: current.state === 'active' ? ('active' as const) : ('signed_out' as const),
      joinedAt: member.joinedAt,
      expiresAt: member.expiresAt,
      lastSeenAt: member.lastSeenAt,
      endedAt: member.endedAt,
      endedReason: current.state === 'ended' ? current.reason : null,
      _links: linksOf(origin, { self, list: membersPath(space), remove: { path: self, title: 'DELETE to remove' }, inviteAgain: { path: `${self}/invite-again`, title: 'POST for a fresh invite that replaces it once used' } }),
    }
  }

  /** A member the owner's list shows, signed out ones too; the same 404 for one removed, replaced, of another space or made up. */
  const listedMemberAt = async (space: Space, id: string) => {
    const member = await repo.memberAt(space.id, id)
    if (!member || memberListingOf(member, new Date()) === 'hidden') throw noSuchMember(space, id)
    return member
  }

  const summaryOf = async (c: Context, space: Space) => ({
    space: space.name,
    title: space.title,
    openInvites: await repo.countOpenInvites(space.id, new Date()),
    _links: linksOf(originOf(c), { self: `${spacePath(space)}/sharing`, invites: { path: invitesPath(space), title: 'POST { label } to invite someone' } }),
  })

  const spaceIsFull = (space: Space) => new ProblemError('conflict', { detail: `${space.title} has ${MAX_OPEN_INVITES} open invites: revoke some (GET ${invitesPath(space)}) before making more.` })

  /** Adds the invite with a fresh code (and link token, whose page is not built); a 409 when the space is full, and a code already taken gets new ones, up to 3 tries. */
  const addInvite = async (space: Space, invite: Omit<NewInvite, 'linkHash' | 'codeHash'>) => {
    for (let attempt = 0; attempt < CODE_TRIES; attempt++) {
      const token = newLinkToken()
      const code = newInviteCode()
      const id = await repo.addInvite({ ...invite, linkHash: linkHashOf(config.keys, token), codeHash: codeHashOf(config.keys, code) })
      if (id) return { id, code }
      if ((await repo.countOpenInvites(space.id, new Date(invite.createdAt))) >= MAX_OPEN_INVITES) throw spaceIsFull(space)
    }
    throw new Error(`sharing: ${CODE_TRIES} invite codes in a row were taken; the code maker is broken`)
  }

  /** Makes an invite and answers it once: the code is never kept, by the table or by Idempotency-Key. */
  const answerNewInvite = async (c: Context, sharer: Sharer, space: Space, wanted: InviteWanted) => {
    const lifetime = lifetimeFor(sharer, wanted.lifetime)
    const now = new Date()
    const row = { spaceId: space.id, label: wanted.label, invitedBy: sharer.by, ...makerOf(sharer), scope: wanted.scope, lifetime, replacesMemberId: wanted.replacesMemberId, createdAt: now.toISOString(), redeemBy: redeemByOf(now) }
    const { id, code } = await addInvite(space, row)
    const address = addressOf(space)
    showOnce(c, `This Idempotency-Key already made invite ${id} for ${wanted.label} at ${space.title} (GET ${invitesPath(space)}). Its code was shown once, in that answer, and is never shown again. Lost them? Revoke it (DELETE ${invitesPath(space)}/${id}) and make another with a new Idempotency-Key.`)
    const card = cardOf(originOf(c), space, { ...row, id, revokedAt: null, memberId: null }, now)
    return c.json({ ...card, address, code, message: messageOf(space, address, code, row.redeemBy) }, 201, { location: invitePath(space, id), ...NO_STORE })
  }

  const get: RouteHandler<SharingRoutes['get']> = async (c) => {
    const { space } = await sharingAt(c, c.req.valid('param').space)
    return c.json(await summaryOf(c, space), 200, NO_STORE)
  }

  const createInvite: RouteHandler<SharingRoutes['createInvite']> = async (c) => {
    const { label, scope, lifetime } = c.req.valid('json')
    const { sharer, space } = await sharingAt(c, c.req.valid('param').space)
    return answerNewInvite(c, sharer, space, { label, scope, lifetime, replacesMemberId: null })
  }

  const listInvites: RouteHandler<SharingRoutes['listInvites']> = async (c) => {
    const { limit, cursor } = c.req.valid('query')
    const { space } = await sharingAt(c, c.req.valid('param').space)
    const after = decodeCursor(cursor, z.object({ id: z.string() }))?.id
    const rows = await repo.listInvites(space.id, { after, limit: limit + 1 })
    const shown = rows.slice(0, limit)
    const origin = originOf(c)
    const now = new Date()
    const next = rows.length > limit ? { id: shown.at(-1)!.id } : null
    return c.json(pageOf({ origin, path: invitesPath(space), query: { limit }, name: 'invites', items: shown.map((row) => cardOf(origin, space, row, now)), next }), 200, NO_STORE)
  }

  const getInvite: RouteHandler<SharingRoutes['getInvite']> = async (c) => {
    const { space: name, id } = c.req.valid('param')
    const { space } = await sharingAt(c, name)
    const invite = await repo.inviteAt(space.id, id)
    if (!invite) throw noSuchInvite(space, id)
    return c.json(cardOf(originOf(c), space, invite, new Date()), 200, NO_STORE)
  }

  /** Records the revoke whatever holds the invite, so it never opens again; 409 when a member holds it, who keeps access. */
  const revokeInvite: RouteHandler<SharingRoutes['revokeInvite']> = async (c) => {
    const { space: name, id } = c.req.valid('param')
    const { space } = await sharingAt(c, name)
    const now = new Date()
    await repo.revokeInvite(space.id, id, now)
    const invite = await repo.inviteAt(space.id, id)
    if (!invite) throw noSuchInvite(space, id)
    if (inviteStateOf(invite, invite.memberId ? { id: invite.memberId } : null, now) === 'redeemed')
      throw new ProblemError('conflict', { detail: `Invite ${id} was used already: it is revoked and never works again, but the member who joined by it keeps access. Remove that member to end it.` })
    return c.body(null, 204)
  }

  const listMembers: RouteHandler<SharingRoutes['listMembers']> = async (c) => {
    const { limit, cursor } = c.req.valid('query')
    const { space } = await sharingAt(c, c.req.valid('param').space)
    const after = decodeCursor(cursor, z.object({ id: z.string() }))?.id
    const rows = await repo.listMembers(space.id, { after, limit: limit + 1 })
    const shown = rows.slice(0, limit)
    const origin = originOf(c)
    const now = new Date()
    const next = rows.length > limit ? { id: shown.at(-1)!.id } : null
    return c.json(pageOf({ origin, path: membersPath(space), query: { limit }, name: 'members', items: shown.map((row) => memberCardOf(origin, space, row, now)), next }), 200, NO_STORE)
  }

  const getMember: RouteHandler<SharingRoutes['getMember']> = async (c) => {
    const { space: name, id } = c.req.valid('param')
    const { space } = await sharingAt(c, name)
    const member = await listedMemberAt(space, id)
    return c.json(memberCardOf(originOf(c), space, member, new Date()), 200, NO_STORE)
  }

  /**
   * Revokes the member's invite and its Invite again ones, closes it as `removed`, live or signed out, then revokes its
   * grant; once hidden, a 204 after the revokes alone. Its invites are revoked first, so a join still in `onGrant` that
   * the kit then withdraws (deleting the row) leaves them closed, and so does a replacing join withdrawn after its claim.
   */
  const removeMember: RouteHandler<SharingRoutes['removeMember']> = async (c) => {
    const { space: name, id } = c.req.valid('param')
    const { space } = await sharingAt(c, name)
    const member = await repo.memberAt(space.id, id)
    if (!member) throw noSuchMember(space, id)
    const now = new Date()
    if (member.inviteId) await repo.revokeInvite(space.id, member.inviteId, now)
    await repo.revokeInvitesReplacing(space.id, member.id, now)
    if (memberListingOf(member, now) === 'hidden') return c.body(null, 204)
    const grant = await repo.closeMember(space.id, id, 'removed', now)
    if (grant) await bound.revokeGrant(grant)
    return c.body(null, 204)
  }

  /** A fresh invite with the member's label, scope and lifetime; its earlier ones revoked first, so only the newest works. */
  const inviteAgain: RouteHandler<SharingRoutes['inviteAgain']> = async (c) => {
    const { space: name, id } = c.req.valid('param')
    const { sharer, space } = await sharingAt(c, name)
    const member = await listedMemberAt(space, id)
    const lifetime = lifetimeFor(sharer, member.lifetime)
    await repo.revokeInvitesReplacing(space.id, member.id, new Date())
    return answerNewInvite(c, sharer, space, { label: member.label, scope: member.scope, lifetime, replacesMemberId: member.id })
  }

  return { get, createInvite, listInvites, getInvite, revokeInvite, listMembers, getMember, removeMember, inviteAgain }
}
