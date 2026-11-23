import { createHash, randomBytes } from 'node:crypto'
import { decodeJwt } from 'jose'
import { describe, expect, it } from 'vitest'
import { createAgentApi, createOAuth, generateOAuthKey, parseApiKeys, type OAuthConfig, type OAuthStore } from '../src/index.js'

/**
 * What every OAuth store must do, and the attacks on the token endpoint that a store decides: the same checks run on
 * memory, on node:sqlite and, in workerd, on D1. Rules after cloudflare/workers-oauth-provider and better-auth (both
 * MIT): each test names the advisory or issue it guards against.
 */

export const OWNER = 'owner@example.test'
const ORIGIN = 'http://localhost'
const REDIRECT = 'http://localhost:7777/cb'
const now = () => Math.floor(Date.now() / 1000)
const sha = (value: string) => createHash('sha256').update(value).digest('hex')

export const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
/** A form that names `resource` twice, which a grant from before audiences ignores like any other. */
export const formWithTwoResources = (fields: Record<string, string>, resources = [ORIGIN, `${ORIGIN}/mcp`]) =>
  ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: [new URLSearchParams(fields), ...resources.map((resource) => `resource=${encodeURIComponent(resource)}`)].join('&') })

/** A sample app with the kit's OAuth over `store`; a header stands in for the single sign-on. */
export const oauthApp = async (store: OAuthStore, options: Partial<OAuthConfig> = {}) => {
  const oauth = createOAuth({ name: 'Sample', signingKey: await generateOAuthKey(), store, owner: async (c) => c.req.header('x-test-owner') ?? null, owners: [OWNER], ...options })
  const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys('') }, oauth })
  app.get('/api/v1/things', (c) => c.json({ caller: c.get('caller' as never) }))
  return { app, oauth }
}

type App = Awaited<ReturnType<typeof oauthApp>>['app']

/** Registers a client (unless given one), has the owner approve it, and returns the code with what exchanges it. */
export const approvedCode = async (app: App, { clientId, name = 'Sample', resource, scope = 'read write' }: { clientId?: string; name?: string; resource?: string; scope?: string } = {}) => {
  const client_id = clientId ?? (await (await app.request('/oauth/register', json({ client_name: name, redirect_uris: [REDIRECT] }))).json()).client_id as string
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope, ...(resource === undefined ? {} : { resource }) })
  const page = await (await app.request(`/oauth/authorize?${query}`, { headers: { 'x-test-owner': OWNER } })).text()
  const ticket = /name="ticket" value="([^"]+)"/.exec(page)![1]!
  const approved = await app.request('/oauth/authorize', { ...form({ ticket, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
  const code = new URL(approved.headers.get('location')!).searchParams.get('code')!
  const exchange = (fields: Record<string, string> = {}) => app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: verifier, ...fields }))
  return { client_id, code, verifier, challenge, exchange }
}

/** A client signed in: its tokens, and calls that use them. */
export const signedIn = async (app: App, options: { clientId?: string; name?: string; resource?: string } = {}) => {
  const { client_id, exchange } = await approvedCode(app, options)
  const tokens = (await (await exchange()).json()) as { access_token: string; refresh_token: string }
  return { client_id, tokens }
}

export const callerWith = (app: App, accessToken: string) => app.request('/api/v1/things', { headers: { authorization: `Bearer ${accessToken}` } })
export const refreshWith = (app: App, refreshToken: string, resource?: string) =>
  app.request('/oauth/token', form({ grant_type: 'refresh_token', refresh_token: refreshToken, ...(resource === undefined ? {} : { resource }) }))
/** The audience an access token was signed for, if any. */
export const audOf = (accessToken: string) => decodeJwt(accessToken).aud
/** The owner types an agent's claim code on the claim page. */
const typeClaim = (app: App, attempt: { verification_uri: string; user_code: string }) =>
  app.request('/oauth/claim', { ...form({ claim_attempt_token: new URL(attempt.verification_uri).searchParams.get('claim_attempt_token')!, user_code: attempt.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER } })
const claimPoll = (app: App, claimToken: string) => app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: claimToken }))

export const oauthStoreContract = (name: string, make: () => Promise<OAuthStore>) =>
  describe(`OAuthStore: ${name}`, () => {
    it('takes a live row once, however many ask at once, and never an expired one', async () => {
      const store = await make()
      const id = `t-${crypto.randomUUID()}`
      await store.put('ticket', id, { n: 1 }, now() + 600)
      const taken = await Promise.all(Array.from({ length: 5 }, () => store.take!('ticket', id)))
      expect(taken.filter(Boolean)).toEqual([{ n: 1 }])
      expect(await store.get('ticket', id)).toBeNull()
      await store.put('ticket', `${id}-old`, { n: 2 }, now() - 1)
      expect(await store.take!('ticket', `${id}-old`)).toBeNull()
      expect(await store.take!('ticket', `${id}-none`)).toBeNull()
    })

    it('marks a live row used once, reads a row with no used key as unused, and never marks an expired one', async () => {
      const store = await make()
      const id = `m-${crypto.randomUUID()}`
      await store.put('refresh', id, { client: 'c1', used: false }, now() + 600)
      const marked = await Promise.all(Array.from({ length: 5 }, () => store.markUsed!('refresh', id)))
      expect(marked.filter(Boolean)).toEqual([{ client: 'c1', used: true, usedAt: expect.any(Number) }])
      expect(await store.get('refresh', id)).toMatchObject({ used: true })
      // A sign-in made before `used` existed
      await store.put('refresh', `${id}-legacy`, { client: 'c1' }, now() + 600)
      expect(await store.markUsed!('refresh', `${id}-legacy`)).toMatchObject({ client: 'c1', used: true })
      await store.put('code', `${id}-old`, { client: 'c1', used: false }, now() - 1)
      expect(await store.markUsed!('code', `${id}-old`)).toBeNull()
      expect(await store.markUsed!('code', `${id}-none`)).toBeNull()
    })

    // workers-oauth-provider #420; better-auth GHSA-7w99-5wm4-3g79; OAuth 2.1 §4.1.3
    it('gives one token for two exchanges of a code at once, and the second valid one revokes what the first got', async () => {
      const { app } = await oauthApp(await make())
      const { exchange } = await approvedCode(app)
      const answers = await Promise.all([exchange(), exchange()])
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400])
      const tokens = await answers.find((answer) => answer.status === 200)!.json()
      expect((await callerWith(app, tokens.access_token)).status).toBe(401)
      expect((await (await refreshWith(app, tokens.refresh_token)).json()).error).toBe('invalid_grant')
    })

    it('revokes the sign-in when a used code comes back with its verifier, and nothing when the verifier is wrong', async () => {
      const { app } = await oauthApp(await make())
      const stolen = await approvedCode(app)
      const tokens = await (await stolen.exchange()).json()
      expect((await (await stolen.exchange({ code_verifier: 'not-the-verifier' })).json()).error).toBe('invalid_grant')
      expect((await callerWith(app, tokens.access_token)).status).toBe(200)
      expect((await (await stolen.exchange()).json()).error).toBe('invalid_grant')
      expect((await callerWith(app, tokens.access_token)).status).toBe(401)
      expect((await (await refreshWith(app, tokens.refresh_token)).json()).error).toBe('invalid_grant')
    })

    // OAuth 2.1 §10.2: PKCE binds the code, so redirect_uri is checked only when sent
    it('exchanges a code without redirect_uri, and refuses one with another redirect_uri', async () => {
      const { app } = await oauthApp(await make())
      expect((await (await approvedCode(app)).exchange({ redirect_uri: '' })).status).toBe(200)
      const wrong = await (await approvedCode(app)).exchange({ redirect_uri: 'http://localhost:7777/elsewhere' })
      expect([wrong.status, (await wrong.json()).error]).toEqual([400, 'invalid_grant'])
    })

    // better-auth GHSA-9h47-pqcx-hjr4; workers-oauth-provider GHSA-qgp8-v765-qxx9
    it('refuses plain PKCE and a missing challenge at authorize', async () => {
      const { app } = await oauthApp(await make())
      const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Sample', redirect_uris: [REDIRECT] }))).json()
      for (const pkce of [{ code_challenge: 'abc', code_challenge_method: 'plain' }, {}] as Record<string, string>[]) {
        const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, ...pkce })
        const answer = await app.request(`/oauth/authorize?${query}`, { headers: { 'x-test-owner': OWNER } })
        expect(answer.status).toBe(302)
        expect(new URL(answer.headers.get('location')!).searchParams.get('error')).toBe('invalid_request')
      }
    })

    it('refuses an expired code and an expired refresh token while their rows are still in the table', async () => {
      const store = await make()
      const { app } = await oauthApp(store)
      const { client_id, code, verifier, challenge } = await approvedCode(app)
      const row = { client: client_id, redirectUri: REDIRECT, challenge, scopes: ['read'], owner: OWNER, name: 'Sample', grant: 'g-old' }
      await store.put('code', sha(code), row, now() - 1)
      expect((await (await app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier }))).json()).error).toBe('invalid_grant')
      const refresh = `rt_${crypto.randomUUID()}`
      await store.put('refresh', sha(refresh), { client: client_id, name: 'Sample', owner: OWNER, scopes: ['read'], family: 'g-old', used: false }, now() - 1)
      expect((await (await refreshWith(app, refresh)).json()).error).toBe('invalid_grant')
    })

    it('rotates a refresh token from before `used` once, and reads it as a replay after', async () => {
      const store = await make()
      const { app } = await oauthApp(store)
      const legacy = `rt_${crypto.randomUUID()}`
      await store.put('refresh', sha(legacy), { client: 'client_old', name: 'Old', owner: OWNER, scopes: ['read'] }, now() + 3600)
      const rotated = await (await refreshWith(app, legacy)).json()
      expect(rotated).toMatchObject({ scope: 'read', refresh_token: expect.stringMatching(/^rt_/) })
      expect((await callerWith(app, rotated.access_token)).status).toBe(200)
      expect(await (await refreshWith(app, legacy)).json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') })
      expect((await callerWith(app, rotated.access_token)).status).toBe(401)
    })

    it('gives a code from before grants a grant of its own', async () => {
      const store = await make()
      const { app } = await oauthApp(store)
      const { client_id, code, verifier, challenge } = await approvedCode(app)
      await store.put('code', sha(code), { client: client_id, redirectUri: REDIRECT, challenge, scopes: ['read'], owner: OWNER, name: 'Sample' }, now() + 600)
      const tokens = await (await app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier }))).json()
      expect((await (await callerWith(app, tokens.access_token)).json()).caller).toMatchObject({ client: client_id, grant: expect.any(String) })
    })

    // better-auth GHSA-392p-2q2v-4372; workers-oauth-provider #214
    it('rotates once for two refreshes at once, and by default the second is reuse that ends the sign-in', async () => {
      const { app } = await oauthApp(await make())
      const { tokens } = await signedIn(app)
      const answers = await Promise.all([refreshWith(app, tokens.refresh_token), refreshWith(app, tokens.refresh_token)])
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400])
      const loser = await answers.find((answer) => answer.status === 400)!.json()
      expect(loser.error_description).toContain('already used')
      const winner = await answers.find((answer) => answer.status === 200)!.json()
      expect((await callerWith(app, winner.access_token)).status).toBe(401)
      expect((await (await refreshWith(app, winner.refresh_token)).json()).error).toBe('invalid_grant')
    })

    it('with reuseGraceSeconds, gives a used refresh token sent again in the window the same successor, and ends the sign-in after it', async () => {
      const store = await make()
      const { app } = await oauthApp(store, { reuseGraceSeconds: 30 })
      const { tokens } = await signedIn(app)
      const answers = await Promise.all([refreshWith(app, tokens.refresh_token), refreshWith(app, tokens.refresh_token)])
      expect(answers.map((answer) => answer.status)).toEqual([200, 200])
      const [first, second] = await Promise.all(answers.map((answer) => answer.json()))
      expect(second.refresh_token).toBe(first.refresh_token)
      expect((await callerWith(app, second.access_token)).status).toBe(200)

      // The window passes: the same token again is reuse
      const used = (await store.get('refresh', sha(tokens.refresh_token)))!
      await store.put('refresh', sha(tokens.refresh_token), { ...used, usedAt: now() - 31 }, now() + 3600)
      expect((await (await refreshWith(app, tokens.refresh_token)).json()).error).toBe('invalid_grant')
      expect((await callerWith(app, first.access_token)).status).toBe(401)
      expect((await (await refreshWith(app, first.refresh_token)).json()).error).toBe('invalid_grant')
    })

    it('with reuseGraceSeconds, ends the sign-in when the successor was already used', async () => {
      const { app } = await oauthApp(await make(), { reuseGraceSeconds: 30 })
      const { tokens } = await signedIn(app)
      const first = await (await refreshWith(app, tokens.refresh_token)).json()
      const second = await (await refreshWith(app, first.refresh_token)).json()
      expect((await (await refreshWith(app, tokens.refresh_token)).json()).error).toBe('invalid_grant')
      expect((await callerWith(app, second.access_token)).status).toBe(401)
    })

    // workers-oauth-provider #428
    it('keeps a sign-in revoked when the revoke lands in the middle of a refresh', async () => {
      const inner = await make()
      const during: { run?: () => unknown } = {}
      const store: OAuthStore = {
        ...inner,
        put: async (kind, id, value, expiresAt) => {
          const run = kind === 'access' ? during.run : undefined
          during.run = undefined
          if (run) await run()
          return inner.put(kind, id, value, expiresAt)
        },
      }
      const { app } = await oauthApp(store)
      const { tokens } = await signedIn(app)
      during.run = () => app.request('/oauth/revoke', form({ token: tokens.refresh_token }))
      const raced = await (await refreshWith(app, tokens.refresh_token)).json()
      if (raced.access_token) expect((await callerWith(app, raced.access_token)).status).toBe(401)
      if (raced.refresh_token) expect((await (await refreshWith(app, raced.refresh_token)).json()).error).toBe('invalid_grant')
      expect((await callerWith(app, tokens.access_token)).status).toBe(401)
    })

    it('ends one grant at once with revokeGrant, access and refresh tokens alike, and leaves the client’s other grant', async () => {
      const { app, oauth } = await oauthApp(await make())
      const one = await signedIn(app)
      const other = await signedIn(app, { clientId: one.client_id })
      const { caller } = await (await callerWith(app, one.tokens.access_token)).json()
      expect(caller).toMatchObject({ kind: 'agent', client: one.client_id, grant: expect.any(String) })
      await oauth.revokeGrant(caller.grant)
      expect((await callerWith(app, one.tokens.access_token)).status).toBe(401)
      expect((await (await refreshWith(app, one.tokens.refresh_token)).json()).error).toBe('invalid_grant')
      expect((await callerWith(app, other.tokens.access_token)).status).toBe(200)
      expect((await refreshWith(app, other.tokens.refresh_token)).status).toBe(200)
    })

    it('issues one sign-in for a device approval polled from three places at once', async () => {
      const { app } = await oauthApp(await make())
      const device = 'urn:ietf:params:oauth:grant-type:device_code'
      const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
      const { device_code, user_code } = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
      await app.request('/oauth/device', { ...form({ user_code, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
      const poll = () => app.request('/oauth/token', form({ grant_type: device, device_code, client_id }))
      const answers = await Promise.all([poll(), poll(), poll()])
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400, 400])
      for (const loser of answers.filter((answer) => answer.status === 400)) expect((await loser.json()).error).toBe('invalid_grant')
      expect((await (await poll()).json()).error).toBe('invalid_grant')
    })

    it('refuses a code collected after revokeClient', async () => {
      const { app, oauth } = await oauthApp(await make())
      const { client_id, exchange } = await approvedCode(app)
      await oauth.revokeClient(client_id)
      const answer = await exchange()
      expect([answer.status, (await answer.json()).error]).toEqual([400, 'invalid_grant'])
    })

    it('refuses a device approval collected after revokeClient, and a device whose client was revoked before approval', async () => {
      const { app, oauth } = await oauthApp(await make())
      const device = 'urn:ietf:params:oauth:grant-type:device_code'
      const approve = (user_code: string) => app.request('/oauth/device', { ...form({ user_code, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
      const waiting = async () => {
        const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
        const { device_code, user_code } = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
        const poll = () => app.request('/oauth/token', form({ grant_type: device, device_code, client_id }))
        return { client_id, user_code, poll }
      }

      const approved = await waiting()
      expect((await approve(approved.user_code)).status).toBe(200)
      await oauth.revokeClient(approved.client_id)
      const late = await approved.poll()
      expect([late.status, (await late.json()).error]).toEqual([400, 'invalid_grant'])

      const revoked = await waiting()
      await oauth.revokeClient(revoked.client_id)
      expect((await approve(revoked.user_code)).status).toBe(400)
      expect((await (await revoked.poll()).json()).error).toBe('invalid_grant')
    })

    it('refuses a claim token collected after its grant was revoked, so the revoke never undoes itself', async () => {
      const { app, oauth } = await oauthApp(await make())
      const { registration_id, claim_token, identity_assertion } = await (await app.request('/agent/identity', json({ type: 'anonymous', client_name: 'Night shift' }))).json()
      const { claim_attempt } = await (await app.request('/agent/identity/claim', json({ claim_token, email: OWNER }))).json()
      expect((await typeClaim(app, claim_attempt)).status).toBe(200)
      // The agent learns its grant through jwt-bearer before it collects the claim
      const bearing = await (await app.request('/oauth/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: identity_assertion }))).json()
      const { caller } = await (await callerWith(app, bearing.access_token)).json()
      expect(caller).toMatchObject({ client: registration_id, grant: expect.any(String) })
      await oauth.revokeGrant(caller.grant)
      const late = await claimPoll(app, claim_token)
      expect([late.status, (await late.json()).error]).toEqual([400, 'invalid_grant'])
    })

    it('refuses a claim token collected after revokeClient, and one whose revoke lands while it is collected', async () => {
      const inner = await make()
      const during: { run?: () => unknown } = {}
      const store: OAuthStore = {
        ...inner,
        get: async (kind, id) => {
          const value = await inner.get(kind, id)
          if (kind !== 'registration' || !during.run) return value
          const run = during.run
          during.run = undefined
          await run()
          return value
        },
      }
      const { app, oauth } = await oauthApp(store)
      const approved = async () => {
        const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Night shift' }))).json()
        expect((await typeClaim(app, registration.claim)).status).toBe(200)
        return registration as { registration_id: string; claim_token: string }
      }

      const revoked = await approved()
      await oauth.revokeClient(revoked.registration_id)
      const late = await claimPoll(app, revoked.claim_token)
      expect([late.status, (await late.json()).error]).toEqual([400, 'invalid_grant'])

      const racing = await approved()
      during.run = () => oauth.revokeClient(racing.registration_id)
      const raced = await claimPoll(app, racing.claim_token)
      expect([raced.status, (await raced.json()).error]).toEqual([400, 'invalid_grant'])
    })

    it('approves a claim code once when the same form is posted twice at once', async () => {
      const { app } = await oauthApp(await make())
      const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Night shift' }))).json()
      const answers = await Promise.all([typeClaim(app, registration.claim), typeClaim(app, registration.claim)])
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 410])
      expect(await answers.find((answer) => answer.status === 410)!.text()).toContain('This code expired')
      expect((await claimPoll(app, registration.claim_token)).status).toBe(200)
    })

    it('keeps one grant per registration when two different claim codes are approved at once', async () => {
      const inner = await make()
      const families = new Set<string>()
      const store: OAuthStore = {
        ...inner,
        put: async (kind, id, value, expires) => {
          if (kind === 'registration' && typeof value.family === 'string') families.add(value.family)
          return inner.put(kind, id, value, expires)
        },
      }
      const { app } = await oauthApp(store)
      const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Night shift' }))).json()
      const { claim_attempt } = await (await app.request('/agent/identity/claim', json({ claim_token: registration.claim_token }))).json()
      await Promise.all([typeClaim(app, registration.claim), typeClaim(app, claim_attempt)])
      expect(families.size).toBe(1)
      expect((await claimPoll(app, registration.claim_token)).status).toBe(200)
    })

    it('makes one code when the consent form is posted twice at once', async () => {
      const { app } = await oauthApp(await make())
      const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Sample', redirect_uris: [REDIRECT] }))).json()
      const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })
      const ticket = /name="ticket" value="([^"]+)"/.exec(await (await app.request(`/oauth/authorize?${query}`, { headers: { 'x-test-owner': OWNER } })).text())![1]!
      const allow = () => app.request('/oauth/authorize', { ...form({ ticket, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
      const answers = await Promise.all([allow(), allow()])
      expect(answers.map((answer) => answer.status).sort()).toEqual([302, 400])
    })

    it('takes one answer when the device form is posted twice at once', async () => {
      const { app } = await oauthApp(await make())
      const device = 'urn:ietf:params:oauth:grant-type:device_code'
      const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
      const { device_code, user_code } = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
      const answer = (decision: string) => app.request('/oauth/device', { ...form({ user_code, decision }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
      const answers = await Promise.all([answer('allow'), answer('deny')])
      expect(answers.map((one) => one.status).sort()).toEqual([200, 400])
      const won = await answers.find((one) => one.status === 200)!.text()
      const polled = await (await app.request('/oauth/token', form({ grant_type: device, device_code, client_id }))).json()
      if (won.includes('Approved')) expect(polled.access_token).toBeTruthy()
      else expect(polled.error).toBe('access_denied')
    })

    it('issues one sign-in for a claim polled from two places at once', async () => {
      const { app } = await oauthApp(await make())
      const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Night shift' }))).json()
      const claim_attempt_token = new URL(registration.claim.verification_uri).searchParams.get('claim_attempt_token')!
      await app.request('/oauth/claim', { ...form({ claim_attempt_token, user_code: registration.claim.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER } })
      const poll = () => app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: registration.claim_token }))
      const answers = await Promise.all([poll(), poll()])
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400])
      expect((await answers.find((answer) => answer.status === 400)!.json()).error).toBe('expired_token')
    })
    // RFC 8707; MCP 2026-07-28: every grant made now is bound to an audience
    it('binds a grant whose client named no resource to the root, which works everywhere on the origin', async () => {
      const { app } = await oauthApp(await make())
      app.post('/mcp', (c) => c.json({ caller: c.get('caller' as never) }))
      const { tokens } = await signedIn(app)
      expect(audOf(tokens.access_token)).toBe(ORIGIN)
      expect((await callerWith(app, tokens.access_token)).status).toBe(200)
      expect((await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(200)
      // The audience was the server's choice, so a resource sent on refresh is not held against it
      const rotated = await (await refreshWith(app, tokens.refresh_token, `${ORIGIN}/mcp`)).json()
      expect(audOf(rotated.access_token)).toBe(ORIGIN)
      expect((await callerWith(app, rotated.access_token)).status).toBe(200)
    })

    it('gives the root to a resource the server does not describe, and takes that same resource again at the token endpoint and on refresh', async () => {
      const { app } = await oauthApp(await make())
      const asked = `${ORIGIN}/s/alpha/mcp`
      const { exchange } = await approvedCode(app, { resource: asked })
      const tokens = await (await exchange({ resource: asked })).json()
      expect(audOf(tokens.access_token)).toBe(ORIGIN)
      const rotated = await (await refreshWith(app, tokens.refresh_token, asked)).json()
      expect(audOf(rotated.access_token)).toBe(ORIGIN)
    })

    it('keeps an asked audience through every refresh, and refuses a refresh that asks for another', async () => {
      const store = await make()
      const { app } = await oauthApp(store)
      const asked = `${ORIGIN}/mcp`
      const { exchange } = await approvedCode(app, { resource: asked })
      const tokens = await (await exchange({ resource: asked })).json()
      expect(audOf(tokens.access_token)).toBe(asked)
      const other = await refreshWith(app, tokens.refresh_token, ORIGIN)
      expect([other.status, (await other.json()).error]).toEqual([400, 'invalid_target'])
      // invalid_target comes before any write: the token is still unused
      const rotated = await (await refreshWith(app, tokens.refresh_token, `${asked}/`)).json()
      expect(audOf(rotated.access_token)).toBe(asked)
      const silent = await (await refreshWith(app, rotated.refresh_token)).json()
      expect(audOf(silent.access_token)).toBe(asked)
      expect(await store.get('refresh', sha(silent.refresh_token))).toMatchObject({ audience: asked })
    })

    it('keeps a code, a device approval and a refresh token from before audiences aud-less, whatever resource the client sends', async () => {
      const store = await make()
      const { app } = await oauthApp(store)
      const asked = `${ORIGIN}/mcp`
      // 1.28.0 kept the query's resource as it came, or null; older kits left it out
      for (const kept of [{ resource: null }, { resource: asked }, { resource: `${ORIGIN}/s/alpha/mcp` }, {}]) {
        const { client_id, code, verifier, challenge } = await approvedCode(app)
        await store.put('code', sha(code), { client: client_id, redirectUri: REDIRECT, challenge, scopes: ['read', 'write'], owner: OWNER, name: 'Sample', grant: `g-${crypto.randomUUID()}`, used: false, ...kept }, now() + 600)
        const tokens = await (await app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier, resource: ORIGIN }))).json()
        expect(audOf(tokens.access_token), JSON.stringify(kept)).toBeUndefined()
        expect((await callerWith(app, tokens.access_token)).status).toBe(200)
        const rotated = await (await refreshWith(app, tokens.refresh_token, asked)).json()
        expect(audOf(rotated.access_token)).toBeUndefined()
        expect(await store.get('refresh', sha(rotated.refresh_token))).not.toHaveProperty('audience')
        // Two resources are ignored too: the row has no audience to hold them against
        const twice = await (await app.request('/oauth/token', formWithTwoResources({ grant_type: 'refresh_token', refresh_token: rotated.refresh_token }))).json()
        expect(twice.error).toBeUndefined()
        expect(audOf(twice.access_token), JSON.stringify(kept)).toBeUndefined()
      }
      const { client_id: twiceClient, code: twiceCode, verifier: twiceVerifier, challenge: twiceChallenge } = await approvedCode(app)
      await store.put('code', sha(twiceCode), { client: twiceClient, redirectUri: REDIRECT, challenge: twiceChallenge, scopes: ['read'], owner: OWNER, name: 'Sample', grant: `g-${crypto.randomUUID()}`, used: false }, now() + 600)
      const twiceTokens = await (await app.request('/oauth/token', formWithTwoResources({ grant_type: 'authorization_code', code: twiceCode, client_id: twiceClient, code_verifier: twiceVerifier }))).json()
      expect(twiceTokens.error).toBeUndefined()
      expect(audOf(twiceTokens.access_token)).toBeUndefined()
      expect((await callerWith(app, twiceTokens.access_token)).status).toBe(200)

      const device = 'urn:ietf:params:oauth:grant-type:device_code'
      const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
      const { device_code, user_code } = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
      const expiresAt = now() + 600
      await store.put('device', sha(device_code), { client: client_id, name: 'Terminal', scopes: ['read', 'write'], expiresAt, interval: 5, polledAt: 0 }, expiresAt + 600)
      await app.request('/oauth/device', { ...form({ user_code, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
      const fromDevice = await (await app.request('/oauth/token', form({ grant_type: device, device_code, client_id, resource: asked }))).json()
      expect(audOf(fromDevice.access_token)).toBeUndefined()
      const second = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
      await store.put('device', sha(second.device_code), { client: client_id, name: 'Terminal', scopes: ['read'], expiresAt, interval: 5, polledAt: 0 }, expiresAt + 600)
      await app.request('/oauth/device', { ...form({ user_code: second.user_code, decision: 'allow' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
      const fromDeviceTwice = await (await app.request('/oauth/token', formWithTwoResources({ grant_type: device, device_code: second.device_code, client_id }))).json()
      expect(fromDeviceTwice.error).toBeUndefined()
      expect(audOf(fromDeviceTwice.access_token)).toBeUndefined()

      const legacy = `rt_${crypto.randomUUID()}`
      await store.put('refresh', sha(legacy), { client: client_id, name: 'Terminal', owner: OWNER, scopes: ['read'], family: `g-${crypto.randomUUID()}`, used: false }, now() + 3600)
      const first = await (await refreshWith(app, legacy, asked)).json()
      expect(audOf(first.access_token)).toBeUndefined()
      const rotatedLegacy = await (await refreshWith(app, first.refresh_token, ORIGIN)).json()
      expect(audOf(rotatedLegacy.access_token)).toBeUndefined()
      expect((await callerWith(app, rotatedLegacy.access_token)).status).toBe(200)
    })
  })
