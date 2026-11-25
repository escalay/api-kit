/**
 * Signing in at a space: the ladder `approve` climbs to pick a sign-in's page (`signInStepOf`), and
 * `POST /sharing/join`, which completes the ticket with the typed code's invite. The step is worked out again from the
 * ticket on every post, never from a hidden field; the grant is bound to the invite's space with `complete`'s
 * `resource`, its scopes what the client asked and the invite gives; nothing here ever completes a root grant. The
 * owner's own page and its posts are in `owner.ts`.
 *
 * @example
 * signInStepOf({ asked: 'space', owner: false, found: false })        // 'code'
 * signInStepOf({ asked: 'named-root', owner: false, found: false })   // 'wrong-address'
 */
import type { Context } from 'hono'
import type { AgentBrand } from '../core/discovery.js'
import { originOf } from '../core/hal.js'
import type { OAuth, SignInAsk } from '../oauth/index.js'
import { sameOrigin } from '../oauth/approval.js'
import { handlesFor, spaceOfResource, type Binding, type Bound } from './grants.js'
import type { SharingConfig, Space } from './index.js'
import type { CodeLimits } from './limits.js'
import { sharingPages, type CodeView, type OwnerView, type Return, type SharingPages } from './pages.js'
import type { InviteWithMember, SharingRepo } from './repo.js'
import type { Scope } from './schema.js'
import { codeHashOf } from './secrets.js'
import { inviteStateOf } from './states.js'

/** What a sign-in asks for: a space, or the whole app, named by the client or chosen by the server when it named none. */
export type Asked = 'space' | 'named-root' | 'unnamed-root'
/** What the ladder decides by: what is asked for, whether the owner is signed in, and whether the asked space is found (looked up for the owner only). */
export type SignInFacts = { asked: Asked; owner: boolean; found: boolean }
/**
 * The page a sign-in gets: the kit's own consent page (`approve` answers null), the wrong-address page, the code page,
 * the owner's page, or the owner's "no such space" page.
 */
export type SignInStep = 'kit' | 'wrong-address' | 'code' | 'owner' | 'no-such-space'

/** The ladder, as the README's table: each row's `when` alone decides it. */
const LADDER: { when: (facts: SignInFacts) => boolean; step: SignInStep }[] = [
  { when: ({ asked, owner }) => asked === 'named-root' && owner, step: 'kit' },
  { when: ({ asked, owner }) => asked === 'named-root' && !owner, step: 'wrong-address' },
  { when: ({ asked, owner }) => asked === 'unnamed-root' && owner, step: 'kit' },
  { when: ({ asked, owner }) => asked === 'unnamed-root' && !owner, step: 'code' },
  { when: ({ asked, owner, found }) => asked === 'space' && owner && found, step: 'owner' },
  { when: ({ asked, owner, found }) => asked === 'space' && owner && !found, step: 'no-such-space' },
  { when: ({ asked }) => asked === 'space', step: 'code' },
]

/** The steps at which a typed code is taken: every space's, and a stranger's at the root. */
const CODE_STEPS: readonly SignInStep[] = ['code', 'owner', 'no-such-space']

/**
 * The page a sign-in the part handles gets, from what it asks for, whether the owner is signed in, and whether the
 * space is found. Only the owner reaches the kit's consent for the whole app, or their own page at a space; a client
 * that named the whole app is never bound to a space.
 *
 * @example
 * signInStepOf({ asked: 'unnamed-root', owner: false, found: false })   // 'code': the typed code's space binds it
 * signInStepOf({ asked: 'space', owner: true, found: true })            // 'owner'
 */
export const signInStepOf = (facts: SignInFacts): SignInStep => LADDER.find((row) => row.when(facts))!.step

/** What a sign-in the part handles asks for. */
const askedOf = (config: SharingConfig, bound: Bound, ask: Pick<SignInAsk, 'resource' | 'named'>): Asked => {
  if (spaceOfResource(config, ask.resource, bound.root)) return 'space'
  return ask.named ? 'named-root' : 'unnamed-root'
}

/** The space a sign-in asks for, looked up only for the owner, so no one else learns whether it exists. */
const ownersSpaceOf = async (config: SharingConfig, bound: Bound, ask: Pick<SignInAsk, 'resource'>, { asked, owner }: Pick<SignInFacts, 'asked' | 'owner'>) => {
  if (!owner || asked !== 'space') return null
  return config.spaces.byName(spaceOfResource(config, ask.resource, bound.root) ?? '')
}

/** Where a client returns: this computer (a loopback http redirect), an exact callback in `knownReturns`, or neither. */
const returnOf = (config: SharingConfig, ask: Pick<SignInAsk, 'onThisComputer' | 'redirectUri' | 'redirectHost'>): Return => {
  if (ask.onThisComputer) return { kind: 'this-computer' }
  const known = config.knownReturns.find((one) => one.callback === ask.redirectUri)
  if (known) return { kind: 'known', name: known.name }
  return { kind: 'unknown', host: ask.redirectHost }
}

/** What the code page shows of where a sign-in returns, and whether it asks for a space (only there may the owner step in). */
const codeViewOf = (config: SharingConfig, bound: Bound, ask: SignInAsk): CodeView => ({ back: returnOf(config, ask), atSpace: askedOf(config, bound, ask) === 'space' })

/**
 * What the owner's page starts with: at a known return what the app asked, until revoked; at any other, read for 30
 * days. The owner may narrow either, never widen.
 *
 * @example
 * ownerViewOf(config, ask, soups)   // { title: 'Soups', back: { kind: 'unknown', host: 'evil.example.test' }, write: false, untilRevoked: false }
 */
export const ownerViewOf = (config: SharingConfig, ask: SignInAsk, space: Space): OwnerView => {
  const back = returnOf(config, ask)
  const known = back.kind !== 'unknown'
  return { title: space.title, back, write: known && ask.scopes.includes('write'), untilRevoked: known }
}

/**
 * What a member row keeps of where its client returns: `this computer`, or the host (the scheme, for a custom one).
 *
 * @example
 * returnsToOf({ onThisComputer: false, redirectHost: 'evil-app:' })   // 'evil-app:'
 */
export const returnsToOf = (ask: Pick<SignInAsk, 'onThisComputer' | 'redirectHost'>) => (ask.onThisComputer ? 'this computer' : ask.redirectHost)

/**
 * A space's address, on the pinned origin: the resource every grant the pages make is bound to.
 *
 * @example
 * spaceResourceOf(config, bound, soups)   // 'https://sample.example.test/s/soups/mcp'
 */
export const spaceResourceOf = (config: SharingConfig, bound: Bound, space: Space) => bound.root + config.resourcePath.replace('{space}', space.name)

/** The scopes each invite, or each answer of the owner, gives. */
const GIVES: Record<Scope, string[]> = { read: ['read'], write: ['read', 'write'] }

/**
 * What the client asked for that the invite or the owner gives: never more than either.
 *
 * @example
 * scopesFor(['read', 'write'], 'read')   // ['read']
 * scopesFor(['write'], 'read')           // []: nothing to give
 */
export const scopesFor = (asked: string[], given: Scope) => asked.filter((scope) => GIVES[given].includes(scope))

/**
 * A form field as text: absent or a file is empty.
 *
 * @example
 * textOf((await c.req.parseBody()).ticket)   // 'consent_…', or ''
 */
export const textOf = (value: unknown) => (typeof value === 'string' ? value : '')

/** What `approve` works from: the options, and the server and brand once bound. */
type SignIn = { config: SharingConfig; binding: Binding }

/**
 * `approve`: the part's page for a sign-in it handles, or null for the kit's consent page (the owner at the whole app)
 * and for a sign-in it doesn't handle. Before `bind`, a page saying sharing is not ready.
 *
 * @example
 * const approve = approveFor({ config, binding })   // what sharing.oauth.approve is
 */
export const approveFor = ({ config, binding }: SignIn) => async (c: Context, ask: SignInAsk): Promise<Response | null> => {
  const { bound, brand } = binding
  if (!bound) return sharingPages({ origin: originOf(c) }).notReady(c)
  if (!handlesFor({ config, binding })(ask)) return null
  const pages = sharingPages({ brand, origin: bound.root, signInPath: config.signInPath })
  const asked = askedOf(config, bound, ask)
  const owner = (await config.owner(c)) !== null
  const space = await ownersSpaceOf(config, bound, ask, { asked, owner })
  const step = signInStepOf({ asked, owner, found: space !== null })
  if (step === 'kit') return null
  if (step === 'wrong-address') return pages.wrongAddress(c, 200)
  if (step === 'no-such-space') return pages.noSuchSpace(c, spaceOfResource(config, ask.resource, bound.root) ?? '')
  if (step === 'owner') return pages.owner(c, ask, ownerViewOf(config, ask, space!))
  return pages.code(c, ask, codeViewOf(config, bound, ask))
}

/** What `complete` and its two lookups need from the app's OAuth server. */
export type SignInOAuth = Pick<OAuth, 'ticketOf' | 'answeredOf' | 'complete'>

/** What `POST /sharing/join` works from. */
type Joining = { config: SharingConfig; bound: Bound; brand?: AgentBrand; repo: SharingRepo; limits: CodeLimits; oauth: SignInOAuth }

/** A typed code's open invite and its space. */
type Found = { invite: InviteWithMember; space: Space }

/**
 * `POST /sharing/join { ticket, code }`: same-origin first, then the ticket this browser holds, its step again, the
 * limits (never for the owner), the code's open invite, and `complete` with it. A wrong code is the code page again,
 * and the fifth on one ticket answers it `deny`, so the app hears `access_denied`.
 *
 * @example
 * app.post('/sharing/join', joinByCodeFor({ config, bound, brand, repo, limits, oauth }))
 */
export const joinByCodeFor = ({ config, bound, brand, repo, limits, oauth }: Joining) => {
  const pages: SharingPages = sharingPages({ brand, origin: bound.root, signInPath: config.signInPath })
  const handles = handlesFor({ config, binding: { bound } })

  /** The open invite a code names at the asked space. */
  const atAskedSpace = async (ask: SignInAsk, codeHash: string): Promise<Found | null> => {
    const space = await config.spaces.byName(spaceOfResource(config, ask.resource, bound.root) ?? '')
    if (!space) return null
    const invite = await repo.inviteByCodeAt(space.id, codeHash)
    return invite ? { invite, space } : null
  }

  /** The invite a code names at any space, for a client that named none: the code then picks the space. */
  const atItsSpace = async (codeHash: string): Promise<Found | null> => {
    const invite = await repo.inviteByCodeAnywhere(codeHash)
    if (!invite) return null
    const space = await config.spaces.byId(invite.spaceId)
    if (!space || !config.spaceName.test(space.name)) return null
    return { invite, space }
  }

  /** The open invite a typed code names, with its space; null for anything else, whether or not the space exists. */
  const openInviteOf = async (asked: Asked, ask: SignInAsk, typed: string) => {
    const codeHash = codeHashOf(config.keys, typed)
    const found = asked === 'space' ? await atAskedSpace(ask, codeHash) : await atItsSpace(codeHash)
    if (!found) return null
    const redeemedBy = found.invite.memberId ? { id: found.invite.memberId } : null
    return inviteStateOf(found.invite, redeemedBy, new Date()) === 'open' ? found : null
  }

  /** Whose budget a typed code spends: the asked space's, by its name, or `any` for a client that named none. */
  const budgetOf = (asked: Asked, ask: SignInAsk) => (asked === 'space' ? spaceOfResource(config, ask.resource, bound.root)! : 'any')

  /** A wrong code: the code page again, or the ticket answered `deny` when it was the last try. The owner is never counted. */
  const wrongCode = async (c: Context, ask: SignInAsk, owner: boolean) => {
    if (!owner && (await limits.lastTry(ask.ticket))) return oauth.complete(c, ask.ticket, 'deny')
    return pages.wrongCode(c, ask, codeViewOf(config, bound, ask))
  }

  /** Completes the ticket with the invite: its approver, the scopes it gives of those asked, its space's address. */
  const joinWith = (c: Context, ask: SignInAsk, { invite, space }: Found) => {
    const scopes = scopesFor(ask.scopes, invite.scope)
    if (!scopes.length) return pages.tooLittle(c, ask, codeViewOf(config, bound, ask))
    return oauth.complete(c, ask.ticket, { approver: `invite:${invite.id}`, scopes, resource: spaceResourceOf(config, bound, space), data: { sharing: 'invite', invite: invite.id, returnsTo: returnsToOf(ask) } })
  }

  return async (c: Context) => {
    if (!sameOrigin(c, bound.root)) return pages.notAllowed(c)
    const body = await c.req.parseBody()
    const ticket = textOf(body.ticket)
    const ask = await oauth.ticketOf(c, ticket)
    if (!ask) return pages.gone(c, await oauth.answeredOf(c, ticket))
    if (!handles(ask)) return pages.notAllowed(c)
    const asked = askedOf(config, bound, ask)
    const owner = (await config.owner(c)) !== null
    const space = await ownersSpaceOf(config, bound, ask, { asked, owner })
    const step = signInStepOf({ asked, owner, found: space !== null })
    if (step === 'wrong-address') return pages.wrongAddress(c, 400)
    if (!CODE_STEPS.includes(step)) return pages.notAllowed(c)
    if (!owner) {
      const retry = await limits.retryAfter(c, budgetOf(asked, ask))
      if (retry) return pages.tooMany(c, retry)
    }
    const found = await openInviteOf(asked, ask, textOf(body.code))
    if (!found) return wrongCode(c, ask, owner)
    return joinWith(c, ask, found)
  }
}
