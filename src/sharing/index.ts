/**
 * Sharing: invites to a space, asks to join and the owner's approval, on the oauth part's hooks (`approve`,
 * `complete`, `onGrant`, `onRevoke`, `accepts`). A **space** is the part of an app that is shared (a shelf, a board, a
 * project); a **member** is one grant into one space. So far the part holds its tables (`SHARING_MIGRATIONS`), the
 * only queries (`sharingRepo`), the named states of its rows (`states.ts`), its secrets (`secrets.ts`), and the
 * owner's routes and tools for a space's settings and its invites:
 *   GET    {path}/{space}/sharing         how the space is shared
 *   PATCH  {path}/{space}/sharing         switch Ask to join
 *   POST   {path}/{space}/invites         a new invite → 201, its link and code shown this once
 *   GET    {path}/{space}/invites         the space's invites, newest first, a page at a time
 *   DELETE {path}/{space}/invites/{id}    revoke an invite no one has used
 * The sign-in pages and the hooks come next (its README says what is there).
 *
 * @example
 * const sharing = await createSharing({ db, secret: env.SHARING_SECRET, spaces, owner, fixedKeys: [...parseApiKeys(env.API_KEYS).values()] })
 * const app = createAgentApi({ …, tags: [...FEATURE_TAGS, SHARING_TAG], auth: { …, relay: ['/mcp', '/a2a', sharing.relay] }, guards: { …, skip: sharing.neverKept }, oauth })
 * await registerSharing(app, sharing, { oauth })
 * mcpServerFactory({ tools: [...FEATURE_TOOLS, ...sharingTools({ noun: 'shelf' })], … })
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { migrate, type Db } from '../db/index.js'
import type { OAuth } from '../oauth/index.js'
import { sharingHandlers } from './handlers.js'
import { sharingRepo } from './repo.js'
import { sharingRoutes } from './routes.js'
import { SHARING_MIGRATIONS } from './schema.js'
import { sharingKeys, type SharingKeys } from './secrets.js'

export { sharerOf, type Sharer, type SharerFacts } from './handlers.js'
export { sharingRepo, type InviteRow, type InviteWithMember, type MemberRow, type NewInvite, type NewMember, type NewRequest, type PageAt, type RequestRow, type RequestWithMember, type SharingRepo, type SpaceRow } from './repo.js'
export { PLAIN_TEXT, sharingRoutes, type SharingRoutes } from './routes.js'
export { sharingInvites, sharingMembers, sharingRequests, sharingSpaces, SHARING_MIGRATIONS, type EndedReason, type Lifetime, type Scope } from './schema.js'
export { addressKeyOf, CODE_ALPHABET, codeHashOf, linkHashOf, newInviteCode, newLinkToken, newShownCode, normalisedCode, sharingKeys, ticketHashOf, type SharingKeys } from './secrets.js'
export { askingStateOf, inviteStateOf, MAX_OPEN_INVITES, memberExpiresAtOf, memberListingOf, memberStateOf, redeemByOf, requestStateOf, REDEEM_WITHIN, UNANSWERED_PAUSE, UNSEEN_FOR, type AskingState, type InviteState, type MemberListing, type MemberState, type RequestState } from './states.js'
export { sharingTools } from './tools.js'

export const SHARING_TAG = { name: 'Sharing', description: 'Invites to a space, and how it is shared: for the owner, their deployment keys and their own agents.' }

/** A space, as the app keeps it: its id (never reused), the name in its address, and its title. */
export type Space = { id: string; name: string; title: string }

export type SharingOptions = {
  /** The app's database (`openDb`), the same one as its OAuth state; the sharing tables are migrated into it. */
  db: Db
  /** 32+ random bytes from the app's secret store, used only here. Rotating it voids open invites; members keep working. */
  secret: string
  /** The app's spaces by the name in their address; null when there is none. */
  spaces: { byName: (name: string) => Promise<Space | null> }
  /** The signed-in owner's email, or null: the same function the app gives `createOAuth`. */
  owner: (c: Context) => Promise<string | null>
  /** Names of keys from `API_KEYS` that may share. Default none. */
  fixedKeys?: string[]
  /** The space's MCP address, one `{space}` segment with one after it. Default '/s/{space}/mcp'. */
  resourcePath?: string
  /** What a space's name looks like, checked before any lookup. Default /^[a-z0-9][a-z0-9-]{0,62}$/. */
  spaceName?: RegExp
  /** Where the owner routes live: `{path}/{space}/…`. Default '/api/spaces'. */
  path?: string
  /** Whether asking to join exists at all; each space still switches it on. Default false. */
  askToJoin?: boolean
  tag?: string
}

/** The options with their defaults, and the keys derived from the secret: what `registerSharing` reads. */
export type SharingConfig = Required<Omit<SharingOptions, 'secret'>> & { keys: SharingKeys }

export type Sharing = {
  /** The space addresses as a pattern for `auth.relay` (`/s/*\/mcp`): a `read` token may POST there. */
  relay: string
  /** The space address as a Hono path for `mountMcp` (`/s/:space/mcp`). */
  mcpPath: string
  /** Paths whose answers Idempotency-Key never keeps (`guards.skip`): the sign-in pages answer with codes in redirects. */
  neverKept: string[]
  config: SharingConfig
}

const SPACE = '{space}'

/** The relay pattern and the MCP mount of a space address; throws unless it has one whole `{space}` segment with one after it. */
const spaceAddressOf = (resourcePath: string) => {
  const segments = resourcePath.split('/')
  const holding = segments.filter((segment) => segment.includes(SPACE))
  const at = segments.indexOf(SPACE)
  const fits = resourcePath.startsWith('/') && holding.length === 1 && at > 0 && at < segments.length - 1
  if (!fits) throw new Error(`sharing: resourcePath ${resourcePath} needs exactly one {space} segment with a segment after it, as in /s/{space}/mcp`)
  return { relay: resourcePath.replace(SPACE, '*'), mcpPath: resourcePath.replace(SPACE, ':space') }
}

/**
 * The part, with its options checked: the keys derived from `secret` (it throws on a short one) and the space address.
 * Give its `relay` to `auth.relay`, its `neverKept` to `guards.skip`, and it to `registerSharing`.
 *
 * @example
 * const sharing = await createSharing({ db, secret: env.SHARING_SECRET, spaces: { byName: (name) => shelves.byName(name) }, owner, askToJoin: true })
 */
export const createSharing = async (options: SharingOptions): Promise<Sharing> => {
  const { secret, resourcePath = '/s/{space}/mcp', ...rest } = options
  const { relay, mcpPath } = spaceAddressOf(resourcePath)
  const config: SharingConfig = {
    ...rest,
    keys: sharingKeys(secret),
    resourcePath,
    fixedKeys: options.fixedKeys ?? [],
    spaceName: options.spaceName ?? /^[a-z0-9][a-z0-9-]{0,62}$/,
    path: options.path ?? '/api/spaces',
    askToJoin: options.askToJoin ?? false,
    tag: options.tag ?? SHARING_TAG.name,
  }
  return { relay, mcpPath, neverKept: ['/sharing/*'], config }
}

/**
 * Registers the owner's sharing routes on the app, after migrating the sharing tables. Call it after `createAgentApi`,
 * with the app's `createOAuth` server: its root and MCP path say which agents may share, and its issuer names links.
 *
 * @example
 * await registerSharing(app, sharing, { oauth })
 */
export const registerSharing = async (app: OpenAPIHono, sharing: Sharing, { oauth }: { oauth: Pick<OAuth, 'rootOf' | 'issuerOf' | 'mcpPath'> }) => {
  const { config } = sharing
  await migrate(config.db, 'sharing', SHARING_MIGRATIONS)
  const routes = sharingRoutes({ path: config.path, tag: config.tag })
  const handle = sharingHandlers(config, oauth, sharingRepo(config.db))
  app.openapi(routes.get, handle.get)
  app.openapi(routes.update, handle.update)
  app.openapi(routes.createInvite, handle.createInvite)
  app.openapi(routes.listInvites, handle.listInvites)
  app.openapi(routes.revokeInvite, handle.revokeInvite)
}
