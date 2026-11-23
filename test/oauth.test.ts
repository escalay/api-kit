import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { SignJWT, decodeJwt, importJWK } from 'jose'
import { count, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { createAgentApi, createBrand, createOAuth, defineBrand, generateOAuthKey, matches, memoryGuardStore, memoryOAuthStore, memoryStore, oauthKeys, originOf, parseApiKeys, dbOAuthStore, openDb, rateLimit, serveGuide, testDb, type OAuthStore, type SignInAsk } from '../src/index.js'
import { ASSETS, cookbookApi } from './brand-fixture.js'
import { approveSignIn } from '../src/testing/index.js'
import { approvedCode, audOf, authorizeQuery, browserOf, callerWith, formWithTwoResources, joinApp, oauthApp, oauthStoreContract, refreshWith, registered, signedIn, ticketIn, typeClaim } from './oauth-store-contract.js'

const OWNER = 'owner@example.test'
const ORIGIN = 'http://localhost'

const sampleApi = async (store: OAuthStore = memoryOAuthStore()) => {
  const oauth = createOAuth({
    name: 'Sample',
    signingKey: await generateOAuthKey(),
    store,
    // The test stands in for the single sign-on: a header says who is signed in
    owner: async (c) => c.req.header('x-test-owner') ?? null,
    owners: [OWNER],
  })
  const app = createAgentApi({
    title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys('') }, oauth,
    discovery: { sitemap: ['/', '/llms.txt'], poppy: { name: 'Sample', apis: [{ type: 'openapi', path: '/openapi.json', description: 'The API' }], scopes: { read: { description: 'Read', changes: 'none', personalData: false } } } },
  })
  app.get('/api/v1/things', (c) => c.json({ things: [], caller: c.get('caller' as never) }))
  app.post('/api/v1/things', (c) => c.json({ saved: true }, 201))
  app.post('/mcp', (c) => c.json({ ok: true }))
  return { app, oauth }
}

const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

describe('OAuth for agents', () => {
  it('publishes the metadata the discovery specs ask for', async () => {
    const { app } = await sampleApi()
    const prm = await (await app.request('/.well-known/oauth-protected-resource')).json()
    expect(prm).toMatchObject({ resource: ORIGIN, authorization_servers: [ORIGIN], scopes_supported: ['read', 'write'], bearer_methods_supported: ['header'] })
    expect((await (await app.request('/.well-known/oauth-protected-resource/mcp')).json()).resource).toBe(`${ORIGIN}/mcp`)
    const as = await (await app.request('/.well-known/oauth-authorization-server')).json()
    expect(as).toMatchObject({ issuer: ORIGIN, jwks_uri: `${ORIGIN}/.well-known/jwks.json`, code_challenge_methods_supported: ['S256'], agent_auth: { skill: `${ORIGIN}/auth.md`, register_uri: `${ORIGIN}/agent/identity`, identity_types_supported: ['anonymous', 'service_auth'], anonymous: { credential_types_supported: ['identity_assertion'] } } })
    expect(as).toMatchObject({ device_authorization_endpoint: `${ORIGIN}/oauth/device_authorization`, grant_types_supported: expect.arrayContaining(['refresh_token', 'urn:ietf:params:oauth:grant-type:device_code']) })
    expect((await (await app.request('/.well-known/jwks.json')).json()).keys[0]).toMatchObject({ kty: 'EC', alg: 'ES256', use: 'sig' })
    expect((await (await app.request('/.well-known/jwks.json')).json()).keys[0].d).toBeUndefined()
    const md = await app.request('/auth.md')
    expect(md.headers.get('content-type')).toContain('text/markdown')
    const text = await md.text()
    expect(text).toMatch(/^# Sample auth\.md/)
    expect(text).toContain('/oauth/device_authorization')
  })

  it('names no example resource in the scopes of the OpenAPI document', async () => {
    const { app } = await sampleApi()
    const doc = await (await app.request('/openapi.json')).json()
    expect(doc.components.securitySchemes.oauth.flows.authorizationCode.scopes).toEqual({ read: 'Read everything', write: 'Make changes' })
  })

  it('publishes a sitemap and a Personal Agent Protocol document bound to the issuer', async () => {
    const { app } = await sampleApi()
    expect(await (await app.request('/sitemap.xml')).text()).toContain(`<loc>${ORIGIN}/llms.txt</loc>`)
    expect(await (await app.request('/robots.txt')).text()).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`)
    const poppy = await (await app.request('/.well-known/poppy.json')).json()
    expect(poppy).toMatchObject({ protocol_version: '0.3', organization: { name: 'Sample', domain: 'localhost' }, auth: { issuer: ORIGIN, scopes: { read: 'Read' } }, apis: [{ type: 'openapi', url: `${ORIGIN}/openapi.json` }] })
    const as = await (await app.request('/.well-known/oauth-authorization-server')).json()
    expect(as).toMatchObject({ issuer: poppy.auth.issuer, poppy_domains: ['localhost'], protected_resources: [ORIGIN, `${ORIGIN}/mcp`] })
  })

  it('points a 401 at the protected-resource metadata, per path', async () => {
    const { app } = await sampleApi()
    expect((await app.request('/api/v1/things')).headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`)
    expect((await app.request('/mcp', { method: 'POST' })).headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`)
    expect((await app.request('/mcpx', { method: 'POST' })).headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`)

    // MCP mounted elsewhere: the pointer, the metadata, the listed resources and the relay follow mcpPath
    const { app: moved } = await oauthApp(memoryOAuthStore(), { mcpPath: '/ai/mcp' })
    moved.post('/ai/mcp', (c) => c.json({ ok: true }))
    expect((await moved.request('/ai/mcp', { method: 'POST' })).headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/ai/mcp"`)
    expect((await (await moved.request('/.well-known/oauth-protected-resource/ai/mcp')).json()).resource).toBe(`${ORIGIN}/ai/mcp`)
    expect((await (await moved.request('/.well-known/oauth-authorization-server')).json()).protected_resources).toEqual([ORIGIN, `${ORIGIN}/ai/mcp`])
    const { exchange } = await approvedCode(moved, { resource: `${ORIGIN}/ai/mcp`, scope: 'read' })
    const readOnly = await (await exchange()).json()
    expect(audOf(readOnly.access_token)).toBe(`${ORIGIN}/ai/mcp`)
    expect((await moved.request('/ai/mcp', { method: 'POST', headers: { authorization: `Bearer ${readOnly.access_token}` } })).status).toBe(200)
  })

  it('answers 401, never 500, when the forwarded host is no host at all', async () => {
    const { app } = await sampleApi()
    for (const host of ['exa mple.test', '[::1', 'example.test:abc']) {
      for (const [path, method, suffix] of [['/api/v1/things', 'GET', ''], ['/mcp', 'POST', '/mcp']] as const) {
        for (const authorization of [undefined, 'Bearer a.b.c']) {
          const answer = await app.request(path, { method, headers: { 'x-forwarded-host': host, ...(authorization ? { authorization } : {}) } })
          expect(answer.status, `${host} ${path} ${authorization}`).toBe(401)
          expect(answer.headers.get('www-authenticate')).toContain(`/.well-known/oauth-protected-resource${suffix}"`)
        }
      }
    }
  })

  it('runs authorization code with PKCE, refresh and revocation, with the owner approving', async () => {
    const { app } = await sampleApi()
    const registered = await app.request('/oauth/register', json({ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }))
    expect(registered.status).toBe(201)
    const { client_id } = await registered.json()
    expect((await app.request('/oauth/register', json({ redirect_uris: ['javascript:alert(1)'] }))).status).toBe(400)

    const { verifier, challenge } = pkce()
    const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_challenge: challenge, code_challenge_method: 'S256', state: 's1', scope: 'read write' })
    expect((await app.request(`/oauth/authorize?${query}`)).status).toBe(401)
    const browser = browserOf(app, { 'x-test-owner': OWNER })
    const consent = await browser.request(`/oauth/authorize?${query}`)
    const html = await consent.text()
    expect(html).toContain('Allow <strong>Claude</strong>')
    const ticket = /name="ticket" value="([^"]+)"/.exec(html)![1]!
    // Another site can't approve through the owner's session
    expect((await browser.post('/oauth/authorize', { ticket, decision: 'allow' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    const approved = await browser.post('/oauth/authorize', { ticket, decision: 'allow' })
    const back = new URL(approved.headers.get('location')!)
    expect(back.searchParams.get('state')).toBe('s1')
    expect(back.searchParams.get('iss')).toBe(ORIGIN)
    const code = back.searchParams.get('code')!

    expect((await app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: 'wrong' }))).status).toBe(400)
    // A code is single use, even after a failed exchange
    expect((await (await app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id, redirect_uri: 'https://claude.ai/api/mcp/auth_callback', code_verifier: verifier }))).json()).error).toBe('invalid_grant')
  })

  it('issues tokens that work on the API, rotate, and stop working when revoked', async () => {
    const { app } = await sampleApi()
    const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Cursor', redirect_uris: ['http://localhost:7777/cb'] }))).json()
    const { verifier, challenge } = pkce()
    const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://localhost:7777/cb', code_challenge: challenge, code_challenge_method: 'S256', scope: 'read' })
    const location = (await approveSignIn(app, query, { headers: { 'x-test-owner': OWNER } })).headers.get('location')!
    const tokens = await (await app.request('/oauth/token', form({ grant_type: 'authorization_code', code: new URL(location).searchParams.get('code')!, client_id, redirect_uri: 'http://localhost:7777/cb', code_verifier: verifier }))).json()
    expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'read' })

    const auth = { authorization: `Bearer ${tokens.access_token}` }
    const read = await app.request('/api/v1/things', { headers: auth })
    expect(read.status).toBe(200)
    expect((await read.json()).caller).toMatchObject({ kind: 'agent', name: 'Cursor', owner: OWNER, scopes: ['read'] })
    // read alone can't change anything, but it can use MCP, which relays each call to a route that checks again
    expect((await app.request('/api/v1/things', { method: 'POST', headers: auth })).status).toBe(403)
    expect((await app.request('/mcp', { method: 'POST', headers: auth })).status).toBe(200)

    const rotated = await (await app.request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))).json()
    expect(rotated.access_token).toBeTruthy()

    expect((await app.request('/oauth/revoke', form({ token: tokens.access_token }))).status).toBe(200)
    expect((await app.request('/api/v1/things', { headers: auth })).status).toBe(401)
    expect((await app.request('/api/v1/things', { headers: { authorization: `Bearer ${rotated.access_token}` } })).status).toBe(200)

    // A used refresh token sent again ends the whole grant, its access tokens at once
    expect((await app.request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))).status).toBe(400)
    expect((await app.request('/api/v1/things', { headers: { authorization: `Bearer ${rotated.access_token}` } })).status).toBe(401)
  })

  it('registers an agent by auth.md and grants nothing until the owner types its code', async () => {
    const { app } = await sampleApi()
    const registration = await (await app.request('/agent/identity', json({ type: 'anonymous', client_name: 'Research bot' }))).json()
    expect(registration).toMatchObject({ registration_type: 'anonymous', pre_claim_scopes: [], post_claim_scopes: ['read', 'write'] })
    // Unclaimed, the assertion buys nothing
    expect((await (await app.request('/oauth/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: registration.identity_assertion }))).json()).error).toBe('invalid_grant')
    expect((await app.request('/agent/identity/claim', json({ claim_token: registration.claim_token, email: 'someone@else.test' }))).status).toBe(403)

    const { claim_attempt } = await (await app.request('/agent/identity/claim', json({ claim_token: registration.claim_token, email: OWNER }))).json()
    expect(claim_attempt).toMatchObject({ expires_in: 600, interval: 5 })
    const poll = () => app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: registration.claim_token }))
    expect((await (await poll()).json()).error).toBe('authorization_pending')

    const attemptToken = new URL(claim_attempt.verification_uri).searchParams.get('claim_attempt_token')!
    const signedIn = { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' }
    expect(await (await app.request(`/oauth/claim?claim_attempt_token=${attemptToken}`, { headers: signedIn })).text()).toContain('Research bot')
    expect((await app.request('/oauth/claim', { ...form({ claim_attempt_token: attemptToken, user_code: '000000' === claim_attempt.user_code ? '111111' : '000000' }), headers: signedIn })).status).toBe(400)
    expect((await app.request('/oauth/claim', { ...form({ claim_attempt_token: attemptToken, user_code: claim_attempt.user_code }), headers: signedIn })).status).toBe(200)

    const granted = await (await poll()).json()
    expect(granted).toMatchObject({ token_type: 'Bearer', scope: 'read write' })
    expect((await app.request('/api/v1/things', { method: 'POST', headers: { authorization: `Bearer ${granted.access_token}` } })).status).toBe(201)
    const again = await (await app.request('/oauth/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: granted.identity_assertion }))).json()
    expect(again.access_token).toBeTruthy()
  })

  it('gives a claimed agent a refresh token that rotates, and revokes the sign-in when a used one comes back', async () => {
    const { app, oauth } = await sampleApi()
    const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Night shift' }))).json()
    const attemptToken = new URL(registration.claim.verification_uri).searchParams.get('claim_attempt_token')!
    await app.request('/oauth/claim', { ...form({ claim_attempt_token: attemptToken, user_code: registration.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
    const granted = await (await app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: registration.claim_token }))).json()
    expect(granted.refresh_token).toMatch(/^rt_/)

    const refresh = (token: string) => app.request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: token }))
    const first = await (await refresh(granted.refresh_token)).json()
    expect(first).toMatchObject({ token_type: 'Bearer', scope: 'read write' })
    expect(first.refresh_token).not.toBe(granted.refresh_token)
    expect((await app.request('/api/v1/things', { headers: { authorization: `Bearer ${first.access_token}` } })).status).toBe(200)
    const second = await (await refresh(first.refresh_token)).json()
    expect(second.refresh_token).toBeTruthy()

    // A used token sent again (stolen, or a retry): refused, and so is the newest one of the same sign-in
    const replay = await (await refresh(first.refresh_token)).json()
    expect(replay).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') })
    expect((await (await refresh(second.refresh_token)).json()).error).toBe('invalid_grant')

    // The identity assertion is part of that same sign-in, so it is refused too, never answered with a dead token
    const other = await (await app.request('/oauth/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: granted.identity_assertion }))).json()
    expect(other.error).toBe('invalid_grant')
    // Another agent's sign-in is untouched by that, and the owner's kill switch ends it
    const registration2 = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER }))).json()
    const attempt2 = new URL(registration2.claim.verification_uri).searchParams.get('claim_attempt_token')!
    await app.request('/oauth/claim', { ...form({ claim_attempt_token: attempt2, user_code: registration2.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
    const granted2 = await (await app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: registration2.claim_token }))).json()
    expect((await app.request('/api/v1/things', { headers: { authorization: `Bearer ${granted2.access_token}` } })).status).toBe(200)
    expect((await (await app.request('/oauth/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: granted2.identity_assertion }))).json()).access_token).toBeTruthy()
    await oauth.revokeClient(registration2.registration_id)
    expect((await refresh(granted2.refresh_token)).status).toBe(400)
  })

  it('revokes the whole sign-in when a refresh token is revoked, and still rotates a token stored before families', async () => {
    const store = memoryOAuthStore()
    const oauth = createOAuth({ name: 'Sample', signingKey: await generateOAuthKey(), store, owner: async () => null })
    const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys('') }, oauth })
    const legacy = 'rt_from-an-older-kit'
    await store.put('refresh', createHash('sha256').update(legacy).digest('hex'), { client: 'c1', name: 'Old', owner: OWNER, scopes: ['read'] }, Math.floor(Date.now() / 1000) + 3600)
    const rotated = await (await app.request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: legacy }))).json()
    expect(rotated).toMatchObject({ scope: 'read', refresh_token: expect.stringMatching(/^rt_/) })
    // Revoking any token of the sign-in, even a used one, ends its newest
    expect((await app.request('/oauth/revoke', form({ token: legacy }))).status).toBe(200)
    const next = await (await app.request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: rotated.refresh_token }))).json()
    expect(next.error).toBe('invalid_grant')
  })

  describe('device authorization (RFC 8628)', () => {
    const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code'
    afterEach(() => vi.useRealTimers())
    // Only Date moves: jose and the store read it, and async crypto keeps working
    const clock = () => {
      let at = Date.now()
      vi.useFakeTimers({ toFake: ['Date'], now: at })
      return (seconds: number) => vi.setSystemTime((at += seconds * 1000))
    }
    const signedIn = (owner = OWNER) => ({ 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': owner, 'sec-fetch-site': 'same-origin' })
    const start = async (app: Awaited<ReturnType<typeof sampleApi>>['app'], scope = 'read write', name = 'Terminal') => {
      const registered = await app.request('/oauth/register', json({ client_name: name, grant_types: [DEVICE] }))
      expect(registered.status).toBe(201)
      const client = await registered.json()
      expect(client.grant_types).toEqual(['refresh_token', DEVICE])
      const started = await app.request('/oauth/device_authorization', form({ client_id: client.client_id, scope }))
      expect(started.headers.get('cache-control')).toBe('no-store')
      const device = await started.json()
      const poll = () => app.request('/oauth/token', form({ grant_type: DEVICE, device_code: device.device_code, client_id: client.client_id }))
      const decide = (decision: string, code = device.user_code, owner = OWNER) => app.request('/oauth/device', { ...form({ user_code: code, decision }), headers: signedIn(owner) })
      return { client, device, poll, decide }
    }

    it('hands out a code, waits for the owner, then issues tokens once', async () => {
      const tick = clock()
      const { app } = await sampleApi()
      const { device, poll, decide } = await start(app)
      expect(device).toMatchObject({ device_code: expect.stringMatching(/^dc_/), verification_uri: `${ORIGIN}/oauth/device`, expires_in: 600, interval: 5 })
      expect(device.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
      expect(device.verification_uri_complete).toBe(`${ORIGIN}/oauth/device?user_code=${device.user_code}`)

      expect(await (await poll()).json()).toMatchObject({ error: 'authorization_pending' })
      // The page asks for sign-in, then shows who is asking, from the complete link, lower case and all
      expect((await app.request('/oauth/device')).status).toBe(401)
      expect(await (await app.request('/oauth/device', { headers: signedIn() })).text()).toContain('name="user_code"')
      const consent = await app.request(`/oauth/device?user_code=${device.user_code.toLowerCase()}`, { headers: signedIn() })
      expect(await consent.text()).toContain('Allow <strong>Terminal</strong>')
      // Another site can't approve through the owner's session
      expect((await app.request('/oauth/device', { ...form({ user_code: device.user_code, decision: 'allow' }), headers: { ...signedIn(), 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
      expect((await decide('allow')).status).toBe(200)
      // The typed code is single use
      expect((await decide('allow')).status).toBe(400)

      tick(5)
      const tokens = await (await poll()).json()
      expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'read write', refresh_token: expect.stringMatching(/^rt_/) })
      const read = await app.request('/api/v1/things', { headers: { authorization: `Bearer ${tokens.access_token}` } })
      expect((await read.json()).caller).toMatchObject({ kind: 'agent', name: 'Terminal', owner: OWNER, scopes: ['read', 'write'] })
      // The device code is single use too
      tick(5)
      expect((await (await poll()).json()).error).toBe('invalid_grant')
    })

    it('keeps the owner’s answer when a poll lands at the same moment', async () => {
      const tick = clock()
      const inner = memoryOAuthStore()
      const during: { run?: () => unknown } = {}
      // The approval lands between a poll's read of the device row and its write
      const store: OAuthStore = {
        ...inner,
        put: async (kind, id, value, expiresAt) => {
          const run = kind === 'device' && Number(value.polledAt) > 0 ? during.run : undefined
          during.run = undefined
          if (run) await run()
          return inner.put(kind, id, value, expiresAt)
        },
      }
      const { app } = await sampleApi(store)
      const { poll, decide } = await start(app)
      during.run = () => decide('allow')
      expect((await (await poll()).json()).error).toBe('authorization_pending')
      tick(5)
      expect((await (await poll()).json()).access_token).toBeTruthy()
    })

    it('keeps only hashes of device codes, user codes and refresh tokens', async () => {
      const tick = clock()
      const inner = memoryOAuthStore()
      const kept: string[] = []
      const store: OAuthStore = { ...inner, put: async (kind, id, value, expiresAt) => (kept.push(id, JSON.stringify(value)), inner.put(kind, id, value, expiresAt)) }
      const { app } = await sampleApi(store)
      const { device, poll, decide } = await start(app)
      await decide('allow')
      tick(5)
      const tokens = await (await poll()).json()
      const rotated = await (await app.request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))).json()
      const secrets = [device.device_code, device.user_code, device.user_code.replace('-', ''), tokens.refresh_token, rotated.refresh_token]
      for (const secret of secrets) expect(kept.filter((entry) => entry.includes(secret)), secret).toEqual([])
    })

    it('says access_denied when the owner says no', async () => {
      clock()
      const { app } = await sampleApi()
      const { poll, decide } = await start(app, 'read')
      const denied = await decide('deny')
      expect([denied.status, await denied.text()]).toEqual([200, expect.stringContaining('Denied')])
      expect((await (await poll()).json()).error).toBe('access_denied')
    })

    it('says slow_down to a device polling faster than the interval, and raises it', async () => {
      const tick = clock()
      const { app } = await sampleApi()
      const { poll } = await start(app)
      expect((await (await poll()).json()).error).toBe('authorization_pending')
      tick(2)
      expect(await (await poll()).json()).toMatchObject({ error: 'slow_down', interval: 10 })
      tick(6)
      expect((await (await poll()).json()).error).toBe('slow_down')
      tick(15)
      expect((await (await poll()).json()).error).toBe('authorization_pending')
    })

    it('says expired_token after ten minutes, and the code no longer opens the page', async () => {
      const tick = clock()
      const { app } = await sampleApi()
      const { poll, decide } = await start(app)
      tick(601)
      expect((await decide('allow')).status).toBe(400)
      expect((await (await poll()).json()).error).toBe('expired_token')
    })

    it('refuses an unregistered client, a stranger, and a sixth wrong code', async () => {
      clock()
      const { app } = await sampleApi()
      expect((await (await app.request('/oauth/device_authorization', form({ client_id: 'client_nope' }))).json()).error).toBe('invalid_client')
      expect((await app.request('/oauth/register', json({ client_name: 'No way back' }))).status).toBe(400)
      const { decide } = await start(app)
      // Only the owners the server names may approve
      expect((await decide('allow', undefined, 'someone@else.test')).status).toBe(403)
      for (let tries = 0; tries < 5; tries++) expect((await decide('allow', 'AAAA-AAAA')).status).toBe(400)
      expect((await decide('allow')).status).toBe(429)
    })
  })

  it('lets the owner revoke an agent outright', async () => {
    const { app, oauth } = await sampleApi()
    const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER }))).json()
    const attemptToken = new URL(registration.claim.verification_uri).searchParams.get('claim_attempt_token')!
    await app.request('/oauth/claim', { ...form({ claim_attempt_token: attemptToken, user_code: registration.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
    const granted = await (await app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: registration.claim_token }))).json()
    await oauth.revokeClient(registration.registration_id)
    expect((await app.request('/api/v1/things', { headers: { authorization: `Bearer ${granted.access_token}` } })).status).toBe(401)
    expect((await app.request('/oauth/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: granted.identity_assertion }))).status).toBe(400)
  })
})

describe('OAuth callers: the client and the grant, not the name', () => {
  const claimed = async (app: Awaited<ReturnType<typeof oauthApp>>['app'], name = 'Night shift') => {
    const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: name }))).json()
    const attemptToken = new URL(registration.claim.verification_uri).searchParams.get('claim_attempt_token')!
    await app.request('/oauth/claim', { ...form({ claim_attempt_token: attemptToken, user_code: registration.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
    const granted = await (await app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: registration.claim_token }))).json()
    return { registration, granted }
  }
  const bearer = (app: Awaited<ReturnType<typeof oauthApp>>['app'], assertion: string) => app.request('/oauth/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }))
  const callerOf = async (app: Awaited<ReturnType<typeof oauthApp>>['app'], accessToken: string) => (await (await callerWith(app, accessToken)).json()).caller

  it('names an agent by its client_id and grant, with its registered name for display', async () => {
    const { app } = await oauthApp(memoryOAuthStore())
    const { client_id, tokens } = await signedIn(app, { name: 'Sample' })
    expect(await callerOf(app, tokens.access_token)).toEqual({ kind: 'agent', name: 'Sample', client: client_id, grant: expect.any(String), scopes: ['read', 'write'], owner: OWNER, resource: ORIGIN })
  })

  it('keeps two clients that register the same name apart: their rate windows and idempotency answers', async () => {
    const { app } = await oauthApp(memoryOAuthStore())
    let notes = 0
    app.use('/api/v1/notes', rateLimit({ policy: 'notes', limit: 1, windowSeconds: 60 }))
    app.post('/api/v1/notes', (c) => c.json({ count: ++notes }, 201))
    const one = await signedIn(app, { name: 'Sample' })
    const two = await signedIn(app, { name: 'Sample' })
    const callers = [await callerOf(app, one.tokens.access_token), await callerOf(app, two.tokens.access_token)]
    expect(callers[0].client).not.toBe(callers[1].client)
    expect(callers[0].grant).not.toBe(callers[1].grant)
    const post = (accessToken: string) => app.request('/api/v1/notes', { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': 'same-key', 'content-type': 'application/json' }, body: '{}' })
    const first = await post(one.tokens.access_token)
    const second = await post(two.tokens.access_token)
    expect([first.status, second.status]).toEqual([201, 201])
    expect(second.headers.get('idempotent-replayed')).toBeNull()
    expect([await first.json(), await second.json()]).toEqual([{ count: 1 }, { count: 2 }])
    expect((await app.request('/api/v1/notes', { method: 'POST', headers: { authorization: `Bearer ${one.tokens.access_token}` } })).status).toBe(429)
  })

  it('never replays the token endpoint: tokens are not kept, and a code sent twice is a real second exchange', async () => {
    const { app } = await oauthApp(memoryOAuthStore())
    const { client_id, code, verifier } = await approvedCode(app)
    const exchange = () => app.request('/oauth/token', { ...form({ grant_type: 'authorization_code', code, client_id, redirect_uri: 'http://localhost:7777/cb', code_verifier: verifier }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': 'exchange-1' } })
    const first = await exchange()
    expect(first.status).toBe(200)
    expect((await first.json()).access_token).toBeTruthy()
    const second = await exchange()
    expect(second.headers.get('idempotent-replayed')).toBeNull()
    const body = await second.json()
    expect(body.error).toBe('invalid_grant')
    expect(body.access_token).toBeUndefined()
  })

  it('makes a revoked client register again', async () => {
    const { app, oauth } = await oauthApp(memoryOAuthStore())
    const { client_id, tokens } = await signedIn(app)
    await oauth.revokeClient(client_id)
    expect((await callerWith(app, tokens.access_token)).status).toBe(401)
    expect((await refreshWith(app, tokens.refresh_token)).status).toBe(400)
    const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://localhost:7777/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })
    const page = await app.request(`/oauth/authorize?${query}`, { headers: { 'x-test-owner': OWNER } })
    expect([page.status, await page.text()]).toEqual([400, expect.stringContaining('not registered')])
    // Registering again gives a new id that works
    const again = await signedIn(app)
    expect(again.client_id).not.toBe(client_id)
    expect((await callerWith(app, again.tokens.access_token)).status).toBe(200)
  })

  it('gives a claimed agent one grant across its claim, refresh and jwt-bearer tokens', async () => {
    const { app } = await oauthApp(memoryOAuthStore())
    const { registration, granted } = await claimed(app)
    const fromClaim = await callerOf(app, granted.access_token)
    expect(fromClaim).toMatchObject({ client: registration.registration_id, grant: expect.any(String), name: 'Night shift' })
    const fromBearer = await callerOf(app, (await (await bearer(app, granted.identity_assertion)).json()).access_token)
    const fromRefresh = await callerOf(app, (await (await refreshWith(app, granted.refresh_token)).json()).access_token)
    expect([fromBearer.grant, fromRefresh.grant]).toEqual([fromClaim.grant, fromClaim.grant])
  })

  it('refuses a claimed agent’s identity assertion once its grant is revoked, never handing out a dead token', async () => {
    const { app, oauth } = await oauthApp(memoryOAuthStore())
    const replayed = await claimed(app)
    expect((await refreshWith(app, replayed.granted.refresh_token)).status).toBe(200)
    expect((await refreshWith(app, replayed.granted.refresh_token)).status).toBe(400)
    expect(await (await bearer(app, replayed.granted.identity_assertion)).json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('revoked') })

    const revoked = await claimed(app)
    await oauth.revokeGrant((await callerOf(app, revoked.granted.access_token)).grant)
    expect((await (await bearer(app, revoked.granted.identity_assertion)).json()).error).toBe('invalid_grant')
  })

  it('keeps a revoke marker longer than anything issued behind it', async () => {
    const inner = memoryOAuthStore()
    const expiries: Record<string, number> = {}
    const store: OAuthStore = { ...inner, put: async (kind, id, value, expiresAt) => ((expiries[kind] = expiresAt), inner.put(kind, id, value, expiresAt)) }
    const { app, oauth } = await oauthApp(store)
    const { client_id, tokens } = await signedIn(app)
    await oauth.revokeGrant((await callerOf(app, tokens.access_token)).grant)
    await oauth.revokeClient(client_id)
    // A code or a device approval still waiting can be collected, and its refresh token lives 30 days from then
    const latest = expiries.refresh! + 10 * 60 + 10 * 60
    expect(expiries['revoked-family']).toBeGreaterThanOrEqual(latest)
    expect(expiries['revoked-client']).toBeGreaterThanOrEqual(latest)
  })

  it('takes one approval per registration, so the claim, refresh and jwt-bearer tokens share one grant', async () => {
    const { app, oauth } = await oauthApp(memoryOAuthStore())
    const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Night shift' }))).json()
    const { claim_attempt } = await (await app.request('/agent/identity/claim', json({ claim_token: registration.claim_token }))).json()
    const type = (attempt: { verification_uri: string; user_code: string }) =>
      app.request('/oauth/claim', { ...form({ claim_attempt_token: new URL(attempt.verification_uri).searchParams.get('claim_attempt_token')!, user_code: attempt.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
    expect((await type(registration.claim)).status).toBe(200)
    const granted = await (await app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: registration.claim_token }))).json()
    const second = await type(claim_attempt)
    expect([second.status, await second.text()]).toEqual([409, expect.stringContaining('Already approved')])

    const refreshed = await (await refreshWith(app, granted.refresh_token)).json()
    const bearing = await (await bearer(app, granted.identity_assertion)).json()
    const grants = await Promise.all([granted, refreshed, bearing].map(async (one) => (await callerOf(app, one.access_token)).grant))
    expect(new Set(grants).size).toBe(1)
    await oauth.revokeGrant(grants[0])
    for (const one of [granted, refreshed, bearing]) expect((await callerWith(app, one.access_token)).status).toBe(401)
    expect((await (await refreshWith(app, refreshed.refresh_token)).json()).error).toBe('invalid_grant')
    expect((await (await bearer(app, granted.identity_assertion)).json()).error).toBe('invalid_grant')
  })

  it('uses a claimed registration’s id as the grant when it was claimed before grants', async () => {
    const store = memoryOAuthStore()
    const { app } = await oauthApp(store)
    const { registration, granted } = await claimed(app)
    const { family: _family, ...before } = (await store.get('registration', registration.registration_id))!
    await store.put('registration', registration.registration_id, before, Math.floor(Date.now() / 1000) + 3600)
    const caller = await callerOf(app, (await (await bearer(app, granted.identity_assertion)).json()).access_token)
    expect(caller).toMatchObject({ client: registration.registration_id, grant: registration.registration_id })
  })

  it('accepts an access token from before grants, known by its client', async () => {
    const store = memoryOAuthStore()
    const signingKey = await generateOAuthKey()
    const { app } = await oauthApp(store, { signingKey })
    const jti = 'jti-from-an-older-kit'
    await store.put('access', jti, { client: 'client_old' }, Math.floor(Date.now() / 1000) + 3600)
    const old = await new SignJWT({ sub: OWNER, client_id: 'client_old', name: 'Old', scope: 'read', jti })
      .setProtectedHeader({ alg: 'ES256' }).setIssuer(ORIGIN).setIssuedAt().setExpirationTime('1h').sign(await importJWK(JSON.parse(signingKey), 'ES256'))
    const caller = await callerOf(app, old)
    expect(caller).toMatchObject({ kind: 'agent', name: 'Old', client: 'client_old', scopes: ['read'] })
    expect(caller.grant).toBeUndefined()
  })

  it('still works on a store without take and markUsed, one request at a time', async () => {
    const { app } = await oauthApp(memoryStore())
    const { exchange } = await approvedCode(app)
    const tokens = await (await exchange()).json()
    expect((await callerWith(app, tokens.access_token)).status).toBe(200)
    expect((await exchange()).status).toBe(400)
    expect((await callerWith(app, tokens.access_token)).status).toBe(401)
    const { tokens: fresh } = await signedIn(app)
    const rotated = await (await refreshWith(app, fresh.refresh_token)).json()
    expect((await callerWith(app, rotated.access_token)).status).toBe(200)
    expect((await (await refreshWith(app, fresh.refresh_token)).json()).error).toBe('invalid_grant')
    expect((await callerWith(app, rotated.access_token)).status).toBe(401)

    const { registration, granted } = await claimed(app)
    expect(granted.access_token).toBeTruthy()
    const claimPoll = () => app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: registration.claim_token }))
    expect((await (await claimPoll()).json()).error).toBe('expired_token')

    const device = 'urn:ietf:params:oauth:grant-type:device_code'
    const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
    const { device_code, user_code } = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
    await app.request('/oauth/device', { ...form({ user_code, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
    const devicePoll = () => app.request('/oauth/token', form({ grant_type: device, device_code, client_id }))
    expect((await (await devicePoll()).json()).access_token).toBeTruthy()
    expect((await (await devicePoll()).json()).error).toBe('invalid_grant')
  })
})

describe('OAuth audiences: each token bound to the resource it was asked for (RFC 8707, RFC 9728)', () => {
  const ALPHA = `${ORIGIN}/s/alpha/mcp`
  const BETA = `${ORIGIN}/s/beta/mcp`

  /** An app with one MCP resource per space (`/s/<name>/mcp`), the oauth README's example as written; a test header stands in for how the app knows which resource an in-process call serves (`spaceOf`), which a real app makes something no client can set. */
  const spacesApi = async () => {
    const spaceOf = (c: Context) => c.req.header('x-test-resource')
    const SPACE = /^\/s\/[a-z0-9-]+\/mcp/
    const resourceOf = (c: Context) =>
      oauth.rootOf(c) + (SPACE.exec(c.req.path)?.[0] ?? (c.req.path === oauth.mcpPath || c.req.path.startsWith(oauth.mcpPath + '/') ? oauth.mcpPath : ''))
    const oauth = createOAuth({
      name: 'Sample',
      signingKey: await generateOAuthKey(),
      store: memoryOAuthStore(),
      owner: async (c) => c.req.header('x-test-owner') ?? null,
      owners: [OWNER],
      // A pure check of the path: the kit has checked the origin, and the metadata path asks it too
      resources: (path) => /^\/s\/[a-z0-9-]+\/mcp$/.test(path),
      resourceOf,                                                  // where a 401 points (RFC 9728 §3.3)
      accepts: async (caller, c) => {
        // The path decides at an MCP address, a space's or mcpPath. Elsewhere, as in a tool's in-process /api call, the
        // path names none: only then does the app read the space the call carries (`spaceOf`)
        const root = oauth.rootOf(c)
        const here = resourceOf(c) === root ? (spaceOf(c) ?? root) : resourceOf(c)
        // An aud-less, root or mcpPath token works everywhere, as with the default
        return !caller.resource || caller.resource === root || caller.resource === root + oauth.mcpPath || caller.resource === here || `This token is for ${caller.resource}, not ${here}: connect again there.`
      },
    })
    const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys('') }, oauth })
    app.get('/api/v1/things', (c) => c.json({ caller: c.get('caller' as never) }))
    app.post('/s/:name/mcp', async (c) => {
      // A tool calling the API in-process with the same bearer
      const inner = await app.request('/api/v1/things', { headers: { authorization: c.req.header('authorization') ?? '', 'x-test-resource': resourceOf(c) } })
      return c.json({ api: inner.status })
    })
    // The single MCP calls the API in-process too, carrying no space
    app.post('/mcp', async (c) => c.json({ api: (await app.request('/api/v1/things', { headers: { authorization: c.req.header('authorization') ?? '' } })).status }))
    return { app, oauth }
  }
  type App = Awaited<ReturnType<typeof oauthApp>>['app']
  const authorizeWith = async (app: App, resources: string[]) => {
    const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Sample', redirect_uris: ['http://localhost:7777/cb'] }))).json()
    const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://localhost:7777/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })
    for (const resource of resources) query.append('resource', resource)
    return app.request(`/oauth/authorize?${query}`, { headers: { 'x-test-owner': OWNER } })
  }
  const refusedAtAuthorize = async (app: App, resource: string) => {
    const page = await authorizeWith(app, [resource])
    expect([page.status, page.headers.get('location')], resource).toEqual([400, null])
    expect(await page.text(), resource).toContain('invalid_target')
  }
  const audienceFor = async (app: App, resource: string) => audOf((await (await (await approvedCode(app, { resource })).exchange({ resource })).json()).access_token)

  it('lets a token asked for one resource work there, in-process calls included, and nowhere else', async () => {
    const { app } = await spacesApi()
    const { exchange } = await approvedCode(app, { resource: ALPHA })
    const tokens = await (await exchange({ resource: ALPHA })).json()
    expect(audOf(tokens.access_token)).toBe(ALPHA)
    const auth = { authorization: `Bearer ${tokens.access_token}` }
    const here = await app.request('/s/alpha/mcp', { method: 'POST', headers: auth })
    expect([here.status, await here.json()]).toEqual([200, { api: 200 }])
    const there = await app.request('/s/beta/mcp', { method: 'POST', headers: auth })
    expect(there.status).toBe(401)
    expect(there.headers.get('www-authenticate')).toContain('error="invalid_token"')
    expect(there.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/s/beta/mcp"`)
    expect((await there.json()).detail).toContain(`This token is for ${ALPHA}`)
    expect((await app.request('/api/v1/things', { headers: auth })).status).toBe(401)
    // A root token is the app's to accept in every space
    const { tokens: root } = await signedIn(app)
    expect(audOf(root.access_token)).toBe(ORIGIN)
    expect(await (await app.request('/s/beta/mcp', { method: 'POST', headers: { authorization: `Bearer ${root.access_token}` } })).json()).toEqual({ api: 200 })
  })

  it('lets a read token POST to every space’s MCP when auth.relay names them with a pattern', async () => {
    const withRelay = async (relay?: string[]) => {
      const oauth = createOAuth({ name: 'Sample', signingKey: await generateOAuthKey(), store: memoryOAuthStore(), owner: async (c) => c.req.header('x-test-owner') ?? null, owners: [OWNER], resources: (path) => /^\/s\/[a-z]+\/mcp(\/x)?$/.test(path), resourceOf: (c) => `${originOf(c)}${c.req.path}` })
      const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(''), ...(relay ? { relay } : {}) }, oauth })
      app.post('/s/:name/mcp', (c) => c.json({ ok: true }))
      app.post('/s/:name/mcp/x', (c) => c.json({ ok: true }))
      const post = async (path: string) => {
        const { exchange } = await approvedCode(app, { resource: `${ORIGIN}${path}`, scope: 'read' })
        return (await app.request(path, { method: 'POST', headers: { authorization: `Bearer ${(await (await exchange()).json()).access_token}` } })).status
      }
      return post
    }
    const relayed = await withRelay(['/s/*/mcp'])
    expect(await relayed('/s/alpha/mcp')).toBe(200)
    // A star inside a pattern is one path segment
    expect(await relayed('/s/alpha/mcp/x')).toBe(403)
    expect(await (await withRelay())('/s/alpha/mcp')).toBe(403)
  })

  it('reads a star inside a pattern as one path segment, and the old forms as before', () => {
    expect(matches('/s/alpha/mcp', '/s/*/mcp')).toBe(true)
    for (const path of ['/s/alpha/mcp/x', '/s//mcp', '/s/a/b/mcp', '/s/alpha/mcpx']) expect(matches(path, '/s/*/mcp'), path).toBe(false)
    expect(matches('/s/alpha/mcp/x', '/s/*/mcp/*')).toBe(true)
    expect(matches('/s/a.b/mcp', '/s/*/mcp')).toBe(true)
    expect(matches('/s/alpha/mcp', '/s/*.b/mcp')).toBe(false)
    expect([matches('/oauth/token', '/oauth/*'), matches('/oauth', '/oauth/*'), matches('/mcp/server-card', '*/server-card'), matches('/llms.txt', '/llms.txt'), matches('/llms.txt', '/llms.txt/')]).toEqual([true, false, true, true, false])
  })

  it('lets the path decide the space when it names one, so a client setting the in-process carrier gets nothing', async () => {
    const { app } = await spacesApi()
    const { exchange } = await approvedCode(app, { resource: ALPHA })
    const auth = { authorization: `Bearer ${(await (await exchange()).json()).access_token}` }
    const forged = await app.request('/s/beta/mcp', { method: 'POST', headers: { ...auth, 'x-test-resource': ALPHA } })
    expect(forged.status).toBe(401)
    expect((await forged.json()).detail).toContain(`not ${BETA}`)
  })

  it('with spaces, takes a token asked for /mcp at /mcp, its in-process /api call included, and everywhere else on the origin', async () => {
    const { app } = await spacesApi()
    const { exchange } = await approvedCode(app, { resource: `${ORIGIN}/mcp` })
    const auth = { authorization: `Bearer ${(await (await exchange({ resource: `${ORIGIN}/mcp` })).json()).access_token}` }
    const here = await app.request('/mcp', { method: 'POST', headers: auth })
    expect([here.status, await here.json()]).toEqual([200, { api: 200 }])
    expect((await app.request('/api/v1/things', { headers: auth })).status).toBe(200)
    expect(await (await app.request('/s/alpha/mcp', { method: 'POST', headers: auth })).json()).toEqual({ api: 200 })
    // The /mcp path outranks the carrier: a space's token is refused there, pointed at /mcp's metadata
    const { exchange: alpha } = await approvedCode(app, { resource: ALPHA })
    const refused = await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${(await (await alpha()).json()).access_token}`, 'x-test-resource': ALPHA } })
    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`)
  })

  it('with resources and no accepts, takes a token at its own resource and refuses it at another and at /api, in-process calls included', async () => {
    const resourceOf = (c: Context) => `${originOf(c)}${/^\/s\/[a-z]+\/mcp/.exec(c.req.path)?.[0] ?? (c.req.path === '/mcp' || c.req.path.startsWith('/mcp/') ? '/mcp' : '')}`
    const { app } = await oauthApp(memoryOAuthStore(), { resources: (path) => /^\/s\/[a-z]+\/mcp$/.test(path), resourceOf })
    app.post('/s/:name/mcp', async (c) => c.json({ api: (await app.request('/api/v1/things', { headers: { authorization: c.req.header('authorization') ?? '' } })).status }))
    const { exchange } = await approvedCode(app, { resource: ALPHA })
    const auth = { authorization: `Bearer ${(await (await exchange()).json()).access_token}` }
    const here = await app.request('/s/alpha/mcp', { method: 'POST', headers: auth })
    // The in-process /api call has lost the space's path: only the app's own accepts can let it in
    expect([here.status, await here.json()]).toEqual([200, { api: 401 }])
    for (const [path, method] of [['/s/beta/mcp', 'POST'], ['/api/v1/things', 'GET'], ['/mcp', 'POST']] as const) {
      const refused = await app.request(path, { method, headers: auth })
      expect([refused.status, refused.headers.get('www-authenticate')], path).toEqual([401, expect.stringContaining('error="invalid_token"')])
    }
    // The default still takes a root token at every resource
    const { tokens: root } = await signedIn(app)
    expect((await app.request('/s/beta/mcp', { method: 'POST', headers: { authorization: `Bearer ${root.access_token}` } })).status).toBe(200)
    // And an mcpPath token, which in-process calls carry to the whole origin
    const { tokens: mcp } = await signedIn(app, { resource: `${ORIGIN}/mcp` })
    expect(audOf(mcp.access_token)).toBe(`${ORIGIN}/mcp`)
    expect(await (await app.request('/s/beta/mcp', { method: 'POST', headers: { authorization: `Bearer ${mcp.access_token}` } })).json()).toEqual({ api: 200 })
  })

  it('refuses a resource the server does not issue for with invalid_target: a page at authorize, JSON at the token endpoints', async () => {
    const { app } = await spacesApi()
    await refusedAtAuthorize(app, `${ORIGIN}/s/alpha/files`)
    const { exchange } = await approvedCode(app, { resource: ALPHA })
    const other = await exchange({ resource: BETA })
    expect([other.status, (await other.json()).error]).toEqual([400, 'invalid_target'])
    // Refused before anything is written: the code still works for its own resource
    expect(audOf((await (await exchange({ resource: ALPHA })).json()).access_token)).toBe(ALPHA)
    const device = 'urn:ietf:params:oauth:grant-type:device_code'
    const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
    const started = await app.request('/oauth/device_authorization', form({ client_id, resource: `${ORIGIN}/s/alpha/files` }))
    expect([started.status, (await started.json()).error]).toEqual([400, 'invalid_target'])
  })

  it('with resources set, refuses a resource on another origin whatever resources says; without it, gives the root', async () => {
    const { app } = await oauthApp(memoryOAuthStore(), { resources: () => true })
    const elsewhere = ['https://example.test/s/alpha/mcp', 'http://localhost.example.test/mcp', 'http://localhost:8080/mcp', 'https://localhost/mcp']
    for (const resource of elsewhere) await refusedAtAuthorize(app, resource)
    const { app: plain } = await oauthApp(memoryOAuthStore())
    for (const resource of elsewhere) expect(await audienceFor(plain, resource), resource).toBe(ORIGIN)
  })

  it('refuses a resource with a query, a user part, a fragment, dot segments or encoded dots, or one that is not an http URL', async () => {
    const malformed = [`${ALPHA}?x=1`, `${ALPHA}?`, `${ALPHA}#top`, `${ALPHA}#`, 'http://someone@localhost/s/alpha/mcp', 'http://:secret@localhost/s/alpha/mcp', `${ORIGIN}/s/beta/../alpha/mcp`,
      `${ORIGIN}/s/beta/%2e%2e/alpha/mcp`, `${ORIGIN}/s/alpha/%2E/mcp`, `${ORIGIN}/s/al%2epha/mcp`, `${ORIGIN}\\s\\alpha\\mcp`, '/s/alpha/mcp', 'ftp://localhost/s/alpha/mcp', '']
    const { app } = await oauthApp(memoryOAuthStore(), { resources: () => true })
    for (const resource of malformed) await refusedAtAuthorize(app, resource)
    // Without resources nothing is refused: the grant gets the root, as a client that asks for nothing does
    const { app: plain } = await oauthApp(memoryOAuthStore())
    for (const resource of malformed) expect(await audienceFor(plain, resource), resource).toBe(ORIGIN)
  })

  it('reads an upper-case scheme or host, a default port and a trailing slash as the same resource, never a path in another case', async () => {
    const { app } = await oauthApp(memoryOAuthStore())
    for (const resource of ['HTTP://LOCALHOST/mcp/', 'http://localhost:80/mcp', 'http://Localhost/mcp']) expect(await audienceFor(app, resource), resource).toBe(`${ORIGIN}/mcp`)
    expect(await audienceFor(app, 'http://localhost/')).toBe(ORIGIN)
    const { exchange } = await approvedCode(app, { resource: `${ORIGIN}/mcp` })
    expect((await (await exchange({ resource: `${ORIGIN}/MCP` })).json()).error).toBe('invalid_target')
  })

  it('without resources, gives a resource the app does not describe the root, which works as before', async () => {
    const { app } = await sampleApi()
    const { exchange } = await approvedCode(app, { resource: ALPHA })
    const tokens = await (await exchange({ resource: ALPHA })).json()
    expect(audOf(tokens.access_token)).toBe(ORIGIN)
    for (const [path, method] of [['/api/v1/things', 'GET'], ['/api/v1/things', 'POST'], ['/mcp', 'POST']] as const)
      expect((await app.request(path, { method, headers: { authorization: `Bearer ${tokens.access_token}` } })).status, path).toBeLessThan(300)
  })

  it('refuses a resource at the token endpoint other than the code’s, and a code bound to one needs it sent no more', async () => {
    const { app } = await sampleApi()
    const { exchange } = await approvedCode(app, { resource: `${ORIGIN}/mcp` })
    expect((await (await exchange({ resource: ORIGIN })).json()).error).toBe('invalid_target')
    expect(audOf((await (await exchange()).json()).access_token)).toBe(`${ORIGIN}/mcp`)
  })

  it('refuses more than one resource at authorize', async () => {
    const { app } = await sampleApi()
    const page = await authorizeWith(app, [ORIGIN, `${ORIGIN}/mcp`])
    expect([page.status, await page.text()]).toEqual([400, expect.stringContaining('Send one resource')])
  })

  it('refuses more than one resource, or one not sent as a string, at device_authorization and the token endpoint, before anything is written', async () => {
    const { app } = await sampleApi()
    const twice = (path: string, fields: Record<string, string>) =>
      app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `${new URLSearchParams(fields)}&resource=${encodeURIComponent(ORIGIN)}&resource=${encodeURIComponent(`${ORIGIN}/mcp`)}` })
    const refused = async (answer: Response) => [answer.status, (await answer.json()).error]
    const device = 'urn:ietf:params:oauth:grant-type:device_code'
    const { client_id: deviceClient } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
    expect(await refused(await twice('/oauth/device_authorization', { client_id: deviceClient }))).toEqual([400, 'invalid_target'])
    expect(await refused(await app.request('/oauth/device_authorization', json({ client_id: deviceClient, resource: [`${ORIGIN}/mcp`] })))).toEqual([400, 'invalid_target'])
    const { client_id, verifier, code, exchange } = await approvedCode(app, { resource: `${ORIGIN}/mcp` })
    const fields = { grant_type: 'authorization_code', code, client_id, code_verifier: verifier }
    expect(await refused(await twice('/oauth/token', fields))).toEqual([400, 'invalid_target'])
    expect(await refused(await app.request('/oauth/token', json({ ...fields, resource: [`${ORIGIN}/mcp`] })))).toEqual([400, 'invalid_target'])
    // The code was not spent by either refusal
    const tokens = await (await exchange({ resource: `${ORIGIN}/mcp` })).json()
    expect(audOf(tokens.access_token)).toBe(`${ORIGIN}/mcp`)
    expect(await refused(await twice('/oauth/token', { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))).toEqual([400, 'invalid_target'])
    expect(await refused(await app.request('/oauth/token', json({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: [`${ORIGIN}/mcp`] })))).toEqual([400, 'invalid_target'])
    expect(audOf((await (await refreshWith(app, tokens.refresh_token, `${ORIGIN}/mcp`)).json()).access_token)).toBe(`${ORIGIN}/mcp`)
  })

  it('binds a device grant to the resource asked for at device_authorization', async () => {
    const { app } = await sampleApi()
    const device = 'urn:ietf:params:oauth:grant-type:device_code'
    const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
    const { device_code, user_code } = await (await app.request('/oauth/device_authorization', form({ client_id, resource: `${ORIGIN}/mcp` }))).json()
    await app.request('/oauth/device', { ...form({ user_code, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
    const poll = (resource?: string) => app.request('/oauth/token', form({ grant_type: device, device_code, client_id, ...(resource ? { resource } : {}) }))
    expect((await (await poll(ORIGIN)).json()).error).toBe('invalid_target')
    const tokens = await (await poll(`${ORIGIN}/mcp`)).json()
    expect(audOf(tokens.access_token)).toBe(`${ORIGIN}/mcp`)
    expect(audOf((await (await refreshWith(app, tokens.refresh_token)).json()).access_token)).toBe(`${ORIGIN}/mcp`)
  })

  it('binds a claimed agent to the root across its claim, refresh and jwt-bearer tokens, and leaves one claimed before audiences aud-less', async () => {
    const store = memoryOAuthStore()
    const { app } = await oauthApp(store)
    const claim = async () => {
      const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Night shift' }))).json()
      const claim_attempt_token = new URL(registration.claim.verification_uri).searchParams.get('claim_attempt_token')!
      await app.request('/oauth/claim', { ...form({ claim_attempt_token, user_code: registration.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
      return registration
    }
    const tokensOf = async (registration: { claim_token: string }) => {
      const granted = await (await app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: registration.claim_token }))).json()
      const refreshed = await (await refreshWith(app, granted.refresh_token, `${ORIGIN}/mcp`)).json()
      const bearing = await (await app.request('/oauth/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: granted.identity_assertion }))).json()
      return [granted, refreshed, bearing].map((one) => audOf(one.access_token))
    }
    expect(await tokensOf(await claim())).toEqual([ORIGIN, ORIGIN, ORIGIN])
    // Two resources: refused for a registration bound to the root, before its claim token is taken; ignored for one from before audiences
    const CLAIM = 'urn:workos:agent-auth:grant-type:claim'
    const bound = await claim()
    expect((await (await app.request('/oauth/token', formWithTwoResources({ grant_type: CLAIM, claim_token: bound.claim_token }))).json()).error).toBe('invalid_target')
    const boundTokens = await (await app.request('/oauth/token', form({ grant_type: CLAIM, claim_token: bound.claim_token }))).json()
    expect(audOf(boundTokens.access_token)).toBe(ORIGIN)
    expect((await (await app.request('/oauth/token', formWithTwoResources({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: boundTokens.identity_assertion }))).json()).error).toBe('invalid_target')
    const unbound = await claim()
    const { audience: _bound, ...unboundRow } = (await store.get('registration', unbound.registration_id))!
    await store.put('registration', unbound.registration_id, unboundRow, Math.floor(Date.now() / 1000) + 3600)
    const claimedTwice = await (await app.request('/oauth/token', formWithTwoResources({ grant_type: CLAIM, claim_token: unbound.claim_token }))).json()
    const bearingTwice = await (await app.request('/oauth/token', formWithTwoResources({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: claimedTwice.identity_assertion }))).json()
    expect([claimedTwice.error, bearingTwice.error]).toEqual([undefined, undefined])
    expect([audOf(claimedTwice.access_token), audOf(bearingTwice.access_token)]).toEqual([undefined, undefined])
    const before = await claim()
    const { audience: _audience, ...row } = (await store.get('registration', before.registration_id))!
    await store.put('registration', before.registration_id, row, Math.floor(Date.now() / 1000) + 3600)
    expect(await tokensOf(before)).toEqual([undefined, undefined, undefined])
    // Registered before audiences and claimed after: its grant was made at registration, so it stays aud-less too
    const registered = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Late shift' }))).json()
    const { audience: _unclaimed, ...unclaimed } = (await store.get('registration', registered.registration_id))!
    await store.put('registration', registered.registration_id, unclaimed, Math.floor(Date.now() / 1000) + 3600)
    const claim_attempt_token = new URL(registered.claim.verification_uri).searchParams.get('claim_attempt_token')!
    await app.request('/oauth/claim', { ...form({ claim_attempt_token, user_code: registered.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
    expect(await tokensOf(registered)).toEqual([undefined, undefined, undefined])
  })

  it('refuses a token for another resource under the default accepts, and takes one without aud or for the origin or MCP', async () => {
    const store = memoryOAuthStore()
    const signingKey = await generateOAuthKey()
    const { app } = await oauthApp(store, { signingKey })
    const tokenFor = async (aud?: string) => {
      const jti = `jti-${randomBytes(6).toString('hex')}`
      await store.put('access', jti, { client: 'client_one' }, Math.floor(Date.now() / 1000) + 3600)
      return new SignJWT({ sub: OWNER, client_id: 'client_one', name: 'One', scope: 'read', jti, ...(aud ? { aud } : {}) })
        .setProtectedHeader({ alg: 'ES256' }).setIssuer(ORIGIN).setIssuedAt().setExpirationTime('1h').sign(await importJWK(JSON.parse(signingKey), 'ES256'))
    }
    for (const aud of [undefined, ORIGIN, `${ORIGIN}/mcp`]) expect((await callerWith(app, await tokenFor(aud))).status, aud).toBe(200)
    const elsewhere = await callerWith(app, await tokenFor(ALPHA))
    expect(elsewhere.status).toBe(401)
    expect(elsewhere.headers.get('www-authenticate')).toContain('error="invalid_token"')
    expect((await elsewhere.json()).detail).toContain(ALPHA)
  })

  it('says an app’s refusal in the problem, and only its printable ASCII in the header', async () => {
    const sentence = 'This token isn’t for here.\r\nConnect again.'
    const { app } = await oauthApp(memoryOAuthStore(), { accepts: async () => sentence })
    const { tokens } = await signedIn(app)
    const refused = await callerWith(app, tokens.access_token)
    expect(refused.status).toBe(401)
    expect((await refused.json()).detail).toBe(sentence)
    expect(refused.headers.get('www-authenticate')).toContain('error_description="This token isnt for here.Connect again."')
  })

  it('points the 401 at a path-scoped MCP at that path’s metadata, whose resource is the URL asked (RFC 9728 §3.3)', async () => {
    const { app } = await spacesApi()
    const pointer = /resource_metadata="([^"]+)"/.exec((await app.request('/s/alpha/mcp', { method: 'POST' })).headers.get('www-authenticate')!)![1]!
    expect(pointer).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/s/alpha/mcp`)
    expect((await (await app.request(new URL(pointer).pathname)).json()).resource).toBe(ALPHA)
  })

  it('serves metadata for a resource that cannot be granted only when resources is not set', async () => {
    const { app } = await spacesApi()
    expect((await app.request('/.well-known/oauth-protected-resource/s/alpha/files')).status).toBe(404)
    expect((await app.request('/.well-known/oauth-protected-resource/s/alpha/mcp/..')).status).toBe(404)
    for (const path of ['', '/mcp', '/s/alpha/mcp']) expect((await app.request(`/.well-known/oauth-protected-resource${path}`)).status, path).toBe(200)
    const { app: plain } = await sampleApi()
    expect((await (await plain.request('/.well-known/oauth-protected-resource/s/alpha/files')).json()).resource).toBe(`${ORIGIN}/s/alpha/files`)
  })
})

describe('OAuth approvals: the app decides who approves a sign-in', () => {
  type App = Awaited<ReturnType<typeof oauthApp>>['app']
  afterEach(() => vi.useRealTimers())
  const exchangeAt = (app: App, location: string | null, client_id: string, extra: Record<string, string> = {}) =>
    app.request('/oauth/token', form({ grant_type: 'authorization_code', code: new URL(location!).searchParams.get('code')!, client_id, code_verifier: 'v'.repeat(43), ...extra }))
  const cookieOf = (answer: Response) => answer.headers.getSetCookie().find((line) => /^(__Host-)?oauth_ticket=/.test(line))

  it('runs the oauth README’s invite example as written', async () => {
    const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
    const signingKey = await generateOAuthKey()
    const store = memoryOAuthStore()
    const owner = async (c: Context) => c.req.header('x-test-owner') ?? null

    // The invites the owner made, each for one person (an app keeps them in its database)
    const INVITES = new Map([['garden-42', 'owner@example.test']])
    const invitePage = (ask: SignInAsk, note = '') => `<!doctype html><meta name="referrer" content="same-origin"><title>Join Sample</title>
<p>${escape(ask.client.name)} asks to use Sample (${escape(ask.resource)}) and returns to ${ask.onThisComputer ? 'an app on this computer' : escape(ask.redirectHost)}. ${note}</p>
<form method="post" action="/join"><input type="hidden" name="ticket" value="${ask.ticket}"><input name="invite" aria-label="Invite code"><button>Join</button></form>`

    const oauth = createOAuth({
      name: 'Sample', signingKey, store, owner,
      approve: async (c, ask) => c.html(invitePage(ask)),                                          // every sign-in starts at the app's page
      onGrant: async (grant) => grant.kind !== 'code' || INVITES.delete(grant.data?.invite ?? ''),  // spent with the first token
    })
    const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(''), open: ['/join'] }, oauth })
    app.post('/join', async (c) => {
      const body = await c.req.parseBody()
      const ticket = String(body.ticket ?? '')
      const ask = await oauth.ticketOf(c, ticket)
      if (!ask) return c.html((await oauth.answeredOf(c, ticket)) === 'approved' ? '<p>Already approved: return to your app.</p>' : '<p>This sign-in expired: start again from your app.</p>', 400)
      const holder = INVITES.get(String(body.invite ?? ''))
      if (!holder) return c.html(invitePage(ask, 'That invite code is not one of ours.'), 400)
      return oauth.complete(c, ask.ticket, { approver: holder, scopes: ['read'], data: { invite: String(body.invite) } })
    })

    app.get('/api/v1/things', (c) => c.json({ caller: c.get('caller' as never) }))
    const client_id = await registered(app)
    const browser = browserOf(app)
    const page = await browser.request(`/oauth/authorize?${authorizeQuery(client_id, { resource: `${ORIGIN}/mcp` })}`)
    const html = await page.text()
    expect(html).toContain(`Sample asks to use Sample (${ORIGIN}/mcp) and returns to an app on this computer.`)
    expect(html).toContain('<meta name="referrer" content="same-origin">')
    expect((await browser.post('/join', { ticket: ticketIn(html), invite: 'garden-1' })).status).toBe(400)
    const joined = await browser.post('/join', { ticket: ticketIn(html), invite: 'garden-42' })
    // Posted again from this browser (a double click, a tab brought back): it went through; from another, it expired
    const again = await browser.post('/join', { ticket: ticketIn(html), invite: 'garden-42' })
    expect([again.status, again.headers.get('location'), await again.text()]).toEqual([400, null, expect.stringContaining('Already approved')])
    expect(await (await browserOf(app).post('/join', { ticket: ticketIn(html), invite: 'garden-42' })).text()).toContain('This sign-in expired')
    const tokens = await (await exchangeAt(app, joined.headers.get('location'), client_id)).json()
    expect(tokens.scope).toBe('read')
    expect((await (await callerWith(app, tokens.access_token)).json()).caller).toMatchObject({ owner: OWNER, client: client_id, scopes: ['read'], resource: `${ORIGIN}/mcp` })
    // Spent: the same invite opens nothing a second time
    const second = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
    expect((await browser.post('/join', { ticket: second, invite: 'garden-42' })).status).toBe(400)
  })

  it('lets an app approve at its own page, and the client gets a code with state and iss', async () => {
    const { app, heard, asks } = await joinApp(memoryOAuthStore())
    const client_id = await registered(app, 'Sample client', 'https://client.example.test/callback')
    const browser = browserOf(app, { referer: 'https://client.example.test/settings', 'sec-fetch-site': 'cross-site' })
    const query = authorizeQuery(client_id, { redirect_uri: 'https://client.example.test/callback', resource: `${ORIGIN}/mcp`, scope: 'read write', state: 'abc' })
    const page = await browser.request(`/oauth/authorize?${query}`)
    expect([page.status, page.headers.get('location')]).toEqual([200, null])
    expect(cookieOf(page)).toMatch(/^oauth_ticket=[\w-]{32,};/)
    expect(asks).toEqual([{
      ticket: ticketIn(await page.text()),
      client: { id: client_id, name: 'Sample client', redirectUris: ['https://client.example.test/callback'] },
      redirectUri: 'https://client.example.test/callback',
      redirectHost: 'client.example.test',
      onThisComputer: false,
      scopes: ['read', 'write'],
      resource: `${ORIGIN}/mcp`,
      state: 'abc',
      arrival: { site: 'cross-site', referrerOrigin: 'https://client.example.test' },
    }])
    const done = await browser.post('/join', { ticket: asks[0]!.ticket, invite: 'garden-42' })
    expect(done.status).toBe(302)
    const back = new URL(done.headers.get('location')!)
    expect([back.origin + back.pathname, back.searchParams.get('state'), back.searchParams.get('iss')]).toEqual(['https://client.example.test/callback', 'abc', ORIGIN])
    const tokens = await (await exchangeAt(app, done.headers.get('location'), client_id, { redirect_uri: 'https://client.example.test/callback' })).json()
    const caller = (await (await callerWith(app, tokens.access_token)).json()).caller
    expect(caller).toMatchObject({ owner: OWNER, client: client_id, scopes: ['read', 'write'], resource: `${ORIGIN}/mcp` })
    expect(heard).toEqual([{ kind: 'code', grant: caller.grant, client: { id: client_id, name: 'Sample client' }, approver: OWNER, scopes: ['read', 'write'], resource: `${ORIGIN}/mcp`, data: { invite: 'garden-42' } }])
    // Refresh never asks onGrant again
    expect((await refreshWith(app, tokens.refresh_token)).status).toBe(200)
    expect(heard).toHaveLength(1)
  })

  it('needs the browser that opened the ticket to complete it', async () => {
    const { app } = await joinApp(memoryOAuthStore())
    const opener = browserOf(app)
    const ticket = ticketIn(await (await opener.request(`/oauth/authorize?${authorizeQuery(await registered(app))}`)).text())
    // Another browser (its own ticket cookie) and one with none
    const other = browserOf(app)
    await other.request(`/oauth/authorize?${authorizeQuery(await registered(app))}`)
    for (const browser of [other, browserOf(app)]) {
      const answer = await browser.post('/join/direct', { ticket, invite: 'garden-42' })
      expect([answer.status, answer.headers.get('location')]).toEqual([403, null])
      expect((await browser.post('/join', { ticket, invite: 'garden-42' })).status).toBe(400)
    }
    expect((await opener.post('/join', { ticket, invite: 'garden-42' })).headers.get('location')).toContain('code=')
  })

  it('refuses a cross-site, same-site-sibling or originless approval, on the kit’s page and at complete alike', async () => {
    const refusedHeaders: Record<string, string>[] = [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'none' }, {}, { origin: 'null' }, { origin: 'http://localhost.example.test' }, { origin: 'http://sub.localhost' }, { origin: 'https://localhost' }]
    const { app } = await joinApp(memoryOAuthStore(), { approve: async (c, ask) => (ask.state === 'kit' ? null : c.html(`<input name="ticket" value="${ask.ticket}">`)) })
    const client_id = await registered(app)
    const browser = browserOf(app, { 'x-test-owner': OWNER })
    for (const headers of refusedHeaders) {
      const kit = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id, { state: 'kit' })}`)).text())
      const own = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
      for (const [path, ticket] of [['/oauth/authorize', kit], ['/join/direct', own]] as const) {
        const answer = await browser.post(path, { ticket, decision: 'allow', invite: 'garden-42' }, headers)
        expect([answer.status, answer.headers.get('location')], `${path} ${JSON.stringify(headers)}`).toEqual([403, null])
      }
      // Refused before anything was spent: the same tickets still go through from this site
      expect((await browser.post('/oauth/authorize', { ticket: kit, decision: 'allow' }, { origin: ORIGIN })).headers.get('location')).toContain('code=')
      expect((await browser.post('/join/direct', { ticket: own, invite: 'garden-42' }, { origin: 'HTTP://LOCALHOST:80' })).headers.get('location')).toContain('code=')
    }
  })

  it('makes one code when complete is called twice: the second finds the ticket spent', async () => {
    const { app } = await joinApp(memoryOAuthStore())
    const client_id = await registered(app)
    const browser = browserOf(app)
    const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
    const first = await browser.post('/join/direct', { ticket, invite: 'garden-42' })
    const second = await browser.post('/join/direct', { ticket, invite: 'garden-42' })
    expect([first.status, second.status, second.headers.get('location')]).toEqual([302, 400, null])
    expect(await second.text()).toContain('Already approved')
    expect((await browser.post('/join', { ticket, invite: 'garden-42' })).status).toBe(400)
  })

  it('refuses a blank approver before the ticket is spent', async () => {
    const { app } = await joinApp(memoryOAuthStore())
    const browser = browserOf(app)
    const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(await registered(app))}`)).text())
    for (const approver of ['', '  ']) {
      const refused = await browser.post('/join/direct', { ticket, approver })
      expect([refused.status, refused.headers.get('location'), await refused.text()]).toEqual([400, null, expect.stringContaining('needs an approver')])
    }
    expect((await browser.post('/join/direct', { ticket, approver: OWNER })).headers.get('location')).toContain('code=')
  })

  it('stores no ticket for a stranger the app’s approve sends to the owner’s sign-in', async () => {
    const store = memoryOAuthStore()
    const tickets: string[] = []
    const { app } = await joinApp(store, { approve: async (_c, ask) => (tickets.push(ask.ticket), null) })
    const answer = await app.request(`/oauth/authorize?${authorizeQuery(await registered(app))}`)
    expect([answer.status, cookieOf(answer)]).toEqual([401, undefined])
    expect(await answer.text()).toContain('Sign in first')
    expect(tickets).toHaveLength(1)
    expect(await store.get('consent', tickets[0]!)).toBeNull()
  })

  it('lets an approval narrow the scopes, never widen them, and a refresh keeps it read-only', async () => {
    const { app } = await joinApp(memoryOAuthStore())
    const client_id = await registered(app)
    const browser = browserOf(app)
    const open = async (scope: string) => ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id, { scope })}`)).text())
    const narrowed = await browser.post('/join', { ticket: await open('read write'), invite: 'garden-42', scopes: 'read' })
    const tokens = await (await exchangeAt(app, narrowed.headers.get('location'), client_id)).json()
    expect(tokens.scope).toBe('read')
    const rotated = await (await refreshWith(app, tokens.refresh_token)).json()
    expect(rotated.scope).toBe('read')
    expect((await app.request('/api/v1/things', { method: 'POST', headers: { authorization: `Bearer ${rotated.access_token}` } })).status).toBe(403)
    // Wider than asked, or nothing at all: refused, and the ticket is still there to answer properly
    const readOnly = await open('read')
    for (const scopes of ['read write', 'admin', ' ']) {
      const refused = await browser.post('/join', { ticket: readOnly, invite: 'garden-42', scopes })
      expect([refused.status, refused.headers.get('location')], scopes).toEqual([400, null])
    }
    expect((await browser.post('/join', { ticket: readOnly, invite: 'garden-42' })).headers.get('location')).toContain('code=')
    // An empty list passed by the app is refused too
    const { app: own, oauth } = await oauthApp(memoryOAuthStore(), { approve: async (c, ask) => c.html(`<input name="ticket" value="${ask.ticket}">`) }, { open: ['/none'] })
    own.post('/none', async (c) => oauth.complete(c, String((await c.req.parseBody()).ticket ?? ''), { approver: OWNER, scopes: [] }))
    const ownBrowser = browserOf(own)
    const ticket = ticketIn(await (await ownBrowser.request(`/oauth/authorize?${authorizeQuery(await registered(own))}`)).text())
    const none = await ownBrowser.post('/none', { ticket })
    expect([none.status, none.headers.get('location')]).toEqual([400, null])
  })

  it('completes a sign-in that asked only for unknown scopes on the kit’s page, as before approvals: a token with no scopes', async () => {
    const { app } = await oauthApp(memoryOAuthStore())
    const client_id = await registered(app)
    const owner = browserOf(app, { 'x-test-owner': OWNER })
    const page = await owner.request(`/oauth/authorize?${authorizeQuery(client_id, { scope: 'admin' })}`)
    expect(page.status).toBe(200)
    const allowed = await owner.post('/oauth/authorize', { ticket: ticketIn(await page.text()), decision: 'allow' })
    expect([allowed.status, allowed.headers.get('location')]).toEqual([302, expect.stringContaining('code=')])
    const tokens = await (await exchangeAt(app, allowed.headers.get('location'), client_id)).json()
    expect(tokens.scope).toBe('')
    // A token with no scopes reads nothing
    expect((await callerWith(app, tokens.access_token)).status).toBe(403)
  })

  it('hands onGrant the data, and false spends the code and issues nothing', async () => {
    const { app, heard } = await joinApp(memoryOAuthStore())
    const client_id = await registered(app)
    const browser = browserOf(app)
    const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
    const location = (await browser.post('/join', { ticket, invite: 'not-an-invite' })).headers.get('location')
    const refused = await (await exchangeAt(app, location, client_id)).json()
    expect(refused).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('withdrawn') })
    expect(refused.access_token).toBeUndefined()
    expect(heard.map((grant) => [grant.kind, grant.data])).toEqual([['code', { invite: 'not-an-invite' }]])
    expect((await (await exchangeAt(app, location, client_id)).json()).error).toBe('invalid_grant')
    expect(heard).toHaveLength(1)
  })

  it('asks onGrant for the device and claim grants, once each, and false issues nothing', async () => {
    const device = 'urn:ietf:params:oauth:grant-type:device_code'
    const CLAIM = 'urn:workos:agent-auth:grant-type:claim'
    const BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
    for (const allowed of [true, false]) {
      const heard: { kind: string; approver: string; resource?: string; grant: string }[] = []
      const { app } = await oauthApp(memoryOAuthStore(), { onGrant: async (grant) => (heard.push(grant), allowed) })
      const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
      const { device_code, user_code } = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
      await browserOf(app, { 'x-test-owner': OWNER }).post('/oauth/device', { user_code, decision: 'allow' })
      const poll = () => app.request('/oauth/token', form({ grant_type: device, device_code, client_id }))
      const polls = await Promise.all([poll(), poll(), poll()])
      const bodies = await Promise.all(polls.map((answer) => answer.json()))
      expect(bodies.filter((body) => body.access_token)).toHaveLength(allowed ? 1 : 0)
      if (!allowed) expect(bodies.map((body) => body.error_description).join(' ')).toContain('withdrawn')
      expect(heard).toMatchObject([{ kind: 'device', approver: OWNER, resource: ORIGIN, client: { id: client_id, name: 'Terminal' } }])

      // An anonymous agent holds its assertion from the start: it buys no token before the claim is collected
      const registration = await (await app.request('/agent/identity', json({ type: 'anonymous', client_name: 'Night shift' }))).json()
      const { claim_attempt } = await (await app.request('/agent/identity/claim', json({ claim_token: registration.claim_token, email: OWNER }))).json()
      expect((await typeClaim(app, claim_attempt)).status).toBe(200)
      const bearing = () => app.request('/oauth/token', form({ grant_type: BEARER, assertion: registration.identity_assertion }))
      expect((await (await bearing()).json()).error).toBe('invalid_grant')
      const claimPoll = () => app.request('/oauth/token', form({ grant_type: CLAIM, claim_token: registration.claim_token }))
      const claimed = await Promise.all([claimPoll(), claimPoll()])
      const claimBodies = await Promise.all(claimed.map((answer) => answer.json()))
      expect(claimBodies.filter((body) => body.access_token)).toHaveLength(allowed ? 1 : 0)
      expect(heard.map((grant) => grant.kind)).toEqual(['device', 'claim'])
      expect(heard[1]).toMatchObject({ approver: OWNER, client: { id: registration.registration_id, name: 'Night shift' } })
      // Collected and allowed, the assertion works from then on without asking again; withdrawn, it never does
      const after = await (await bearing()).json()
      expect(Boolean(after.access_token)).toBe(allowed)
      if (allowed) expect((await refreshWith(app, claimBodies.find((body) => body.refresh_token).refresh_token)).status).toBe(200)
      expect(heard).toHaveLength(2)
    }
  })

  it('with approve set, answers a bad request with a page, never a redirect', async () => {
    const { app, asks } = await joinApp(memoryOAuthStore(), { resources: (path) => path === '/s/alpha/mcp' })
    const client_id = await registered(app)
    for (const extra of <Record<string, string>[]>[{ response_type: 'token' }, { code_challenge: '' }, { code_challenge_method: 'plain' }, { resource: `${ORIGIN}/s/beta/mcp` }, { resource: 'https://elsewhere.example.test/s/alpha/mcp' }, { redirect_uri: 'https://elsewhere.example.test/cb' }, { client_id: 'client_nope' }]) {
      const answer = await app.request(`/oauth/authorize?${authorizeQuery(client_id, extra)}`)
      expect([answer.status, answer.headers.get('location')], JSON.stringify(extra)).toEqual([400, null])
      expect(await answer.text()).not.toContain('<a ')
    }
    expect(asks).toEqual([])
    // Without approve the kit keeps today's order: the owner first, then an error the client may hear at its redirect
    const { app: plain } = await oauthApp(memoryOAuthStore())
    const plainClient = await registered(plain)
    expect((await plain.request(`/oauth/authorize?${authorizeQuery(plainClient, { response_type: 'token' })}`)).status).toBe(401)
    expect((await plain.request(`/oauth/authorize?${authorizeQuery(plainClient, { response_type: 'token' })}`, { headers: { 'x-test-owner': OWNER } })).status).toBe(302)
  })

  it('falls back to the owner’s page when approve answers null, and never lets a ticket from the app’s page be approved there', async () => {
    const { app } = await joinApp(memoryOAuthStore(), { approve: async (c, ask) => (ask.resource === ORIGIN ? null : c.html(`<input name="ticket" value="${ask.ticket}">`)) })
    const client_id = await registered(app)
    expect((await app.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).status).toBe(401)
    const owner = browserOf(app, { 'x-test-owner': OWNER })
    const page = await owner.request(`/oauth/authorize?${authorizeQuery(client_id)}`)
    expect(await page.clone().text()).toContain('Allow <strong>Sample</strong>')
    expect((await owner.post('/oauth/authorize', { ticket: ticketIn(await page.text()), decision: 'allow' })).headers.get('location')).toContain('code=')
    const appTicket = ticketIn(await (await owner.request(`/oauth/authorize?${authorizeQuery(client_id, { resource: `${ORIGIN}/mcp` })}`)).text())
    const refused = await owner.post('/oauth/authorize', { ticket: appTicket, decision: 'allow' })
    expect([refused.status, refused.headers.get('location')]).toEqual([403, null])
  })

  it('without approve, refuses a hand-made approval that lacks the ticket cookie, or comes from another owner', async () => {
    const { app } = await oauthApp(memoryOAuthStore(), { owners: [OWNER, 'second@example.test'] })
    const client_id = await registered(app)
    const owner = browserOf(app, { 'x-test-owner': OWNER })
    const ticket = ticketIn(await (await owner.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
    const bare = await app.request('/oauth/authorize', { ...form({ ticket, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
    expect([bare.status, bare.headers.get('location')]).toEqual([403, null])
    const someoneElse = await owner.post('/oauth/authorize', { ticket, decision: 'allow' }, { 'sec-fetch-site': 'same-origin', 'x-test-owner': 'second@example.test' })
    expect(someoneElse.headers.get('location')).toBeNull()
    expect((await owner.post('/oauth/authorize', { ticket, decision: 'allow' })).headers.get('location')).toContain('code=')
  })

  it('sets the ticket cookie with the __Host- prefix over https, and reads only that name there', async () => {
    const { app } = await oauthApp(memoryOAuthStore())
    const client_id = await registered(app)
    const https = browserOf(app, { 'x-test-owner': OWNER, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.test' })
    const page = await https.request(`/oauth/authorize?${authorizeQuery(client_id)}`)
    const cookie = cookieOf(page)!
    expect(cookie).toMatch(/^__Host-oauth_ticket=[\w-]{32,}; /)
    for (const part of ['Max-Age=600', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) expect(cookie).toContain(part)
    expect(cookie).not.toContain('Domain')
    const ticket = ticketIn(await page.text())
    const nonce = /=([^;]+)/.exec(cookie)![1]!
    // The same value under the plain name, which a sibling host could set, is not the ticket's browser
    const plainName = await app.request('/oauth/authorize', { ...form({ ticket, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.test', 'sec-fetch-site': 'same-origin', cookie: `oauth_ticket=${nonce}` } })
    expect(plainName.status).toBe(403)
    expect((await https.post('/oauth/authorize', { ticket, decision: 'allow' })).headers.get('location')).toContain('code=')
    // Over http, no prefix and no Secure
    const http = cookieOf(await browserOf(app, { 'x-test-owner': OWNER }).request(`/oauth/authorize?${authorizeQuery(client_id)}`))!
    expect(http).toMatch(/^oauth_ticket=/)
    expect(http).not.toContain('Secure')
  })

  it('completes two sign-ins opened in one browser, the second opened in the first’s ninth minute', async () => {
    let at = Date.now()
    vi.useFakeTimers({ toFake: ['Date'], now: at })
    const { app } = await oauthApp(memoryOAuthStore())
    const client_id = await registered(app)
    const browser = browserOf(app, { 'x-test-owner': OWNER })
    const firstPage = await browser.request(`/oauth/authorize?${authorizeQuery(client_id, { state: 'one' })}`)
    const first = ticketIn(await firstPage.clone().text())
    vi.setSystemTime((at += 8.5 * 60 * 1000))
    const secondPage = await browser.request(`/oauth/authorize?${authorizeQuery(client_id, { state: 'two' })}`)
    // The same nonce, its life renewed: neither sign-in breaks the other
    expect(/=([^;]+)/.exec(cookieOf(secondPage)!)![1]).toBe(/=([^;]+)/.exec(cookieOf(firstPage)!)![1])
    expect(cookieOf(secondPage)).toContain('Max-Age=600')
    vi.setSystemTime((at += 60 * 1000))
    expect(new URL((await browser.post('/oauth/authorize', { ticket: first, decision: 'allow' })).headers.get('location')!).searchParams.get('state')).toBe('one')
    vi.setSystemTime((at += 8 * 60 * 1000))
    expect(new URL((await browser.post('/oauth/authorize', { ticket: ticketIn(await secondPage.text()), decision: 'allow' })).headers.get('location')!).searchParams.get('state')).toBe('two')
  })

  it('refuses a claim or device approval posted with no Sec-Fetch-Site and no matching Origin', async () => {
    const { app } = await oauthApp(memoryOAuthStore())
    const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Night shift' }))).json()
    const claim_attempt_token = new URL(registration.claim.verification_uri).searchParams.get('claim_attempt_token')!
    const device = 'urn:ietf:params:oauth:grant-type:device_code'
    const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
    const { user_code } = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
    const owner = browserOf(app, { 'x-test-owner': OWNER })
    for (const headers of <Record<string, string>[]>[{}, { origin: 'http://localhost.example.test' }, { 'sec-fetch-site': 'same-site' }]) {
      expect((await owner.post('/oauth/claim', { claim_attempt_token, user_code: registration.claim.user_code }, headers)).status, JSON.stringify(headers)).toBe(403)
      expect((await owner.post('/oauth/device', { user_code, decision: 'allow' }, headers)).status, JSON.stringify(headers)).toBe(403)
    }
    expect((await owner.post('/oauth/claim', { claim_attempt_token, user_code: registration.claim.user_code }, { origin: ORIGIN })).status).toBe(200)
    expect((await owner.post('/oauth/device', { user_code, decision: 'allow' }, { origin: ORIGIN })).status).toBe(200)
  })

  it('sends a referrer policy on every kit page with a form, so its POST carries the real Origin', async () => {
    const REFERRER = '<meta name="referrer" content="same-origin">'
    const { app } = await oauthApp(memoryOAuthStore())
    const owner = browserOf(app, { 'x-test-owner': OWNER })
    const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Night shift' }))).json()
    const device = 'urn:ietf:params:oauth:grant-type:device_code'
    const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
    const { user_code } = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
    const pages = {
      consent: await owner.request(`/oauth/authorize?${authorizeQuery(await registered(app))}`),
      claim: await owner.request(new URL(registration.claim.verification_uri).pathname + new URL(registration.claim.verification_uri).search),
      deviceCode: await owner.request('/oauth/device'),
      deviceConsent: await owner.request(`/oauth/device?user_code=${user_code}`),
      deviceConfirm: await owner.post('/oauth/device', { user_code }),
      deviceWrongCode: await owner.post('/oauth/device', { user_code: 'WXYZ-WXYZ' }),
    }
    for (const [name, answer] of Object.entries(pages)) {
      const html = await answer.text()
      expect(html, name).toContain('<form method="post"')
      expect(html, name).toContain(REFERRER)
      // The header stays strict; the page's own policy is what its form POST follows
      expect(answer.headers.get('referrer-policy'), name).toBe('no-referrer')
    }
  })

  it('refuses an approval POST with no Sec-Fetch-Site and Origin null, and takes one with the issuer’s Origin', async () => {
    // A browser sends Origin: null from a page served with no-referrer and no policy of its own; over plain http at a
    // non-loopback address it may send no Sec-Fetch-Site either, so only the page's referrer policy lets it through
    const { app } = await joinApp(memoryOAuthStore(), { approve: async (c, ask) => (ask.state === 'kit' ? null : c.html(`<input name="ticket" value="${ask.ticket}">`)) })
    const owner = browserOf(app, { 'x-test-owner': OWNER })
    const posts = async () => {
      const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Night shift' }))).json()
      const claim_attempt_token = new URL(registration.claim.verification_uri).searchParams.get('claim_attempt_token')!
      const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: ['urn:ietf:params:oauth:grant-type:device_code'] }))).json()
      const { user_code } = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
      const signIn = await registered(app)
      const kit = ticketIn(await (await owner.request(`/oauth/authorize?${authorizeQuery(signIn, { state: 'kit' })}`)).text())
      const own = ticketIn(await (await owner.request(`/oauth/authorize?${authorizeQuery(signIn)}`)).text())
      return [
        ['/oauth/authorize', { ticket: kit, decision: 'allow' }],
        ['/join/direct', { ticket: own, invite: 'garden-42' }],
        ['/oauth/claim', { claim_attempt_token, user_code: registration.claim.user_code }],
        ['/oauth/device', { user_code, decision: 'allow' }],
      ] as const
    }
    for (const [path, fields] of await posts()) {
      expect((await owner.post(path, fields, { origin: 'null' })).status, path).toBe(403)
      const taken = await owner.post(path, fields, { origin: ORIGIN })
      expect(taken.status, path).toBe(path === '/oauth/authorize' || path === '/join/direct' ? 302 : 200)
    }
  })

  it('tells a person at authorize with an unknown or expired client id to add the connection again', async () => {
    for (const options of [{}, { approve: async () => null }]) {
      const { app } = await oauthApp(memoryOAuthStore(), options)
      const page = await app.request(`/oauth/authorize?${authorizeQuery('client_gone')}`, { headers: { 'x-test-owner': OWNER } })
      expect([page.status, page.headers.get('location')]).toEqual([400, null])
      const text = await page.text()
      expect(text).toContain('not registered')
      expect(text).toContain('Remove this connection in your app and add it again.')
    }
  })

  it('names what is asked for on the kit’s consent page, and where it returns: a host, or an app on this computer', async () => {
    const { app } = await oauthApp(memoryOAuthStore(), { resources: (path) => path === '/s/alpha/mcp' })
    const owner = browserOf(app, { 'x-test-owner': OWNER })
    const pageFor = async (redirect: string, extra: Record<string, string> = {}) =>
      (await owner.request(`/oauth/authorize?${authorizeQuery(await registered(app, 'Sample', redirect), { redirect_uri: redirect, ...extra })}`)).text()
    expect(await pageFor('https://client.example.test/cb', { resource: `${ORIGIN}/s/alpha/mcp` })).toContain('<code>Sample: /s/alpha/mcp</code>')
    expect(await pageFor('https://client.example.test/cb', { resource: `${ORIGIN}/mcp` })).toContain('<code>Sample: /mcp</code>')
    expect(await pageFor('https://client.example.test/cb')).toContain('all of Sample')
    const hosted = await pageFor('https://client.example.test/cb')
    expect(hosted).toContain('<code>client.example.test</code>')
    expect(hosted).not.toContain('this computer')
    expect(await pageFor('http://127.0.0.1:33418/cb')).toContain('an app on this computer (<code>127.0.0.1:33418</code>)')
    expect(await pageFor('sample-app://oauth/callback')).toContain('an app on this computer (<code>sample-app:</code>)')
  })

  describe('the brand on the kit’s own pages', () => {
    const BRAND = defineBrand({ name: 'sample', title: 'Sample Notes', description: 'Notes for agents.', accent: '#2563eb' })
    const brandedApp = async (brand = true) => {
      const oauth = createOAuth({ name: 'Sample', signingKey: await generateOAuthKey(), store: memoryOAuthStore(), owner: async (c) => c.req.header('x-test-owner') ?? null, owners: [OWNER] })
      return createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys('') }, oauth, ...(brand ? { brand: createBrand(BRAND, ASSETS) } : {}) })
    }
    const pagesOf = async (app: App) => {
      const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Sample', redirect_uris: ['http://localhost:7777/cb'], logo_uri: 'https://tracker.example.test/logo.png' }))).json()
      const owner = browserOf(app, { 'x-test-owner': OWNER })
      const consent = await (await owner.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text()
      const signIn = await (await app.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text()
      const error = await (await owner.request(`/oauth/authorize?${authorizeQuery('client_gone')}`)).text()
      const device = await (await owner.request('/oauth/device')).text()
      const expired = await (await owner.post('/oauth/authorize', { ticket: 'consent_gone', decision: 'allow' })).text()
      return { consent, signIn, error, device, expired }
    }

    it('carries the app’s brand: head tags, icon, name and accent, and never a client’s logo_uri', async () => {
      for (const [name, html] of Object.entries(await pagesOf(await brandedApp()))) {
        expect(html, name).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">')
        expect(html, name).toContain('<meta name="theme-color" content="#2563eb">')
        expect(html, name).toContain('<img src="/icon.svg"')
        expect(html, name).toContain('Sample Notes')
        expect(html, name).toContain('--accent:#2563eb')
        expect(html, name).not.toContain('tracker.example.test')
      }
    })

    it('keeps today’s look without a brand', async () => {
      for (const [name, html] of Object.entries(await pagesOf(await brandedApp(false)))) {
        for (const absent of ['<link rel="icon"', 'theme-color', '<img', '--accent', 'tracker.example.test']) expect(html, name).not.toContain(absent)
      }
    })
  })
})

describe('OAuth open endpoints: one public origin, lifetimes, caps and limits for sign-ins by anyone', () => {
  const PUBLIC = 'https://sample.example.test'
  const FORGED = { 'x-forwarded-host': 'elsewhere.example.test', 'x-forwarded-proto': 'https' }
  const REDIRECT = 'http://localhost:7777/cb'
  const VERIFIER = 'v'.repeat(43)
  const DAY = 24 * 3600
  const DEVICE = 'urn:ietf:params:oauth:grant-type:device_code'
  const nowSeconds = () => Math.floor(Date.now() / 1000)
  afterEach(() => vi.useRealTimers())
  // Only Date moves: jose and the stores read it, and async crypto keeps working
  const clock = () => {
    let at = Date.now()
    vi.useFakeTimers({ toFake: ['Date'], now: at })
    return (seconds: number) => vi.setSystemTime((at += seconds * 1000))
  }
  type App = Awaited<ReturnType<typeof oauthApp>>['app']
  const ownerForm = { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' }
  /** A device client the owner approved, its first token collected. */
  const deviceSignedIn = async (app: App) => {
    const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [DEVICE] }))).json()
    const { device_code, user_code } = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
    await app.request('/oauth/device', { ...form({ user_code, decision: 'allow' }), headers: ownerForm })
    expect((await app.request('/oauth/token', form({ grant_type: DEVICE, device_code, client_id }))).status).toBe(200)
    return client_id as string
  }
  const authorizePage = (app: App, client_id: string, headers: Record<string, string> = {}) => app.request(`/oauth/authorize?${authorizeQuery(client_id)}`, { headers: { 'x-test-owner': OWNER, ...headers } })
  const deviceStart = (app: App, client_id: string, headers: Record<string, string> = {}) => app.request('/oauth/device_authorization', { ...form({ client_id }), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } })
  const register = (app: App, headers: Record<string, string> = {}) => app.request('/oauth/register', json({ client_name: 'Sample', redirect_uris: [REDIRECT] }, headers))

  it('a forged x-forwarded-host changes no document, iss or check when publicOrigin is set', async () => {
    const store = memoryOAuthStore()
    const { app } = await oauthApp(store, { publicOrigin: PUBLIC })
    for (const headers of [{}, FORGED]) {
      const as = await app.request('/.well-known/oauth-authorization-server', { headers })
      expect(as.headers.get('cache-control')).toBe('public, max-age=300')
      expect(await as.json()).toMatchObject({ issuer: PUBLIC, token_endpoint: `${PUBLIC}/oauth/token`, protected_resources: [PUBLIC, `${PUBLIC}/mcp`], agent_auth: { skill: `${PUBLIC}/auth.md` } })
      const prm = await app.request('/.well-known/oauth-protected-resource/mcp', { headers })
      expect(prm.headers.get('cache-control')).toBe('public, max-age=300')
      expect(await prm.json()).toMatchObject({ resource: `${PUBLIC}/mcp`, authorization_servers: [PUBLIC] })
      const md = await app.request('/auth.md', { headers })
      expect(md.headers.get('cache-control')).toBe('public, max-age=300')
      const text = await md.text()
      expect(text).toContain(`${PUBLIC}/oauth/register`)
      expect(text).not.toContain('elsewhere.example.test')
      expect((await app.request('/api/v1/things', { headers })).headers.get('www-authenticate')).toContain(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource"`)
    }

    // A sign-in made through the forged host: the resource is checked against the public origin, and iss is it
    const signIn = async (resource: string) => {
      const client_id = await registered(app)
      const answer = await approveSignIn(app, authorizeQuery(client_id, { resource }), { headers: { ...FORGED, 'x-test-owner': OWNER } })
      const back = new URL(answer.headers.get('location')!)
      expect(back.searchParams.get('iss')).toBe(PUBLIC)
      const exchanged = await app.request('/oauth/token', { ...form({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }), headers: { 'content-type': 'application/x-www-form-urlencoded', ...FORGED } })
      return (await exchanged.json()) as { access_token: string }
    }
    const tokens = await signIn(`${PUBLIC}/mcp`)
    expect(decodeJwt(tokens.access_token)).toMatchObject({ iss: PUBLIC, aud: `${PUBLIC}/mcp` })
    // The forged host's MCP is not this server's: the grant gets the public root
    expect(audOf((await signIn('https://elsewhere.example.test/mcp')).access_token)).toBe(PUBLIC)
    // verify checks the issuer against the public origin, whatever host the request names
    for (const headers of [{}, FORGED]) expect((await app.request('/api/v1/things', { headers: { ...headers, authorization: `Bearer ${tokens.access_token}` } })).status).toBe(200)

    // The same-origin rule compares Origin with the public origin, never the forged host
    const browser = browserOf(app, { ...FORGED, 'x-test-owner': OWNER })
    const page = await browser.request(`/oauth/authorize?${authorizeQuery(await registered(app))}`)
    expect(page.headers.get('set-cookie')).toMatch(/^__Host-oauth_ticket=.*; Secure/)
    const ticket = ticketIn(await page.text())
    expect((await browser.post('/oauth/authorize', { ticket, decision: 'allow' }, { origin: 'https://elsewhere.example.test' })).status).toBe(403)
    expect((await browser.post('/oauth/authorize', { ticket, decision: 'allow' }, { origin: PUBLIC })).status).toBe(302)

    // The device and claim links point at the public origin
    const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [DEVICE] }))).json()
    expect((await (await deviceStart(app, client_id, FORGED)).json()).verification_uri).toBe(`${PUBLIC}/oauth/device`)
    const agent = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER }, FORGED))).json()
    expect(agent.claim.verification_uri.startsWith(`${PUBLIC}/oauth/claim?`)).toBe(true)

    // The Personal Agent Protocol document names the same issuer
    const oauth = createOAuth({ name: 'Sample', signingKey: await generateOAuthKey(), store, owner: async () => null, publicOrigin: PUBLIC })
    const withPoppy = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys('') }, oauth, discovery: { poppy: { name: 'Sample' } } })
    expect((await (await withPoppy.request('/.well-known/poppy.json', { headers: FORGED })).json()).auth.issuer).toBe(PUBLIC)

    // One origin, canonical, with no path
    const keyed = { name: 'Sample', signingKey: await generateOAuthKey(), store, owner: async () => null }
    const canonicalApp = (await oauthApp(store, { publicOrigin: 'HTTPS://Sample.Example.test:443/' })).app
    expect(await (await canonicalApp.request('/.well-known/oauth-authorization-server')).json()).toMatchObject({ issuer: PUBLIC })
    for (const wrong of ['https://sample.example.test/app', 'sample.example.test', 'https://sample.example.test/?x=1']) expect(() => createOAuth({ ...keyed, publicOrigin: wrong }), wrong).toThrow(/publicOrigin/)
  })

  it('a forged x-forwarded-host reaches no publicly cached discovery document when publicOrigin is set', async () => {
    const oauth = createOAuth({ name: 'Cookbook', signingKey: await generateOAuthKey(), store: memoryOAuthStore(), owner: async () => null, publicOrigin: PUBLIC })
    const app = await cookbookApi({ oauth, discovery: { sitemap: ['/llms.txt'], poppy: { name: 'Cookbook', apis: [{ type: 'openapi', path: '/openapi.json', description: 'The API' }] } } })
    const documents = ['/.well-known/api-catalog', '/robots.txt', '/sitemap.xml', '/.well-known/poppy.json', '/.well-known/ai-catalog.json', '/.well-known/agent-card.json', '/mcp/server-card', '/.well-known/mcp/server-card.json', '/.well-known/agent-skills/index.json']
    for (const path of documents) {
      const answer = await app.request(path, { headers: FORGED })
      expect([answer.status, answer.headers.get('cache-control')], path).toEqual([200, 'public, max-age=3600'])
      expect(await answer.text(), path).not.toContain('elsewhere.example.test')
    }
    const poppy = await (await app.request('/.well-known/poppy.json', { headers: FORGED })).json()
    expect(poppy).toMatchObject({ organization: { domain: 'sample.example.test' }, auth: { issuer: PUBLIC }, apis: [{ url: `${PUBLIC}/openapi.json` }] })
    expect(await (await app.request('/.well-known/api-catalog', { headers: FORGED })).text()).toContain(`${PUBLIC}/api`)
    // A skill's index entry and its archive, rendered for the public origin
    const guided = createAgentApi({ title: 'Cookbook', version: '1.0.0', description: 'Recipes.', tags: [], auth: { realm: 'cookbook', keys: parseApiKeys('') }, oauth })
    serveGuide(guided, { files: { 'llms.txt': '# Cookbook\n', 'skills/recipes/SKILL.md': '---\nname: recipes\ndescription: Use when finding recipes at {{origin}}.\n---\n\n# Recipes at {{origin}}\n', 'skills/recipes/references/soups.md': '# Soups at {{origin}}\n' }, vars: () => ({}), full: ['llms.txt'] })
    const index = await (await guided.request('/.well-known/agent-skills/index.json', { headers: FORGED })).json()
    expect(index.skills).toMatchObject([{ name: 'recipes', description: `Use when finding recipes at ${PUBLIC}.`, url: `${PUBLIC}/.well-known/agent-skills/recipes.tar.gz` }])
    const archive = await guided.request('/.well-known/agent-skills/recipes.tar.gz', { headers: FORGED })
    expect(archive.headers.get('cache-control')).toBe('public, max-age=3600')
    const unpacked = gunzipSync(new Uint8Array(await archive.arrayBuffer())).toString('utf8')
    expect(unpacked).toContain(`# Recipes at ${PUBLIC}`)
    expect(unpacked).not.toContain('elsewhere.example.test')
    // Without publicOrigin, each request's origin, as before
    const plain = await cookbookApi({ oauth: createOAuth({ name: 'Cookbook', signingKey: await generateOAuthKey(), store: memoryOAuthStore(), owner: async () => null }) })
    expect(await (await plain.request('/.well-known/api-catalog', { headers: FORGED })).text()).toContain('https://elsewhere.example.test/api')
  })

  it('without publicOrigin the metadata is no-store', async () => {
    const { app } = await oauthApp(memoryOAuthStore())
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/auth.md'])
      expect((await app.request(path)).headers.get('cache-control'), path).toBe('no-store')
    // The keys name no origin, so a shared cache may keep them
    expect((await app.request('/.well-known/jwks.json')).headers.get('cache-control')).toBe('public, max-age=300')
  })

  it('a registration never used lapses in a week; one used by a code or a device lives a year', async () => {
    const tick = clock()
    const store = memoryOAuthStore()
    const { app } = await oauthApp(store)
    const unused = await registered(app)
    const byCode = (await signedIn(app)).client_id
    const byDevice = await deviceSignedIn(app)
    // A client registered before registrations lapsed: no `used` flag, a year's life
    await store.put('client', 'client_before', { name: 'Before', redirectUris: [REDIRECT] }, nowSeconds() + 365 * DAY)
    tick(7 * DAY - 60)
    expect((await authorizePage(app, unused)).status).toBe(200)
    tick(120)
    const lapsed = await authorizePage(app, unused)
    expect(lapsed.status).toBe(400)
    expect(await lapsed.text()).toContain('Remove this connection in your app and add it again.')
    tick(350 * DAY)
    expect((await authorizePage(app, byCode)).status).toBe(200)
    expect((await deviceStart(app, byDevice)).status).toBe(200)
    expect((await authorizePage(app, 'client_before')).status).toBe(200)
    // A year from its first use, the used one lapses too
    tick(15 * DAY)
    expect((await authorizePage(app, byCode)).status).toBe(400)
  })

  it('a code approved before its unused registration lapsed still works after, and the client is not made again', async () => {
    const tick = clock()
    const { app } = await oauthApp(memoryOAuthStore())
    const client_id = await registered(app)
    tick(7 * DAY - 60)
    // An approval after the lapse is refused: the client is read again
    const browser = browserOf(app, { 'x-test-owner': OWNER })
    const late = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
    const approved = await approveSignIn(app, authorizeQuery(client_id), { headers: { 'x-test-owner': OWNER } })
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!
    tick(120)
    expect((await browser.post('/oauth/authorize', { ticket: late, decision: 'allow' }, { origin: ORIGIN })).status).toBe(400)
    const exchanged = await app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }))
    expect(exchanged.status).toBe(200)
    const { refresh_token } = await exchanged.json()
    expect((await app.request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token }))).status).toBe(200)
    expect(await (await authorizePage(app, client_id)).text()).toContain('Remove this connection in your app and add it again.')
  })

  it('past the cap a new registration evicts the oldest unused one', async () => {
    const tick = clock()
    const store = memoryOAuthStore()
    const { app } = await oauthApp(store, { maxUnusedClients: 3 })
    const used = (await signedIn(app)).client_id
    await store.put('client', 'client_before', { name: 'Before', redirectUris: [REDIRECT] }, nowSeconds() + 365 * DAY)
    const ids: string[] = []
    for (let n = 0; n < 4; n++) {
      ids.push(await registered(app))
      tick(1)
    }
    expect(await Promise.all(ids.map(async (id) => Boolean(await store.get('client', id))))).toEqual([false, true, true, true])
    // A used client and one from before the cap are never evicted
    expect(await store.get('client', used)).not.toBeNull()
    expect(await store.get('client', 'client_before')).not.toBeNull()
    expect(await (await authorizePage(app, ids[0]!)).text()).toContain('Remove this connection in your app and add it again.')
  })

  it('takes only a whole number of rows, zero or more, as a cap', async () => {
    const keyed = { name: 'Sample', signingKey: await generateOAuthKey(), store: memoryOAuthStore(), owner: async () => null }
    for (const wrong of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => createOAuth({ ...keyed, maxUnusedClients: wrong }), String(wrong)).toThrow(/maxUnusedClients/)
      expect(() => createOAuth({ ...keyed, maxUnusedTickets: wrong }), String(wrong)).toThrow(/maxUnusedTickets/)
    }
    expect(() => createOAuth({ ...keyed, maxUnusedClients: 0, maxUnusedTickets: 3 })).not.toThrow()
  })

  it('a burst of registrations is pruned and never stops a new one', async () => {
    const tick = clock()
    const db = await testDb()
    const store = await dbOAuthStore(db)
    const { app } = await oauthApp(store, { maxUnusedClients: 5 })
    const rowsOf = async (kind: string) => (await db.select({ n: count() }).from(oauthKeys).where(eq(oauthKeys.kind, kind)))[0]!.n
    for (let n = 0; n < 30; n++) expect((await register(app)).status).toBe(201)
    expect(await rowsOf('client')).toBe(5)
    const burst = await Promise.all(Array.from({ length: 10 }, () => register(app)))
    expect(burst.map((answer) => answer.status)).toEqual(Array(10).fill(201))
    expect((await register(app)).status).toBe(201)
    expect(await rowsOf('client')).toBe(5)

    // Expired rows leave the table on a write, at most once a minute
    await store.put('code', 'stale', { used: false }, nowSeconds() + 5)
    tick(10)
    await register(app)
    expect(await rowsOf('code')).toBe(1)
    tick(60)
    await register(app)
    expect(await rowsOf('code')).toBe(0)
  })

  it('caps stored consent tickets like unused registrations: past the cap the oldest open one goes', async () => {
    const tick = clock()
    const { app } = await joinApp(memoryOAuthStore(), { maxUnusedTickets: 2 })
    const client_id = await registered(app)
    const opened: { browser: ReturnType<typeof browserOf>; ticket: string }[] = []
    for (let n = 0; n < 3; n++) {
      const browser = browserOf(app)
      const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
      opened.push({ browser, ticket })
      tick(1)
    }
    const join = ({ browser, ticket }: { browser: ReturnType<typeof browserOf>; ticket: string }) => browser.post('/join', { ticket, invite: 'garden-42' })
    const evicted = await join(opened[0]!)
    expect([evicted.status, await evicted.text()]).toEqual([400, '<p>This sign-in expired: start again from your app.</p>'])
    expect((await join(opened[2]!)).status).toBe(302)
    // An answered ticket is not open: it never takes a place under the cap
    const browser = browserOf(app)
    const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
    expect((await join(opened[1]!)).status).toBe(302)
    expect((await join({ browser, ticket })).status).toBe(302)
  })

  it('the open endpoints are limited per trusted address, and token-endpoint junk never refuses a right code', async () => {
    const limits = { store: memoryGuardStore(), address: { header: 'x-forwarded-for' } }
    const { app } = await oauthApp(memoryOAuthStore(), { limits })
    // One proxy that appends: the last value is the address
    const from = (address: string) => ({ 'x-forwarded-for': `198.51.100.7, ${address}` })
    const refusedFor = async (answer: Response) => {
      expect(answer.status).toBe(429)
      expect(Number(answer.headers.get('retry-after'))).toBeGreaterThan(0)
      return answer
    }

    // Registrations, by /oauth/register and /agent/identity alike: 20 an hour per address
    for (let n = 0; n < 10; n++) expect((await register(app, from('203.0.113.1'))).status).toBe(201)
    for (let n = 0; n < 10; n++) expect((await app.request('/agent/identity', json({ type: 'anonymous' }, from('203.0.113.1')))).status).toBe(200)
    expect((await (await refusedFor(await register(app, from('203.0.113.1')))).json()).error).toBe('too_many_requests')
    await refusedFor(await app.request('/agent/identity', json({ type: 'anonymous' }, from('203.0.113.1'))))
    expect((await register(app, from('203.0.113.2'))).status).toBe(201)
    // IPv6 counts by its /64
    for (let n = 1; n <= 20; n++) expect((await register(app, from(`2001:db8:1:2::${n}`))).status).toBe(201)
    await refusedFor(await register(app, from('2001:db8:1:2:ffff::1')))
    expect((await register(app, from('2001:db8:1:3::1'))).status).toBe(201)

    // Device authorization: 20 an hour
    const { client_id: device } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [DEVICE] }))).json()
    for (let n = 0; n < 20; n++) expect((await deviceStart(app, device, from('203.0.113.3'))).status).toBe(200)
    await refusedFor(await deviceStart(app, device, from('203.0.113.3')))

    // The token endpoint counts misses only, after the lookup: 30 a minute
    const right = await approvedCode(app)
    const junk = (n: number) => app.request('/oauth/token', { ...form({ grant_type: 'authorization_code', code: `code_junk${n}`, client_id: right.client_id, code_verifier: VERIFIER }), headers: { 'content-type': 'application/x-www-form-urlencoded', ...from('203.0.113.4') } })
    for (let n = 0; n < 25; n++) expect((await (await junk(n)).json()).error).toBe('invalid_grant')
    for (let n = 0; n < 5; n++) expect((await (await app.request('/oauth/token', { ...form({ grant_type: 'refresh_token', refresh_token: `rt_junk${n}` }), headers: { 'content-type': 'application/x-www-form-urlencoded', ...from('203.0.113.4') } })).json()).error).toBe('invalid_grant')
    await refusedFor(await junk(99))
    const exchanged = await app.request('/oauth/token', { ...form({ grant_type: 'authorization_code', code: right.code, client_id: right.client_id, redirect_uri: REDIRECT, code_verifier: right.verifier }), headers: { 'content-type': 'application/x-www-form-urlencoded', ...from('203.0.113.4') } })
    expect(exchanged.status).toBe(200)
    // A pending device poll is no miss
    const { device_code } = await (await deviceStart(app, device, from('203.0.113.5'))).json()
    for (let n = 0; n < 35; n++) expect((await app.request('/oauth/token', { ...form({ grant_type: DEVICE, device_code, client_id: device }), headers: { 'content-type': 'application/x-www-form-urlencoded', ...from('203.0.113.5') } })).status).toBe(400)

    // The sign-in page an app opens to anyone (approve): 60 a minute, then a 429 page
    const { app: open } = await joinApp(memoryOAuthStore(), { limits: { store: memoryGuardStore(), address: { header: 'x-forwarded-for' } } })
    const client_id = await registered(open)
    for (let n = 0; n < 60; n++) expect((await open.request(`/oauth/authorize?${authorizeQuery(client_id)}`, { headers: from('203.0.113.6') })).status).toBe(200)
    const page = await refusedFor(await open.request(`/oauth/authorize?${authorizeQuery(client_id)}`, { headers: from('203.0.113.6') }))
    expect(page.headers.get('content-type')).toContain('text/html')
    expect((await open.request(`/oauth/authorize?${authorizeQuery(client_id)}`, { headers: from('203.0.113.7') })).status).toBe(200)

    // Without limits (the default), nothing is counted
    const { app: unlimited } = await oauthApp(memoryOAuthStore())
    for (let n = 0; n < 25; n++) expect((await register(unlimited, from('203.0.113.1'))).status).toBe(201)
  })

  it('the owner is never counted against an address bucket', async () => {
    const { app } = await oauthApp(memoryOAuthStore(), { limits: { store: memoryGuardStore(), address: { header: 'x-forwarded-for' } } })
    const shared = { 'x-forwarded-for': '203.0.113.8' }
    const client_id = await registered(app)
    // Someone on the owner's address fills its buckets
    for (let n = 0; n < 60; n++) expect((await app.request(`/oauth/authorize?${authorizeQuery(client_id)}`, { headers: shared })).status).toBe(401)
    expect((await app.request(`/oauth/authorize?${authorizeQuery(client_id)}`, { headers: shared })).status).toBe(429)
    for (let n = 0; n < 20; n++) await register(app, shared)
    expect((await register(app, shared)).status).toBe(429)
    // The owner, signed in on that address, still signs in, registers and approves
    for (let n = 0; n < 5; n++) expect((await authorizePage(app, client_id, shared)).status).toBe(200)
    expect((await register(app, { ...shared, 'x-test-owner': OWNER })).status).toBe(201)
    const approved = await approveSignIn(app, authorizeQuery(client_id), { headers: { ...shared, 'x-test-owner': OWNER } })
    expect(approved.status).toBe(302)
  })
})

oauthStoreContract('memory', async () => memoryOAuthStore())
oauthStoreContract('database (node:sqlite)', async () => dbOAuthStore(await testDb()))

describe('OAuth store in the database', () => {
  it('keeps what was issued across a restart and forgets what expired', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'oauth-')), 'state.sqlite')
    const later = Math.floor(Date.now() / 1000) + 3600
    const first = await dbOAuthStore(await openDb(`file:${file}`))
    await first.put('client', 'c1', { name: 'Claude' }, later)
    await first.put('code', 'old', { used: false }, Math.floor(Date.now() / 1000) - 1)
    await first.put('client', 'c2', { name: 'Gone' }, later)
    await first.delete('client', 'c2')
    const restarted = await dbOAuthStore(await openDb(`file:${file}`))
    expect(await restarted.get('client', 'c1')).toEqual({ name: 'Claude' })
    expect(await restarted.get('code', 'old')).toBeNull()
    expect(await restarted.get('client', 'c2')).toBeNull()
    expect(new DatabaseSync(file).prepare('select count(*) as n from oauth').get()).toEqual({ n: 1 })
  })
})
