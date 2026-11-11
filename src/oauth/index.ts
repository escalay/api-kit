/**
 * The service as its own OAuth authorization server, so an agent can get a token without anyone pasting a key. Two
 * ways in, both ending at a person who approves it on a page behind the site's single sign-on:
 *   MCP clients (claude.ai, Claude Desktop, Cursor) follow the 401's `resource_metadata` to the protected-resource
 *   metadata, register themselves (RFC 7591), send the owner to `/oauth/authorize` (authorization code + PKCE S256),
 *   and refresh with rotating refresh tokens.
 *   Any other agent follows `/auth.md` (agent registration, anonymous or by email): it registers at `/agent/identity`,
 *   asks for a claim at `/agent/identity/claim`, hands the owner a 6-digit code to type at `/oauth/claim`, and polls
 *   the token endpoint until the owner has.
 * Access tokens are ES256 JWTs (one hour) signed with the app's key and checked against a revocation list on every
 * request; refresh tokens, codes and registrations live in the app's store. Nothing is granted before a person
 * approves: an unclaimed registration can't get a token.
 *
 * @example
 * const oauth = createOAuth({ name: 'Cookbook', signingKey: env.OAUTH_SIGNING_KEY, store, owner: (c) => ownerOf(c) })
 * oauth.mount(app)                                                    // the metadata, the endpoints and auth.md
 * app.use('*', authenticate({ realm: 'cookbook', keys, tokens: oauth.verify, resourceMetadata: oauth.resourceMetadataFor }))
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { calculateJwkThumbprint, exportJWK, importJWK, jwtVerify, SignJWT, type JWK } from 'jose'
import { OAUTH_OPEN_PATHS, SCOPES } from '../core/auth.js'
import { originOf } from '../core/hal.js'
import { problemResponse } from '../core/problem.js'
import type { OAuthStore } from './store.js'

export { OAUTH_MIGRATIONS, oauthKeys } from './schema.js'
export { dbOAuthStore, memoryOAuthStore, type OAuthStore } from './store.js'

const HOUR = 3600
const ACCESS_TTL = HOUR
const CODE_TTL = 600
const REFRESH_TTL = 30 * 24 * HOUR
const CLIENT_TTL = 365 * 24 * HOUR
const REGISTRATION_TTL = 24 * HOUR
const CLAIM_TTL = 600
const CLAIM_GRANT = 'urn:workos:agent-auth:grant-type:claim'
const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

export type OAuthConfig = {
  /** Shown on the consent page and in the metadata (`resource_name`). */
  name: string
  /** The private ES256 key as a JWK JSON string (`generateOAuthKey()` makes one). */
  signingKey: string
  store: OAuthStore
  /** The signed-in person's email on the approval pages (from the single sign-on), or null: only they may approve. */
  owner: (c: Context) => Promise<string | null>
  /** Emails allowed to claim an agent registration; empty means whoever `owner` lets in. */
  owners?: string[]
  /** Extra fields for the authorization server metadata, e.g. `poppy_domains`. */
  metadata?: Record<string, unknown>
}

export type TokenCaller = { kind: 'agent'; name: string; scopes: string[]; owner: string }

const now = () => Math.floor(Date.now() / 1000)
const token = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/** A fresh ES256 signing key as a private JWK JSON string, for the app's secrets. */
export const generateOAuthKey = async () => {
  const { privateKey } = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return JSON.stringify({ ...(await exportJWK(privateKey)), alg: 'ES256' })
}

const UNSAFE_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:'])

/** Redirect URIs a client may register: https anywhere, http only on this machine, or an app's own scheme (`cursor://`). */
const redirectAllowed = (uri: string) => {
  const url = URL.canParse(uri) ? new URL(uri) : null
  if (!url || url.hash || UNSAFE_SCHEMES.has(url.protocol)) return false
  if (url.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  return true
}

const bodyOf = async (c: Context): Promise<Record<string, string>> => {
  const type = c.req.header('content-type') ?? ''
  if (type.includes('application/json')) return ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, string>
  const form = await c.req.parseBody().catch(() => ({}))
  return Object.fromEntries(Object.entries(form).map(([key, value]) => [key, String(value)]))
}

const oauthError = (c: Context, status: 400 | 401 | 403 | 410 | 429, error: string, description: string, extra: Record<string, unknown> = {}) =>
  c.json({ error, error_description: description, ...extra }, status, { 'cache-control': 'no-store' })

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>:root{color-scheme:light dark;--bg:#fafaf9;--fg:#111;--muted:#ececeb;--mfg:#6b6b6b}@media(prefers-color-scheme:dark){:root{--bg:#0b0b0b;--fg:#f2f2f2;--muted:#1c1c1c;--mfg:#9a9a9a}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 Inter,ui-sans-serif,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:16px}
main{max-width:28rem;width:100%;background:var(--muted);border-radius:12px;padding:28px}h1{font-size:20px;font-weight:400;letter-spacing:-.01em;margin:0 0 8px}p{color:var(--mfg);margin:0 0 16px}
form{display:flex;gap:8px;flex-wrap:wrap;margin-top:20px}button,input{font:inherit;border-radius:8px;border:0;padding:10px 16px}button{background:var(--fg);color:var(--bg);cursor:pointer}button.quiet{background:transparent;color:var(--fg);box-shadow:inset 0 0 0 1px var(--mfg)}
input{background:var(--bg);color:var(--fg);letter-spacing:.3em;width:9ch;text-align:center}code{font-size:14px}</style></head><body><main>${body}</main></body></html>`

export const createOAuth = (config: OAuthConfig) => {
  const { store } = config
  const ready = (async () => {
    const jwk = JSON.parse(config.signingKey) as JWK
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

  const issue = async (origin: string, grant: { client: string; name: string; owner: string; scopes: string[]; resource?: string }) => {
    const jti = randomBytes(12).toString('base64url')
    const access = await sign({ sub: grant.owner, client_id: grant.client, name: grant.name, scope: grant.scopes.join(' '), jti }, ACCESS_TTL, origin)
    await store.put('access', jti, { client: grant.client }, now() + ACCESS_TTL)
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL, scope: grant.scopes.join(' ') }
  }

  const refreshFor = async (grant: { client: string; name: string; owner: string; scopes: string[] }) => {
    const refresh = token('rt')
    await store.put('refresh', sha(refresh), grant, now() + REFRESH_TTL)
    return refresh
  }

  /** The protected-resource metadata URL for a request: suffixed with `/mcp` for MCP, the bare one elsewhere. */
  const resourceMetadataFor = (c: Context) => `${originOf(c)}/.well-known/oauth-protected-resource${c.req.path.startsWith('/mcp') ? '/mcp' : ''}`

  /** An access token → its caller, or null (expired, revoked, or not ours). */
  const verify = async (jwt: string, c: Context): Promise<TokenCaller | null> => {
    const { publicKey } = await ready
    const origin = originOf(c)
    const { payload } = await jwtVerify(jwt, publicKey, { issuer: origin, algorithms: ['ES256'] }).catch(() => ({ payload: null }))
    if (!payload || typeof payload.jti !== 'string' || typeof payload.client_id !== 'string') return null
    if (!(await store.get('access', payload.jti))) return null
    if (await store.get('revoked-client', payload.client_id)) return null
    return { kind: 'agent', name: String(payload.name ?? payload.client_id), scopes: String(payload.scope ?? '').split(' ').filter(Boolean), owner: String(payload.sub) }
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
    grant_types_supported: ['authorization_code', 'refresh_token', JWT_BEARER, CLAIM_GRANT],
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
    protected_resources: [origin, `${origin}/mcp`],
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
approves you** on a page behind their sign-in. There are two ways; pick the one your client supports.

## A. OAuth with the owner in the browser (MCP clients, apps)

1. Call any API route without a token. The 401 carries
   \`WWW-Authenticate: Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"\` (\`/mcp\` adds \`/mcp\`).
2. Read that document, then \`${origin}/.well-known/oauth-authorization-server\`.
3. Register: \`POST ${origin}/oauth/register\` with \`{"client_name": "…", "redirect_uris": ["https://…/callback"]}\`
   (RFC 7591, public client, no secret). Keep the \`client_id\`.
4. Send the owner to \`${origin}/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&scope=read%20write\`.
   They sign in and approve.
5. Exchange the code: \`POST ${origin}/oauth/token\` with \`grant_type=authorization_code&code=…&redirect_uri=…&client_id=…&code_verifier=…\`.
   You get an access token (one hour) and a refresh token (\`grant_type=refresh_token\`, rotated on each use).

## B. Agent registration (auth.md profile)

1. Register: \`POST ${origin}/agent/identity\` with \`{"type": "anonymous"}\`, or \`{"type": "service_auth", "login_hint": "<owner email>"}\`.
   Keep the \`claim_token\`; it is returned once. An anonymous registration has no scopes yet.
2. Ask for a claim (anonymous only): \`POST ${origin}/agent/identity/claim\` with \`{"claim_token": "…", "email": "<owner email>"}\`.
   Only ${config.owners?.length ? 'the owner' : 'a person who can sign in to this site'} can complete it.
3. Give the owner the \`verification_uri\` and the 6-digit \`user_code\` in one message. They sign in and type the code.
4. Poll \`POST ${origin}/oauth/token\` with \`grant_type=${CLAIM_GRANT}&claim_token=…\` every \`interval\` seconds
   (\`authorization_pending\` until they do). Success returns an access token and an \`identity_assertion\`.
5. When the access token expires, exchange the assertion: \`grant_type=${JWT_BEARER}&assertion=…\`.

## Using the token

\`Authorization: Bearer <access_token>\` on \`/api\` and \`/mcp\`. Scopes: \`read\` (everything you can GET) and \`write\`
(saved items and other changes). Revoke with \`POST ${origin}/oauth/revoke\` and \`token=…\`. What to call next: ${origin}/llms.txt.

| Error | Means |
|---|---|
| \`authorization_pending\` | the owner hasn't approved yet; keep polling at \`interval\` |
| \`expired_token\` | the 10-minute code window passed; ask for a new claim |
| \`invalid_grant\` | the code, refresh token or assertion is used, expired or revoked; start again |
| \`access_denied\` | the owner said no |
`

  const mount = (app: Hono<any, any, any>) => {
    const json = (c: Context, body: unknown, type = 'application/json') => c.body(JSON.stringify(body, null, 2), 200, { 'content-type': type, 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' })

    app.get('/.well-known/oauth-authorization-server', (c) => json(c, authorizationServer(originOf(c))))
    app.get('/.well-known/oauth-authorization-server/*', (c) => json(c, authorizationServer(originOf(c))))
    app.get('/.well-known/oauth-protected-resource', (c) => json(c, protectedResource(originOf(c), '')))
    app.get('/.well-known/oauth-protected-resource/*', (c) => json(c, protectedResource(originOf(c), c.req.path.slice('/.well-known/oauth-protected-resource'.length))))
    app.get('/.well-known/jwks.json', async (c) => json(c, { keys: [(await ready).publicJwk] }))
    app.get('/auth.md', (c) => c.body(authMd(originOf(c)), 200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300' }))

    // RFC 7591: a public client registers itself; registering grants nothing until the owner approves a request
    app.post('/oauth/register', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown }
      const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : []
      if (!uris.length || !uris.every(redirectAllowed)) return oauthError(c, 400, 'invalid_redirect_uri', 'Send redirect_uris: https URLs, or http on localhost for apps on this machine.')
      const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : 'An unnamed client'
      const clientId = token('client')
      const issuedAt = now()
      await store.put('client', clientId, { name, redirectUris: uris }, issuedAt + CLIENT_TTL)
      return c.json({ client_id: clientId, client_id_issued_at: issuedAt, client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }, 201, { 'cache-control': 'no-store' })
    })

    const authorizeParams = async (c: Context, params: Record<string, string>) => {
      const client = params.client_id ? await store.get('client', params.client_id) : null
      if (!client) return { error: 'This client is not registered here (or its registration expired). Register again at /oauth/register.' }
      if (!(client.redirectUris as string[]).includes(params.redirect_uri ?? '')) return { error: 'The redirect_uri is not one this client registered.' }
      if (params.response_type !== 'code') return { error: 'Only response_type=code is supported.', redirect: true }
      if (!params.code_challenge || params.code_challenge_method !== 'S256') return { error: 'PKCE is required: code_challenge with code_challenge_method=S256.', redirect: true }
      const scopes = (params.scope || SCOPES.join(' ')).split(' ').filter((scope) => (SCOPES as readonly string[]).includes(scope))
      return { client, scopes }
    }

    const backTo = (redirectUri: string, origin: string, query: Record<string, string | undefined>) => {
      const url = new URL(redirectUri)
      for (const [key, value] of Object.entries({ ...query, iss: origin })) if (value !== undefined) url.searchParams.set(key, value)
      return url.toString()
    }

    // The consent page: behind the single sign-on, and the owner check runs here too
    app.get('/oauth/authorize', async (c) => {
      const params = c.req.query()
      const owner = await config.owner(c)
      if (!owner) return c.html(page('Sign in first', '<h1>Sign in first</h1><p>Approving an agent needs you signed in to this site. Open it in your browser, sign in, then try again.</p>'), 401)
      const checked = await authorizeParams(c, params)
      if ('error' in checked) {
        if (checked.redirect && params.redirect_uri) return c.redirect(backTo(params.redirect_uri, originOf(c), { error: 'invalid_request', error_description: checked.error, state: params.state }), 302)
        return c.html(page('Can’t approve this', `<h1>Can’t approve this request</h1><p>${escape(checked.error!)}</p>`), 400)
      }
      const ticket = token('consent')
      await store.put('consent', ticket, { ...params, owner }, now() + CODE_TTL)
      const what = checked.scopes.includes('write') ? 'read everything and make changes' : 'read everything'
      return c.html(page(`Allow ${checked.client.name}?`, `<h1>Allow <strong>${escape(String(checked.client.name))}</strong> to use ${escape(config.name)}?</h1>
<p>It will be able to ${what} as you (${escape(owner)}), until you revoke it. It sends you back to <code>${escape(new URL(params.redirect_uri!).host)}</code>.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="ticket" value="${ticket}"><button name="decision" value="allow">Allow</button><button class="quiet" name="decision" value="deny">Deny</button></form>`))
    })

    app.post('/oauth/authorize', async (c) => {
      const owner = await config.owner(c)
      const site = c.req.header('sec-fetch-site')
      if (!owner || (site && site !== 'same-origin')) return c.html(page('Not allowed', '<h1>Not allowed</h1><p>Approve from the page this site showed you, signed in.</p>'), 403)
      const body = await bodyOf(c)
      const consent = body.ticket ? await store.get('consent', body.ticket) : null
      if (!consent || consent.owner !== owner) return c.html(page('Expired', '<h1>This approval expired</h1><p>Start again from the app that asked.</p>'), 400)
      await store.delete('consent', body.ticket!)
      const params = consent as Record<string, string>
      const origin = originOf(c)
      if (body.decision !== 'allow') return c.redirect(backTo(params.redirect_uri!, origin, { error: 'access_denied', error_description: 'The owner said no.', state: params.state }), 302)
      const checked = await authorizeParams(c, params)
      if ('error' in checked) return c.html(page('Can’t approve this', `<h1>Can’t approve this request</h1><p>${escape(checked.error!)}</p>`), 400)
      const code = token('code')
      await store.put('code', sha(code), { client: params.client_id, redirectUri: params.redirect_uri, challenge: params.code_challenge, scopes: checked.scopes, owner, name: checked.client.name, resource: params.resource ?? null }, now() + CODE_TTL)
      return c.redirect(backTo(params.redirect_uri!, origin, { code, state: params.state }), 302)
    })

    // auth.md registration: anonymous or bound to an email, claimed by a person typing the code
    app.post('/agent/identity', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { type?: string; login_hint?: string; client_name?: string }
      if (body.type === 'identity_assertion') return oauthError(c, 400, 'issuer_not_enabled', 'Identity assertions (ID-JAG) are not accepted here: register as anonymous or service_auth.')
      if (body.type !== 'anonymous' && body.type !== 'service_auth') return oauthError(c, 400, 'invalid_request', 'Send {"type": "anonymous"} or {"type": "service_auth", "login_hint": "<email>"}.')
      if (body.type === 'service_auth' && !body.login_hint) return oauthError(c, 400, 'invalid_request', 'service_auth needs login_hint: the owner’s email.')
      const origin = originOf(c)
      const registrationId = token('reg')
      const claimToken = token('clm')
      const expires = now() + REGISTRATION_TTL
      const name = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 80) : `Agent ${registrationId.slice(4, 10)}`
      await store.put('registration', registrationId, { name, type: body.type, claimed: false, email: body.login_hint ?? null }, expires)
      await store.put('claim-token', sha(claimToken), { registration: registrationId }, expires)
      const assertion = await sign({ sub: registrationId, typ: 'agent_identity' }, REGISTRATION_TTL, origin)
      const base = { registration_id: registrationId, registration_type: body.type, claim_url: `${origin}/agent/identity/claim`, claim_token: claimToken, claim_token_expires: new Date(expires * 1000).toISOString(), post_claim_scopes: [...SCOPES] }
      if (body.type === 'anonymous') return c.json({ ...base, identity_assertion: assertion, assertion_expires: new Date(expires * 1000).toISOString(), pre_claim_scopes: [] }, 200, { 'cache-control': 'no-store' })
      return c.json({ ...base, claim: await startClaim(origin, registrationId, body.login_hint!) }, 200, { 'cache-control': 'no-store' })
    })

    const startClaim = async (origin: string, registrationId: string, email: string) => {
      const userCode = String(randomInt(0, 1_000_000)).padStart(6, '0')
      const attempt = token('cla')
      await store.put('claim-attempt', sha(attempt), { registration: registrationId, email: email.toLowerCase(), code: sha(userCode), tries: 0 }, now() + CLAIM_TTL)
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
      const attempt = await startClaim(originOf(c), String(held.registration), email)
      return c.json({ registration_id: held.registration, status: 'initiated', expires_at: new Date((now() + CLAIM_TTL) * 1000).toISOString(), claim_attempt: attempt }, 200, { 'cache-control': 'no-store' })
    })

    // The claim page: behind the single sign-on; the signed-in person must be the one the claim names
    app.get('/oauth/claim', async (c) => {
      const owner = await config.owner(c)
      if (!owner) return c.html(page('Sign in first', '<h1>Sign in first</h1><p>Open this link in the browser where you are signed in to this site.</p>'), 401)
      const attemptToken = c.req.query('claim_attempt_token') ?? ''
      const attempt = await store.get('claim-attempt', sha(attemptToken))
      if (!attempt) return c.html(page('Expired', '<h1>This code expired</h1><p>Ask the agent for a new one.</p>'), 410)
      const registration = await store.get('registration', String(attempt.registration))
      return c.html(page('Approve an agent', `<h1>Approve <strong>${escape(String(registration?.name ?? 'an agent'))}</strong>?</h1>
<p>You are signed in as ${escape(owner)}. Type the 6-digit code the agent gave you to let it read and change ${escape(config.name)} as you.</p>
<form method="post" action="/oauth/claim"><input type="hidden" name="claim_attempt_token" value="${escape(attemptToken)}"><input name="user_code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required aria-label="Code"><button>Approve</button></form>`))
    })

    app.post('/oauth/claim', async (c) => {
      const owner = await config.owner(c)
      const site = c.req.header('sec-fetch-site')
      if (!owner || (site && site !== 'same-origin')) return c.html(page('Not allowed', '<h1>Not allowed</h1>'), 403)
      const body = await bodyOf(c)
      const key = sha(body.claim_attempt_token ?? '')
      const attempt = await store.get('claim-attempt', key)
      if (!attempt) return c.html(page('Expired', '<h1>This code expired</h1><p>Ask the agent for a new one.</p>'), 410)
      if (String(attempt.email) !== owner.toLowerCase()) return c.html(page('Not yours', `<h1>This claim names someone else</h1><p>Sign in as the person the agent asked for.</p>`), 403)
      if (!same(sha(body.user_code ?? ''), String(attempt.code))) {
        const tries = Number(attempt.tries) + 1
        if (tries >= 5) await store.delete('claim-attempt', key)
        else await store.put('claim-attempt', key, { ...attempt, tries }, now() + CLAIM_TTL)
        return c.html(page('Wrong code', `<h1>That code doesn’t match</h1><p>${tries >= 5 ? 'Too many tries: ask the agent for a new code.' : 'Check the code the agent gave you and try again.'}</p>`), 400)
      }
      await store.delete('claim-attempt', key)
      const registration = await store.get('registration', String(attempt.registration))
      if (!registration) return c.html(page('Expired', '<h1>This registration expired</h1>'), 410)
      await store.put('registration', String(attempt.registration), { ...registration, claimed: true, owner }, now() + REGISTRATION_TTL)
      return c.html(page('Approved', `<h1>Approved</h1><p>${escape(String(registration.name))} can now use ${escape(config.name)}. You can close this page.</p>`))
    })

    app.post('/oauth/token', async (c) => {
      const body = await bodyOf(c)
      const origin = originOf(c)
      switch (body.grant_type) {
        case 'authorization_code': {
          const grant = body.code ? await store.get('code', sha(body.code)) : null
          if (!grant) return oauthError(c, 400, 'invalid_grant', 'This code is used, expired or unknown.')
          await store.delete('code', sha(body.code!))
          if (grant.client !== body.client_id || grant.redirectUri !== body.redirect_uri) return oauthError(c, 400, 'invalid_grant', 'client_id or redirect_uri differ from the authorization request.')
          const challenge = createHash('sha256').update(body.code_verifier ?? '').digest('base64url')
          if (!body.code_verifier || !same(challenge, String(grant.challenge))) return oauthError(c, 400, 'invalid_grant', 'The code_verifier doesn’t match the code_challenge.')
          const issued = { client: String(grant.client), name: String(grant.name), owner: String(grant.owner), scopes: grant.scopes as string[] }
          return c.json({ ...(await issue(origin, issued)), refresh_token: await refreshFor(issued) }, 200, { 'cache-control': 'no-store' })
        }
        case 'refresh_token': {
          const held = body.refresh_token ? await store.get('refresh', sha(body.refresh_token)) : null
          if (!held || (await store.get('revoked-client', String(held.client)))) return oauthError(c, 400, 'invalid_grant', 'This refresh token is used, expired or revoked: authorize again.')
          await store.delete('refresh', sha(body.refresh_token!))
          const issued = held as { client: string; name: string; owner: string; scopes: string[] }
          return c.json({ ...(await issue(origin, issued)), refresh_token: await refreshFor(issued) }, 200, { 'cache-control': 'no-store' })
        }
        case CLAIM_GRANT: {
          const held = body.claim_token ? await store.get('claim-token', sha(body.claim_token)) : null
          if (!held) return oauthError(c, 400, 'expired_token', 'The claim window closed: register again.')
          const registration = await store.get('registration', String(held.registration))
          if (!registration) return oauthError(c, 400, 'expired_token', 'The registration expired: register again.')
          if (!registration.claimed) return oauthError(c, 400, 'authorization_pending', 'The owner hasn’t typed the code yet.')
          await store.delete('claim-token', sha(body.claim_token!))
          const issued = { client: String(held.registration), name: String(registration.name), owner: String(registration.owner), scopes: [...SCOPES] }
          const assertion = await sign({ sub: held.registration, typ: 'agent_identity', email: registration.owner, email_verified: true }, REGISTRATION_TTL, origin)
          return c.json({ ...(await issue(origin, issued)), identity_assertion: assertion, assertion_expires: new Date((now() + REGISTRATION_TTL) * 1000).toISOString() }, 200, { 'cache-control': 'no-store' })
        }
        case JWT_BEARER: {
          const { publicKey } = await ready
          const { payload } = await jwtVerify(body.assertion ?? '', publicKey, { issuer: origin, algorithms: ['ES256'] }).catch(() => ({ payload: null }))
          const registration = payload?.typ === 'agent_identity' && typeof payload.sub === 'string' ? await store.get('registration', payload.sub) : null
          if (!registration || (await store.get('revoked-client', String(payload!.sub)))) return oauthError(c, 400, 'invalid_grant', 'This assertion is expired, revoked or unknown: register again.')
          if (!registration.claimed) return oauthError(c, 400, 'invalid_grant', 'Not claimed yet: an unclaimed registration has no scopes. Run the claim (auth.md step B2).')
          return c.json(await issue(origin, { client: String(payload!.sub), name: String(registration.name), owner: String(registration.owner), scopes: [...SCOPES] }), 200, { 'cache-control': 'no-store' })
        }
        default:
          return oauthError(c, 400, 'unsupported_grant_type', `grant_type must be one of: authorization_code, refresh_token, ${JWT_BEARER}, ${CLAIM_GRANT}.`)
      }
    })

    // RFC 7009: always 200, whatever the token was
    app.post('/oauth/revoke', async (c) => {
      const body = await bodyOf(c)
      const value = body.token ?? ''
      const refresh = await store.get('refresh', sha(value))
      if (refresh) await store.delete('refresh', sha(value))
      const { publicKey } = await ready
      const { payload } = await jwtVerify(value, publicKey, { issuer: originOf(c), algorithms: ['ES256'] }).catch(() => ({ payload: null }))
      if (typeof payload?.jti === 'string') await store.delete('access', payload.jti)
      return c.body(null, 200, { 'cache-control': 'no-store' })
    })
  }

  /** Revokes every token a client or agent registration holds (the owner's kill switch). */
  const revokeClient = (clientId: string) => store.put('revoked-client', clientId, {}, now() + REFRESH_TTL)

  return { mount, verify, resourceMetadataFor, revokeClient, authorizationServer, protectedResource, authMd }
}

export type OAuth = ReturnType<typeof createOAuth>

