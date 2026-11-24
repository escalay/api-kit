/**
 * The owner's sharing routes' handlers: who is asking, the space they named, then the repo. Anyone who may not share,
 * and a space the app doesn't have, get the same 404 with the same body, so nothing says whether a space exists.
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
import type { InviteWithMember, NewInvite, SharingRepo } from './repo.js'
import type { SharingRoutes } from './routes.js'
import type { Lifetime, Scope } from './schema.js'
import { codeHashOf, linkHashOf, newInviteCode, newLinkToken } from './secrets.js'
import { askingStateOf, inviteStateOf, MAX_OPEN_INVITES, redeemByOf } from './states.js'

const NO_STORE = { 'cache-control': 'no-store' }
/** Fresh links and codes tried when the code made is taken. */
const CODE_TRIES = 3
/** What an agent may give: never until revoked (decision 17). */
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

/** The invite in words, ready for the owner to send. */
const messageOf = (space: Space, link: string, code: string, redeemBy: string) =>
  `I've invited you to ${space.title}. Open this link in your browser before ${whenOf(redeemBy)} and follow its steps: ${link}\nIf your app asks for a code, type ${code}. The invite works once.`

/** What an invite is made of besides its link and code. */
type InviteWanted = { label: string; scope: Scope; lifetime: Lifetime; replacesMemberId: string | null }

export const sharingHandlers = (config: SharingConfig, bound: Bound, repo: SharingRepo) => {
  const spacePath = (space: Space) => `${config.path}/${encodeURIComponent(space.name)}`
  const invitesPath = (space: Space) => `${spacePath(space)}/invites`
  const invitePath = (space: Space, id: string) => `${invitesPath(space)}/${encodeURIComponent(id)}`
  const noSuchSpace = (name: string) => new ProblemError('not_found', { detail: `No space ${name} here that you may share. Check the name in its address, or ask its owner.` })
  const noSuchInvite = (space: Space, id: string) => new ProblemError('not_found', { detail: `No invite ${id} at ${space.title}. GET ${invitesPath(space)} lists them.` })

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

  const summaryOf = async (c: Context, space: Space) => ({
    space: space.name,
    title: space.title,
    askToJoin: askingStateOf(await repo.spaceAt(space.id)),
    askToJoinOffered: config.askToJoin,
    openInvites: await repo.countOpenInvites(space.id, new Date()),
    _links: linksOf(originOf(c), { self: `${spacePath(space)}/sharing`, invites: { path: invitesPath(space), title: 'POST { label } to invite someone' } }),
  })

  const spaceIsFull = (space: Space) => new ProblemError('conflict', { detail: `${space.title} has ${MAX_OPEN_INVITES} open invites: revoke some (GET ${invitesPath(space)}) before making more.` })

  /** Adds the invite with a fresh link and code; a 409 when the space is full, and a code already taken gets new ones, up to 3 tries. */
  const addInvite = async (space: Space, invite: Omit<NewInvite, 'linkHash' | 'codeHash'>) => {
    for (let attempt = 0; attempt < CODE_TRIES; attempt++) {
      const token = newLinkToken()
      const code = newInviteCode()
      const id = await repo.addInvite({ ...invite, linkHash: linkHashOf(config.keys, token), codeHash: codeHashOf(config.keys, code) })
      if (id) return { id, token, code }
      if ((await repo.countOpenInvites(space.id, new Date(invite.createdAt))) >= MAX_OPEN_INVITES) throw spaceIsFull(space)
    }
    throw new Error(`sharing: ${CODE_TRIES} invite codes in a row were taken; the code maker is broken`)
  }

  /** Makes an invite and answers it once: the link and code are never kept, by the table or by Idempotency-Key. */
  const answerNewInvite = async (c: Context, sharer: Sharer, space: Space, wanted: InviteWanted) => {
    const lifetime = lifetimeFor(sharer, wanted.lifetime)
    const now = new Date()
    const row = { spaceId: space.id, label: wanted.label, invitedBy: sharer.by, ...makerOf(sharer), scope: wanted.scope, lifetime, replacesMemberId: wanted.replacesMemberId, createdAt: now.toISOString(), redeemBy: redeemByOf(now) }
    const { id, token, code } = await addInvite(space, row)
    const link = `${bound.root}/sharing/join/${token}`
    showOnce(c, `This Idempotency-Key already made invite ${id} for ${wanted.label} at ${space.title} (GET ${invitesPath(space)}). Its link and code were shown once, in that answer, and are never shown again. Lost them? Revoke it (DELETE ${invitesPath(space)}/${id}) and make another with a new Idempotency-Key.`)
    const card = cardOf(originOf(c), space, { ...row, id, revokedAt: null, memberId: null }, now)
    return c.json({ ...card, link, code, message: messageOf(space, link, code, row.redeemBy) }, 201, { location: invitePath(space, id), ...NO_STORE })
  }

  const get: RouteHandler<SharingRoutes['get']> = async (c) => {
    const { space } = await sharingAt(c, c.req.valid('param').space)
    return c.json(await summaryOf(c, space), 200, NO_STORE)
  }

  const update: RouteHandler<SharingRoutes['update']> = async (c) => {
    const { askToJoin } = c.req.valid('json')
    const { sharer, space } = await sharingAt(c, c.req.valid('param').space)
    if (!config.askToJoin) throw new ProblemError('conflict', { detail: 'This app does not offer asking to join (its sharing option askToJoin is off): invite people instead.' })
    const now = new Date()
    await repo.setAskToJoin(space.id, askToJoin, now)
    if (!askToJoin) await repo.refuseWaitingAt(space.id, sharer.by, now)
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

  return { get, update, createInvite, listInvites, getInvite, revokeInvite }
}
