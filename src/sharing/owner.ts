/**
 * The owner's own approval at a space (decisions 3, 6, 16, 24): `POST /sharing/as-owner`, the hop from a space's code
 * page when the owner's cookie did not come with a cross-site arrival, and `POST /sharing/owner`, their answer. Each
 * post is same-origin from the browser that opened the ticket, and asks `owner(c)` and the space again, in that order,
 * so no one but the owner learns whether a space exists. Every approval names its scopes (what the app asked that the
 * owner gives: read, and write when ticked) and its lifetime (30 days, or until revoked when ticked).
 *
 * @example
 * const owner = ownerRoutesFor({ config, bound, brand, oauth })
 * app.post('/sharing/as-owner', owner.asOwner)
 * app.post('/sharing/owner', owner.answer)
 */
import type { Context } from 'hono'
import type { AgentBrand } from '../core/discovery.js'
import type { SignInAsk } from '../oauth/index.js'
import { sameOrigin } from '../oauth/approval.js'
import { handlesFor, spaceOfResource, type Bound } from './grants.js'
import type { SharingConfig, Space } from './index.js'
import { sharingPages } from './pages.js'
import type { Lifetime } from './schema.js'
import { ownerViewOf, returnsToOf, scopesFor, spaceResourceOf, textOf, type SignInOAuth } from './signin.js'

const WIDENED = 'This app did not ask to make changes: untick Allow changes, or refuse.'
const ONLY_CHANGES = 'This app asks only to make changes: tick Allow changes, or refuse.'

/** What the owner ticked on their page: an unticked box is never sent. */
type Ticks = { write: boolean; untilRevoked: boolean }

/** What the owner's routes work from. */
type Owning = { config: SharingConfig; bound: Bound; brand?: AgentBrand; oauth: SignInOAuth }

/** A space sign-in a post names, or the page that answers instead. */
type SpaceAsk = { ask: SignInAsk; name: string } | { page: Response }

/**
 * The owner's two posts, for one app: its options, the server it is bound to, its brand and OAuth server.
 *
 * @example
 * app.post('/sharing/owner', ownerRoutesFor({ config, bound, brand, oauth }).answer)
 */
export const ownerRoutesFor = ({ config, bound, brand, oauth }: Owning) => {
  const pages = sharingPages({ brand, origin: bound.root, signInPath: config.signInPath })
  const handles = handlesFor({ config, binding: { bound } })

  /** The sign-in this browser holds, when it asks for a space; else the page that says why not. */
  const spaceAskOf = async (c: Context, ticket: string): Promise<SpaceAsk> => {
    const ask = await oauth.ticketOf(c, ticket)
    if (!ask) return { page: await pages.gone(c, await oauth.answeredOf(c, ticket)) }
    const name = handles(ask) ? spaceOfResource(config, ask.resource, bound.root) : null
    if (!name) return { page: await pages.notAllowed(c) }
    return { ask, name }
  }

  /** Completes the ticket as the owner: the scopes asked that the ticks give, the space's address, the lifetime ticked. */
  const approveAt = (c: Context, ask: SignInAsk, space: Space, owner: string, ticks: Ticks) => {
    const offer = ownerViewOf(config, ask, space)
    if (ticks.write && !ask.scopes.includes('write')) return pages.owner(c, ask, offer, WIDENED)
    const scopes = scopesFor(ask.scopes, ticks.write ? 'write' : 'read')
    if (!scopes.length) return pages.owner(c, ask, offer, ONLY_CHANGES)
    const lifetime: Lifetime = ticks.untilRevoked ? 'until_revoked' : '30d'
    const data = { sharing: 'owner', space: space.id, lifetime, returnsTo: returnsToOf(ask) }
    return oauth.complete(c, ask.ticket, { approver: `owner:${owner}`, scopes, resource: spaceResourceOf(config, bound, space), data })
  }

  /** `POST /sharing/as-owner { ticket }`: the owner's page, once this same-origin post carries their cookie; else "Sign in first". */
  const asOwner = async (c: Context) => {
    if (!sameOrigin(c, bound.root)) return pages.notAllowed(c)
    const found = await spaceAskOf(c, textOf((await c.req.parseBody()).ticket))
    if ('page' in found) return found.page
    if ((await config.owner(c)) === null) return pages.signInFirst(c)
    const space = await config.spaces.byName(found.name)
    if (!space) return pages.noSuchSpace(c, found.name)
    return pages.owner(c, found.ask, ownerViewOf(config, found.ask, space))
  }

  /** `POST /sharing/owner { ticket, decision, write, untilRevoked }`: Approve as ticked, or Refuse (`access_denied`). */
  const answer = async (c: Context) => {
    if (!sameOrigin(c, bound.root)) return pages.notAllowed(c)
    const body = await c.req.parseBody()
    const found = await spaceAskOf(c, textOf(body.ticket))
    if ('page' in found) return found.page
    const owner = await config.owner(c)
    if (owner === null) return pages.notAllowed(c)
    const space = await config.spaces.byName(found.name)
    if (!space) return pages.noSuchSpace(c, found.name)
    const decision = textOf(body.decision)
    if (decision === 'deny') return oauth.complete(c, found.ask.ticket, 'deny')
    if (decision !== 'approve') return pages.notAllowed(c)
    return approveAt(c, found.ask, space, owner, { write: body.write === 'on', untilRevoked: body.untilRevoked === 'on' })
  }

  return { asOwner, answer }
}
