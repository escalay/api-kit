/**
 * Sharing: invites to a space, asks to join and the owner's approval, on the oauth part's hooks (`approve`,
 * `complete`, `onGrant`, `onRevoke`, `accepts`). A **space** is the part of an app that is shared (a shelf, a board, a
 * project); a **member** is one grant into one space. So far the part holds its tables (`SHARING_MIGRATIONS`), the
 * only queries (`sharingRepo`), the named states of its rows (`states.ts`), its secrets (`secrets.ts`), the oauth hooks
 * that make members and hold a space's token to its space (`sharing.oauth`, `grants.ts`), the sign-in pages where an
 * invite's code is typed (`signin.ts`, `pages.ts`, `limits.ts`: `POST /sharing/join`), and the owner's routes and
 * tools for a space's settings and its invites:
 *   GET    {path}/{space}/sharing         how the space is shared
 *   PATCH  {path}/{space}/sharing         switch Ask to join
 *   POST   {path}/{space}/invites         a new invite → 201, its link and code shown this once
 *   GET    {path}/{space}/invites         the space's invites, newest first, a page at a time
 *   GET    {path}/{space}/invites/{id}    one invite and its state, never its link or code
 *   DELETE {path}/{space}/invites/{id}    revoke an invite no one has used
 * The owner's own approval at a space, members, the remembered link and asking to join come next (its README says
 * what is there).
 *
 * @example
 * const sharing = await createSharing({ db, secret: env.SHARING_SECRET, spaces, owner, spaceOfPath, fixedKeys: [...parseApiKeys(env.API_KEYS).values()] })
 * const oauth = createOAuth({ name: 'Sample', signingKey, store, owner, publicOrigin, ...sharing.oauth })
 * const app = createAgentApi({ …, tags: [...FEATURE_TAGS, SHARING_TAG], auth: { …, open: [...SHARING_OPEN_PATHS], relay: ['/mcp', '/a2a', sharing.relay] }, guards: { …, skip: sharing.neverKept }, oauth })
 * await registerSharing(app, sharing, { oauth })
 * mcpServerFactory({ tools: [...FEATURE_TOOLS, ...sharingTools({ noun: 'shelf' })], … })
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { AddressTrust, GuardStore } from '../core/guards.js'
import { mountedOf, type AgentBrand } from '../core/discovery.js'
import { dbGuardStore } from '../db/guards.js'
import { migrate, type Db } from '../db/index.js'
import type { OAuthConfig, SignInAsk } from '../oauth/index.js'
import { acceptsFor, boundOf, handlesFor, memberOfFor, onGrantFor, onRevokeFor, resourceOfFor, resourcesFor, type Binding, type Bound, type BoundOAuth, type MemberView } from './grants.js'
import { sharingHandlers } from './handlers.js'
import { codeLimitsOf, type SharingLimits } from './limits.js'
import { sharingRepo } from './repo.js'
import { sharingRoutes } from './routes.js'
import { SHARING_MIGRATIONS } from './schema.js'
import { sharingKeys, type SharingKeys } from './secrets.js'
import { approveFor, joinByCodeFor, type SignInOAuth } from './signin.js'

export { appNameOf, boundOf, isRootAudience, ONLY_ITS_SPACE, spaceNameIn, type Binding, type Bound, type BoundOAuth, type MemberView } from './grants.js'
export { sharerOf, type Sharer, type SharerFacts } from './handlers.js'
export { sharingRepo, type InviteRow, type InviteWithMember, type MemberRow, type NewInvite, type NewMember, type NewRequest, type PageAt, type RequestRow, type RequestWithMember, type SharingRepo, type SpaceRow } from './repo.js'
export { PLAIN_TEXT, sharingRoutes, type SharingRoutes } from './routes.js'
export { sharingInvites, sharingMembers, sharingRequests, sharingSpaces, SHARING_MIGRATIONS, type EndedReason, type Lifetime, type Scope } from './schema.js'
export { addressKeyOf, CODE_ALPHABET, codeHashOf, linkHashOf, newInviteCode, newLinkToken, newShownCode, normalisedCode, sharingKeys, ticketHashOf, type SharingKeys } from './secrets.js'
export { askingStateOf, inviteStateOf, MAX_OPEN_INVITES, memberExpiresAtOf, memberListingOf, memberStateOf, redeemByOf, requestStateOf, REDEEM_WITHIN, UNANSWERED_PAUSE, UNSEEN_FOR, type AskingState, type InviteState, type MemberListing, type MemberState, type RequestState } from './states.js'
export { signInStepOf, type Asked, type SignInFacts, type SignInOAuth, type SignInStep } from './signin.js'
export { sharingTools } from './tools.js'

export const SHARING_TAG = { name: 'Sharing', description: 'Invites to a space, and how it is shared: for the owner, their deployment keys and their own agents.' }

/** A space, as the app keeps it: its id (never reused), the name in its address, and its title. */
export type Space = { id: string; name: string; title: string }

export type SharingOptions = {
  /** The app's database (`openDb`), the same one as its OAuth state; the sharing tables are migrated into it. */
  db: Db
  /** 32+ random bytes from the app's secret store, used only here. Rotating it voids open invites; members keep working. */
  secret: string
  /** The app's spaces by the name in their address and by id; null when there is none. Ids are never reused. */
  spaces: { byName: (name: string) => Promise<Space | null>; byId: (id: string) => Promise<Space | null> }
  /**
   * The space an `/api` request is about, from its path alone: an MCP tool calls `/api` in-process, where the space's
   * address is gone. A pure function of the path, never a header a client can set. Default: none, so a space token
   * reaches no `/api` route.
   */
  spaceOfPath?: (path: string) => string | null
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
  /**
   * The apps the app expects, by their exact callbacks (https, or a custom scheme it trusts): the pages name them
   * instead of warning. A loopback http redirect is always known (an app on this computer). Default none.
   */
  knownReturns?: { name: string; callback: string }[]
  /**
   * Where typed codes are counted, and how the caller's address is read. Default `{ store: await dbGuardStore(db) }`
   * and the app's `address`; `false` throws. Under `'headers'` an address is as sent, so set the app's `address`
   * (core README, The caller's address) or a stranger names a new one on every post.
   */
  limits?: { store?: GuardStore; address?: AddressTrust } | false
  tag?: string
}

/** The options with their defaults, and the keys derived from the secret: what `registerSharing` reads. */
export type SharingConfig = Required<Omit<SharingOptions, 'secret' | 'limits'>> & { keys: SharingKeys; limits: SharingLimits }

export type Sharing = {
  /** The space addresses as a pattern for `auth.relay` (`/s/*\/mcp`): a `read` token may POST there. */
  relay: string
  /** The space address as a Hono path for `mountMcp` (`/s/:space/mcp`). */
  mcpPath: string
  /** Paths whose answers Idempotency-Key never keeps (`guards.skip`): the sign-in pages answer with codes in redirects. */
  neverKept: string[]
  config: SharingConfig
  /**
   * The oauth hooks, to spread into `createOAuth`: `onGrant` makes members, `onRevoke` ends them, `accepts` holds a
   * space token to its space, `resources` and `resourceOf` describe the space addresses. An app with hooks of its own
   * chains them (its README, Wire it).
   */
  oauth: Required<Pick<OAuthConfig, 'approve' | 'onGrant' | 'onRevoke' | 'accepts' | 'resources' | 'resourceOf'>>
  /**
   * Ties the hooks to the app's OAuth server (and the pages to its brand) and answers what they judge by;
   * `registerSharing` calls it. Throws when the server has no `publicOrigin`. Before it, `approve` shows a 503 page,
   * `onGrant` says no and `accepts` takes only a token with no audience.
   */
  bind: (oauth: BoundOAuth, brand?: AgentBrand) => Bound
  /** Whether a sign-in is the part's to judge: its audience a space, the root or the root's MCP. */
  handles: (ask: Pick<SignInAsk, 'resource'>) => boolean
  /** The member behind a request's space token while it lives, with its space; null for anyone else. */
  memberOf: (c: Context) => Promise<MemberView | null>
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
 * const sharing = await createSharing({ db, secret: env.SHARING_SECRET, spaces: { byName: (name) => shelves.byName(name), byId: (id) => shelves.byId(id) }, owner, askToJoin: true })
 */
export const createSharing = async (options: SharingOptions): Promise<Sharing> => {
  const { secret, resourcePath = '/s/{space}/mcp', limits, ...rest } = options
  const { relay, mcpPath } = spaceAddressOf(resourcePath)
  if (limits === false) throw new Error('sharing: limits are always on, since a typed code is all that stands between a stranger and a space: leave limits out (the app\'s database counts them) or pass { store }.')
  const config: SharingConfig = {
    ...rest,
    keys: sharingKeys(secret),
    limits: { store: limits?.store ?? (await dbGuardStore(options.db)), address: limits?.address },
    knownReturns: options.knownReturns ?? [],
    resourcePath,
    fixedKeys: options.fixedKeys ?? [],
    spaceName: options.spaceName ?? /^[a-z0-9][a-z0-9-]{0,62}$/,
    path: options.path ?? '/api/spaces',
    askToJoin: options.askToJoin ?? false,
    tag: options.tag ?? SHARING_TAG.name,
    spaceOfPath: options.spaceOfPath ?? (() => null),
  }
  const binding: Binding = { bound: null }
  const grants = { config, repo: sharingRepo(config.db), binding }
  return {
    relay,
    mcpPath,
    neverKept: ['/sharing/*'],
    config,
    oauth: { approve: approveFor(grants), onGrant: onGrantFor(grants), onRevoke: onRevokeFor(grants), accepts: acceptsFor(grants), resources: resourcesFor(grants), resourceOf: resourceOfFor(grants) },
    bind: (oauth, brand) => {
      binding.bound = boundOf(oauth)
      binding.brand = brand
      return binding.bound
    },
    handles: handlesFor(grants),
    memberOf: memberOfFor(grants),
  }
}

/**
 * Registers the sign-in pages' route (`POST /sharing/join`) and the owner's sharing routes on the app, after binding
 * the hooks to the app's `createOAuth` server and brand (`bind`, which throws without `publicOrigin`) and migrating
 * the sharing tables. Call it after `createAgentApi`, before serving: its pinned origin and MCP path say which agents
 * may share and which tokens are root tokens, and name links.
 *
 * @example
 * await registerSharing(app, sharing, { oauth })
 */
export const registerSharing = async (app: OpenAPIHono, sharing: Sharing, { oauth }: { oauth: BoundOAuth & SignInOAuth }) => {
  const { config } = sharing
  const { brand } = mountedOf(app)
  const bound = sharing.bind(oauth, brand)
  await migrate(config.db, 'sharing', SHARING_MIGRATIONS)
  const repo = sharingRepo(config.db)
  app.post('/sharing/join', joinByCodeFor({ config, bound, brand, repo, limits: codeLimitsOf(config.limits, config.keys), oauth }))
  const routes = sharingRoutes({ path: config.path, tag: config.tag })
  const handle = sharingHandlers(config, bound, repo)
  app.openapi(routes.get, handle.get)
  app.openapi(routes.update, handle.update)
  app.openapi(routes.createInvite, handle.createInvite)
  app.openapi(routes.listInvites, handle.listInvites)
  app.openapi(routes.getInvite, handle.getInvite)
  app.openapi(routes.revokeInvite, handle.revokeInvite)
}

/** The sign-in pages' paths, open without auth: give them to `auth.open`. */
export const SHARING_OPEN_PATHS = ['/sharing/*']

/**
 * Every path a sign-in at a space reaches beyond what the kit's OAuth already lets past Cloudflare Access: the sign-in
 * page, the part's pages, the space addresses and their metadata. Let exactly these through; `/oauth/device` and
 * `/oauth/claim` stay behind it.
 *
 * @example
 * sharingSignInPaths(sharing)   // ['/oauth/authorize', '/sharing/*', '/s/*\/mcp', '/.well-known/oauth-protected-resource/s/*\/mcp']
 */
export const sharingSignInPaths = (sharing: Pick<Sharing, 'relay'>) => ['/oauth/authorize', ...SHARING_OPEN_PATHS, sharing.relay, `/.well-known/oauth-protected-resource${sharing.relay}`]
