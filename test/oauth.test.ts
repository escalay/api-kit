import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignJWT, importJWK } from 'jose'
import type { Context } from 'hono'
import { createAgentApi, createOAuth, generateOAuthKey, matches, memoryOAuthStore, memoryStore, originOf, parseApiKeys, dbOAuthStore, openDb, rateLimit, testDb, type OAuthStore } from '../src/index.js'
import { approvedCode, audOf, callerWith, formWithTwoResources, oauthApp, oauthStoreContract, refreshWith, signedIn } from './oauth-store-contract.js'

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
    const consent = await app.request(`/oauth/authorize?${query}`, { headers: { 'x-test-owner': OWNER } })
    const html = await consent.text()
    expect(html).toContain('Allow <strong>Claude</strong>')
    const ticket = /name="ticket" value="([^"]+)"/.exec(html)![1]!
    // Another site can't approve through the owner's session
    expect((await app.request('/oauth/authorize', { ...form({ ticket, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'cross-site' } })).status).toBe(403)
    const approved = await app.request('/oauth/authorize', { ...form({ ticket, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
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
    const ticket = /name="ticket" value="([^"]+)"/.exec(await (await app.request(`/oauth/authorize?${query}`, { headers: { 'x-test-owner': OWNER } })).text())![1]!
    const location = (await app.request('/oauth/authorize', { ...form({ ticket, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER } })).headers.get('location')!
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
    const signedIn = { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER }
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
    await app.request('/oauth/claim', { ...form({ claim_attempt_token: attemptToken, user_code: registration.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER } })
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
    await app.request('/oauth/claim', { ...form({ claim_attempt_token: attempt2, user_code: registration2.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER } })
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
    await app.request('/oauth/claim', { ...form({ claim_attempt_token: attemptToken, user_code: registration.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER } })
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
    await app.request('/oauth/claim', { ...form({ claim_attempt_token: attemptToken, user_code: registration.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER } })
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
      app.request('/oauth/claim', { ...form({ claim_attempt_token: new URL(attempt.verification_uri).searchParams.get('claim_attempt_token')!, user_code: attempt.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER } })
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
      await app.request('/oauth/claim', { ...form({ claim_attempt_token, user_code: registration.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER } })
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
    await app.request('/oauth/claim', { ...form({ claim_attempt_token, user_code: registered.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER } })
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
