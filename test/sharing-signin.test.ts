/** The sharing part's sign-in pages: the ladder `approve` climbs, the code page, and `POST /sharing/join` with its limits. */
import { createHash, randomBytes } from 'node:crypto'
import { decodeJwt } from 'jose'
import { describe, expect, it } from 'vitest'
import { matches, testDb } from '../src/index.js'
import { createSharing, SHARING_OPEN_PATHS, sharingSignInPaths, signInStepOf, type SharingOptions } from '../src/sharing/index.js'
import { approveSignIn } from '../src/testing/index.js'
import { BAKES, grantsApp, ORIGIN, OWNER, REDIRECT, SOUPS } from './sharing-grants-contract.js'

const SECRET = 'a sharing secret of thirty-two bytes or more, for tests only'
const ACCOUNT_LINE = 'This connects the app signed in in this browser.'
const NOT_OURS = 'That code is not one of ours'
const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
/** A page's words, without its tags, styles or the ticket that differs between two. */
const wordsOf = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/value="[^"]*"/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

type NewInvite = { id: string; code: string }

/** The recipe box with the part's own sign-in pages, and a browser that opens a sign-in once and posts its page many times. */
const box = async ({ options = {} }: { options?: Partial<SharingOptions> } = {}) => {
  const knownReturns = [{ name: 'Sample App', callback: 'sample-app:/callback' }, { name: 'Client A', callback: REDIRECT }]
  const made = await grantsApp(await testDb(), { pages: true, options: { knownReturns, ...options } })
  const { app } = made
  const makeInvite = async (space = 'soups', body: Record<string, unknown> = { label: 'Sam' }) => (await made.makeInvite(space, body)) as unknown as NewInvite

  /** A client registered with `redirect`, at `/oauth/authorize` once: its page, ticket, cookie and verifier. */
  const open = async ({ resource, redirect = REDIRECT, name = 'Sample', scope = 'read write', headers = {} }: { resource?: string; redirect?: string; name?: string; scope?: string; headers?: Record<string, string> } = {}) => {
    const client_id = (await (await app.request('/oauth/register', json({ client_name: name, redirect_uris: [redirect] }))).json()).client_id as string
    const verifier = randomBytes(32).toString('base64url')
    const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', scope, ...(resource === undefined ? {} : { resource }) })
    const page = await app.request(`/oauth/authorize?${query}`, { headers })
    const html = await page.text()
    const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? ''
    const cookie = page.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    return { page, html, ticket, cookie, client_id, verifier, query }
  }
  type Opened = Awaited<ReturnType<typeof open>>
  /** Posts the code page as the browser that opened it does: same-origin, with its cookie. */
  const post = (opened: Opened, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    app.request('/sharing/join', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', cookie: opened.cookie, ...headers }, body: new URLSearchParams({ ticket: opened.ticket, ...fields }).toString() })
  /** Exchanges the code a 302 carries: the token answer. */
  const exchange = async (opened: Opened, answer: Response) => {
    const code = new URL(answer.headers.get('location')!).searchParams.get('code')!
    const tokens = await app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: opened.client_id, code_verifier: opened.verifier }))
    return { status: tokens.status, tokens: (await tokens.json()) as { access_token: string; scope: string; error?: string } }
  }
  return { ...made, makeInvite, open, post, exchange }
}

describe('the sign-in ladder', () => {
  it('picks one step per row, as the README’s table says', () => {
    const rows = [
      [{ asked: 'named-root', owner: true }, 'kit'],
      [{ asked: 'named-root', owner: false }, 'wrong-address'],
      [{ asked: 'unnamed-root', owner: true }, 'kit'],
      [{ asked: 'unnamed-root', owner: false }, 'code'],
      [{ asked: 'space', owner: true }, 'code'],
      [{ asked: 'space', owner: false }, 'code'],
    ] as const
    for (const [facts, step] of rows) expect([facts, signInStepOf(facts)]).toEqual([facts, step])
  })
})

describe('approve', () => {
  it('sends a client that named the root to the address in its invite, and no sharing route completes it (probe T4)', async () => {
    const { open, post, makeInvite, inviteState } = await box()
    const invite = await makeInvite()
    for (const resource of [ORIGIN, `${ORIGIN}/mcp`]) {
      const stranger = await open({ resource })
      expect([resource, stranger.page.status, stranger.html]).toEqual([resource, 200, expect.stringContaining('connect it to the address in your invite instead')])
      expect(stranger.html).not.toContain('<form')
      // A live ticket for the root, from the owner's consent page, posted here with the right code: refused, signed in or not
      const owners = await open({ resource, headers: { 'x-test-owner': OWNER } })
      for (const headers of [{}, { 'x-test-owner': OWNER }] as Record<string, string>[]) {
        const forged = await post(owners, { code: invite.code }, headers)
        expect([resource, forged.status, forged.headers.get('location')]).toEqual([resource, expect.any(Number), null])
        expect(forged.status).toBeGreaterThanOrEqual(400)
      }
    }
    expect(await inviteState(invite.id)).toBe('open')
  })

  it('never takes a stranger at the root to the owner’s consent: the owner gets it, anyone else the code page', async () => {
    const { open } = await box()
    const stranger = await open()
    expect(stranger.html).toContain('action="/sharing/join"')
    expect(stranger.html).not.toContain('action="/oauth/authorize"')
    for (const resource of [undefined, ORIGIN]) {
      const owner = await open({ resource, headers: { 'x-test-owner': OWNER } })
      expect([resource, owner.html]).toEqual([resource, expect.stringContaining('action="/oauth/authorize"')])
    }
  })

  it('warns of a return it does not know, a custom scheme not listed included, and asks for the code everywhere (probe T1)', async () => {
    const { open } = await box()
    const warned = ['sample-browser:https://evil.example/cb', 'sample-browsers://evil.example/cb', 'evil-app://cb', 'https://localhost/cb', 'https://client-a.example.test/other']
    for (const redirect of warned) {
      const { html } = await open({ resource: SOUPS, redirect })
      const host = new URL(redirect).protocol.startsWith('http') ? new URL(redirect).host : new URL(redirect).protocol
      expect([redirect, wordsOf(html)]).toEqual([redirect, expect.stringContaining(`This app returns to ${host}`)])
      expect(html).toContain('action="/sharing/join"')
    }
    const known = [['http://127.0.0.1:33418/cb', 'an app on this computer'], ['http://localhost/cb', 'an app on this computer'], ['sample-app:/callback', 'Sample App'], [REDIRECT, 'Client A']]
    for (const [redirect, named] of known) {
      const { html } = await open({ resource: SOUPS, redirect })
      expect([redirect, wordsOf(html)]).toEqual([redirect, expect.stringContaining(`It returns to ${named}`)])
      expect([redirect, html]).toEqual([redirect, expect.not.stringContaining('This app returns to')])
      // Known or not, a code is needed until the link is remembered
      expect(html).toContain('name="code"')
    }
  })

  it('keeps a client’s name from reordering or hiding text, and escapes it', async () => {
    const { open } = await box()
    const { html } = await open({ resource: SOUPS, name: 'Sam‮ppa​ <script>alert("x")</script>' })
    expect(html).not.toMatch(/[‮​]/)
    expect(html).not.toContain('<script')
    expect(html).toContain('calls itself <strong>Samppa &#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;</strong>')
  })

  it('carries the account line on every page that approves, the wrong code’s too', async () => {
    const { open, post } = await box()
    for (const resource of [SOUPS, undefined]) {
      const opened = await open({ resource })
      expect([resource, opened.html]).toEqual([resource, expect.stringContaining(ACCOUNT_LINE)])
      expect(await (await post(opened, { code: 'BDKM-QXTW' })).text()).toContain(ACCOUNT_LINE)
    }
  })

  it('answers alike for a space that exists and one that does not, at the page and at a wrong code', async () => {
    const { open, post } = await box()
    const soups = await open({ resource: SOUPS })
    const pies = await open({ resource: `${ORIGIN}/s/pies/mcp` })
    expect([pies.page.status, wordsOf(pies.html)]).toEqual([soups.page.status, wordsOf(soups.html)])
    expect(wordsOf(soups.html)).not.toContain('Soups')
    const [wrongAtSoups, wrongAtPies] = await Promise.all([post(soups, { code: 'BDKM-QXTW' }), post(pies, { code: 'BDKM-QXTW' })])
    expect([wrongAtPies.status, wordsOf(await wrongAtPies.text())]).toEqual([wrongAtSoups.status, wordsOf(await wrongAtSoups.text())])
  })

  it('serves its pages never stored, never framed, sending no referrer out, and posting only here or to the client', async () => {
    const { open, post } = await box()
    const [atSpace, atRoot] = [await open({ resource: SOUPS }), await open()]
    const wrong = await post(atSpace, { code: 'BDKM-QXTW' })
    for (const [answer, html] of [[atSpace.page, atSpace.html], [atRoot.page, atRoot.html], [wrong, await wrong.text()]] as const) {
      expect(answer.headers.get('cache-control')).toBe('no-store')
      expect(answer.headers.get('x-robots-tag')).toBe('noindex')
      expect(answer.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://client-a.example.test")
      expect(html).toContain('<meta name="referrer" content="same-origin">')
      expect(html).not.toContain('<script')
    }
    const scheme = await open({ resource: SOUPS, redirect: 'sample-app:/callback' })
    expect(scheme.page.headers.get('content-security-policy')).toMatch(/form-action 'self' sample-app:$/)
  })

  it('shows a page saying sharing is not ready before registerSharing binds it', async () => {
    const sharing = await createSharing({ db: await testDb(), secret: SECRET, spaces: { byName: async () => null, byId: async () => null }, owner: async () => null })
    const { Hono } = await import('hono')
    const probe = new Hono()
    probe.get('*', async (c) => (await sharing.oauth.approve(c, { resource: SOUPS, named: true } as never))!)
    const answer = await probe.request('/oauth/authorize')
    expect([answer.status, await answer.text()]).toEqual([503, expect.stringContaining('not ready')])
  })
})

describe('POST /sharing/join', () => {
  it('joins with the invite’s code, typed in any case and spacing, and gives no more than the invite: write asked, read given', async () => {
    const { makeInvite, open, post, exchange, call, memberOfToken, inviteState } = await box()
    const invite = await makeInvite()
    const opened = await open({ resource: SOUPS, scope: 'read write' })
    const answer = await post(opened, { code: ` ${invite.code.toLowerCase().replace('-', ' ')} ` })
    expect(answer.status).toBe(302)
    const { tokens } = await exchange(opened, answer)
    expect(tokens.scope).toBe('read')
    expect(await memberOfToken(tokens.access_token)).toMatchObject({ via: 'invite', inviteId: invite.id, scope: 'read', returnsTo: 'client-a.example.test' })
    expect((await call('/s/soups/mcp', tokens.access_token)).status).toBe(200)
    // Asking to make changes only, at a read invite: nothing to give, the code unspent
    const writeOnly = await open({ resource: SOUPS, scope: 'write' })
    const other = await makeInvite()
    const refused = await post(writeOnly, { code: other.code })
    expect([refused.status, refused.headers.get('location'), await refused.text()]).toEqual([400, null, expect.stringContaining('asks only to make changes')])
    expect(await inviteState(other.id)).toBe('open')
  })

  it('joins through approveSignIn’s form, as an app’s own test would', async () => {
    const { makeInvite, open, app } = await box()
    const invite = await makeInvite()
    const { query } = await open({ resource: SOUPS })
    const answer = await approveSignIn(app, query, { form: { action: '/sharing/join', fields: { code: invite.code } } })
    expect(answer.status).toBe(302)
  })

  it('binds a client that named nothing to the space of the code it is given', async () => {
    const { makeInvite, open, post, exchange, call } = await box()
    const invite = await makeInvite('bakes')
    const opened = await open()
    const { tokens } = await exchange(opened, await post(opened, { code: invite.code }))
    expect(decodeJwt(tokens.access_token).aud).toBe(BAKES)
    expect([(await call('/s/bakes/mcp', tokens.access_token)).status, (await call('/mcp', tokens.access_token)).status, (await call('/s/soups/mcp', tokens.access_token)).status]).toEqual([200, 401, 401])
  })

  it('names returns from this computer as such', async () => {
    const { makeInvite, open, post, exchange, memberOfToken } = await box()
    const opened = await open({ resource: SOUPS, redirect: 'http://127.0.0.1:33418/cb' })
    const { tokens } = await exchange(opened, await post(opened, { code: (await makeInvite()).code }))
    expect((await memberOfToken(tokens.access_token))?.returnsTo).toBe('this computer')
  })

  it('gives nothing and spends nothing for a Soups ticket with a Bakes code, and no hidden field steers the grant', async () => {
    const { makeInvite, open, post, exchange, inviteState, memberOfToken } = await box()
    const bakes = await makeInvite('bakes')
    const soups = await makeInvite('soups', { label: 'Ada', scope: 'write' })
    const opened = await open({ resource: SOUPS })
    const wrong = await post(opened, { code: bakes.code })
    expect([wrong.status, wrong.headers.get('location'), await wrong.text()]).toEqual([400, null, expect.stringContaining(NOT_OURS)])
    expect(await inviteState(bakes.id, 'bakes')).toBe('open')
    // The same ticket still joins with its own space's code; posted fields beyond the code change nothing
    const steered = await post(opened, { code: soups.code, resource: BAKES, invite: bakes.id, scope: 'read write', approver: `owner:${OWNER}`, data: '{"sharing":"owner"}' })
    const { tokens } = await exchange(opened, steered)
    expect(decodeJwt(tokens.access_token)).toMatchObject({ aud: SOUPS, sub: `invite:${soups.id}` })
    expect(await memberOfToken(tokens.access_token)).toMatchObject({ inviteId: soups.id, scope: 'write', label: 'Ada' })
  })

  it('calls a revoked, spent or late code, or one for a space the app deleted, not one of ours', async () => {
    const { makeInvite, open, post, exchange, byKey, ageInvite, shelves } = await box()
    const revoked = await makeInvite()
    await byKey(`/api/spaces/soups/invites/${revoked.id}`, { method: 'DELETE' })
    const spent = await makeInvite()
    const first = await open({ resource: SOUPS })
    expect((await exchange(first, await post(first, { code: spent.code }))).status).toBe(200)
    const late = await makeInvite()
    await ageInvite(late.id, new Date(Date.now() - 1000).toISOString())
    const gone = await makeInvite('bakes')
    shelves.splice(1, 1)
    for (const [resource, code] of [[SOUPS, revoked.code], [SOUPS, spent.code], [SOUPS, late.code], [undefined, gone.code]] as const) {
      const answer = await post(await open({ resource }), { code })
      expect([code, answer.status, await answer.text()]).toEqual([code, 400, expect.stringContaining(NOT_OURS)])
    }
  })

  it('refuses a post from another site or another browser before reading anything, and spends nothing', async () => {
    const { makeInvite, open, post, inviteState } = await box()
    const invite = await makeInvite()
    const opened = await open({ resource: SOUPS })
    for (const site of ['cross-site', 'same-site', 'none']) {
      const answer = await post(opened, { code: invite.code }, { 'sec-fetch-site': site })
      expect([site, answer.status, answer.headers.get('location'), await answer.text()]).toEqual([site, 403, null, expect.stringContaining('Join from the page this site showed you')])
    }
    const elsewhere = await post({ ...opened, cookie: '' }, { code: invite.code })
    expect([elsewhere.status, elsewhere.headers.get('location'), await elsewhere.text()]).toEqual([400, null, expect.stringContaining('start again from your app')])
    expect(await inviteState(invite.id)).toBe('open')
    // Refused before anything is counted: a flood from another site leaves the address its budget
    for (let posted = 0; posted < 12; posted++) await post(opened, { code: 'BDKM-QXTW' }, { 'sec-fetch-site': 'cross-site' })
    expect((await post(opened, { code: invite.code })).status).toBe(302)
  })

  it('answers a bad request with a page, never a redirect', async () => {
    const { app, open, post } = await box()
    const opened = await open({ resource: SOUPS })
    const bad = [
      await app.request('/sharing/join', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }),
      await app.request('/sharing/join', { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: opened.cookie }, body: JSON.stringify({ ticket: opened.ticket, code: 'BDKM-QXTW' }) }),
      await post({ ...opened, ticket: 'consent_made_up' }, { code: 'BDKM-QXTW' }),
      await post(opened, {}),
    ]
    for (const answer of bad) {
      expect([answer.status, answer.headers.get('location'), answer.headers.get('content-type')]).toEqual([expect.any(Number), null, expect.stringContaining('text/html')])
      expect(answer.status).toBeGreaterThanOrEqual(400)
    }
  })

  it('ends a ticket at its fifth wrong code, and the app hears access_denied; another ticket still joins', async () => {
    const { makeInvite, open, post, exchange, inviteState } = await box()
    const invite = await makeInvite()
    const guessed = await open({ resource: SOUPS })
    for (let wrong = 1; wrong <= 4; wrong++) expect((await post(guessed, { code: 'BDKM-QXTW' })).status).toBe(400)
    const fifth = await post(guessed, { code: 'BDKM-QXTW' })
    expect(fifth.status).toBe(302)
    expect(new URL(fifth.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
    // The right code on the ended ticket is too late, and spends nothing
    const late = await post(guessed, { code: invite.code })
    expect([late.status, late.headers.get('location'), await late.text()]).toEqual([400, null, expect.stringContaining('start again from your app')])
    expect(await inviteState(invite.id)).toBe('open')
    const fresh = await open({ resource: SOUPS })
    expect((await exchange(fresh, await post(fresh, { code: invite.code }))).status).toBe(200)
  })

  it('ends a ticket once when two tabs race its fifth wrong code', async () => {
    const { open, post } = await box()
    const guessed = await open({ resource: SOUPS })
    for (let wrong = 1; wrong <= 4; wrong++) await post(guessed, { code: 'BDKM-QXTW' })
    const raced = await Promise.all([post(guessed, { code: 'BDKM-QXTW' }), post(guessed, { code: 'BDKM-QXTW' })])
    expect(raced.map((answer) => answer.status).sort()).toEqual([302, 400])
  })

  it('stops guessing at the limits with no limits option given: per address, then per space, never the owner', async () => {
    const { makeInvite, open, post } = await box()
    const invite = await makeInvite()
    const from = (address: string) => ({ 'x-forwarded-for': address })
    // Ten a minute from one address, over tickets of its own so none ends first
    const tickets = await Promise.all([0, 1, 2].map(() => open({ resource: SOUPS })))
    for (let tried = 0; tried < 10; tried++) expect((await post(tickets[tried % 3]!, { code: 'BDKM-QXTW' }, from('192.0.2.1'))).status).toBe(400)
    const stopped = await post(tickets[0]!, { code: invite.code }, from('192.0.2.1'))
    expect([stopped.status, stopped.headers.get('retry-after'), await stopped.text()]).toEqual([429, expect.stringMatching(/^\d+$/), expect.stringContaining('Too many codes')])
    // Sixty in ten minutes at one space, from any addresses: ten counted above, fifty more
    for (let tried = 0; tried < 50; tried++) {
      const opened = await open({ resource: SOUPS })
      expect((await post(opened, { code: 'BDKM-QXTW' }, from(`198.51.100.${tried}`))).status).toBe(400)
    }
    const spaceSpent = await post(await open({ resource: SOUPS }), { code: invite.code }, from('203.0.113.9'))
    expect(spaceSpent.status).toBe(429)
    // Another space keeps its budget, and the owner is never counted
    expect((await post(await open({ resource: BAKES }), { code: 'BDKM-QXTW' }, from('203.0.113.9'))).status).toBe(400)
    const owner = await open({ resource: SOUPS, headers: { 'x-test-owner': OWNER } })
    expect((await post(owner, { code: invite.code }, { ...from('192.0.2.1'), 'x-test-owner': OWNER })).status).toBe(302)
  })

  it('is always limited: limits false throws', async () => {
    await expect(createSharing({ db: await testDb(), secret: SECRET, spaces: { byName: async () => null, byId: async () => null }, owner: async () => null, limits: false })).rejects.toThrow(/always/)
  })
})

describe('sharingSignInPaths', () => {
  it('lists every path a sign-in touches outside the kit’s own machine endpoints, and never the owner’s gated pages', async () => {
    const made = await box()
    const touched: string[] = []
    const app = { request: (input: string, init?: RequestInit) => (touched.push(new URL(input, ORIGIN).pathname), made.app.request(input, init)) }
    const invite = await made.makeInvite()
    // An agent at the space's address: the 401, the metadata, registration, the page, the code, the token
    const challenge = await app.request('/s/soups/mcp')
    const metadata = /resource_metadata="([^"]+)"/.exec(challenge.headers.get('www-authenticate') ?? '')![1]!
    await app.request(new URL(metadata).pathname)
    await app.request('/.well-known/oauth-authorization-server')
    const client_id = (await (await app.request('/oauth/register', json({ client_name: 'Sample', redirect_uris: [REDIRECT] }))).json()).client_id as string
    const verifier = randomBytes(32).toString('base64url')
    const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: SOUPS })
    const joined = await approveSignIn(app as never, query, { form: { action: '/sharing/join', fields: { code: invite.code } } })
    const code = new URL(joined.headers.get('location')!).searchParams.get('code')!
    const tokens = await (await app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier }))).json()
    expect((await app.request('/s/soups/mcp', { headers: { authorization: `Bearer ${tokens.access_token}` } })).status).toBe(200)

    const paths = sharingSignInPaths(made.sharing)
    expect(paths).toEqual(['/oauth/authorize', ...SHARING_OPEN_PATHS, '/s/*/mcp', '/.well-known/oauth-protected-resource/s/*/mcp'])
    // What §7 already lets past Access for every app with OAuth
    const kitBypass = ['/oauth/register', '/oauth/token', '/.well-known/oauth-authorization-server']
    const outside = touched.filter((path) => !paths.some((pattern) => matches(path, pattern)) && !kitBypass.includes(path))
    expect(outside).toEqual([])
    for (const gated of ['/oauth/device', '/oauth/claim', '/mcp', '/api/spaces/soups/invites']) expect([gated, paths.some((pattern) => matches(gated, pattern))]).toEqual([gated, false])
  })
})
