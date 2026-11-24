import { createHash, createHmac, randomBytes } from 'node:crypto'
import { decodeJwt } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { createAgentApi, createOAuth, generateOAuthKey, parseApiKeys, type OAuthConfig, type OAuthStore, type SignInRevoked } from '../src/index.js'
import { approveSignIn } from '../src/testing/index.js'

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
/** The successor 1.29.0 gave a refresh token: `rt_` and an HMAC of the token under a secret from the signing key, as v1.29.0 wrote it. */
const successorIn1290 = (signingKey: string, refresh: string) => {
  const { d } = JSON.parse(signingKey) as { d?: string }
  const secret = createHash('sha256').update(`api-kit refresh successor\0${d ?? signingKey}`).digest()
  return `rt_${createHmac('sha256', secret).update(refresh).digest('base64url')}`
}
/** A typed device code as the server keys it. */
const userCodeKey = (typed: string) => sha(typed.toUpperCase().replace(/[^A-Z]/g, ''))

export const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
/** A form that names `resource` twice, which a grant from before audiences ignores like any other. */
export const formWithTwoResources = (fields: Record<string, string>, resources = [ORIGIN, `${ORIGIN}/mcp`]) =>
  ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: [new URLSearchParams(fields), ...resources.map((resource) => `resource=${encodeURIComponent(resource)}`)].join('&') })

/** A sample app with the kit's OAuth over `store`; a header stands in for the single sign-on. `open` names the app's own sign-in pages. */
export const oauthApp = async (store: OAuthStore, options: Partial<OAuthConfig> = {}, { open }: { open?: string[] } = {}) => {
  const oauth = createOAuth({ name: 'Sample', signingKey: await generateOAuthKey(), store, owner: async (c) => c.req.header('x-test-owner') ?? null, owners: [OWNER], ...options })
  const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(''), ...(open ? { open } : {}) }, oauth })
  app.get('/api/v1/things', (c) => c.json({ caller: c.get('caller' as never) }))
  return { app, oauth }
}

type App = Awaited<ReturnType<typeof oauthApp>>['app']

/** A browser: keeps the cookies answers set and sends them back; `headers` go on every request. */
export const browserOf = (app: App, headers: Record<string, string> = {}) => {
  const jar = new Map<string, string>()
  const request = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    const answer = await app.request(path, { ...init, headers: { ...headers, ...(cookie ? { cookie } : {}), ...init.headers } })
    for (const line of answer.headers.getSetCookie()) {
      const pair = line.split(';')[0]!
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1))
    }
    return answer
  }
  /** A form posted from one of this site's own pages. */
  const post = (path: string, fields: Record<string, string>, extra: Record<string, string> = { 'sec-fetch-site': 'same-origin' }) =>
    request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams(fields).toString() })
  return { request, post, jar }
}
/** The ticket a sign-in page holds. */
export const ticketIn = (html: string) => /name="ticket" value="([^"]+)"/.exec(html)![1]!

/** Registers a client (unless given one), has the owner approve it, and returns the code with what exchanges it. */
export const approvedCode = async (app: App, { clientId, name = 'Sample', resource, scope = 'read write' }: { clientId?: string; name?: string; resource?: string; scope?: string } = {}) => {
  const client_id = clientId ?? (await (await app.request('/oauth/register', json({ client_name: name, redirect_uris: [REDIRECT] }))).json()).client_id as string
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope, ...(resource === undefined ? {} : { resource }) })
  const approved = await approveSignIn(app, query, { headers: { 'x-test-owner': OWNER } })
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
export const typeClaim = (app: App, attempt: { verification_uri: string; user_code: string }) =>
  app.request('/oauth/claim', { ...form({ claim_attempt_token: new URL(attempt.verification_uri).searchParams.get('claim_attempt_token')!, user_code: attempt.user_code }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' } })
const claimPoll = (app: App, claimToken: string) => app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: claimToken }))

/** A sign-in started in a browser: the client's query, and the browser holding its ticket cookie. */
export const authorizeQuery = (client_id: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256', state: 's1', ...extra })
export const registered = async (app: App, name = 'Sample', redirect = REDIRECT) => (await (await app.request('/oauth/register', json({ client_name: name, redirect_uris: [redirect] }))).json()).client_id as string

/**
 * An app that approves at its own page: the person types an invite, and the app completes the ticket as the person the
 * invite was made for (or `approver` when posted). `heard` is every grant `onGrant` saw; `/join/direct` completes without reading the ticket first;
 * `/join/hold` holds the ticket for `seconds` (a day when not sent) and sets the cookie `holdTicket` gives.
 */
export const joinApp = async (store: OAuthStore, options: Partial<OAuthConfig> = {}) => {
  const heard: Parameters<NonNullable<OAuthConfig['onGrant']>>[0][] = []
  const asks: Parameters<NonNullable<OAuthConfig['approve']>>[1][] = []
  const pageOf = (ticket: string, note = '') => `<!doctype html><title>Join Sample</title><p>${note}</p><form method="post" action="/join"><input type="hidden" name="ticket" value="${ticket}"><input name="invite"><button>Join</button></form>`
  const { app, oauth } = await oauthApp(store, {
    approve: async (c, ask) => (asks.push(ask), c.html(pageOf(ask.ticket))),
    onGrant: async (grant) => (heard.push(grant), grant.kind !== 'code' || grant.data?.invite === 'garden-42'),
    ...options,
  }, { open: ['/join', '/join/direct', '/join/hold'] })
  const spentPages = { approved: 'Already approved: return to your app.', denied: 'You said no to this sign-in.', answered: 'This sign-in was answered already.', expired: 'This sign-in expired: start again from your app.' }
  const decisionOf = (body: Record<string, unknown>) =>
    body.decision === 'deny' ? ('deny' as const) : { approver: body.approver === undefined ? OWNER : String(body.approver), data: { invite: String(body.invite ?? '') }, ...(body.scopes ? { scopes: String(body.scopes).split(' ') } : {}) }
  app.post('/join', async (c) => {
    const body = await c.req.parseBody()
    const ticket = String(body.ticket ?? '')
    const ask = await oauth.ticketOf(c, ticket)
    if (!ask) return c.html(`<p>${spentPages[(await oauth.answeredOf(c, ticket)) ?? 'expired']}</p>`, 400)
    return oauth.complete(c, ask.ticket, decisionOf(body))
  })
  app.post('/join/direct', async (c) => {
    const body = await c.req.parseBody()
    return oauth.complete(c, String(body.ticket ?? ''), decisionOf(body))
  })
  app.post('/join/hold', async (c) => {
    const body = await c.req.parseBody()
    const held = await oauth.holdTicket(c, String(body.ticket ?? ''), Number(body.seconds ?? 24 * 3600))
    return held ? c.json({ expiresAt: held.expiresAt }, 200, { 'set-cookie': held.cookie }) : c.json(null, 400)
  })
  return { app, oauth, heard, asks }
}

/** Opens a sign-in at the join app in `browser` and holds its ticket for a day: the ticket. */
export const heldTicket = async (app: App, browser: ReturnType<typeof browserOf>, client_id: string, extra: Record<string, string> = {}) => {
  const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id, extra)}`)).text())
  expect((await browser.post('/join/hold', { ticket })).status).toBe(200)
  return ticket
}

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

    it('trims a kind to its newest unused rows, never a used one, one from before `used`, or another kind', async () => {
      const store = await make()
      const kind = `capped-${crypto.randomUUID()}`
      for (const [id, life] of [['a', 100], ['b', 200], ['c', 300], ['d', 400]] as const) await store.put(kind, id, { used: false }, now() + life)
      // Two written in the same second: the later one is the newer
      await store.put(kind, 'e', { used: false }, now() + 400)
      await store.put(kind, 'used', { used: true }, now() + 50)
      await store.put(kind, 'before', { name: 'Before' }, now() + 60)
      await store.put(`${kind}-other`, 'x', { used: false }, now() + 10)
      const live = async () => (await Promise.all(['a', 'b', 'c', 'd', 'e', 'used', 'before'].map(async (id) => ((await store.get(kind, id)) ? id : null)))).filter(Boolean)
      await store.trim!(kind, 2)
      expect(await live()).toEqual(['d', 'e', 'used', 'before'])
      expect(await store.get(`${kind}-other`, 'x')).not.toBeNull()
      await store.trim!(kind, 0)
      expect(await live()).toEqual(['used', 'before'])
    })

    it('never trims a row that a live row of the holding kind names, and trims it once that row is gone', async () => {
      const store = await make()
      const kind = `capped-${crypto.randomUUID()}`
      const holder = `${kind}-holder`
      for (const id of ['old', 'mid', 'new']) await store.put(kind, id, { used: false }, now() + 600)
      await store.put(holder, 'ticket', { holds: 'old', used: false }, now() + 600)
      await store.put(holder, 'lapsed', { holds: 'mid', used: false }, now() - 1)
      await store.trim!(kind, 1, holder)
      expect(await Promise.all(['old', 'mid', 'new'].map(async (id) => Boolean(await store.get(kind, id))))).toEqual([true, false, true])
      await store.delete(holder, 'ticket')
      await store.trim!(kind, 1, holder)
      expect(await store.get(kind, 'old')).toBeNull()
    })

    it('caps every row an unauthenticated caller writes: agent registrations, claim tokens and attempts, device codes', async () => {
      const store = await make()
      const { app } = await oauthApp(store, { maxUnusedClients: 2, maxUnusedTickets: 2 })
      const agents = []
      for (let n = 0; n < 3; n++) agents.push(await (await app.request('/agent/identity', json({ type: 'anonymous', client_name: `Agent ${n}` }))).json())
      const kept = async (kind: string, ids: string[]) => Promise.all(ids.map(async (id) => Boolean(await store.get(kind, id))))
      expect(await kept('registration', agents.map((agent) => agent.registration_id))).toEqual([false, true, true])
      expect(await kept('claim-token', agents.map((agent) => sha(agent.claim_token)))).toEqual([false, true, true])

      const attempts = []
      for (let n = 0; n < 3; n++) attempts.push((await (await app.request('/agent/identity/claim', json({ claim_token: agents[2].claim_token, email: OWNER }))).json()).claim_attempt)
      expect((await typeClaim(app, attempts[0])).status).toBe(410)
      expect((await typeClaim(app, attempts[2])).status).toBe(200)

      const device = 'urn:ietf:params:oauth:grant-type:device_code'
      const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
      const codes = []
      for (let n = 0; n < 3; n++) codes.push(await (await app.request('/oauth/device_authorization', form({ client_id }))).json())
      const poll = (code: { device_code: string }) => app.request('/oauth/token', form({ grant_type: device, device_code: code.device_code, client_id }))
      expect((await (await poll(codes[0])).json()).error).toBe('invalid_grant')
      expect((await (await poll(codes[2])).json()).error).toBe('authorization_pending')
      expect(await kept('device-user', codes.map((code) => userCodeKey(code.user_code)))).toEqual([false, true, true])
    })

    it('never evicts a claimed agent’s registration, so its identity assertion keeps working through a flood', async () => {
      const { app } = await oauthApp(await make(), { maxUnusedClients: 1 })
      const registration = await (await app.request('/agent/identity', json({ type: 'service_auth', login_hint: OWNER, client_name: 'Night shift' }))).json()
      expect((await typeClaim(app, registration.claim)).status).toBe(200)
      const flood = async () => {
        for (let n = 0; n < 3; n++) await app.request('/agent/identity', json({ type: 'anonymous' }))
      }
      await flood()
      const collected = await (await claimPoll(app, registration.claim_token)).json()
      expect(collected.access_token).toBeTruthy()
      await flood()
      expect((await app.request('/oauth/token', form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: collected.identity_assertion }))).status).toBe(200)
    })

    it('never lets a registration flood evict a client whose invite page is open, and evicts it once the ticket lapses', async () => {
      const store = await make()
      const { app } = await joinApp(store, { maxUnusedClients: 1 })
      const invited = await registered(app)
      const browser = browserOf(app)
      const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(invited)}`)).text())
      for (let n = 0; n < 3; n++) await registered(app)
      expect(await store.get('client', invited)).not.toBeNull()
      expect((await browser.post('/join', { ticket, invite: 'garden-42' })).headers.get('location')).toContain('code=')

      // A ticket that lapsed holds nothing: the next registration evicts its client
      const waiting = await registered(app)
      const lapsing = ticketIn(await (await browserOf(app).request(`/oauth/authorize?${authorizeQuery(waiting)}`)).text())
      await store.put('consent', lapsing, (await store.get('consent', lapsing))!, now() - 1)
      await registered(app)
      expect(await store.get('client', waiting)).toBeNull()
    })

    it('lets a flood of newer tickets evict a waiting ticket, and then its client: the ticket cap protects no ticket', async () => {
      const store = await make()
      const { app } = await joinApp(store, { maxUnusedClients: 3, maxUnusedTickets: 3 })
      const invited = await registered(app)
      const browser = browserOf(app)
      const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(invited)}`)).text())
      // Registrations alone never evict it: its ticket holds it
      for (let n = 0; n < 10; n++) await registered(app)
      expect(await store.get('client', invited)).not.toBeNull()
      // maxUnusedTickets newer tickets: the waiting one is the oldest and goes, and its client is held no more
      for (let n = 0; n < 3; n++) await browserOf(app).request(`/oauth/authorize?${authorizeQuery(await registered(app))}`)
      expect(await store.get('consent', ticket)).toBeNull()
      await registered(app)
      expect(await store.get('client', invited)).toBeNull()
      expect(await (await browser.post('/join', { ticket, invite: 'garden-42' })).text()).toContain('This sign-in expired')
    })

    it('never trims a held row, and keeps it outside the cap: the newest unheld rows keep their places', async () => {
      const store = await make()
      const kind = `capped-${crypto.randomUUID()}`
      for (const [id, life] of [['a', 100], ['b', 200], ['c', 300]] as const) await store.put(kind, id, { used: false }, now() + life)
      // Held rows outlive the rest, so ranked with them they would take the newest places
      await store.put(kind, 'held-1', { used: false, held: true }, now() + 86_400)
      await store.put(kind, 'held-2', { used: false, held: true }, now() + 90_000)
      await store.put(kind, 'unheld', { used: false, held: false }, now() + 50)
      const live = async () => (await Promise.all(['a', 'b', 'c', 'held-1', 'held-2', 'unheld'].map(async (id) => ((await store.get(kind, id)) ? id : null)))).filter(Boolean)
      await store.trim!(kind, 2)
      expect(await live()).toEqual(['b', 'c', 'held-1', 'held-2'])
      await store.trim!(kind, 0)
      expect(await live()).toEqual(['held-1', 'held-2'])
    })

    it('holds a live, unused row: its life moved and marked held; never a used, expired or unknown one', async () => {
      const store = await make()
      const id = `h-${crypto.randomUUID()}`
      await store.put('consent', id, { params: { client_id: 'c1' }, used: false, expiresAt: now() + 600 }, now() + 600)
      const until = now() + 86_400
      const held = await store.hold!('consent', id, until)
      expect(held).toEqual({ params: { client_id: 'c1' }, used: false, expiresAt: until, held: true })
      expect(await store.get('consent', id)).toEqual(held)
      // Holding again moves it again, shorter too: the row's expiry with it
      await store.hold!('consent', id, now() - 1)
      expect(await store.get('consent', id)).toBeNull()
      await store.put('consent', `${id}-used`, { used: true }, now() + 600)
      expect(await store.hold!('consent', `${id}-used`, now() + 86_400)).toBeNull()
      await store.put('consent', `${id}-old`, { used: false }, now() - 1)
      expect(await store.hold!('consent', `${id}-old`, now() + 86_400)).toBeNull()
      expect(await store.hold!('consent', `${id}-none`, now() + 86_400)).toBeNull()
    })

    it('never reopens a row a hold races: marked used at once, it stays used', async () => {
      const store = await make()
      for (let n = 0; n < 5; n++) {
        const id = `r-${crypto.randomUUID()}`
        await store.put('consent', id, { used: false, expiresAt: now() + 600 }, now() + 600)
        const [, marked] = await Promise.all([store.hold!('consent', id, now() + 86_400), store.markUsed!('consent', id)])
        expect(marked).toMatchObject({ used: true })
        expect(await store.get('consent', id)).toMatchObject({ used: true })
      }
    })

    it('never lets newer tickets evict a held ticket or its client, and it completes once', async () => {
      const store = await make()
      const { app } = await joinApp(store, { maxUnusedClients: 3, maxUnusedTickets: 3 })
      const invited = await registered(app)
      const browser = browserOf(app)
      // Held a minute, less than a page's ten: by expiry it is the oldest, so only the hold keeps it
      const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(invited)}`)).text())
      expect((await browser.post('/join/hold', { ticket, seconds: '60' })).status).toBe(200)
      for (let n = 0; n < 10; n++) await browserOf(app).request(`/oauth/authorize?${authorizeQuery(await registered(app))}`)
      expect(await store.get('consent', ticket)).toMatchObject({ held: true })
      expect(await store.get('client', invited)).not.toBeNull()
      expect((await browser.post('/join', { ticket, invite: 'garden-42' })).headers.get('location')).toContain('code=')
      expect(await (await browser.post('/join', { ticket, invite: 'garden-42' })).text()).toContain('Already approved')
    })

    it('never reopens a ticket when a hold read it before its completion and writes after', async () => {
      const store = await make()
      let release = () => {}
      const gate = new Promise<void>((resolve) => (release = resolve))
      // The hold's write waits until the ticket was answered
      const { app } = await joinApp({ ...store, hold: async (...args) => (await gate, store.hold!(...args)) })
      const browser = browserOf(app)
      const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(await registered(app))}`)).text())
      const holding = browser.post('/join/hold', { ticket })
      expect((await browser.post('/join', { ticket, invite: 'garden-42' })).headers.get('location')).toContain('code=')
      release()
      expect((await holding).status).toBe(400)
      expect(await (await browser.post('/join', { ticket, invite: 'garden-42' })).text()).toContain('Already approved')
      expect(await store.get('consent', ticket)).toMatchObject({ used: true, answer: 'approved' })
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

    it('with reuseGraceSeconds 30, gives a retry the same successor 29 seconds after the first answer, and ends the sign-in at 30', async () => {
      const store = await make()
      const { app } = await oauthApp(store, { reuseGraceSeconds: 30 })
      let at = Date.now()
      vi.useFakeTimers({ toFake: ['Date'], now: at })
      try {
        // A 1.29.0 token: its used row is kept 30 days, so the window alone decides
        const legacy = `rt_${randomBytes(24).toString('base64url')}`
        await store.put('refresh', sha(legacy), { client: 'client_old', name: 'Old', owner: OWNER, scopes: ['read'], family: `g-${crypto.randomUUID()}`, used: false }, now() + 3600)
        const first = await (await refreshWith(app, legacy)).json()
        vi.setSystemTime((at += 29 * 1000))
        expect((await (await refreshWith(app, legacy)).json()).refresh_token).toBe(first.refresh_token)
        vi.setSystemTime((at += 1000))
        expect(await (await refreshWith(app, legacy)).json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') })
        expect((await callerWith(app, first.access_token)).status).toBe(401)
      } finally {
        vi.useRealTimers()
      }
    })

    it('with reuseGraceSeconds, ends the sign-in when the successor was already used', async () => {
      const { app } = await oauthApp(await make(), { reuseGraceSeconds: 30 })
      const { tokens } = await signedIn(app)
      const first = await (await refreshWith(app, tokens.refresh_token)).json()
      const second = await (await refreshWith(app, first.refresh_token)).json()
      expect((await (await refreshWith(app, tokens.refresh_token)).json()).error).toBe('invalid_grant')
      expect((await callerWith(app, second.access_token)).status).toBe(401)
    })

    it('keeps a row for the newest refresh token only, and any earlier one sent again still ends the sign-in', async () => {
      const store = await make()
      const { app } = await oauthApp(store)
      const { tokens } = await signedIn(app)
      const chain = [tokens.refresh_token]
      let latest = tokens
      for (let n = 0; n < 4; n++) {
        latest = await (await refreshWith(app, chain.at(-1)!)).json()
        chain.push(latest.refresh_token)
      }
      expect(chain.every((one) => one.startsWith('rt_'))).toBe(true)
      expect(await Promise.all(chain.map(async (one) => Boolean(await store.get('refresh', sha(one)))))).toEqual([false, false, false, false, true])
      // The generation before last comes back: stolen, or a client that kept it
      expect(await (await refreshWith(app, chain[2]!)).json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') })
      expect((await callerWith(app, latest.access_token)).status).toBe(401)
      expect((await (await refreshWith(app, chain[4]!)).json()).error).toBe('invalid_grant')
    })

    it('ends nothing for a made-up refresh token that names a live sign-in', async () => {
      const { app } = await oauthApp(await make())
      const { tokens } = await signedIn(app)
      const rotated = await (await refreshWith(app, tokens.refresh_token)).json()
      const { caller } = await (await callerWith(app, rotated.access_token)).json()
      // The grant is no secret: every access token carries it
      const [, nonce, mac] = tokens.refresh_token.split('.')
      for (const forged of [`rt_${caller.grant}.0.${'A'.repeat(32)}.${'B'.repeat(43)}`, `rt_${caller.grant}.0.${nonce}.${mac}x`, `rt_${caller.grant}.0.${'A'.repeat(43)}`, `rt_${caller.grant}.0`]) {
        expect((await (await refreshWith(app, forged)).json()).error_description, forged).not.toContain('already used')
        await app.request('/oauth/revoke', form({ token: forged }))
      }
      expect((await callerWith(app, rotated.access_token)).status).toBe(200)
      expect((await refreshWith(app, rotated.refresh_token)).status).toBe(200)
    })

    it('ends the sign-in when an earlier refresh token is revoked, though no row is kept for it', async () => {
      const { app } = await oauthApp(await make())
      const { tokens } = await signedIn(app)
      const rotated = await (await refreshWith(app, tokens.refresh_token)).json()
      expect((await app.request('/oauth/revoke', form({ token: tokens.refresh_token }))).status).toBe(200)
      expect((await callerWith(app, rotated.access_token)).status).toBe(401)
      expect((await (await refreshWith(app, rotated.refresh_token)).json()).error).toBe('invalid_grant')
    })

    it('rotates a 1.29.0 refresh token after the update, and still knows it and the one before it when they come back', async () => {
      const store = await make()
      const { app } = await oauthApp(store)
      const family = `g-${crypto.randomUUID()}`
      const row = { client: 'client_old', name: 'Old', owner: OWNER, scopes: ['read'], family, audience: ORIGIN, resource: null }
      // What 1.29.0 left: the token before, used and kept, and the newest, unused
      const [before, newest] = [`rt_${randomBytes(24).toString('base64url')}`, `rt_${randomBytes(24).toString('base64url')}`]
      const place = async () => {
        await store.put('refresh', sha(before), { ...row, used: true, usedAt: now() - 3600 }, now() + 3600)
        await store.put('refresh', sha(newest), { ...row, used: false }, now() + 3600)
      }
      await place()
      const rotated = await (await refreshWith(app, newest)).json()
      expect(rotated).toMatchObject({ scope: 'read', refresh_token: expect.stringMatching(/^rt_/) })
      expect((await refreshWith(app, rotated.refresh_token)).status).toBe(200)
      expect(await (await refreshWith(app, newest)).json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') })
      expect((await callerWith(app, rotated.access_token)).status).toBe(401)

      // The token before the newest, from a second sign-in in the same state
      const { app: again } = await oauthApp(store)
      row.family = `g-${crypto.randomUUID()}`
      const [earlier, current] = [`rt_${randomBytes(24).toString('base64url')}`, `rt_${randomBytes(24).toString('base64url')}`]
      await store.put('refresh', sha(earlier), { ...row, used: true, usedAt: now() - 3600 }, now() + 3600)
      await store.put('refresh', sha(current), { ...row, used: false }, now() + 3600)
      const next = await (await refreshWith(again, current)).json()
      expect(await (await refreshWith(again, earlier)).json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') })
      expect((await (await refreshWith(again, next.refresh_token)).json()).error).toBe('invalid_grant')
    })

    /** A sign-in rotated to generation 4 whose newest token 1.29.0 then refreshed (a rollback): the successor 1.29.0 names, in the same family. */
    const rolledBack = async (store: OAuthStore, options: Partial<OAuthConfig> = {}) => {
      const signingKey = await generateOAuthKey()
      const { app } = await oauthApp(store, { signingKey, ...options })
      const { tokens } = await signedIn(app)
      const chain = [tokens.refresh_token]
      for (let n = 0; n < 4; n++) chain.push((await (await refreshWith(app, chain.at(-1)!)).json()).refresh_token)
      const newest = (await store.get('refresh', sha(chain[4]!)))!
      const successor = successorIn1290(signingKey, chain[4]!)
      await store.put('refresh', sha(chain[4]!), { ...newest, used: true, usedAt: now() }, now() + 3600)
      await store.put('refresh', sha(successor), { ...newest, used: false }, now() + 3600)
      return { app, store, signingKey, chain, successor }
    }

    it('keeps a family’s generation when a 1.29.0 successor is refreshed after a rollback, so an earlier token still ends it', async () => {
      const { app, chain, successor } = await rolledBack(await make())
      const rotated = await (await refreshWith(app, successor)).json()
      expect(rotated).toMatchObject({ refresh_token: expect.stringMatching(/^rt_/) })
      expect(await (await refreshWith(app, chain[2]!)).json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') })
      expect((await callerWith(app, rotated.access_token)).status).toBe(401)
      expect((await (await refreshWith(app, rotated.refresh_token)).json()).error).toBe('invalid_grant')
    })

    it('with reuseGraceSeconds, gives a 1.29.0 successor sent again in the window the same successor after a rollback', async () => {
      const { app, successor } = await rolledBack(await make(), { reuseGraceSeconds: 30 })
      const first = await (await refreshWith(app, successor)).json()
      const again = await (await refreshWith(app, successor)).json()
      expect(again.refresh_token).toBe(first.refresh_token)
      expect((await refreshWith(app, again.refresh_token)).status).toBe(200)
    })

    it('with reuseGraceSeconds, ends the sign-in when a 1.29.0 successor comes back after its own successor was used', async () => {
      const { app, successor } = await rolledBack(await make(), { reuseGraceSeconds: 30 })
      const first = await (await refreshWith(app, successor)).json()
      const second = await (await refreshWith(app, first.refresh_token)).json()
      expect(await (await refreshWith(app, successor)).json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') })
      expect((await callerWith(app, second.access_token)).status).toBe(401)
    })

    it('with reuseGraceSeconds, gives a token 1.29.0 answered first, sent again in the window, the successor 1.29.0 gave', async () => {
      const { app, store, signingKey, chain, successor } = await rolledBack(await make(), { reuseGraceSeconds: 30 })
      const again = await (await refreshWith(app, chain[4]!)).json()
      expect(again.refresh_token).toBe(successor)
      expect((await refreshWith(app, again.refresh_token)).status).toBe(200)

      // A 1.29.0 token, 1.29.0 answering first: the same
      const row = { client: 'client_old', name: 'Old', owner: OWNER, scopes: ['read'], family: `g-${crypto.randomUUID()}` }
      const legacy = `rt_${randomBytes(24).toString('base64url')}`
      const legacySuccessor = successorIn1290(signingKey, legacy)
      await store.put('refresh', sha(legacy), { ...row, used: true, usedAt: now() }, now() + 3600)
      await store.put('refresh', sha(legacySuccessor), { ...row, used: false }, now() + 3600)
      const retried = await (await refreshWith(app, legacy)).json()
      expect(retried.refresh_token).toBe(legacySuccessor)
      expect((await refreshWith(app, retried.refresh_token)).status).toBe(200)
    })

    it('with reuseGraceSeconds, ends the sign-in when a token 1.29.0 answered first comes back in the window after that successor was used', async () => {
      const told: SignInRevoked[] = []
      const { app, chain, successor } = await rolledBack(await make(), { reuseGraceSeconds: 30, onRevoke: async (revoked) => void told.push(revoked) })
      const rotated = await (await refreshWith(app, successor)).json()
      expect(await (await refreshWith(app, chain[4]!)).json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') })
      expect((await callerWith(app, rotated.access_token)).status).toBe(401)
      expect((await (await refreshWith(app, rotated.refresh_token)).json()).error).toBe('invalid_grant')
      expect(told).toEqual([expect.objectContaining({ reason: 'replayed' })])
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
      const browser = browserOf(app, { 'x-test-owner': OWNER })
      const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${query}`)).text())
      const allow = () => browser.post('/oauth/authorize', { ticket, decision: 'allow' })
      const answers = await Promise.all([allow(), allow()])
      expect(answers.map((answer) => answer.status).sort()).toEqual([302, 400])
      // The second click lands in the same browser: it hears the ticket was answered (approved, once the first has said
      // so), never a second code
      const second = answers.find((answer) => answer.status === 400)!
      expect([second.headers.get('location'), await second.text()]).toEqual([null, expect.stringMatching(/Already (approved|answered)/)])
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
      await typeClaim(app, registration.claim)
      const poll = () => app.request('/oauth/token', form({ grant_type: 'urn:workos:agent-auth:grant-type:claim', claim_token: registration.claim_token }))
      const answers = await Promise.all([poll(), poll()])
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400])
      expect((await answers.find((answer) => answer.status === 400)!.json()).error).toBe('expired_token')
    })

    it('answers a completed ticket posted again from its browser with already approved, and another browser with expired', async () => {
      const { app } = await oauthApp(await make())
      const query = authorizeQuery(await registered(app))
      const browser = browserOf(app, { 'x-test-owner': OWNER })
      const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${query}`)).text())
      expect((await browser.post('/oauth/authorize', { ticket, decision: 'allow' })).status).toBe(302)
      const again = await browser.post('/oauth/authorize', { ticket, decision: 'allow' })
      expect([again.status, again.headers.get('location'), await again.text()]).toEqual([400, null, expect.stringContaining('Already approved')])
      const elsewhere = await browserOf(app, { 'x-test-owner': OWNER }).post('/oauth/authorize', { ticket, decision: 'allow' })
      expect([elsewhere.status, elsewhere.headers.get('location'), await elsewhere.text()]).toEqual([400, null, expect.stringContaining('This approval expired')])
      // A denied ticket never reads as approved
      const denied = ticketIn(await (await browser.request(`/oauth/authorize?${query}`)).text())
      expect(new URL((await browser.post('/oauth/authorize', { ticket: denied, decision: 'deny' })).headers.get('location')!).searchParams.get('error')).toBe('access_denied')
      const deniedAgain = await (await browser.post('/oauth/authorize', { ticket: denied, decision: 'allow' })).text()
      expect(deniedAgain).not.toContain('Already approved')
      expect(deniedAgain).toContain('Already answered')
    })

    it('tells the app’s route a ticket this browser answered from one that expired or another browser holds', async () => {
      const store = await make()
      const { app } = await joinApp(store)
      const client_id = await registered(app)
      const browser = browserOf(app)
      const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
      expect((await browser.post('/join', { ticket, invite: 'garden-42' })).headers.get('location')).toContain('code=')
      const again = await browser.post('/join', { ticket, invite: 'garden-42' })
      expect([again.status, again.headers.get('location'), await again.text()]).toEqual([400, null, expect.stringContaining('Already approved')])
      // Another browser with a ticket of its own, and one with none
      const other = browserOf(app)
      await other.request(`/oauth/authorize?${authorizeQuery(client_id)}`)
      for (const elsewhere of [other, browserOf(app)]) expect(await (await elsewhere.post('/join', { ticket, invite: 'garden-42' })).text()).toContain('This sign-in expired')
      const denied = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
      expect(new URL((await browser.post('/join', { ticket: denied, decision: 'deny' })).headers.get('location')!).searchParams.get('error')).toBe('access_denied')
      expect(await (await browser.post('/join', { ticket: denied, invite: 'garden-42' })).text()).toContain('You said no')
      // Spent, its answer not written yet (the post that spent it still running): answered, never expired
      const { nonce } = (await store.get('consent', ticket))!
      await store.put('consent', ticket, { nonce, used: true }, now() + 600)
      expect(await (await browser.post('/join', { ticket, invite: 'garden-42' })).text()).toContain('answered already')
      const fresh = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
      expect(await (await browser.post('/join', { ticket: `${fresh}x`, invite: 'garden-42' })).text()).toContain('This sign-in expired')
    })

    it('completes a ticket once when the app’s page posts it twice at once', async () => {
      const { app, heard } = await joinApp(await make())
      const browser = browserOf(app)
      const ticket = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(await registered(app))}`)).text())
      const answers = await Promise.all([browser.post('/join/direct', { ticket, invite: 'garden-42' }), browser.post('/join/direct', { ticket, invite: 'garden-42' })])
      expect(answers.map((answer) => answer.status).sort()).toEqual([302, 400])
      expect(await answers.find((answer) => answer.status === 400)!.text()).toMatch(/Already (approved|answered)/)
      expect(answers.filter((answer) => answer.headers.get('location')?.includes('code='))).toHaveLength(1)
      expect(heard).toEqual([])
    })

    // better-auth's stored consent (findConsent) answered a later sign-in with no click
    it('never lets a stored approval stand in for a click: the same client and approver need the page again', async () => {
      const { app, asks } = await joinApp(await make())
      const client_id = await registered(app)
      const browser = browserOf(app)
      const first = ticketIn(await (await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)).text())
      expect((await browser.post('/join', { ticket: first, invite: 'garden-42' })).status).toBe(302)
      const again = await browser.request(`/oauth/authorize?${authorizeQuery(client_id)}`)
      expect([again.status, again.headers.get('location')]).toEqual([200, null])
      const second = ticketIn(await again.text())
      expect(second).not.toBe(first)
      expect(asks).toHaveLength(2)
      // Nothing but complete makes its code: the first ticket is spent, the built-in page won't take the second
      expect((await browser.post('/join', { ticket: first, invite: 'garden-42' })).headers.get('location')).toBeNull()
      expect((await browser.post('/oauth/authorize', { ticket: second, decision: 'allow' }, { 'sec-fetch-site': 'same-origin', 'x-test-owner': OWNER })).headers.get('location')).toBeNull()
      expect((await browser.post('/join', { ticket: second, invite: 'garden-42' })).headers.get('location')).toContain('code=')

      // The kit's own page asks again too
      const { app: plain } = await oauthApp(await make())
      const plainClient = await registered(plain)
      const owner = browserOf(plain, { 'x-test-owner': OWNER })
      for (let round = 0; round < 2; round++) {
        const page = await owner.request(`/oauth/authorize?${authorizeQuery(plainClient)}`)
        expect([page.status, page.headers.get('location')]).toEqual([200, null])
        expect((await owner.post('/oauth/authorize', { ticket: ticketIn(await page.text()), decision: 'allow' })).headers.get('location')).toContain('code=')
      }
    })

    // better-auth GHSA-cq3f-vc6p-68fh, GHSA-q84f-53jg-9ppm
    it('approves a device only for the owner, naming a client with no page to send anyone back to', async () => {
      const { app } = await joinApp(await make())
      const device = 'urn:ietf:params:oauth:grant-type:device_code'
      const { client_id } = await (await app.request('/oauth/register', json({ client_name: 'Terminal', grant_types: [device] }))).json()
      const { device_code, user_code } = await (await app.request('/oauth/device_authorization', form({ client_id }))).json()
      const poll = () => app.request('/oauth/token', form({ grant_type: device, device_code, client_id }))
      // approve is for /oauth/authorize only: the device page stays the owner's
      for (const who of <Record<string, string>[]>[{}, { 'x-test-owner': 'someone@else.test' }]) {
        const stranger = browserOf(app, who)
        expect((await stranger.request(`/oauth/device?user_code=${user_code}`)).status).toBeGreaterThanOrEqual(400)
        expect((await stranger.post('/oauth/device', { user_code, decision: 'allow' })).status).toBeGreaterThanOrEqual(400)
      }
      expect((await (await poll()).json()).error).toBe('authorization_pending')
      const owner = browserOf(app, { 'x-test-owner': OWNER })
      const page = await (await owner.request(`/oauth/device?user_code=${user_code}`)).text()
      expect(page).toContain('Allow <strong>Terminal</strong>')
      expect(page).toContain('no page to send you back to')
      expect((await owner.post('/oauth/device', { user_code, decision: 'allow' })).status).toBe(200)
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
