/**
 * Approving a sign-in: what the app's page is told (`SignInAsk`), what it answers (`SignInDecision`), what `onGrant`
 * hears (`SignInGrant`), the cookie that binds a ticket to the browser that opened it, and the origin rule every
 * approval POST follows. Rules after cloudflare/workers-oauth-provider (a single-use consent ticket bound to the browser
 * in a `__Host-` cookie; never redirect to a redirect_uri before it is checked) and oidc-provider (the grant is saved
 * before the code exists), both MIT.
 */
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import { originOf } from '../core/hal.js'

/** What `approve` and `ticketOf` hand the app: one sign-in request, already checked by the kit. */
export type SignInAsk = {
  /** Posted back by the app's page; `complete` spends it. */
  ticket: string
  client: { id: string; name: string; redirectUris: string[] }
  redirectUri: string
  /** Where the client returns: the redirect's host, or its scheme (`sample-app:`). */
  redirectHost: string
  /** The redirect is on this machine: an http redirect to a loopback host. Never a custom scheme: any app may claim one. */
  onThisComputer: boolean
  scopes: string[]
  /** The audience the grant gets: the resource asked for when this server issues for it, else the root. */
  resource: string
  /** The client named `resource` itself: `complete` keeps it, and refuses to bind another. */
  named: boolean
  /** When the ticket expires, in epoch seconds. */
  expiresAt: number
  state?: string
  /** How the browser arrived at the first page: `Sec-Fetch-Site` and the `Referer`'s origin, when sent. */
  arrival: { site: string | null; referrerOrigin: string | null }
}

/**
 * The app's answer to a ticket: who approves (the token's `sub`), narrower scopes, data for `onGrant`, and the
 * audience when the client named none (`resource`: an invite binds its space); or `'deny'`.
 */
export type SignInDecision = { approver: string; scopes?: string[]; data?: Record<string, string>; resource?: string } | 'deny'

/** What `onGrant` hears before the first token of a grant. `resource` is absent on a grant from before audiences. */
export type SignInGrant = {
  kind: 'code' | 'device' | 'claim'
  grant: string
  client: { id: string; name: string }
  approver: string
  scopes: string[]
  resource?: string
  data?: Record<string, string>
}

/**
 * What `onRevoke` hears for every grant the kit ends: `revoked` (`revokeGrant`, or a refresh token at `/oauth/revoke`),
 * `replayed` (a used code or refresh token sent again), `withdrawn` (`onGrant` said no), `client_revoked`
 * (`revokeClient`: every grant of the client, none named). `client` is absent where the kit does not know it
 * (`revokeGrant`). A grant that lapses (its refresh token unused for 30 days) is not told: nothing ends it.
 */
export type SignInRevoked = { grant?: string; client?: string; reason: 'revoked' | 'replayed' | 'withdrawn' | 'client_revoked' }

/** Host names that are this machine: an http redirect may use only these. @example LOOPBACK.includes(url.hostname) */
export const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']
const NONCE = /^[\w-]{32,64}$/

/** `__Host-oauth_ticket` on https (no sibling host can set it), `oauth_ticket` on http. */
const cookieName = (origin: string) => (origin.startsWith('https:') ? '__Host-oauth_ticket' : 'oauth_ticket')

/**
 * The ticket nonce this browser holds, when it sent a well-formed one under the cookie name of `origin` (the issuer;
 * default the request's). @example const nonce = nonceOf(c) ?? newNonce()
 */
export const nonceOf = (c: Context, origin = originOf(c)) => {
  const value = getCookie(c, cookieName(origin))
  return value && NONCE.test(value) ? value : null
}

/** The `Set-Cookie` line binding tickets to this browser for `seconds`, named for `origin`. @example page.headers.append('set-cookie', ticketCookie(c, nonce, 600)) */
export const ticketCookie = (c: Context, nonce: string, seconds: number, origin = originOf(c)) =>
  `${cookieName(origin)}=${nonce}; Max-Age=${seconds}; Path=/; HttpOnly; SameSite=Lax${origin.startsWith('https:') ? '; Secure' : ''}`

/**
 * Whether a POST came from this origin's own page: `Sec-Fetch-Site: same-origin`, or with no such header an `Origin`
 * equal to `root`. `same-site` is not enough: a sibling host is same-site. `Origin: null` is refused, and a page served
 * with the kit's `Referrer-Policy: no-referrer` makes a browser send it: a page whose form posts here carries
 * `<meta name="referrer" content="same-origin">`, as the kit's own do.
 *
 * @example
 * if (!sameOrigin(c, oauth.rootOf(c))) return c.text('Not allowed', 403)
 */
export const sameOrigin = (c: Context, root: string) => {
  const site = c.req.header('sec-fetch-site')
  if (site) return site === 'same-origin'
  const origin = c.req.header('origin')
  return Boolean(origin && URL.canParse(origin) && new URL(origin).origin === root)
}

/** How a browser arrived: `Sec-Fetch-Site` and the `Referer`'s origin. @example arrivalOf(c) // { site: 'cross-site', referrerOrigin: 'https://client.example.test' } */
export const arrivalOf = (c: Context) => {
  const referer = c.req.header('referer')
  const origin = referer && URL.canParse(referer) ? new URL(referer).origin : 'null'
  return { site: c.req.header('sec-fetch-site') ?? null, referrerOrigin: origin === 'null' ? null : origin }
}

/**
 * Where a redirect returns, as a person reads it: its host (its scheme for a custom one), and whether that is this
 * computer: an http redirect to a loopback host, and nothing else. A custom scheme is whatever app claimed it, a browser
 * that opens any page included, so it is named, never trusted.
 *
 * @example
 * returnOf('http://127.0.0.1:33418/cb') // { host: '127.0.0.1:33418', onThisComputer: true }
 * returnOf('sample-app://cb')           // { host: 'sample-app:', onThisComputer: false }
 */
export const returnOf = (redirectUri: string) => {
  const url = new URL(redirectUri)
  const web = url.protocol === 'https:' || url.protocol === 'http:'
  return { host: web ? url.host : url.protocol, onThisComputer: url.protocol === 'http:' && LOOPBACK.includes(url.hostname) }
}
