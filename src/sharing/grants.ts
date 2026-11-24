/**
 * The part's word on tokens, as the oauth hooks it hands `createOAuth` (`sharing.oauth`): which grants become members
 * (`onGrant`), which rows end when the kit ends a grant (`onRevoke`), which tokens fit a request (`accepts`), and the
 * space addresses this server issues for (`resources`, `resourceOf`).
 *
 * Which tokens the part judges:
 *   no audience, the root, the root's MCP   onGrant: yes, untouched (unless a sharing page made it)   accepts: everywhere
 *   a space, from the part's pages          onGrant: the claim writes the member, or no                accepts: its member's space only, while it lives
 *   a space any other way                   onGrant: no (withdrawn)                                    accepts: no member, refused
 * A member is known by its grant, and its space by the id on its row: a renamed space keeps its members, and a name
 * another space takes later never opens to them.
 *
 * @example
 * const oauth = createOAuth({ name: 'Sample', signingKey, store, owner, ...sharing.oauth })
 */
import type { Context } from 'hono'
import type { Caller } from '../core/auth.js'
import { originOf } from '../core/hal.js'
import type { OAuth, SignInAsk, SignInGrant, SignInRevoked, TokenCaller } from '../oauth/index.js'
import type { SharingConfig, Space } from './index.js'
import type { MemberRow, NewMember, SharingRepo } from './repo.js'
import { LIFETIMES, type EndedReason, type Lifetime, type Scope } from './schema.js'
import { memberExpiresAtOf, memberStateOf } from './states.js'

const HOUR = 60 * 60 * 1000
const SPACE = '{space}'
/** The longest client name the part keeps or shows. */
const APP_NAME_LENGTH = 80
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** One sentence for every space token out of place, whether or not the asked space exists. */
export const ONLY_ITS_SPACE = 'This sign-in works only at its own space: connect again from the address you were given.'
const NOT_READY = 'Sharing is not ready here yet (the app calls registerSharing before serving): try again in a minute.'

/** What the hooks read from the app's OAuth server once `bind` ties them to it. */
export type BoundOAuth = Pick<OAuth, 'rootOf' | 'mcpPath'>
/** The server the hooks are bound to: null until `registerSharing` binds it, and the hooks refuse until then. */
export type Binding = { oauth: BoundOAuth | null }
/** What every hook works from. */
type Grants = { config: SharingConfig; repo: SharingRepo; binding: Binding }

/** What `memberOf` tells the app about the member behind a request; never its grant. */
export type MemberView = Pick<MemberRow, 'id' | 'label' | 'appName' | 'returnsTo' | 'via' | 'scope' | 'lifetime' | 'joinedAt' | 'expiresAt'> & { space: Space }

/**
 * A token for the whole app: no audience (from before audiences), the root, or the root's MCP.
 *
 * @example
 * isRootAudience(undefined, root, '/mcp')            // true
 * isRootAudience(`${root}/s/soups/mcp`, root, '/mcp') // false
 */
export const isRootAudience = (resource: string | undefined, root: string, mcpPath: string) => !resource || resource === root || resource === root + mcpPath

/**
 * A client's name as the part keeps and shows it: no control, bidi or zero-width character (Unicode Cc and Cf), 80
 * characters at most. It stays the client's own claim, never verified.
 *
 * @example
 * appNameOf('Sam\u202Eppa') // 'Samppa'
 */
export const appNameOf = (name: string) => Array.from(name.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()).slice(0, APP_NAME_LENGTH).join('').trim() || 'An unnamed client'

/**
 * The space a path names at the space address: its one segment where `resourcePath` has `{space}`, when it passes
 * `spaceName`; else null. With `under`, a path below the address names it too (`/s/soups/mcp/server-card`).
 *
 * @example
 * spaceNameIn(config, '/s/soups/mcp')   // 'soups'
 * spaceNameIn(config, '/s/Soups/mcp')   // null
 */
export const spaceNameIn = (config: Pick<SharingConfig, 'resourcePath' | 'spaceName'>, path: string, under = false) => {
  const [prefix = '', suffix = ''] = config.resourcePath.split(SPACE)
  if (!path.startsWith(prefix)) return null
  const rest = path.slice(prefix.length)
  const end = rest.indexOf('/')
  if (end < 0) return null
  const name = rest.slice(0, end)
  const tail = rest.slice(end)
  const fits = tail === suffix || (under && tail.startsWith(`${suffix}/`))
  return fits && config.spaceName.test(name) ? name : null
}

/** A resource's path: what follows its scheme and authority (empty for the origin). */
const pathOf = (resource: string) => resource.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, '')

/** The space a grant's resource names on this origin, or null. */
const spaceOfResource = (config: SharingConfig, resource: string, root: string) => (resource.startsWith(`${root}/`) ? spaceNameIn(config, resource.slice(root.length)) : null)

/** What a request is about: the space in its path at a space address, else the app's `spaceOfPath`. */
const askedSpaceOf = (config: SharingConfig, path: string) => spaceNameIn(config, path, true) ?? config.spaceOfPath(path)

/** `write` when the grant may change things, else `read`. */
const scopeOf = (scopes: string[]): Scope => (scopes.includes('write') ? 'write' : 'read')

/** Whether a grant's scope is more than what was given: `write` where only `read` was. */
const exceeds = (granted: Scope, given: Scope) => granted === 'write' && given === 'read'

const lifetimeIn = (text: string | undefined): Lifetime | null => LIFETIMES.find((lifetime) => lifetime === text) ?? null

/** A day as people read it, in UTC: `12 March 2026`. */
const dayOf = (at: string) => {
  const day = new Date(at)
  return `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`
}

/** Why an ended member's token is refused, in words. */
const endedSentence = (member: MemberRow, reason: EndedReason) => {
  if (reason === 'expired' && member.expiresAt) return `This access ended on ${dayOf(member.expiresAt)} (UTC): ask the owner for a new invite.`
  if (reason === 'lapsed') return 'This access lapsed: it went unused for 30 days. Ask the owner for a new invite.'
  return 'This access has ended: ask the owner for a new invite.'
}

/** A member row for a grant at a space, joined now. */
const newMemberOf = (grant: SignInGrant, space: Space, given: { label: string; scope: Scope; lifetime: Lifetime }, now: Date): NewMember => ({
  grantId: grant.grant,
  clientId: grant.client.id,
  spaceId: space.id,
  label: given.label,
  appName: appNameOf(grant.client.name),
  returnsTo: grant.data?.returnsTo ?? '',
  scope: given.scope,
  lifetime: given.lifetime,
  joinedAt: now.toISOString(),
  expiresAt: memberExpiresAtOf(given.lifetime, now),
  lastSeenAt: now.toISOString(),
})

/** The invite claim: the grant's approver is that invite, its scope no more than the invite's, and the one statement writes the member. */
const claimByInvite = async ({ repo }: Grants, grant: SignInGrant, space: Space) => {
  const inviteId = grant.data?.invite ?? ''
  if (grant.approver !== `invite:${inviteId}`) return false
  const invite = await repo.inviteAt(space.id, inviteId)
  if (!invite) return false
  const scope = scopeOf(grant.scopes)
  if (exceeds(scope, invite.scope)) return false
  const now = new Date()
  const member = newMemberOf(grant, space, { label: invite.label, scope, lifetime: invite.lifetime }, now)
  return (await repo.claimInvite(invite.id, member, now)) !== null
}

/** The owner's approval at a space: approved as `owner:<email>`, for the space the resource names, with a lifetime the part has. */
const memberByOwner = async ({ repo }: Grants, grant: SignInGrant, space: Space) => {
  if (!grant.approver.startsWith('owner:')) return false
  if (grant.data?.space !== space.id) return false
  const lifetime = lifetimeIn(grant.data?.lifetime)
  if (!lifetime) return false
  const now = new Date()
  const member = newMemberOf(grant, space, { label: appNameOf(grant.client.name), scope: scopeOf(grant.scopes), lifetime }, now)
  return (await repo.addOwnerMember(member)) !== null
}

/** A grant into a space: only a code from one of the part's pages, at a space the app has, by the way that page said. */
const joinSpace = async (grants: Grants, grant: SignInGrant, root: string) => {
  if (grant.kind !== 'code') return false
  const name = spaceOfResource(grants.config, grant.resource ?? '', root)
  if (!name) return false
  const space = await grants.config.spaces.byName(name)
  if (!space) return false
  if (grant.data?.sharing === 'invite') return claimByInvite(grants, grant, space)
  if (grant.data?.sharing === 'owner') return memberByOwner(grants, grant, space)
  return false
}

/**
 * `onGrant`: a root grant passes untouched, unless one of the part's pages made it (they bind a space, never the root).
 * A space grant becomes a member, or is withdrawn. Before `bind`, no.
 */
export const onGrantFor = (grants: Grants) => async (grant: SignInGrant, c: Context) => {
  const oauth = grants.binding.oauth
  if (!oauth) return false
  const root = oauth.rootOf(c)
  if (isRootAudience(grant.resource, root, oauth.mcpPath)) return grant.data?.sharing === undefined
  return joinSpace(grants, grant, root)
}

/**
 * `onRevoke`: a withdrawn grant's row is deleted (it never became a member, so its invite opens again); any other
 * reason ends the rows of that grant, or of that client. Then, unless withdrawn, the open invites an agent made under
 * that grant or client are revoked; people who joined through them keep access. Each statement is conditional, so being
 * told twice changes nothing.
 */
export const onRevokeFor = ({ repo }: Pick<Grants, 'repo'>) => async ({ grant, client, reason }: SignInRevoked) => {
  const now = new Date()
  if (reason === 'withdrawn') {
    if (grant) await repo.deleteMemberOfGrant(grant)
    return
  }
  if (reason === 'client_revoked') {
    if (!client) return
    await repo.endMembersOfClient(client, now)
    await repo.revokeInvitesMadeByClient(client, now)
    return
  }
  if (!grant) return
  await repo.endMemberOfGrant(grant, reason, now)
  await repo.revokeInvitesMadeByGrant(grant, now)
}

/** A space token at this request: its member lives, and this request is about the member's space by its name now. */
const spaceTokenFits = async ({ config, repo }: Grants, caller: TokenCaller, c: Context): Promise<true | string> => {
  const member = caller.grant ? await repo.memberByGrant(caller.grant) : undefined
  if (!member) return ONLY_ITS_SPACE
  const now = new Date()
  const state = memberStateOf(member, now)
  if (state.state === 'ended') return endedSentence(member, state.reason)
  const space = await config.spaces.byId(member.spaceId)
  if (!space || askedSpaceOf(config, c.req.path) !== space.name) return ONLY_ITS_SPACE
  await repo.noteSeen(member.grantId, new Date(now.getTime() - HOUR), now)
  return true
}

/** `accepts`: a root token fits everywhere; a space token only at its member's space. Before `bind`, only a token with no audience. */
export const acceptsFor = (grants: Grants) => async (caller: TokenCaller, c: Context): Promise<true | string> => {
  const oauth = grants.binding.oauth
  if (!oauth) return caller.resource ? NOT_READY : true
  if (isRootAudience(caller.resource, oauth.rootOf(c), oauth.mcpPath)) return true
  return spaceTokenFits(grants, caller, c)
}

/** `resources`: this server issues for a space address whose name passes `spaceName`; a pure check of the path. */
export const resourcesFor = ({ config }: Pick<Grants, 'config'>) => (path: string) => spaceNameIn(config, path) !== null

/** The resource path a request is for: its space's address, the root's MCP, or the root (''). */
const resourcePathOf = (config: SharingConfig, path: string, mcpPath: string | undefined) => {
  const name = spaceNameIn(config, path, true)
  if (name) return config.resourcePath.replace(SPACE, name)
  if (mcpPath && (path === mcpPath || path.startsWith(`${mcpPath}/`))) return mcpPath
  return ''
}

/** `resourceOf`: the space address a request is at, the root's MCP, or the root. Before `bind`, on the request's own origin. */
export const resourceOfFor = ({ config, binding }: Pick<Grants, 'config' | 'binding'>) => (c: Context) => {
  const root = binding.oauth ? binding.oauth.rootOf(c) : originOf(c)
  return root + resourcePathOf(config, c.req.path, binding.oauth?.mcpPath)
}

/** Whether a sign-in is the part's to judge: its audience a space, the root, or (once bound) the root's MCP. */
export const handlesFor = ({ config, binding }: Pick<Grants, 'config' | 'binding'>) => (ask: Pick<SignInAsk, 'resource'>) => {
  const path = pathOf(ask.resource)
  return path === '' || path === binding.oauth?.mcpPath || spaceNameIn(config, path) !== null
}

/** The member behind a request's space token while it lives, with its space; null for anyone else. */
export const memberOfFor = ({ config, repo }: Pick<Grants, 'config' | 'repo'>) => async (c: Context): Promise<MemberView | null> => {
  const caller = c.get('caller' as never) as Caller | undefined
  if (caller?.kind !== 'agent' || !caller.grant) return null
  const member = await repo.memberByGrant(caller.grant)
  if (!member || memberStateOf(member, new Date()).state === 'ended') return null
  const space = await config.spaces.byId(member.spaceId)
  if (!space) return null
  const { id, label, appName, returnsTo, via, scope, lifetime, joinedAt, expiresAt } = member
  return { id, space, label, appName, returnsTo, via, scope, lifetime, joinedAt, expiresAt }
}
