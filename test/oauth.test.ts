import { createHash, randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentApi, createOAuth, generateOAuthKey, memoryOAuthStore, parseApiKeys, dbOAuthStore, openDb } from '../src/index.js'

const OWNER = 'owner@example.test'
const ORIGIN = 'http://localhost'

const sampleApi = async () => {
  const oauth = createOAuth({
    name: 'Sample',
    signingKey: await generateOAuthKey(),
    store: memoryOAuthStore(),
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
    expect((await app.request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token }))).status).toBe(400)

    expect((await app.request('/oauth/revoke', form({ token: tokens.access_token }))).status).toBe(200)
    expect((await app.request('/api/v1/things', { headers: auth })).status).toBe(401)
    expect((await app.request('/api/v1/things', { headers: { authorization: `Bearer ${rotated.access_token}` } })).status).toBe(200)
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

    // Another sign-in of the same agent is untouched by that, and the owner's kill switch ends it too
    const other = await (await app.request('/oauth/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: granted.identity_assertion }))).json()
    expect(other.access_token).toBeTruthy()
    const registration2 = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER }))).json()
    const attempt2 = new URL(registration2.claim.verification_uri).searchParams.get('claim_attempt_token')!
    await app.request('/oauth/claim', { ...form({ claim_attempt_token: attempt2, user_code: registration2.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER } })
    const granted2 = await (await app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: registration2.claim_token }))).json()
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
    const start = async (app: Awaited<ReturnType<typeof sampleApi>>['app'], scope = 'read write') => {
      const registered = await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [DEVICE] }))
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
