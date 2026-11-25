/**
 * The service as its own OAuth authorization server, so an agent can get a token without anyone pasting a key. Three
 * ways in, each ending at a person who approves it on a page behind the site's single sign-on (or, for the first, on
 * the app's own page: `approve`, `complete`, `onGrant`):
 *   MCP clients (claude.ai, Claude Desktop, Cursor) follow the 401's `resource_metadata` to the protected-resource
 *   metadata, register themselves (RFC 7591), send the owner to `/oauth/authorize` (authorization code + PKCE S256),
 *   and refresh with rotating refresh tokens.
 *   Any other agent follows `/auth.md` (agent registration, anonymous or by email): it registers at `/agent/identity`,
 *   asks for a claim at `/agent/identity/claim`, hands the owner a 6-digit code to type at `/oauth/claim`, and polls
 *   the token endpoint until the owner has; it gets a refresh token with its first access token.
 *   A device or CLI without a browser uses the device authorization grant (RFC 8628): it asks
 *   `/oauth/device_authorization` for a code like `BDKM-QXTW`, the owner types it at `/oauth/device`, and the device
 *   polls the token endpoint.
 * Access tokens are ES256 JWTs (one hour) signed with the app's key and checked against a revocation list on every
 * request. Refresh tokens last 30 days and rotate on each use; a used one sent again revokes every refresh token of
 * that sign-in. An earlier refresh token is known by its MAC and its family's generation, even once its row is gone.
 * Codes and registrations live in the app's store as hashes. Nothing is granted before a person approves: an
 * unclaimed registration can't get a token.
 * A caller is known by its client (the client_id) and its grant (one approval: every token from one sign-in, rotated
 * or not, shares it), never by the name it registered, which is for display. Revoking a grant ends its access tokens
 * at once. Single use under concurrent requests (codes, refresh tokens) and replay handling follow rules after
 * cloudflare/workers-oauth-provider and better-auth (both MIT), written again here with their tests.
 * Every grant is bound to an audience (RFC 8707): the resource the client asked for at the authorization request when
 * this server issues for it, else the root (the issuer's origin). It never changes on refresh, and a grant from before
 * audiences never gains one. `accepts` judges whether a token's audience fits a request.
 * The endpoints anyone may call stay bounded: `publicOrigin` fixes the one origin every document, token and check
 * names; a registration no sign-in has used lives a week; every kind of row anyone may write is capped (a client a
 * live consent ticket holds stays); and `limits` counts registrations and claims, device authorizations, sign-in
 * pages and token misses per address. Rules after cloudflare/workers-oauth-provider (MIT): a registration's life
 * starts again when it is first used.
 *
 * @example
 * const oauth = createOAuth({ name: 'Cookbook', signingKey: env.OAUTH_SIGNING_KEY, store, owner: (c) => ownerOf(c) })
 * oauth.mount(app)                                                    // the metadata, the endpoints and auth.md
 * app.use('*', authenticate({ realm: 'cookbook', keys, tokens: oauth.verify, resourceMetadata: oauth.resourceMetadataFor }))
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { calculateJwkThumbprint, exportJWK, importJWK, jwtVerify, SignJWT, type JWK } from 'jose'
import { OAUTH_OPEN_PATHS, SCOPES } from '../core/auth.js'
import { mountedOf, type AgentBrand } from '../core/discovery.js'
import { addressOf, type AddressTrust, type GuardStore } from '../core/guards.js'
import { originOf } from '../core/hal.js'
import { problemResponse } from '../core/problem.js'
import { arrivalOf, LOOPBACK, nonceOf, returnOf, sameOrigin, ticketCookie, type SignInAsk, type SignInDecision, type SignInGrant, type SignInRevoked } from './approval.js'
import type { OAuthStore } from './store.js'

export type { SignInAsk, SignInDecision, SignInGrant, SignInRevoked } from './approval.js'
export { OAUTH_MIGRATIONS, oauthKeys } from './schema.js'
export { dbOAuthStore, memoryOAuthStore, type OAuthStore } from './store.js'

const HOUR = 3600
const ACCESS_TTL = HOUR
const CODE_TTL = 600
const REFRESH_TTL = 30 * 24 * HOUR
const CLIENT_TTL = 365 * 24 * HOUR
/** A registration no sign-in has used yet: long enough for an invite of a day, with room. Its first use gives it CLIENT_TTL. */
const UNUSED_CLIENT_TTL = 7 * 24 * HOUR
/** Unused registrations and open consent tickets kept at most, by default: past it the oldest goes. */
const MAX_UNUSED = 10_000
/** What `limits` allows per address on the open endpoints: calls per window (seconds). */
const LIMITS = {
  register: { limit: 20, window: HOUR },
  device: { limit: 20, window: HOUR },
  authorize: { limit: 60, window: 60 },
  token: { limit: 30, window: 60 },
} as const
const REGISTRATION_TTL = 24 * HOUR
const CLAIM_TTL = 600
const CLAIM_GRANT = 'urn:workos:agent-auth:grant-type:claim'
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const DEVICE_TTL = 600
const DEVICE_INTERVAL = 5
/** Wrong device codes a signed-in person may type in a window before the page refuses for the rest of it. */
const DEVICE_TRIES = 5
const DEVICE_TRIES_WINDOW = 600
/** A revoke marker outlives anything issued behind it: a code or device approval collected late, then its refresh token. */
const REVOKED_TTL = REFRESH_TTL + CODE_TTL + DEVICE_TTL
/** No vowels (no words), nothing that reads as another letter or a digit (RFC 8628 §6.1). */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

export type OAuthConfig = {
  /** Shown on the consent page and in the metadata (`resource_name`). */
  name: string
  /** The private ES256 key as a JWK JSON string (`generateOAuthKey()` makes one). */
  signingKey: string
  store: OAuthStore
  /** The signed-in person's email on the kit's approval pages (from the single sign-on), or null: only they may approve. */
  owner: (c: Context) => Promise<string | null>
  /**
   * The app's own page for a sign-in (an invite, an ask to join), called by `GET /oauth/authorize` once the kit has
   * checked the client, its redirect, PKCE and the resource, and before `owner`. A Response is the page: it posts the
   * ticket to the app's own route, which reads it with `ticketOf` and answers with `complete`, so nothing is granted
   * without a click. null shows the kit's own page to the owner. Set, `/oauth/authorize` answers every error with a
   * page and never redirects before a person acts.
   *
   * @example
   * approve: async (c, ask) => c.html(invitePage(ask))   // a form posting `ticket` and the invite to /join
   */
  approve?: (c: Context, ask: SignInAsk) => Promise<Response | null>
  /**
   * Hears the first token of every grant (a code, a device approval, a claim), after the kit's own checks: where an app
   * spends an invite or makes its own row for the grant. false withdraws it (`invalid_grant`, the code or device code
   * spent, a claim's grant revoked). A grant ended while it ran (a replayed code, a revoke) gets no token either, and
   * `onRevoke` hears it again after. Never asked on refresh or jwt-bearer: judge later requests in `accepts`.
   *
   * @example
   * onGrant: async (grant) => grant.kind !== 'code' || invites.spend(grant.data?.invite, grant.grant)
   */
  onGrant?: (grant: SignInGrant, c: Context) => Promise<boolean>
  /**
   * Hears every grant the kit ends, and why (`SignInRevoked`), after it has ended it: where an app drops the row it
   * made in `onGrant`. A grant that lapses (its refresh token unused for 30 days) is not told: the app ages its own
   * rows. At least once: a grant ended again (a code sent a third time), or while `onGrant` ran, is told again. A
   * throw is logged, never answered, so it can't undo or fail a revoke.
   *
   * @example
   * onRevoke: async ({ grant, reason }) => grant && members.dropGrant(grant, reason)
   */
  onRevoke?: (revoked: SignInRevoked) => void | Promise<void>
  /** The brand on the kit's own pages; default the app's (`createAgentApi({ brand })`). */
  brand?: AgentBrand
  /** Emails allowed to claim an agent registration; empty means whoever `owner` lets in. */
  owners?: string[]
  /**
   * The one origin of the issuer, `iss`, the metadata, auth.md, the 401's pointer, the resource check and the
   * same-origin rule (`https://sample.example.test`). Unset, each request's own origin is used, forwarded host
   * included, so the metadata and auth.md are `no-store` rather than cached publicly. An app whose sign-in is reachable
   * outside Access sets it.
   *
   * @example
   * publicOrigin: env.PUBLIC_ORIGIN   // 'https://sample.example.test'
   */
  publicOrigin?: string
  /**
   * Per-address limits on the endpoints anyone may call (registration and claims, device authorization, the sign-in
   * page, token misses), counted in `store` and read with `addressOf` (`address`, default the app's). The owner is never
   * counted. Default false: none.
   *
   * @example
   * limits: { store: await dbGuardStore(db), address: { header: 'cf-connecting-ip' } }
   */
  limits?: { store: GuardStore; address?: AddressTrust } | false
  /**
   * Registrations no sign-in has used yet (clients, agent registrations, their claim tokens), kept at most of each (a
   * whole number, default 10 000): past it a new one evicts the oldest. Never a client a live consent ticket holds.
   */
  maxUnusedClients?: number
  /**
   * Codes waiting for a person (consent tickets, claim attempts, device codes and their user codes), kept at most of
   * each (a whole number, default 10 000): past it a new one evicts the oldest. Never a ticket the app holds
   * (`holdTicket`): those are outside the cap, and the app bounds them.
   */
  maxUnusedTickets?: number
  /**
   * Seconds a consent ticket lives, and its browser's nonce cookie: whole, from 60 to a week (default 600). An app that
   * decides later (an ask to join the owner answers in hours) holds that one ticket with `holdTicket` and leaves this
   * alone; a longer `ticketTtl` makes every page live as long, and newer tickets still evict a waiting one.
   *
   * @example
   * ticketTtl: 300   // pages close sooner
   */
  ticketTtl?: number
  /** Extra fields for the authorization server metadata, e.g. `poppy_domains`. */
  metadata?: Record<string, unknown>
  /**
   * Seconds in which a used refresh token sent again (a client that lost the answer and retried) gets the same
   * successor, never a second one. 0 (the default): any replay revokes the grant.
   */
  reuseGraceSeconds?: number
  /** Where MCP is mounted (`mountMcp`'s `path`): its resource, metadata pointer and relay. Default `/mcp`. */
  mcpPath?: string
  /**
   * Whether this server issues tokens for a resource path (`/s/alpha/mcp`), besides the origin and `mcpPath` it always
   * issues for. The kit has already checked the resource's origin is the issuer's, so this sees the path only. Keep it
   * a pure check of the string, with no lookup: it answers the metadata path too, so a lookup would tell anyone which
   * resources exist. Set, it also refuses: an unknown resource or another origin is `invalid_target`, and metadata for
   * a path it refuses is 404. Unset, an unknown resource gets the root audience, as no resource does. With `resourceOf`
   * and no `accepts`, a token works at its own resource's address; an in-process `/api` call with it needs `accepts`.
   *
   * @example
   * resources: (path) => /^\/s\/[a-z0-9-]+\/mcp$/.test(path)
   */
  resources?: (path: string) => boolean
  /**
   * The canonical resource a request is for, as a full URL: where its 401 points (RFC 9728 §3.3). Default: the origin
   * plus `mcpPath` under it, else the origin.
   *
   * @example
   * resourceOf: (c) =>
   *   oauth.rootOf(c) + (/^\/s\/[a-z0-9-]+\/mcp/.exec(c.req.path)?.[0] ?? (c.req.path === oauth.mcpPath || c.req.path.startsWith(oauth.mcpPath + '/') ? oauth.mcpPath : ''))
   */
  resourceOf?: (c: Context) => string
  /**
   * Whether a valid token fits this request: true lets it in, a sentence refuses it (a 401 `invalid_token` whose
   * metadata points at `resourceOf(c)`). Asked on every request, in-process calls included (an MCP tool calling `/api`
   * with the same bearer). Default: a token with no audience, or one for the origin or `mcpPath`, fits everywhere, and
   * one whose audience is exactly `resourceOf(c)` fits there (RFC 8707's own rule). An in-process `/api` call has lost
   * the path that named its resource, so a path-scoped token works there only through the app's own `accepts`.
   *
   * @example
   * // The path decides at an MCP address; elsewhere the app reads the space an in-process call carries (`spaceOf`).
   * // The whole example: the oauth README's "Audiences (RFC 8707)".
   * accepts: async (caller, c) => {
   *   const root = oauth.rootOf(c)
   *   const here = oauth.resourceOf(c) === root ? (spaceOf(c) ?? root) : oauth.resourceOf(c)
   *   return !caller.resource || caller.resource === root || caller.resource === root + oauth.mcpPath || caller.resource === here || 'This token is for another space.'
   * }
   */
  accepts?: (caller: TokenCaller, c: Context) => Promise<true | string>
  /**
   * The resources the metadata lists (`protected_resources`). Default `[origin, origin + mcpPath]`.
   *
   * @example
   * listResources: (origin) => [origin, `${origin}/mcp`]
   */
  listResources?: (origin: string) => string[]
}

/**
 * An OAuth caller: `client` is its client_id, `grant` the approval its token came from, `name` only for display,
 * `resource` the audience its token was issued for (none on tokens from before audiences).
 */
export type TokenCaller = { kind: 'agent'; name: string; client: string; grant?: string; scopes: string[]; owner: string; resource?: string }
/**
 * What a token is issued for; `grant` is the approval (stored as `family` on refresh rows), `audience` what it is signed
 * for, `resource` the one the client asked for and got (null when the audience was the server's choice).
 */
type Grant = { client: string; name: string; owner: string; scopes: string[]; grant: string; audience?: string; resource?: string | null }

const now = () => Math.floor(Date.now() / 1000)
const token = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`
const newGrant = () => randomBytes(12).toString('base64url')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
const deviceUserCode = () => {
  const letters = Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join('')
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}
/** A typed code as stored: case, dashes and spaces don't matter. */
const userCodeKey = (typed: string) => sha(typed.toUpperCase().replace(/[^A-Z]/g, ''))

/** A fresh ES256 signing key as a private JWK JSON string, for the app's secrets. */
export const generateOAuthKey = async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return JSON.stringify({ ...(await exportJWK(privateKey)), alg: 'ES256' })
}

/**
 * A resource indicator's one stored form (RFC 8707), `origin + path`, or null: not an absolute http(s) URL, a user
 * part, a query, a fragment, an encoded dot, or anything that does not read back as itself once the scheme and host are
 * lower-cased, a default port and one trailing slash dropped (so dot segments fail). Rules after
 * cloudflare/workers-oauth-provider (MIT).
 */
const canonical = (uri: string) => {
  if (!URL.canParse(uri) || /[?#]|%2e/i.test(uri)) return null
  const url = new URL(uri)
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null
  const resource = url.origin + url.pathname.replace(/\/$/, '')
  const [, scheme = '', authority = '', rest = ''] = /^([^:]+):\/\/([^/]*)(.*)$/.exec(uri) ?? []
  const written = `${scheme.toLowerCase()}://${authority.toLowerCase().replace(scheme.toLowerCase() === 'https' ? /:443$/ : /:80$/, '')}${rest}`
  return written === resource || written === `${resource}/` ? resource : null
}

/** A resource's path: what follows its scheme and authority (empty for the origin). Plain string handling, so a resource built on an unparseable forwarded host never throws. */
const pathOf = (resource: string) => resource.replace(/^[a-z][a-z\d+.-]*:\/\/[^/]*/i, '')

const UNSAFE_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'])
/** A ticket nonce: 24 random bytes, base64url. */
const newNonce = () => randomBytes(24).toString('base64url')

/** Redirect URIs a client may register: https anywhere, http only on this machine, or an app's own scheme (`cursor://`). */
const redirectAllowed = (uri: string) => {
  const url = URL.canParse(uri) ? new URL(uri) : null
  if (!url || url.hash || UNSAFE_SCHEMES.has(url.protocol)) return false
  if (url.protocol === 'http:') return LOOPBACK.includes(url.hostname)
  return true
}

const bodyOf = async (c: Context): Promise<Record<string, string>> => {
  const type = c.req.header('content-type') ?? ''
  if (type.includes('application/json')) return ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, string>
  const form = await c.req.parseBody().catch(() => ({}))
  return Object.fromEntries(Object.entries(form).map(([key, value]) => [key, String(value)]))
}

/** Whether a body sent `resource` more than once or not as one string: RFC 8707 allows several, the kit binds one. */
const manyResources = async (c: Context) => {
  const type = c.req.header('content-type') ?? ''
  const body = type.includes('application/json') ? await c.req.json().catch(() => null) : await c.req.parseBody({ all: true }).catch(() => null)
  const resource = (body as Record<string, unknown> | null)?.resource
  return resource !== undefined && typeof resource !== 'string'
}
const ONE_RESOURCE = 'Send one resource: the address the token is for.'

const oauthError = (c: Context, status: 400 | 401 | 403 | 410 | 429, error: string, description: string, extra: Record<string, unknown> = {}) =>
  c.json({ error, error_description: description, ...extra }, status, { 'cache-control': 'no-store' })

export const createOAuth = (config: OAuthConfig) => {
  const { store } = config
  /** The one origin the server answers as, canonical (`oauth.publicOrigin`); undefined when the app pinned none. */
  const publicOrigin = config.publicOrigin === undefined ? undefined : (canonical(config.publicOrigin) ?? '')
  if (publicOrigin !== undefined && (!publicOrigin || pathOf(publicOrigin))) throw new Error(`createOAuth: publicOrigin must be an origin with no path, query or fragment (https://sample.example.test), not ${config.publicOrigin}.`)
  for (const cap of ['maxUnusedClients', 'maxUnusedTickets'] as const) {
    const max = config[cap]
    if (max !== undefined && !(Number.isSafeInteger(max) && max >= 0)) throw new Error(`createOAuth: ${cap} must be a whole number of rows, 0 or more, not ${max}.`)
  }
  const ticketTtl = config.ticketTtl ?? CODE_TTL
  // Never past a week, an unused client's whole life: a ticket can't be approved once its client lapsed
  if (!(Number.isSafeInteger(ticketTtl) && ticketTtl >= 60 && ticketTtl <= UNUSED_CLIENT_TTL)) throw new Error(`createOAuth: ticketTtl must be whole seconds from 60 to a week (604800), not ${config.ticketTtl}.`)
  // Once, at start: the app's own page answers anyone at /oauth/authorize, outside Access
  if (config.approve && (!config.limits || publicOrigin === undefined))
    console.warn('createOAuth: approve lets anyone open /oauth/authorize, but limits or publicOrigin is not set: pass both, or the open endpoints are unbounded per address and their documents follow a forwarded host (oauth README, Open endpoints).')
  /** The issuer's origin: `publicOrigin`, else the request's own. */
  const issuerOf = (c: Context) => publicOrigin ?? originOf(c)
  const jwk = JSON.parse(config.signingKey) as JWK
  // A secret of its own, from the signing key: a refresh token ends in a MAC of its family, generation and nonce, so
  // the server knows an earlier token of a family it keeps no row for, and no one can make one without the key
  const refreshSecret = createHash('sha256').update(`api-kit refresh token\0${jwk.d ?? config.signingKey}`).digest()
  const macOf = (text: string) => createHmac('sha256', refreshSecret).update(text).digest('base64url')
  /** A refresh token: its family, generation and nonce, and their MAC. */
  const refreshTokenOf = (family: string, generation: number, nonce: string) => `rt_${family}.${generation}.${nonce}.${macOf(`${family}.${generation}.${nonce}`)}`
  /**
   * The next generation's token: its nonce a MAC of the token before it, so a retry in the grace gets the one the first
   * answer held, and none can be made without a real token.
   */
  const successorOf = (refresh: string, family: string, generation: number) => refreshTokenOf(family, generation, macOf(`successor\0${refresh}`))
  /** The family and generation a refresh token carries under a valid MAC; null for one from before generations, or a made-up one. */
  const generationOf = (refresh: string) => {
    const [, family, generation, nonce, mac] = /^rt_([\w-]+)\.(\d+)\.([\w-]+)\.([\w-]+)$/.exec(refresh) ?? []
    if (!family || !generation || !nonce || !mac || !same(mac, macOf(`${family}.${generation}.${nonce}`))) return null
    return { family, generation: Number(generation) }
  }
  // 1.29.0 named a successor `rt_` and an HMAC of the token before it, under a secret of its own: a retry this version
  // answers finds the successor 1.29.0 gave first by that name
  const successorSecretOf1290 = createHash('sha256').update(`api-kit refresh successor\0${jwk.d ?? config.signingKey}`).digest()
  /** The successor 1.29.0 gave a refresh token. */
  const successorOf1290 = (refresh: string) => `rt_${createHmac('sha256', successorSecretOf1290).update(refresh).digest('base64url')}`
  const reuseGrace = config.reuseGraceSeconds ?? 0
  const ready = (async () => {
    const privateKey = await importJWK(jwk, 'ES256')
    const { d: _d, ...publicJwk } = jwk
    const kid = await calculateJwkThumbprint(publicJwk)
    const publicKey = await importJWK(publicJwk, 'ES256')
    return { privateKey, publicKey, publicJwk: { ...publicJwk, kid, use: 'sig', alg: 'ES256' }, kid }
  })()

  const sign = async (claims: Record<string, unknown>, ttl: number, origin: string) => {
    const { privateKey, kid } = await ready
    return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid }).setIssuer(origin).setIssuedAt().setExpirationTime(now() + ttl).sign(privateKey)
  }

  const issue = async (origin: string, grant: Grant) => {
    const jti = randomBytes(12).toString('base64url')
    const audience = grant.audience ? { aud: grant.audience } : {}
    const access = await sign({ sub: grant.owner, client_id: grant.client, name: grant.name, grant: grant.grant, scope: grant.scopes.join(' '), jti, ...audience }, ACCESS_TTL, origin)
    await store.put('access', jti, { client: grant.client, grant: grant.grant }, now() + ACCESS_TTL)
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, scope: grant.scopes.join(' ') }
  }

  /** A refresh token in its grant's family: every token rotated from one sign-in shares it, so a replay can revoke them all. The first has a random nonce. */
  const refreshFor = async ({ grant, ...rest }: Grant, refresh = refreshTokenOf(grant, 0, newNonce())) => {
    await store.put('refresh', sha(refresh), { ...rest, family: grant, used: false }, now() + REFRESH_TTL)
    return refresh
  }

  /** A family's row when it has moved past this generation: a later token was issued, so this one was used. */
  const movedPast = async ({ family, generation }: { family: string; generation: number }) => {
    const row = await store.get('refresh-family', family)
    return row && Number(row.generation) > generation ? row : null
  }

  /** How far a family has rotated: its row's generation, 0 when it has none. */
  const generationOfFamily = async (family: string) => Number((await store.get('refresh-family', family))?.generation ?? 0)

  /**
   * Whether a token used at `usedAt` may still be retried: `reuseGraceSeconds` set and not yet over. Strict, like the
   * store's expiry, so a row kept for the grace and the grace end at the same second.
   */
  const withinGrace = (usedAt: number) => reuseGrace > 0 && usedAt > 0 && now() - usedAt < reuseGrace

  /**
   * The successor the first answer to a used refresh token gave: 1.29.0's when 1.29.0 answered (its successor has a
   * row), else this version's, at the generation the used row names or `nextGeneration`.
   */
  const firstSuccessorOf = async (refresh: string, used: Record<string, unknown>, family: string, nextGeneration: number) => {
    const from1290 = successorOf1290(refresh)
    if (await store.get('refresh', sha(from1290))) return from1290
    return successorOf(refresh, family, Number(used.successorGeneration ?? nextGeneration))
  }

  /**
   * What a retry of a used refresh token gets: the successor the first answer gave, while the grace lasts and that
   * successor is unused; null when the token came back as a replay. `nextGeneration` is the token's own next one, or,
   * for a token from before generations, the one it would get now: what a first answer still writing it gave.
   */
  const retriedSuccessor = async (refresh: string, family: string, nextGeneration: number) => {
    // Read again: the first answer writes its successor's generation on this row after marking it used
    const used = await store.get('refresh', sha(refresh))
    if (!used || !withinGrace(Number(used.usedAt ?? 0))) return null
    const successor = await firstSuccessorOf(refresh, used, family, nextGeneration)
    // No row yet is a first answer still writing it, so only a used successor ends the retry
    return (await store.get('refresh', sha(successor)))?.used ? null : successor
  }

  /** The store's own `markUsed`, or a read then a write: safe only one request at a time. */
  const markUsed = (kind: string, id: string, keepUntil?: number) =>
    store.markUsed
      ? store.markUsed(kind, id, keepUntil)
      : store.get(kind, id).then(async (value) => {
          if (!value || value.used) return null
          const marked = { ...value, used: true, usedAt: now() }
          await store.put(kind, id, marked, keepUntil ?? now() + CODE_TTL)
          return marked
        })

  /** The store's own `hold`, or a read then a write: safe only one request at a time. */
  const hold = (kind: string, id: string, expiresAt: number) =>
    store.hold
      ? store.hold(kind, id, expiresAt)
      : store.get(kind, id).then(async (value) => {
          if (!value || value.used) return null
          const held = { ...value, expiresAt, held: true }
          await store.put(kind, id, held, expiresAt)
          return held
        })

  /** The store's own `extend`, or a read then a write: safe only one request at a time. */
  const extend = async (kind: string, id: string, until: number) => {
    if (store.extend) return store.extend(kind, id, until)
    const longest = Math.max(Number((await store.get(kind, id))?.until ?? 0), until)
    await store.put(kind, id, { until: longest }, longest)
    return longest
  }

  /** The store's own `take`, or a read then a delete: safe only one request at a time. */
  const take = async (kind: string, id: string) => {
    if (store.take) return store.take(kind, id)
    const value = await store.get(kind, id)
    if (value) await store.delete(kind, id)
    return value
  }

  const maxClients = config.maxUnusedClients ?? MAX_UNUSED
  const maxTickets = config.maxUnusedTickets ?? MAX_UNUSED
  /**
   * Every kind of row anyone may write without auth, and its cap: registrations under one, codes waiting for a person
   * under the other. `heldBy`: the kind whose live rows hold one of these (`holds`), so it is never evicted under them.
   */
  const CAPS = {
    client: { max: maxClients, heldBy: 'consent' },
    registration: { max: maxClients },
    'claim-token': { max: maxClients, heldBy: 'registration' },
    consent: { max: maxTickets },
    'claim-attempt': { max: maxTickets },
    device: { max: maxTickets },
    'device-user': { max: maxTickets },
  } satisfies Record<string, { max: number; heldBy?: string }>

  /**
   * Writes a row that waits to be used, evicting the oldest unused of its kind past its cap first, so the table stays
   * bounded whoever writes. A client a live consent ticket `holds` is never evicted. Before the write: rows written in
   * the same second tie, and the new one never goes.
   */
  const putUnused = async (kind: keyof typeof CAPS, id: string, value: Record<string, unknown>, expiresAt: number) => {
    const cap: { max: number; heldBy?: string } = CAPS[kind]
    await store.trim?.(kind, Math.max(0, cap.max - 1), cap.heldBy)
    await store.put(kind, id, { ...value, used: false }, expiresAt)
  }

  /** A registration's first sign-in: it lives a year from now. Conditional, so a client revoked meanwhile stays gone. */
  const usedClient = (client: string) => markUsed('client', client, now() + CLIENT_TTL)

  /** Past its limit at this address: the seconds until the window ends; null within it, without `limits`, or for the owner. */
  const overLimit = async (c: Context, policy: keyof typeof LIMITS) => {
    if (!config.limits || (await config.owner(c))) return null
    const { limit, window } = LIMITS[policy]
    const at = Date.now()
    const counted = await config.limits.store.count(`oauth-${policy} ip:${addressOf(c, config.limits.address)}`, window * 1000, at)
    return counted.used > limit ? Math.max(1, Math.ceil((counted.start + window * 1000 - at) / 1000)) : null
  }

  /** Tells the app a grant ended; a throw is logged, never answered: the grant has ended either way. */
  const tellRevoked = async (revoked: SignInRevoked) => {
    try {
      await config.onRevoke?.(revoked)
    } catch (error) {
      console.error(`onRevoke failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Ends one approval at once (its access tokens fail `verify`, its refresh tokens are refused), then tells the app why. */
  const endGrant = async (grant: string, reason: SignInRevoked['reason'], client?: string) => {
    await store.put('revoked-family', grant, { reason }, now() + REVOKED_TTL)
    await tellRevoked({ grant, ...(client === undefined ? {} : { client }), reason })
  }

  /**
   * Whether a grant ended while `onGrant` ran (a replayed code, `revokeGrant`, `revokeClient`). Read after `onGrant`
   * answers, before anything is issued, so no token comes from a dead grant.
   */
  const endedDuringOnGrant = async ({ grant, client }: Grant) => {
    const [grantMarker, clientMarker] = await Promise.all([store.get('revoked-family', grant), store.get('revoked-client', client)])
    return Boolean(grantMarker || clientMarker)
  }

  /**
   * Ends a grant that got no token, as `withdrawn`, and tells the app, so a row it wrote in `onGrant` never outlives it
   * (a no from the app may follow a yes from a hook it chained). Never throws: a store that fails here is logged, and
   * the answer is an error either way.
   */
  const withdrawAfterYes = async ({ grant, client }: Grant) => {
    try {
      await store.put('revoked-family', grant, { reason: 'withdrawn' }, now() + REVOKED_TTL)
    } catch (error) {
      console.error(`withdrawing grant ${grant} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    await tellRevoked({ grant, client, reason: 'withdrawn' })
  }

  /**
   * Ends one approval at once: its access tokens fail `verify`, its refresh tokens are refused; `onRevoke` hears it.
   *
   * @example
   * await oauth.revokeGrant(caller.grant)
   */
  const revokeGrant = (grant: string) => endGrant(grant, 'revoked')

  /** The app this server was mounted on, for its brand. */
  let mounted: object | undefined
  const brandOf = () => config.brand ?? (mounted ? mountedOf(mounted).brand : undefined)

  /**
   * One of the kit's own pages, carrying the app's brand when it has one: head tags, icon, name, accent. Never a client's
   * logo. Its own referrer policy (same-origin) overrides the no-referrer header, so its form POST carries the real
   * `Origin` (never `null`), which the origin rule needs when a browser sends no `Sec-Fetch-Site`.
   */
  const page = (c: Context, title: string, body: string) => {
    const brand = brandOf()
    const accent = brand?.accent && /^#[0-9a-f]{6}$/i.test(brand.accent) ? `:root{--accent:${brand.accent}}button{background:var(--accent);color:#fff}` : ''
    const mark = brand ? `<header style="display:flex;align-items:center;gap:10px;margin:0 0 20px"><img src="/icon.svg" alt="" width="32" height="32"><span>${escape(brand.title)}</span></header>` : ''
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${escape(title)}</title>${brand ? brand.headTags(issuerOf(c)) : ''}
<style>:root{color-scheme:light dark;--bg:#fafaf9;--fg:#111;--muted:#ececeb;--mfg:#6b6b6b}@media(prefers-color-scheme:dark){:root{--bg:#0b0b0b;--fg:#f2f2f2;--muted:#1c1c1c;--mfg:#9a9a9a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{max-width:28rem;width:100%;background:var(--muted);border-radius:12px;padding:28px}h1{font-size:20px;font-weight:400;letter-spacing:-.01em;margin:0 0 8px}p{color:var(--mfg);margin:0 0 16px}
form{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}button,input{font:inherit;border-radius:8px;border:0;padding:10px 16px}button{background:var(--fg);color:var(--bg);cursor:pointer}button.quiet{background:transparent;color:var(--fg);box-shadow:inset 0 0 0 1px var(--mfg)}
input{background:var(--bg);color:var(--fg);letter-spacing:.3em;width:9ch;text-align:center}code{font-size:14px}${accent}</style></head><body><main>${mark}${body}</main></body></html>`
  }

  const mcpPath = config.mcpPath ?? '/mcp'
  /** The root resource: the issuer's origin in canonical form, what a grant gets when no resource it issues for was asked. */
  const rootOf = (c: Context) => publicOrigin ?? canonical(originOf(c)) ?? originOf(c)
  const resourceOf = config.resourceOf ?? ((c: Context) => rootOf(c) + (c.req.path === mcpPath || c.req.path.startsWith(`${mcpPath}/`) ? mcpPath : ''))
  /** Whether this server issues for a canonical resource: the root and MCP always, others when `resources` says so, on this origin only. */
  const issues = (root: string, resource: string) =>
    resource === root || resource === root + mcpPath || (config.resources !== undefined && new URL(resource).origin === root && config.resources(pathOf(resource)))

  /** The audience of a new grant from the resource asked (or none): that resource when issued for, else the root; with `resources` set, an unknown one is refused. */
  const audienceFor = (c: Context, asked: string | undefined): { audience: string; resource: string | null } | { refused: string } => {
    const root = rootOf(c)
    if (asked === undefined) return { audience: root, resource: null }
    const resource = canonical(asked)
    if (resource && issues(root, resource)) return { audience: resource, resource }
    if (config.resources) return { refused: resource ? `This server issues no tokens for ${resource}.` : 'resource must be an absolute http(s) URL with no user, query, fragment or dot segments.' }
    return { audience: root, resource: null }
  }

  /**
   * The audience an approval gives: the ticket's, or the app's choice when the client named no resource it was issued
   * (`decision.resource`), checked as a resource the client asks for. A client that named its resource keeps it.
   */
  const approvedAudience = (c: Context, asked: string | undefined, decided: string | undefined) => {
    const bound = audienceFor(c, asked)
    if ('refused' in bound || decided === undefined) return bound
    const resource = canonical(decided)
    if (!resource || !issues(rootOf(c), resource)) return { refused: `This server issues no tokens for ${decided}.` }
    if (bound.resource !== null && bound.resource !== resource) return { refused: `The client asked for ${bound.resource}, not ${resource}.` }
    return { audience: resource, resource: bound.resource }
  }

  /** A stored row's audience, or nothing for a row from before audiences: it never gains one. */
  const boundOf = (row: Record<string, unknown>) => (typeof row.audience === 'string' ? { audience: row.audience, resource: typeof row.resource === 'string' ? row.resource : null } : {})
  /** A token request naming a resource other than the one its grant asked for (RFC 8707 §2.2); an audience the server chose is never held against it. */
  const otherTarget = (row: Record<string, unknown>, sent: string | undefined) =>
    sent !== undefined && typeof row.audience === 'string' && typeof row.resource === 'string' && canonical(sent) !== row.resource

  const defaultAccepts = async (caller: TokenCaller, c: Context): Promise<true | string> => {
    const root = rootOf(c)
    const here = resourceOf(c)
    if (!caller.resource || caller.resource === root || caller.resource === root + mcpPath || caller.resource === here) return true
    return `This token is for ${caller.resource} only: connect again from ${here} for a token here.`
  }
  const accepts = config.accepts ?? defaultAccepts

  /** The protected-resource metadata URL for a request: the one for the resource it is for (RFC 9728 §3.3). */
  const resourceMetadataFor = (c: Context) => `${issuerOf(c)}/.well-known/oauth-protected-resource${pathOf(resourceOf(c))}`

  /** An access token → its caller, a sentence when `accepts` refuses it here, or null (expired, revoked, or not ours). */
  const verify = async (jwt: string, c: Context): Promise<TokenCaller | { refused: string } | null> => {
    const { publicKey } = await ready
    const origin = issuerOf(c)
    const { payload } = await jwtVerify(jwt, publicKey, { issuer: origin, algorithms: ['ES256'] }).catch(() => ({ payload: null }))
    if (!payload || typeof payload.jti !== 'string' || typeof payload.client_id !== 'string') return null
    // Tokens from before grants carry none: they run to their hour, known by their client
    const grant = typeof payload.grant === 'string' ? payload.grant : undefined
    // One round trip: the issued row and both revocation markers at once
    const [issued, revokedClient, revokedGrant] = await Promise.all([store.get('access', payload.jti), store.get('revoked-client', payload.client_id), grant ? store.get('revoked-family', grant) : null])
    if (!issued || revokedClient || revokedGrant) return null
    // Tokens from before audiences carry none
    const resource = typeof payload.aud === 'string' ? { resource: payload.aud } : {}
    const caller: TokenCaller = { kind: 'agent', name: String(payload.name ?? payload.client_id), client: payload.client_id, ...(grant ? { grant } : {}), scopes: String(payload.scope ?? '').split(' ').filter(Boolean), owner: String(payload.sub), ...resource }
    const judged = await accepts(caller, c)
    return judged === true ? caller : { refused: judged }
  }

  const authorizationServer = (origin: string) => ({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    jwks_uri: `${origin}/.well-known/jwks.json`,
    scopes_supported: [...SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    device_authorization_endpoint: `${origin}/oauth/device_authorization`,
    grant_types_supported: ['authorization_code', 'refresh_token', DEVICE_GRANT, JWT_BEARER, CLAIM_GRANT],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/llms.txt`,
    // Restated from the protected-resource metadata, as auth.md does
    resource: origin,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    // Personal Agent Protocol (3.2): the resources this issuer speaks for, and the domains it confirms
    protected_resources: config.listResources?.(origin) ?? [origin, `${origin}${mcpPath}`],
    poppy_domains: [new URL(origin).hostname],
    agent_auth: {
      skill: `${origin}/auth.md`,
      register_uri: `${origin}/agent/identity`,
      identity_endpoint: `${origin}/agent/identity`,
      claim_uri: `${origin}/agent/identity/claim`,
      claim_endpoint: `${origin}/agent/identity/claim`,
      identity_types_supported: ['anonymous', 'service_auth'],
      anonymous: { credential_types_supported: ['identity_assertion'], claim_uri: `${origin}/agent/identity/claim`, pre_claim_scopes: [], post_claim_scopes: [...SCOPES] },
      service_auth: { credential_types_supported: ['identity_assertion'], claim_uri: `${origin}/agent/identity/claim`, post_claim_scopes: [...SCOPES] },
    },
    ...config.metadata,
  })

  const protectedResource = (origin: string, suffix: string) => ({
    resource: `${origin}${suffix}`,
    resource_name: config.name,
    authorization_servers: [origin],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_documentation: `${origin}/llms.txt`,
  })

  const authMd = (origin: string) => `# ${config.name} auth.md

You are an agent. ${config.name} lets you register and get an access token, but **nothing is granted until its owner
approves you** on a page behind their sign-in. There are three ways; pick the one your client supports.

## A. OAuth with the owner in the browser (MCP clients, apps)

1. Call any API route without a token. The 401 carries
   \`WWW-Authenticate: Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"\` (\`${mcpPath}\` adds \`${mcpPath}\`).
2. Read that document, then \`${origin}/.well-known/oauth-authorization-server\`.
3. Register: \`POST ${origin}/oauth/register\` with \`{"client_name": "…", "redirect_uris": ["https://…/callback"]}\`
   (RFC 7591, public client, no secret). Keep the \`client_id\`.
4. Send the owner to \`${origin}/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&scope=read%20write\`.
   They sign in and approve. Add \`&resource=<the URL you will call>\` (RFC 8707, e.g. \`${origin}${mcpPath}\`) to bind the token to it.
5. Exchange the code: \`POST ${origin}/oauth/token\` with \`grant_type=authorization_code&code=…&redirect_uri=…&client_id=…&code_verifier=…\`.
   You get an access token (one hour) and a refresh token (\`grant_type=refresh_token\`, rotated on each use).

## B. Agent registration (auth.md profile)

1. Register: \`POST ${origin}/agent/identity\` with \`{"type": "anonymous"}\`, or \`{"type": "service_auth", "login_hint": "<owner email>"}\`.
   Keep the \`claim_token\`; it is returned once. An anonymous registration has no scopes yet.
2. Ask for a claim (anonymous only): \`POST ${origin}/agent/identity/claim\` with \`{"claim_token": "…", "email": "<owner email>"}\`.
   Only ${config.owners?.length ? 'the owner' : 'a person who can sign in to this site'} can complete it.
3. Give the owner the \`verification_uri\` and the 6-digit \`user_code\` in one message. They sign in and type the code.
4. Poll \`POST ${origin}/oauth/token\` with \`grant_type=${CLAIM_GRANT}&claim_token=…\` every \`interval\` seconds
   (\`authorization_pending\` until they do). Success returns an access token, a \`refresh_token\` and an \`identity_assertion\`.
5. When the access token expires, refresh it: \`grant_type=refresh_token&refresh_token=…\` (30 days, a new one each
   time: keep only the newest; sending a used one again revokes them all). Within a day of the claim, the assertion
   works too, until the sign-in is revoked: \`grant_type=${JWT_BEARER}&assertion=…\`.

## C. A device or CLI without a browser (RFC 8628)

1. Register once: \`POST ${origin}/oauth/register\` with \`{"client_name": "…", "grant_types": ["${DEVICE_GRANT}"]}\`
   (no redirect_uris needed). Keep the \`client_id\`.
2. \`POST ${origin}/oauth/device_authorization\` with \`client_id=…&scope=read%20write\`. You get a \`device_code\`
   (keep it to yourself), a \`user_code\` like \`BDKM-QXTW\`, the \`verification_uri\` and an \`interval\`.
3. Show the owner the \`verification_uri\` and the \`user_code\` (or the \`verification_uri_complete\`). They sign
   in, type it and approve.
4. Poll \`POST ${origin}/oauth/token\` with \`grant_type=${DEVICE_GRANT}&device_code=…&client_id=…\` every
   \`interval\` seconds. Success returns an access token and a \`refresh_token\`.

## Using the token

\`Authorization: Bearer <access_token>\` on \`/api\` and \`/mcp\`. Scopes: \`read\` (everything you can GET) and \`write\`
(saved items and other changes). Revoke with \`POST ${origin}/oauth/revoke\` and \`token=…\`. What to call next: ${origin}/llms.txt.

| Error | Means |
|---|---|
| \`authorization_pending\` | the owner hasn't approved yet; keep polling at \`interval\` |
| \`slow_down\` | you polled faster than \`interval\`; wait the new \`interval\` (5 seconds more) from now on |
| \`expired_token\` | the 10-minute code window passed; ask for a new claim or device code |
| \`invalid_grant\` | the code, refresh token, assertion or claim token is used, expired or revoked; start again (a code or a refresh token sent twice revokes its whole sign-in) |
| \`access_denied\` | the owner said no |
`

  /** Whether a sign-in request can go on, and its client and scopes; `redirect` marks an error the client may hear at its redirect. */
  const authorizeParams = async (c: Context, params: Record<string, string>) => {
    const client = params.client_id ? await store.get('client', params.client_id) : null
    if (!client) return { error: 'This app is not registered here, or its registration expired. Remove this connection in your app and add it again.' }
    if (!(client.redirectUris as string[]).includes(params.redirect_uri ?? '')) return { error: 'The redirect_uri is not one this client registered.' }
    if (params.response_type !== 'code') return { error: 'Only response_type=code is supported.', redirect: true }
    if (!params.code_challenge || params.code_challenge_method !== 'S256') return { error: 'PKCE is required: code_challenge with code_challenge_method=S256.', redirect: true }
    const scopes = (params.scope || SCOPES.join(' ')).split(' ').filter((scope) => (SCOPES as readonly string[]).includes(scope))
    return { client, scopes }
  }
  type Checked = { client: Record<string, unknown>; scopes: string[] }

  const backTo = (redirectUri: string, origin: string, query: Record<string, string | undefined>) => {
    const url = new URL(redirectUri)
    for (const [key, value] of Object.entries({ ...query, iss: origin })) if (value !== undefined) url.searchParams.set(key, value)
    return url.toString()
  }

  const signInFirst = (c: Context) => c.html(page(c, 'Sign in first', '<h1>Sign in first</h1><p>Approving an agent needs you signed in to this site. Open it in your browser, sign in, then try again.</p>'), 401)
  const cantApprove = (c: Context, why: string) => c.html(page(c, 'Can’t approve this', `<h1>Can’t approve this request</h1><p>${escape(why)}</p>`), 400)
  const notAllowed = (c: Context) => c.html(page(c, 'Not allowed', '<h1>Not allowed</h1><p>Approve from the page this site showed you, signed in, in the browser that opened it.</p>'), 403)
  const expired = (c: Context) => c.html(page(c, 'Expired', '<h1>This approval expired</h1><p>Start again from the app that asked.</p>'), 400)
  /** A ticket this browser answered already (a double click, a tab brought back): no new code, no redirect. */
  const answered = (c: Context, outcome: unknown) =>
    c.html(
      outcome === 'approved'
        ? page(c, 'Already approved', '<h1>Already approved</h1><p>This sign-in went through already. Return to the app that asked; you can close this page.</p>')
        : page(c, 'Already answered', `<h1>Already answered</h1><p>${outcome === 'denied' ? 'You said no to this sign-in already.' : 'This sign-in was answered already.'} You can close this page.</p>`),
      400,
    )

  /** The kit's own consent page: who asks, for what, as whom, and where it returns. */
  const consentPage = (c: Context, ticket: string, checked: Checked, owner: string, audience: string, redirectUri: string) => {
    const what = checked.scopes.includes('write') ? 'read everything and make changes' : 'read everything'
    const path = pathOf(audience)
    const asked = path ? `<code>${escape(config.name)}: ${escape(path)}</code>` : `all of ${escape(config.name)}`
    const back = returnOf(redirectUri)
    const returns = back.onThisComputer ? `an app on this computer (<code>${escape(back.host)}</code>)` : `<code>${escape(back.host)}</code>`
    return c.html(page(c, `Allow ${checked.client.name}?`, `<h1>Allow <strong>${escape(String(checked.client.name))}</strong> to use ${escape(config.name)}?</h1>
<p>It asks for ${asked}. It will be able to ${what} as you (${escape(owner)}), until you revoke it. It sends you back to ${returns}.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="ticket" value="${ticket}"><button name="decision" value="allow">Allow</button><button class="quiet" name="decision" value="deny">Deny</button></form>`))
  }

  type Consent = { params: Record<string, string>; nonce: string; arrival: SignInAsk['arrival']; expiresAt: number; owner?: string }
  /** `bound`: the ticket's audience, and the resource the client named and got (null when the server chose the root). */
  const askOf = (ticket: string, row: Consent, checked: Checked, bound: { audience: string; resource: string | null }): SignInAsk => {
    const { params } = row
    const back = returnOf(params.redirect_uri!)
    return {
      ticket,
      client: { id: params.client_id!, name: String(checked.client.name), redirectUris: checked.client.redirectUris as string[] },
      redirectUri: params.redirect_uri!,
      redirectHost: back.host,
      onThisComputer: back.onThisComputer,
      scopes: checked.scopes,
      resource: bound.audience,
      named: bound.resource !== null,
      expiresAt: row.expiresAt,
      ...(params.state === undefined ? {} : { state: params.state }),
      arrival: row.arrival,
    }
  }

  /** The ticket as this browser holds it: live and its own, spent here already, another browser's, or gone (expired, unknown, from before tickets were bound). */
  type TicketInBrowser = { gone: true } | { answered: unknown } | { foreign: true } | { row: Consent }
  const consentOf = async (c: Context, ticket: string): Promise<TicketInBrowser> => {
    const row = ticket ? await store.get('consent', ticket) : null
    if (!row || typeof row.nonce !== 'string') return { gone: true }
    const nonce = nonceOf(c, issuerOf(c))
    const mine = nonce !== null && same(sha(nonce), row.nonce)
    if (row.used) return mine ? { answered: row.answer } : { gone: true }
    if (typeof row.params !== 'object') return { gone: true }
    if (!mine) return { foreign: true }
    return { row: row as Consent }
  }

  /**
   * Answers a ticket once, from the browser that opened it, same-origin: a 302 to the client with `code` (or
   * `access_denied`), or a page. The ticket is marked used and kept, hashes only, until it would have expired, so the
   * same browser posting it again hears it went through. `owner` (the kit's page) must be the one it was shown to.
   */
  const answer = async (c: Context, ticket: string, decision: SignInDecision, owner?: string) => {
    if (!sameOrigin(c, rootOf(c))) return notAllowed(c)
    const found = await consentOf(c, ticket)
    if ('gone' in found) return expired(c)
    if ('answered' in found) return answered(c, found.answered)
    if ('foreign' in found || (owner !== undefined && found.row.owner !== owner)) return notAllowed(c)
    const { params, expiresAt, nonce } = found.row
    const origin = issuerOf(c)
    let approved: { checked: Checked; scopes: string[]; audience: Pick<Grant, 'audience' | 'resource'> } | undefined
    if (decision !== 'deny') {
      // Before the ticket is spent: a blank approver would mint a token with no owner
      if (typeof decision.approver !== 'string' || !decision.approver.trim()) return cantApprove(c, 'An approval needs an approver: the person it is for.')
      const checked = await authorizeParams(c, params)
      if ('error' in checked) return cantApprove(c, checked.error!)
      // Resolved again from the ticket's own request: the ticket's audience, or the app's where the client named none
      const bound = approvedAudience(c, params.resource, decision.resource)
      if ('refused' in bound) return cantApprove(c, `${bound.refused} (invalid_target)`)
      // Only the app's own list is checked: without one, the request's scopes go through as they did before approvals, even none
      const scopes = decision.scopes ?? checked.scopes
      if (decision.scopes && (!scopes.length || scopes.some((scope) => !checked.scopes.includes(scope)))) return cantApprove(c, `An approval may only narrow the scopes asked for (${checked.scopes.join(' ')}).`)
      approved = { checked, scopes, audience: bound }
    }
    // Single use: a double-clicked Allow makes one code, never two grants
    if (!(await markUsed('consent', ticket, expiresAt))) {
      const late = await consentOf(c, ticket)
      return 'answered' in late ? answered(c, late.answered) : expired(c)
    }
    await store.put('consent', ticket, { nonce, used: true, answer: approved ? 'approved' : 'denied', expiresAt }, expiresAt)
    if (decision === 'deny' || !approved) return c.redirect(backTo(params.redirect_uri!, origin, { error: 'access_denied', error_description: owner === undefined ? 'The sign-in was refused.' : 'The owner said no.', state: params.state }), 302)
    // The grant is saved before the code exists: everything onGrant hears is on the code's row
    const code = token('code')
    await store.put('code', sha(code), { client: params.client_id, redirectUri: params.redirect_uri, challenge: params.code_challenge, scopes: approved.scopes, owner: decision.approver, name: approved.checked.client.name, ...approved.audience, grant: newGrant(), used: false, ...(decision.data ? { data: decision.data } : {}) }, now() + CODE_TTL)
    return c.redirect(backTo(params.redirect_uri!, origin, { code, state: params.state }), 302)
  }

  /** When the latest ticket held in the browser with this nonce ends (epoch seconds); 0 when none was held. */
  const heldUntilOf = async (nonce: string) => Number((await store.get('held-nonce', sha(nonce)))?.until ?? 0)
  /** The nonce cookie's life: a page's, or longer while a ticket this browser opened is held, so no page cuts it short. */
  const cookieLife = (heldUntil: number) => Math.max(ticketTtl, heldUntil - now())

  /**
   * Holds a ticket for a decision made later (an ask to join the owner answers in hours): it lives `seconds` from now
   * (whole, 60 to a week), is never evicted by newer tickets, and keeps its client held as long. Only the browser that
   * opened it may hold it; null when it expired, was answered, or this browser did not open it. Holding again moves
   * the expiry again. Returns the new expiry and the `Set-Cookie` line that keeps the nonce cookie at least as long: the
   * app's page appends it. Held tickets are outside `maxUnusedTickets`: the app bounds how many it holds.
   *
   * @example
   * const held = await oauth.holdTicket(c, ticket, 24 * 3600)
   * if (!held) return c.html(expiredPage, 400)
   * return c.html(waitingPage(ticket), 200, { 'set-cookie': held.cookie })
   */
  const holdTicket = async (c: Context, ticket: string, seconds: number): Promise<{ expiresAt: number; cookie: string } | null> => {
    if (!(Number.isSafeInteger(seconds) && seconds >= 60 && seconds <= UNUSED_CLIENT_TTL)) throw new Error(`holdTicket: seconds must be whole seconds from 60 to a week (604800), not ${seconds}.`)
    const nonce = nonceOf(c, issuerOf(c))
    const found = await consentOf(c, ticket)
    if (!nonce || !('row' in found)) return null
    const expiresAt = now() + seconds
    // Conditional: a hold racing `complete` never reopens a spent ticket
    if (!(await hold('consent', ticket, expiresAt))) return null
    // Conditional too: two holds in this browser at once leave the longer on the row
    const heldUntil = await extend('held-nonce', sha(nonce), expiresAt)
    return { expiresAt, cookie: ticketCookie(c, nonce, cookieLife(heldUntil), issuerOf(c)) }
  }

  /**
   * The sign-in a ticket holds, for the app's own POST route: null when it expired, was answered, or this browser did
   * not open it.
   *
   * @example
   * const ask = await oauth.ticketOf(c, String(body.ticket))
   * if (!ask) return c.html(expiredPage, 400)
   */
  const ticketOf = async (c: Context, ticket: string): Promise<SignInAsk | null> => {
    const found = await consentOf(c, ticket)
    if (!('row' in found)) return null
    const checked = await authorizeParams(c, found.row.params)
    const bound = audienceFor(c, found.row.params.resource)
    return 'error' in checked || 'refused' in bound ? null : askOf(ticket, found.row, checked, bound)
  }

  /**
   * How this browser answered a ticket it spent already (a double click, a tab brought back), for the app's route when
   * `ticketOf` is null: `approved`, `denied`, `answered` (spent, its answer not yet written), or null when it expired,
   * is live, or another browser opened it.
   *
   * @example
   * if (!ask) return c.html((await oauth.answeredOf(c, ticket)) === 'approved' ? alreadyApprovedPage : expiredPage, 400)
   */
  const answeredOf = async (c: Context, ticket: string): Promise<'approved' | 'denied' | 'answered' | null> => {
    const found = await consentOf(c, ticket)
    if (!('answered' in found)) return null
    return found.answered === 'approved' || found.answered === 'denied' ? found.answered : 'answered'
  }

  /**
   * Answers a ticket from the app's own page: the grant follows only a same-origin POST from the browser that opened it,
   * once. `approver` becomes the token's `sub`, `scopes` may only narrow, `data` reaches `onGrant`; `resource` binds the
   * grant to one this server issues for when the client named none (an invite's space), else the ticket's stays.
   * Returns the 302 to the client (`code`, `state`, `iss`, or `access_denied`), or a 400/403 page.
   *
   * @example
   * return oauth.complete(c, ask.ticket, { approver: 'owner@example.test', scopes: ['read'], data: { invite }, resource: `${oauth.rootOf(c)}/s/alpha/mcp` })
   */
  const complete = (c: Context, ticket: string, decision: SignInDecision) => answer(c, ticket, decision)

  const mount = (app: Hono<any, any, any>) => {
    mounted = app
    if (config.limits) {
      const tooMany = (c: Context, retry: number) =>
        c.json({ error: 'too_many_requests', error_description: `Too many requests from this address: try again in ${retry} seconds.` }, 429, { 'cache-control': 'no-store', 'retry-after': String(retry) })
      /** Counts a call before its route runs. */
      const limited = (policy: keyof typeof LIMITS) => async (c: Context, next: () => Promise<void>) => {
        const retry = await overLimit(c, policy)
        return retry ? tooMany(c, retry) : next()
      }
      app.post('/oauth/register', limited('register'))
      app.post('/agent/identity', limited('register'))
      app.post('/agent/identity/claim', limited('register'))
      app.post('/oauth/device_authorization', limited('device'))
      app.get('/oauth/authorize', async (c, next) => {
        const retry = await overLimit(c, 'authorize')
        if (!retry) return next()
        return c.html(page(c, 'Too many sign-ins', '<h1>Too many sign-ins from here</h1><p>Wait a minute, then start again from the app.</p>'), 429, { 'retry-after': String(retry) })
      })
      // Misses only, counted after the lookup: a right code or token is never turned away by other people's junk
      app.post('/oauth/token', async (c, next) => {
        await next()
        if (c.res.status !== 400) return
        const { error } = (await c.res.clone().json().catch(() => ({}))) as { error?: string }
        if (error !== 'invalid_grant' && error !== 'invalid_client') return
        const retry = await overLimit(c, 'token')
        if (retry) c.res = tooMany(c, retry)
      })
    }
    // A document that names the origin is cached publicly only when the origin is fixed: a forged host must not reach a shared cache
    const named = publicOrigin ? 'public, max-age=300' : 'no-store'
    const json = (c: Context, body: unknown, cache = named) => c.body(JSON.stringify(body, null, 2), 200, { 'content-type': 'application/json', 'cache-control': cache, 'access-control-allow-origin': '*' })

    app.get('/.well-known/oauth-authorization-server', (c) => json(c, authorizationServer(issuerOf(c))))
    app.get('/.well-known/oauth-authorization-server/*', (c) => json(c, authorizationServer(issuerOf(c))))
    app.get('/.well-known/oauth-protected-resource', (c) => json(c, protectedResource(issuerOf(c), '')))
    app.get('/.well-known/oauth-protected-resource/*', (c) => {
      const suffix = c.req.path.slice('/.well-known/oauth-protected-resource'.length)
      // With resources, never metadata for a resource no token can be granted for: it would start a flow that fails
      if (config.resources) {
        const resource = canonical(rootOf(c) + suffix)
        if (!resource || !issues(rootOf(c), resource)) return c.notFound()
      }
      return json(c, protectedResource(issuerOf(c), suffix))
    })
    app.get('/.well-known/jwks.json', async (c) => json(c, { keys: [(await ready).publicJwk] }, 'public, max-age=300'))
    app.get('/auth.md', (c) => c.body(authMd(issuerOf(c)), 200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': named }))

    // RFC 7591: a public client registers itself; registering grants nothing until the owner approves a request
    app.post('/oauth/register', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { redirect_uris?: unknown; client_name?: unknown; grant_types?: unknown; token_endpoint_auth_method?: unknown }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : []
      // A device client has no browser to come back to: it may register without redirect_uris
      const device = Array.isArray(body.grant_types) && body.grant_types.includes(DEVICE_GRANT)
      if (uris.length ? !uris.every(redirectAllowed) : !device)
        return oauthError(c, 400, 'invalid_redirect_uri', `Send redirect_uris: https URLs, or http on localhost for apps on this machine. A device without a browser sends grant_types: ["${DEVICE_GRANT}"] instead.`)
      const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'An unnamed client'
      const clientId = token('client')
      const issuedAt = now()
      // Unused until a sign-in collects its first token: a week's life, and a place under the cap
      await putUnused('client', clientId, { name, redirectUris: uris }, issuedAt + UNUSED_CLIENT_TTL)
      const grantTypes = [...(uris.length ? ['authorization_code'] : []), 'refresh_token', ...(device ? [DEVICE_GRANT] : [])]
      return c.json({ client_id: clientId, client_id_issued_at: issuedAt, client_name: name, redirect_uris: uris, grant_types: grantTypes, response_types: uris.length ? ['code'] : [], token_endpoint_auth_method: 'none' }, 201, { 'cache-control': 'no-store' })
    })

    // The sign-in page: the app's (`approve`) or the kit's own, behind the single sign-on, where the owner check runs too
    app.get('/oauth/authorize', async (c) => {
      const params = c.req.query()
      // With approve, the app decides who signs in: the owner is asked only if it shows no page of its own
      const owner = config.approve ? null : await config.owner(c)
      if (!config.approve && !owner) return signInFirst(c)
      const checked = await authorizeParams(c, params)
      if ('error' in checked) {
        // Never a redirect before a person acts when the app approves; today's redirect otherwise
        if (!config.approve && checked.redirect && params.redirect_uri) return c.redirect(backTo(params.redirect_uri, issuerOf(c), { error: 'invalid_request', error_description: checked.error, state: params.state }), 302)
        return cantApprove(c, checked.error!)
      }
      // A page, never a redirect: the resource is checked before anything is written
      if ((c.req.queries('resource')?.length ?? 0) > 1) return cantApprove(c, ONE_RESOURCE)
      const bound = audienceFor(c, params.resource)
      if ('refused' in bound) return cantApprove(c, `${bound.refused} (invalid_target)`)
      // One nonce binds every ticket this browser opens: reused while it lives, its life renewed, never below a held ticket's
      const reused = nonceOf(c, issuerOf(c))
      const nonce = reused ?? newNonce()
      const ticket = token('consent')
      const expiresAt = now() + ticketTtl
      // It holds its client while it lives: a flood of registrations never evicts a client a person is about to approve
      const row = { params, nonce: sha(nonce), arrival: arrivalOf(c), expiresAt, holds: params.client_id }
      const bindTo = async (page: Response) => {
        const bound = new Response(page.body, page)
        const life = reused ? cookieLife(await heldUntilOf(reused)) : ticketTtl
        bound.headers.append('set-cookie', ticketCookie(c, nonce, life, issuerOf(c)))
        return bound
      }
      if (config.approve) {
        // Stored only once a page holds the ticket: a stranger turned away leaves no row behind
        const own = await config.approve(c, askOf(ticket, row, checked, bound))
        if (own) {
          await putUnused('consent', ticket, row, expiresAt)
          return bindTo(own)
        }
        const person = await config.owner(c)
        if (!person) return signInFirst(c)
        await putUnused('consent', ticket, { ...row, owner: person }, expiresAt)
        return bindTo(consentPage(c, ticket, checked, person, bound.audience, params.redirect_uri!))
      }
      await putUnused('consent', ticket, { ...row, owner }, expiresAt)
      return bindTo(consentPage(c, ticket, checked, owner!, bound.audience, params.redirect_uri!))
    })

    app.post('/oauth/authorize', async (c) => {
      if (!sameOrigin(c, rootOf(c))) return notAllowed(c)
      const owner = await config.owner(c)
      if (!owner) return notAllowed(c)
      const body = await bodyOf(c)
      // Only a ticket the kit's own page showed this owner: one the app's page holds is the app's to complete
      return answer(c, body.ticket ?? '', body.decision === 'allow' ? { approver: owner } : 'deny', owner)
    })

    // auth.md registration: anonymous or bound to an email, claimed by a person typing the code
    app.post('/agent/identity', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { type?: string; login_hint?: string; client_name?: string }
      if (body.type === 'identity_assertion') return oauthError(c, 400, 'issuer_not_enabled', 'Identity assertions (ID-JAG) are not accepted here: register as anonymous or service_auth.')
      if (body.type !== 'anonymous' && body.type !== 'service_auth') return oauthError(c, 400, 'invalid_request', 'Send {"type": "anonymous"} or {"type": "service_auth", "login_hint": "<email>"}.')
      if (body.type === 'service_auth' && !body.login_hint) return oauthError(c, 400, 'invalid_request', 'service_auth needs login_hint: the owner’s email.')
      const origin = issuerOf(c)
      const registrationId = token('reg')
      const claimToken = token('clm')
      const expires = now() + REGISTRATION_TTL
      const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : `Agent ${registrationId.slice(4, 10)}`
      // Its grant from the start, so approvals racing for it can't write two; it names no resource, so it gets the root
      // It holds its claim token: an agent its owner approved can always collect
      await putUnused('registration', registrationId, { name, type: body.type, claimed: false, email: body.login_hint ?? null, family: newGrant(), audience: rootOf(c), resource: null, holds: sha(claimToken) }, expires)
      await putUnused('claim-token', sha(claimToken), { registration: registrationId }, expires)
      const assertion = await sign({ sub: registrationId, typ: 'agent_identity' }, REGISTRATION_TTL, origin)
      const base = { registration_id: registrationId, registration_type: body.type, claim_url: `${origin}/agent/identity/claim`, claim_token: claimToken, claim_token_expires: new Date(expires * 1000).toISOString(), post_claim_scopes: [...SCOPES] }
      if (body.type === 'anonymous') return c.json({ ...base, identity_assertion: assertion, assertion_expires: new Date(expires * 1000).toISOString(), pre_claim_scopes: [] }, 200, { 'cache-control': 'no-store' })
      return c.json({ ...base, claim: await startClaim(origin, registrationId, body.login_hint!) }, 200, { 'cache-control': 'no-store' })
    })

    const startClaim = async (origin: string, registrationId: string, email: string) => {
      const userCode = String(randomInt(0, 1_000_000)).padStart(6, '0')
      const attempt = token('cla')
      await putUnused('claim-attempt', sha(attempt), { registration: registrationId, email: email.toLowerCase(), code: sha(userCode), tries: 0 }, now() + CLAIM_TTL)
      return { user_code: userCode, expires_in: CLAIM_TTL, verification_uri: `${origin}/oauth/claim?claim_attempt_token=${attempt}`, interval: 5 }
    }

    app.post('/agent/identity/claim', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { claim_token?: string; email?: string }
      const held = body.claim_token ? await store.get('claim-token', sha(body.claim_token)) : null
      if (!held) return oauthError(c, 400, 'invalid_claim_token', 'This claim_token is wrong or expired: register again.')
      const registration = await store.get('registration', String(held.registration))
      if (!registration) return oauthError(c, 410, 'claim_expired', 'The registration expired before it was claimed: register again.')
      if (registration.claimed) return oauthError(c, 400, 'claimed_or_in_flight', 'This registration is already claimed: poll the token endpoint.')
      const email = (body.email ?? String(registration.email ?? '')).toLowerCase()
      if (!email) return oauthError(c, 400, 'invalid_request', 'Send email: the address of the person who will approve you.')
      if (config.owners?.length && !config.owners.map((one) => one.toLowerCase()).includes(email)) return oauthError(c, 403, 'access_denied', 'Only the owner of this service can claim an agent.')
      const attempt = await startClaim(issuerOf(c), String(held.registration), email)
      return c.json({ registration_id: held.registration, status: 'initiated', expires_at: new Date((now() + CLAIM_TTL) * 1000).toISOString(), claim_attempt: attempt }, 200, { 'cache-control': 'no-store' })
    })

    // The claim page: behind the single sign-on; the signed-in person must be the one the claim names
    app.get('/oauth/claim', async (c) => {
      const owner = await config.owner(c)
      if (!owner) return c.html(page(c, 'Sign in first', '<h1>Sign in first</h1><p>Open this link in the browser where you are signed in to this site.</p>'), 401)
      const attemptToken = c.req.query('claim_attempt_token') ?? ''
      const attempt = await store.get('claim-attempt', sha(attemptToken))
      if (!attempt) return c.html(page(c, 'Expired', '<h1>This code expired</h1><p>Ask the agent for a new one.</p>'), 410)
      const registration = await store.get('registration', String(attempt.registration))
      return c.html(page(c, 'Approve an agent', `<h1>Approve <strong>${escape(String(registration?.name ?? 'an agent'))}</strong>?</h1>
<p>You are signed in as ${escape(owner)}. Type the 6-digit code the agent gave you to let it read and change ${escape(config.name)} as you.</p>
<form method="post" action="/oauth/claim"><input type="hidden" name="claim_attempt_token" value="${escape(attemptToken)}"><input name="user_code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required aria-label="Code"><button>Approve</button></form>`))
    })

    app.post('/oauth/claim', async (c) => {
      if (!sameOrigin(c, rootOf(c))) return notAllowed(c)
      const owner = await config.owner(c)
      if (!owner) return notAllowed(c)
      const body = await bodyOf(c)
      const key = sha(body.claim_attempt_token ?? '')
      const attempt = await store.get('claim-attempt', key)
      if (!attempt) return c.html(page(c, 'Expired', '<h1>This code expired</h1><p>Ask the agent for a new one.</p>'), 410)
      if (String(attempt.email) !== owner.toLowerCase()) return c.html(page(c, 'Not yours', `<h1>This claim names someone else</h1><p>Sign in as the person the agent asked for.</p>`), 403)
      if (!same(sha(body.user_code ?? ''), String(attempt.code))) {
        const tries = Number(attempt.tries) + 1
        if (tries >= 5) await store.delete('claim-attempt', key)
        else await store.put('claim-attempt', key, { ...attempt, tries }, now() + CLAIM_TTL)
        return c.html(page(c, 'Wrong code', `<h1>That code doesn’t match</h1><p>${tries >= 5 ? 'Too many tries: ask the agent for a new code.' : 'Check the code the agent gave you and try again.'}</p>`), 400)
      }
      // Single use: the same form posted twice at once (a double-click) approves once; the other finds the code spent
      if (!(await take('claim-attempt', key))) return c.html(page(c, 'Expired', '<h1>This code expired</h1><p>Ask the agent for a new one.</p>'), 410)
      const registration = await store.get('registration', String(attempt.registration))
      if (!registration) return c.html(page(c, 'Expired', '<h1>This registration expired</h1>'), 410)
      // One approval per registration: a second would give its jwt-bearer tokens a grant its claim and refresh tokens lack
      if (registration.claimed) return c.html(page(c, 'Already approved', `<h1>Already approved</h1><p>${escape(String(registration.name))} was approved already; this code is spent. You can close this page.</p>`), 409)
      // One grant for the claim: its claim, refresh and jwt-bearer tokens all carry it (made at registration; older rows get one here)
      // The audience came with the grant at registration: one registered before audiences stays without
      // Claimed, it is in use: no cap evicts it while its agent's tokens need it
      await store.put('registration', String(attempt.registration), { ...registration, claimed: true, owner, family: registration.family ?? newGrant(), used: true }, now() + REGISTRATION_TTL)
      return c.html(page(c, 'Approved', `<h1>Approved</h1><p>${escape(String(registration.name))} can now use ${escape(config.name)}. You can close this page.</p>`))
    })

    // RFC 8628: a device without a browser gets a code for the owner to type, then polls the token endpoint
    app.post('/oauth/device_authorization', async (c) => {
      const body = await bodyOf(c)
      const client = body.client_id ? await store.get('client', body.client_id) : null
      if (!client) return oauthError(c, 401, 'invalid_client', 'This client is not registered here (or its registration expired). Register at /oauth/register first.')
      const scopes = (body.scope || SCOPES.join(' ')).split(' ').filter((scope) => (SCOPES as readonly string[]).includes(scope))
      if (!scopes.length) return oauthError(c, 400, 'invalid_scope', `Ask for any of: ${SCOPES.join(', ')}.`)
      if (await manyResources(c)) return oauthError(c, 400, 'invalid_target', ONE_RESOURCE)
      const bound = audienceFor(c, body.resource)
      if ('refused' in bound) return oauthError(c, 400, 'invalid_target', bound.refused)
      const origin = issuerOf(c)
      const deviceCode = token('dc')
      let userCode = deviceUserCode()
      while (await store.get('device-user', userCodeKey(userCode))) userCode = deviceUserCode()
      const expiresAt = now() + DEVICE_TTL
      // Kept a window past its expiry, so a late poll hears expired_token rather than an unknown code
      await putUnused('device', sha(deviceCode), { client: body.client_id!, name: String(client.name), scopes, ...bound, expiresAt, interval: DEVICE_INTERVAL, polledAt: 0 }, expiresAt + DEVICE_TTL)
      await putUnused('device-user', userCodeKey(userCode), { device: sha(deviceCode) }, expiresAt)
      return c.json(
        { device_code: deviceCode, user_code: userCode, verification_uri: `${origin}/oauth/device`, verification_uri_complete: `${origin}/oauth/device?user_code=${userCode}`, expires_in: DEVICE_TTL, interval: DEVICE_INTERVAL },
        200,
        { 'cache-control': 'no-store' },
      )
    })

    const deviceForm = (c: Context, typed: string, note: string) => page(c, 'Connect a device', `<h1>Connect a device</h1><p>${note}</p>
<form method="post" action="/oauth/device"><input name="user_code" value="${escape(typed)}" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="9" required aria-label="Code" style="width:14ch"><button>Continue</button></form>`)

    /** The signed-in person allowed to approve, or the page that says why not. */
    const deviceApprover = async (c: Context) => {
      const owner = await config.owner(c)
      if (!owner) return { refused: c.html(page(c, 'Sign in first', '<h1>Sign in first</h1><p>Open this page in the browser where you are signed in to this site, then type the code.</p>'), 401) }
      if (config.owners?.length && !config.owners.some((one) => one.toLowerCase() === owner.toLowerCase())) return { refused: c.html(page(c, 'Not allowed', '<h1>Not allowed</h1><p>Only the owner of this service can connect a device.</p>'), 403) }
      return { owner }
    }

    /** The waiting device a typed code names; a miss counts against the person typing, 5 in 10 minutes. */
    const deviceFor = async (c: Context, owner: string, typed: string) => {
      const triesKey = sha(owner.toLowerCase())
      const tries = await store.get('device-tries', triesKey)
      if (tries && Number(tries.count) >= DEVICE_TRIES) return { refused: c.html(page(c, 'Too many tries', '<h1>Too many tries</h1><p>Wait ten minutes, then type the code again.</p>'), 429) }
      const entry = await store.get('device-user', userCodeKey(typed))
      const record = entry ? await store.get('device', String(entry.device)) : null
      if (!entry || !record || now() >= Number(record.expiresAt) || (await store.get('device-decision', String(entry.device)))) {
        const until = Number(tries?.until ?? now() + DEVICE_TRIES_WINDOW)
        await store.put('device-tries', triesKey, { count: Number(tries?.count ?? 0) + 1, until }, until)
        return { refused: c.html(deviceForm(c, typed, 'That code doesn’t match a device waiting here. Check it, or ask the device for a new one.'), 400) }
      }
      // The client was revoked (or its registration expired) while the device waited: nothing to approve
      const [client, revoked] = await Promise.all([store.get('client', String(record.client)), store.get('revoked-client', String(record.client))])
      if (!client || revoked) return { refused: c.html(page(c, 'No longer allowed', '<h1>This device can’t be connected</h1><p>Its app was revoked or its registration expired. Start again on the device.</p>'), 400) }
      return { record, client, deviceKey: String(entry.device) }
    }

    const deviceConsent = (c: Context, record: Record<string, unknown>, typed: string, owner: string, client: Record<string, unknown>) => {
      const what = (record.scopes as string[]).includes('write') ? 'read everything and make changes' : 'read everything'
      const code = typed.toUpperCase().replace(/[^A-Z]/g, '')
      return page(c, `Allow ${record.name}?`, `<h1>Allow <strong>${escape(String(record.name))}</strong> to use ${escape(config.name)}?</h1>
<p>It will be able to ${what} as you (${escape(owner)}), until you revoke it. Allow it only if the device in front of you shows <code>${code.slice(0, 4)}-${code.slice(4)}</code>.${(client.redirectUris as string[] | undefined)?.length ? '' : ' It registered as a device, with no page to send you back to: it waits for its token there.'}</p>
<form method="post" action="/oauth/device"><input type="hidden" name="user_code" value="${code}"><button name="decision" value="allow">Allow</button><button class="quiet" name="decision" value="deny">Deny</button></form>`)
    }

    // The code page: behind the single sign-on, like the consent page; ?user_code= (verification_uri_complete) fills it in
    app.get('/oauth/device', async (c) => {
      const approver = await deviceApprover(c)
      if ('refused' in approver) return approver.refused
      const typed = c.req.query('user_code') ?? ''
      if (!typed) return c.html(deviceForm(c, '', `Type the code your device or agent shows to let it use ${escape(config.name)}.`))
      const found = await deviceFor(c, approver.owner, typed)
      if ('refused' in found) return found.refused
      return c.html(deviceConsent(c, found.record, typed, approver.owner, found.client))
    })

    app.post('/oauth/device', async (c) => {
      if (!sameOrigin(c, rootOf(c))) return notAllowed(c)
      const approver = await deviceApprover(c)
      if ('refused' in approver) return approver.refused
      const body = await bodyOf(c)
      const found = await deviceFor(c, approver.owner, body.user_code ?? '')
      if ('refused' in found) return found.refused
      if (body.decision !== 'allow' && body.decision !== 'deny') return c.html(deviceConsent(c, found.record, body.user_code ?? '', approver.owner, found.client))
      // Single use: the typed code is gone either way, and the device's code goes when it collects the answer. Taken, so
      // two posts at once (a double-click, or Allow and Deny from two tabs) write one answer
      if (!(await take('device-user', userCodeKey(body.user_code ?? ''))))
        return c.html(deviceForm(c, body.user_code ?? '', 'That code was just answered. Ask the device for a new one if it still waits.'), 400)
      // Its own row: the device's polls rewrite the device row, and must never write over the answer
      await store.put('device-decision', found.deviceKey, { status: body.decision === 'allow' ? 'approved' : 'denied', owner: approver.owner }, Number(found.record.expiresAt) + DEVICE_TTL)
      if (body.decision === 'deny') return c.html(page(c, 'Denied', `<h1>Denied</h1><p>${escape(String(found.record.name))} gets nothing. You can close this page.</p>`))
      return c.html(page(c, 'Approved', `<h1>Approved</h1><p>${escape(String(found.record.name))} can now use ${escape(config.name)}; it picks up its token within seconds. You can close this page.</p>`))
    })

    app.post('/oauth/token', async (c) => {
      const body = await bodyOf(c)
      const origin = issuerOf(c)
      /** More than one resource for a row bound to one, checked before any write; a row from before audiences ignores resource altogether. */
      const manyFor = async (row: Record<string, unknown>) => typeof row.audience === 'string' && (await manyResources(c))
      /** onGrant said no: the grant ends before any token, and the app hears it did, even when the store fails. */
      const withdrawn = async (issued: Grant) => {
        await withdrawAfterYes(issued)
        return oauthError(c, 400, 'invalid_grant', 'This sign-in was withdrawn: start again.')
      }
      /** `onGrant`'s word on a grant; a throw withdraws the grant before it goes on to the 500. */
      const askApp = async (onGrant: NonNullable<OAuthConfig['onGrant']>, kind: SignInGrant['kind'], issued: Grant, data?: unknown) => {
        try {
          return await onGrant({ kind, grant: issued.grant, client: { id: issued.client, name: issued.name }, approver: issued.owner, scopes: issued.scopes, ...(issued.audience ? { resource: issued.audience } : {}), ...(data ? { data: data as Record<string, string> } : {}) }, c)
        } catch (error) {
          await withdrawAfterYes(issued)
          throw error
        }
      }
      /**
       * A grant's first tokens, past the app's word. `onGrant` says no: withdrawn. It says yes and then anything fails (a
       * throw in it, the grant ended while it ran, the tokens' writes): the grant is withdrawn once and `onRevoke` told,
       * before the error. Without `onGrant`, just the tokens.
       */
      const firstTokens = async (kind: SignInGrant['kind'], issued: Grant, data: unknown, tokens: () => Promise<Response>) => {
        if (!config.onGrant) return tokens()
        if (!(await askApp(config.onGrant, kind, issued, data))) return withdrawn(issued)
        try {
          if (!(await endedDuringOnGrant(issued))) return await tokens()
        } catch (error) {
          await withdrawAfterYes(issued)
          throw error
        }
        await withdrawAfterYes(issued)
        return oauthError(c, 400, 'invalid_grant', 'This sign-in was revoked: start again.')
      }
      switch (body.grant_type) {
        case 'authorization_code': {
          const key = sha(body.code ?? '')
          const row = body.code ? await store.get('code', key) : null
          if (!row) return oauthError(c, 400, 'invalid_grant', 'This code is used, expired or unknown.')
          // Before any write: the resource is fixed at the authorization request
          if (await manyFor(row)) return oauthError(c, 400, 'invalid_target', ONE_RESOURCE)
          if (otherTarget(row, body.resource)) return oauthError(c, 400, 'invalid_target', 'resource differs from the one the authorization request named.')
          // Codes from before grants carry none: the code's own hash names it, so a replay still finds it
          const grant = String(row.grant ?? key)
          const verified = Boolean(body.code_verifier) && same(createHash('sha256').update(body.code_verifier ?? '').digest('base64url'), String(row.challenge))
          // PKCE binds the code, so redirect_uri is checked only when sent (OAuth 2.1 §10.2)
          const sameRequest = row.client === body.client_id && (!body.redirect_uri || body.redirect_uri === row.redirectUri)
          // Used once, even by a failed exchange, and kept until it expires: a second valid request for it ends the
          // grant the first one got, since either could be the thief (OAuth 2.1 §4.1.3); a wrong verifier ends nothing
          if (!(await markUsed('code', key))) {
            if (verified && sameRequest) await endGrant(grant, 'replayed', String(row.client))
            return oauthError(c, 400, 'invalid_grant', 'This code is used, expired or unknown.')
          }
          if (!sameRequest) return oauthError(c, 400, 'invalid_grant', 'client_id or redirect_uri differ from the authorization request.')
          if (!verified) return oauthError(c, 400, 'invalid_grant', 'The code_verifier doesn’t match the code_challenge.')
          if (await store.get('revoked-client', String(row.client))) return oauthError(c, 400, 'invalid_grant', 'This client was revoked: register again.')
          const issued = { client: String(row.client), name: String(row.name), owner: String(row.owner), scopes: row.scopes as string[], grant, ...boundOf(row) }
          // The code is spent either way: a refusal issues nothing
          return firstTokens('code', issued, row.data, async () => {
            await usedClient(issued.client)
            return c.json({ ...(await issue(origin, issued)), refresh_token: await refreshFor(issued) }, 200, { 'cache-control': 'no-store' })
          })
        }
        case 'refresh_token': {
          const refresh = body.refresh_token ?? ''
          const key = sha(refresh)
          // Its family and generation, read from the token itself; null for a token from before generations (1.29.0's,
          // kept only by its row) or a made-up one
          const place = generationOf(refresh)
          const held = refresh ? await store.get('refresh', key) : null
          const alreadyUsed = () => oauthError(c, 400, 'invalid_grant', 'This refresh token was already used, so every refresh token from this sign-in is revoked: authorize again.')
          if (!held) {
            // No row: a token with a generation, of a family that has moved past it, is a replay
            const family = place && (await movedPast(place))
            if (family) {
              await endGrant(place.family, 'replayed', String(family.client))
              return alreadyUsed()
            }
            return oauthError(c, 400, 'invalid_grant', 'This refresh token is expired, revoked or unknown: authorize again.')
          }
          // A refresh keeps its grant's audience and can't retarget it; a row from before audiences stays without one
          if (await manyFor(held)) return oauthError(c, 400, 'invalid_target', ONE_RESOURCE)
          if (otherTarget(held, body.resource)) return oauthError(c, 400, 'invalid_target', 'resource differs from the one this sign-in was granted for.')
          // Rows from before families carry none: the token's own hash starts one
          const grant = String(held.family ?? key)
          if ((await store.get('revoked-family', grant)) || (await store.get('revoked-client', String(held.client)))) return oauthError(c, 400, 'invalid_grant', 'This refresh token is revoked: authorize again.')
          const issued = { client: String(held.client), name: String(held.name), owner: String(held.owner), scopes: held.scopes as string[], grant, ...boundOf(held) }
          const fromBeforeGenerations = place === null
          // A token from before generations has none of its own (1.29.0 may have made it after this code rotated the
          // family): it follows the family's newest, so an earlier token of the family still reads as a replay
          const nextGeneration = (place?.generation ?? (await generationOfFamily(grant))) + 1
          // Marked used, not deleted, so a retry in the grace can read when; a token from before generations is known
          // as used by this row alone, so it keeps it 30 days
          const marked = await markUsed('refresh', key, now() + REFRESH_TTL)
          if (!marked) {
            // A retry inside the window gets the successor the first answer held: never a second branch
            const retried = await retriedSuccessor(refresh, grant, nextGeneration)
            if (retried) return c.json({ ...(await issue(origin, issued)), refresh_token: retried }, 200, { 'cache-control': 'no-store' })
            await endGrant(grant, 'replayed', issued.client)
            return alreadyUsed()
          }
          const successor = successorOf(refresh, grant, nextGeneration)
          // Before the family moves on: a retry of a token from before generations finds its successor's generation
          // here, not from the family, which this answer is about to move
          if (fromBeforeGenerations) await store.put('refresh', key, { ...marked, successorGeneration: nextGeneration }, now() + REFRESH_TTL)
          const access = await issue(origin, issued)
          // The family moves on before its new token exists: from here an earlier token is a replay, row or not
          await store.put('refresh-family', grant, { generation: nextGeneration, client: issued.client }, now() + REFRESH_TTL)
          await refreshFor(issued, successor)
          // A token with a generation is known by its family from now on: its row stays only while a retry may read it
          if (!fromBeforeGenerations) await store.put('refresh', key, marked, now() + reuseGrace)
          return c.json({ ...access, refresh_token: successor }, 200, { 'cache-control': 'no-store' })
        }
        case CLAIM_GRANT: {
          const held = body.claim_token ? await store.get('claim-token', sha(body.claim_token)) : null
          if (!held) return oauthError(c, 400, 'expired_token', 'The claim window closed: register again.')
          const client = String(held.registration)
          // revokeClient drops the registration: its marker says so before the registration reads as expired
          const [registration, revokedClient] = await Promise.all([store.get('registration', client), store.get('revoked-client', client)])
          if (revokedClient) return oauthError(c, 400, 'invalid_grant', 'This agent was revoked: register again.')
          if (!registration) return oauthError(c, 400, 'expired_token', 'The registration expired: register again.')
          if (!registration.claimed) return oauthError(c, 400, 'authorization_pending', 'The owner hasn’t typed the code yet.')
          if (await manyFor(registration)) return oauthError(c, 400, 'invalid_target', ONE_RESOURCE)
          // Single use under concurrent polls: only the one that takes the claim token gets tokens
          if (!(await take('claim-token', sha(body.claim_token!)))) return oauthError(c, 400, 'expired_token', 'The claim window closed: register again.')
          // A registration claimed before grants carries none: its id is the grant, the same in every token
          const grant = String(registration.family ?? client)
          // Read after the take, so a revoke that landed while this poll ran is seen: a refresh row issued into a revoked
          // grant would outlive the marker and undo the revoke
          const [revokedGrant, revokedLate] = await Promise.all([store.get('revoked-family', grant), store.get('revoked-client', client)])
          if (revokedGrant || revokedLate) return oauthError(c, 400, 'invalid_grant', 'This sign-in is revoked: register again.')
          const issued = { client, name: String(registration.name), owner: String(registration.owner), scopes: [...SCOPES], grant, ...boundOf(registration) }
          // Refused or failed, the grant ends, so the agent's identity assertion buys nothing either; heard, jwt-bearer may follow
          return firstTokens('claim', issued, undefined, async () => {
            if (config.onGrant) await store.put('registration', client, { ...registration, collected: true }, now() + REGISTRATION_TTL)
            const assertion = await sign({ sub: client, typ: 'agent_identity', email: registration.owner, email_verified: true }, REGISTRATION_TTL, origin)
            return c.json({ ...(await issue(origin, issued)), refresh_token: await refreshFor(issued), identity_assertion: assertion, assertion_expires: new Date((now() + REGISTRATION_TTL) * 1000).toISOString() }, 200, { 'cache-control': 'no-store' })
          })
        }
        case DEVICE_GRANT: {
          const key = sha(body.device_code ?? '')
          const record = body.device_code ? await store.get('device', key) : null
          if (!record || record.client !== body.client_id) return oauthError(c, 400, 'invalid_grant', 'This device_code is unknown or belongs to another client_id: start again at /oauth/device_authorization.')
          if (await manyFor(record)) return oauthError(c, 400, 'invalid_target', ONE_RESOURCE)
          if (otherTarget(record, body.resource)) return oauthError(c, 400, 'invalid_target', 'resource differs from the one the device authorization named.')
          const keepUntil = Number(record.expiresAt) + DEVICE_TTL
          if (await store.get('revoked-client', String(record.client))) {
            await store.delete('device', key)
            return oauthError(c, 400, 'invalid_grant', 'This client was revoked: register again.')
          }
          if (now() >= Number(record.expiresAt)) {
            await store.delete('device', key)
            return oauthError(c, 400, 'expired_token', 'The code expired before the owner approved it: start again at /oauth/device_authorization.')
          }
          // The owner's answer is collected once, however many polls arrive together: the decision row is marked used
          // and kept, so a poll that lost the race hears invalid_grant rather than waiting
          const decision = await store.get('device-decision', key)
          if (decision) {
            const collected = await markUsed('device-decision', key, keepUntil)
            if (!collected) return oauthError(c, 400, 'invalid_grant', 'This device_code was already used: start again at /oauth/device_authorization.')
            await store.delete('device', key)
          }
          if (decision?.status === 'denied') return oauthError(c, 400, 'access_denied', 'The owner said no.')
          if (decision?.status === 'approved') {
            const issued = { client: String(record.client), name: String(record.name), owner: String(decision.owner), scopes: record.scopes as string[], grant: newGrant(), ...boundOf(record) }
            return firstTokens('device', issued, undefined, async () => {
              await usedClient(issued.client)
              return c.json({ ...(await issue(origin, issued)), refresh_token: await refreshFor(issued) }, 200, { 'cache-control': 'no-store' })
            })
          }
          const interval = Number(record.interval)
          if (now() - Number(record.polledAt) < interval) {
            await store.put('device', key, { ...record, interval: interval + 5, polledAt: now() }, keepUntil)
            return oauthError(c, 400, 'slow_down', `Polled sooner than ${interval} seconds after the last poll: wait ${interval + 5} seconds between polls from now on.`, { interval: interval + 5 })
          }
          await store.put('device', key, { ...record, polledAt: now() }, keepUntil)
          return oauthError(c, 400, 'authorization_pending', 'The owner hasn’t approved the code yet: poll again after `interval` seconds.')
        }
        case JWT_BEARER: {
          const { publicKey } = await ready
          const { payload } = await jwtVerify(body.assertion ?? '', publicKey, { issuer: origin, algorithms: ['ES256'] }).catch(() => ({ payload: null }))
          const registration = payload?.typ === 'agent_identity' && typeof payload.sub === 'string' ? await store.get('registration', payload.sub) : null
          if (!registration || (await store.get('revoked-client', String(payload!.sub)))) return oauthError(c, 400, 'invalid_grant', 'This assertion is expired, revoked or unknown: register again.')
          if (!registration.claimed) return oauthError(c, 400, 'invalid_grant', 'Not claimed yet: an unclaimed registration has no scopes. Run the claim (auth.md step B2).')
          // The claim's first token is the one the app hears: an assertion never gets there first
          if (config.onGrant && !registration.collected) return oauthError(c, 400, 'invalid_grant', 'Collect the claim first: poll the token endpoint with the claim grant (auth.md step B4).')
          if (await manyFor(registration)) return oauthError(c, 400, 'invalid_target', ONE_RESOURCE)
          const grant = String(registration.family ?? payload!.sub)
          // The assertion belongs to the claim's sign-in: once that grant is revoked it buys nothing, never a dead token
          if (await store.get('revoked-family', grant)) return oauthError(c, 400, 'invalid_grant', 'This sign-in is revoked (a used refresh token came back, or the owner ended it): register again.')
          return c.json(await issue(origin, { client: String(payload!.sub), name: String(registration.name), owner: String(registration.owner), scopes: [...SCOPES], grant, ...boundOf(registration) }), 200, { 'cache-control': 'no-store' })
        }
        default:
          return oauthError(c, 400, 'unsupported_grant_type', `grant_type must be one of: authorization_code, refresh_token, ${DEVICE_GRANT}, ${JWT_BEARER}, ${CLAIM_GRANT}.`)
      }
    })

    /**
     * The sign-in a refresh token belongs to: by its row, or, for an earlier token with a generation that keeps no row,
     * by its MAC and its family's row. null for anything else.
     */
    const signInOf = async (refresh: string, row: Record<string, unknown> | null) => {
      if (row) return { family: String(row.family ?? sha(refresh)), client: String(row.client) }
      const place = generationOf(refresh)
      if (!place) return null
      const family = await store.get('refresh-family', place.family)
      return { family: place.family, ...(typeof family?.client === 'string' ? { client: family.client } : {}) }
    }

    // RFC 7009: always 200, whatever the token was
    app.post('/oauth/revoke', async (c) => {
      const body = await bodyOf(c)
      const value = body.token ?? ''
      const refresh = await store.get('refresh', sha(value))
      const signIn = await signInOf(value, refresh)
      if (signIn) await endGrant(signIn.family, 'revoked', signIn.client)
      if (refresh) await store.delete('refresh', sha(value))
      const { publicKey } = await ready
      const { payload } = await jwtVerify(value, publicKey, { issuer: issuerOf(c), algorithms: ['ES256'] }).catch(() => ({ payload: null }))
      if (typeof payload?.jti === 'string') await store.delete('access', payload.jti)
      return c.body(null, 200, { 'cache-control': 'no-store' })
    })
  }

  /**
   * Revokes every token a client or agent registration holds and drops the registration (the owner's kill switch): a
   * revoked client registers again and gets a new id. `onRevoke` hears it once, naming the client and no grant.
   *
   * @example
   * await oauth.revokeClient(caller.client)
   */
  const revokeClient = async (clientId: string) => {
    await store.put('revoked-client', clientId, {}, now() + REVOKED_TTL)
    await store.delete('client', clientId)
    await store.delete('registration', clientId)
    await tellRevoked({ client: clientId, reason: 'client_revoked' })
  }

  return { mount, verify, resourceMetadataFor, resourceOf, rootOf, issuerOf, publicOrigin, mcpPath, revokeGrant, revokeClient, ticketOf, answeredOf, holdTicket, complete, authorizationServer, protectedResource, authMd }
}

export type OAuth = ReturnType<typeof createOAuth>

