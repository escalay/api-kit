/**
 * Who may call: agents and scripts with an API key (`Authorization: Bearer <key>`), people through Cloudflare Access
 * (its signed `Cf-Access-Jwt-Assertion` header, checked against the team's keys so a misrouted request without Access
 * in front is still refused). A browser app on the same host also sends Access's `CF_Authorization` cookie, the same
 * signed token, on paths that bypass the gate; it is accepted too, and writes made with it must come from the same
 * site (`Sec-Fetch-Site` / `Origin`), so another site can't post through someone's login. The service only ever holds key *hashes* (`API_KEYS=name:sha256,…`); the keys themselves
 * live in your secret store, one per client, so revoking one is removing its line.
 *
 * @example
 * const { key, hash } = mintApiKey('cli')                  // once per client: key → the secret store, `laptop:<hash>` → API_KEYS
 * app.use('*', authenticate({ realm: 'cookbook', keys: parseApiKeys(process.env.API_KEYS), access: { team: 'example', audience: process.env.ACCESS_AUD }, open: ['/llms.txt', '/api/health'] }))
 * c.get('caller') // { kind: 'key', name: 'laptop' } or { kind: 'person', email: '…' }
 */
import { createHash, randomBytes } from 'node:crypto'
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { problemResponse } from './problem.js'

/** What an OAuth token can do: `read` for safe methods, `write` for the rest. */
export const SCOPES = ['read', 'write'] as const

/** The paths an app with an OAuth server must leave open to anonymous callers: discovery, registration, the token endpoints, auth.md. */
export const OAUTH_OPEN_PATHS = ['/.well-known/*', '/auth.md', '/oauth/*', '/agent/identity', '/agent/identity/claim']

/** What `createAgentApi` needs from an OAuth server (`createOAuth`, the `oauth` module): mount it, check its tokens, name its metadata. */
export type OAuthServer = {
  mount: (app: Hono<any>) => void
  verify: NonNullable<AuthOptions['tokens']>
  resourceMetadataFor: (c: Context) => string
}

/** A person's role, when the app keeps a team (`people` part): the owner may do everything, a member everything but admin. */
export type Role = 'owner' | 'member'

export type Caller = { kind: 'key'; name: string } | { kind: 'person'; email: string; role?: Role } | { kind: 'agent'; name: string; scopes: string[]; owner: string }

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex')

/** A new key, `<prefix>_` + 192 random bits in base64url, and the hash the service stores. */
export const mintApiKey = (prefix: string) => {
  const key = `${prefix}_${randomBytes(24).toString('base64url')}`
  return { key, hash: hashApiKey(key) }
}

/** `laptop:<sha256>,ci:<sha256>` → hash → client name. Malformed entries are refused loudly at boot. */
export const parseApiKeys = (value: string | undefined) => {
  const keys = new Map<string, string>()
  for (const entry of (value ?? '').split(',').map((part) => part.trim()).filter(Boolean)) {
    const [name, hash] = entry.split(':')
    if (!name || !hash || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`API_KEYS entry "${name ?? entry}" is not name:sha256`)
    keys.set(hash, name)
  }
  return keys
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

/** A write sent with a cookie must come from this host: browsers say so in `Sec-Fetch-Site`, older ones in `Origin`. */
const sameSite = (c: Context) => {
  const site = c.req.header('sec-fetch-site')
  if (site) return site === 'same-origin'
  const origin = c.req.header('origin')
  return Boolean(origin) && new URL(origin!).host === new URL(c.req.url).host
}

const bearerOf = (c: Context) => {
  const header = c.req.header('authorization') ?? ''
  return /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : undefined
}

/** Checks a Cloudflare Access token against the team's published keys (cached by jose). */
export const accessVerifier = ({ team, audience }: { team: string; audience: string }) => {
  const issuer = `https://${team}.cloudflareaccess.com`
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`))
  return async (token: string) => {
    const { payload } = await jwtVerify(token, keys, { issuer, audience })
    return typeof payload.email === 'string' ? payload.email : null
  }
}

/** The signed-in person on a page behind Access (header or cookie), for OAuth's approval pages: their email, or null. */
export const accessOwner = (access: AccessOptions) => {
  const verify = access.verify ?? accessVerifier(access)
  return async (c: Context) => {
    const assertion = c.req.header('cf-access-jwt-assertion') ?? getCookie(c, 'CF_Authorization')
    return assertion ? verify(assertion).catch(() => null) : null
  }
}

// `/llms.txt` matches itself, `/skills/x.md` matches `/skills/*`, and a leading star matches a suffix (`/mcp/server-card`)
const matches = (path: string, pattern: string) =>
  pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : pattern.startsWith('*') ? path.endsWith(pattern.slice(1)) : path === pattern

export type AccessOptions = {
  team: string
  audience: string
  /** Replaces the JWKS check, for tests. */
  verify?: (token: string) => Promise<string | null>
  /** With a team (`people` part): an email → its role, or null to refuse someone Access let through. Without it, every Access email is let in. */
  roleOf?: (email: string) => Promise<Role | null>
}

export type AuthOptions = {
  realm: string
  keys: Map<string, string>
  /** Keys the service stores itself (made and revoked through its API): a key's hash → its name, or undefined. Asked after `keys`. */
  storedKeys?: (hash: string) => Promise<string | undefined>
  access?: AccessOptions
  open?: string[]
  /** OAuth access tokens (`oauth.ts`): a JWT → its caller, or null. Keys still work beside them. */
  tokens?: (jwt: string, c: Context) => Promise<{ kind: 'agent'; name: string; scopes: string[]; owner: string } | null>
  /** Where a 401 points (`WWW-Authenticate: … resource_metadata=`): a URL, or one per request. */
  resourceMetadata?: string | ((c: Context) => string)
  /** Endpoints that POST but only relay to routes in-process (MCP, A2A): a token needs just `read` there, each route checks its own scope. */
  relay?: string[]
  /** A signed-in browser session (`people` part: a passkey, then a cookie): the request → its person, or null. Asked when no Bearer is sent, before Access. */
  session?: (c: Context) => Promise<{ email: string; role?: Role } | null>
}

const isJwt = (value: string) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)

export const authenticate = ({ realm, keys, storedKeys, access, open = [], tokens, resourceMetadata, relay = [], session }: AuthOptions): MiddlewareHandler => {
  const verifyAccess = access?.verify ?? (access?.audience ? accessVerifier(access) : null)
  return async (c, next) => {
    if (c.req.method === 'OPTIONS' || open.some((pattern) => matches(c.req.path, pattern))) return next()
    const key = bearerOf(c)
    const hash = key ? hashApiKey(key) : undefined
    // An OAuth token is never a stored key: it skips the lookup
    const name = hash ? (keys.get(hash) ?? (isJwt(key!) ? undefined : await storedKeys?.(hash))) : undefined
    if (name) {
      c.set('caller' as never, { kind: 'key', name } satisfies Caller as never)
      return next()
    }
    const agent = key && tokens && isJwt(key) ? await tokens(key, c) : null
    if (agent) {
      // read covers what an agent can look at; anything that changes state needs write
      const needed = SAFE.has(c.req.method) || relay.includes(c.req.path) ? 'read' : 'write'
      if (!agent.scopes.includes(needed)) return problemResponse(c, 'forbidden', { detail: `This token lacks the ${needed} scope: authorize again asking for it.`, headers: { 'www-authenticate': `Bearer realm="${realm}", error="insufficient_scope", scope="${needed}"` } })
      c.set('caller' as never, agent satisfies Caller as never)
      return next()
    }
    const person = !key && session ? await session(c) : null
    if (person) {
      // The session is a cookie: like Access's, a write made with it must come from this site
      if (!SAFE.has(c.req.method) && !sameSite(c)) return problemResponse(c, 'forbidden', { detail: 'A write signed in with the session cookie must come from this site.' })
      c.set('caller' as never, { kind: 'person', ...person } satisfies Caller as never)
      return next()
    }
    const header = c.req.header('cf-access-jwt-assertion')
    const cookie = header ? undefined : getCookie(c, 'CF_Authorization')
    const assertion = header ?? cookie
    if (!key && assertion && verifyAccess) {
      const email = await verifyAccess(assertion).catch(() => null)
      if (email && cookie && !SAFE.has(c.req.method) && !sameSite(c))
        return problemResponse(c, 'forbidden', { detail: 'A write signed in with the Access cookie must come from this site.' })
      if (email && access?.roleOf) {
        const role = await access.roleOf(email.toLowerCase())
        if (!role) return problemResponse(c, 'forbidden', { detail: `${email} passed Cloudflare Access but is not on this deployment's team: ask its owner to add you.` })
        c.set('caller' as never, { kind: 'person', email, role } satisfies Caller as never)
        return next()
      }
      if (email) {
        c.set('caller' as never, { kind: 'person', email } satisfies Caller as never)
        return next()
      }
    }
    const metadata = typeof resourceMetadata === 'function' ? resourceMetadata(c) : resourceMetadata
    const challenge = [`Bearer realm="${realm}"`, ...(key ? ['error="invalid_token"'] : []), ...(metadata ? [`resource_metadata="${metadata}"`] : [])].join(', ')
    const howToGetOne = tokens ? ' Or get a token yourself: OAuth from the resource metadata in WWW-Authenticate, or /auth.md.' : ''
    return problemResponse(c, 'unauthorized', {
      detail: key ? `This token or API key is not valid (expired, revoked, mistyped, or for another service).${howToGetOne}` : `Send an API key: \`Authorization: Bearer <key>\`. Keys are issued per client; ask the owner for one.${howToGetOne}`,
      headers: { 'www-authenticate': challenge },
    })
  }
}
