/** The sharing part's sign-in pages: the ladder `approve` climbs, the code page, and `POST /sharing/join` with its limits. */
import { createHash, randomBytes } from 'node:crypto'
import { decodeJwt } from 'jose'
import { describe, expect, it, vi } from 'vitest'
import { createBrand, defineBrand, matches, memoryGuardStore, testDb, type AgentBrand, type GuardStore } from '../src/index.js'
import { createSharing, SHARING_OPEN_PATHS, sharingSignInPaths, signInStepOf, type SharingOptions } from '../src/sharing/index.js'
import type { SignInDecision } from '../src/index.js'
import { approveSignIn } from '../src/testing/index.js'
import { ASSETS } from './brand-fixture.js'
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
const box = async ({ options = {}, brand }: { options?: Partial<SharingOptions>; brand?: AgentBrand } = {}) => {
  const knownReturns = [{ name: 'Sample App', callback: 'sample-app:/callback' }, { name: 'Client A', callback: REDIRECT }]
  const made = await grantsApp(await testDb(), { pages: true, brand, options: { knownReturns, ...options } })
  const { app } = made
  const makeInvite = async (space = 'soups', body: Record<string, unknown> = { label: 'Sam' }) => (await made.makeInvite(space, body)) as unknown as NewInvite

  /** A client registered with `redirect`, at `/oauth/authorize` once: its page, ticket, cookie and verifier. */
  const open = async ({ resource, redirect = REDIRECT, name = 'Sample', scope = 'read write', headers = {} }: { resource?: string; redirect?: string; name?: string; scope?: string | null; headers?: Record<string, string> } = {}) => {
    const client_id = (await (await app.request('/oauth/register', json({ client_name: name, redirect_uris: [redirect] }))).json()).client_id as string
    const verifier = randomBytes(32).toString('base64url')
    const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: redirect, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', ...(scope === null ? {} : { scope }), ...(resource === undefined ? {} : { resource }) })
    const page = await app.request(`/oauth/authorize?${query}`, { headers })
    const html = await page.text()
    const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1] ?? ''
    const cookie = page.headers.getSetCookie().map((line) => line.split(';')[0]).join('; ')
    return { page, html, ticket, cookie, client_id, verifier, query }
  }
  type Opened = Awaited<ReturnType<typeof open>>
  /** Posts one of the part's pages as the browser that opened it does: same-origin, with its cookie. */
  const postTo = (path: string, opened: Opened, fields: Record<string, string>, headers: Record<string, string> = {}) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', cookie: opened.cookie, ...headers }, body: new URLSearchParams({ ticket: opened.ticket, ...fields }).toString() })
  /** Posts the code page. */
  const post = (opened: Opened, fields: Record<string, string>, headers: Record<string, string> = {}) => postTo('/sharing/join', opened, fields, headers)
  /** Exchanges the code a 302 carries: the token answer. */
  const exchange = async (opened: Opened, answer: Response) => {
    const code = new URL(answer.headers.get('location')!).searchParams.get('code')!
    const tokens = await app.request('/oauth/token', form({ grant_type: 'authorization_code', code, client_id: opened.client_id, code_verifier: opened.verifier }))
    return { status: tokens.status, tokens: (await tokens.json()) as { access_token: string; scope: string; error?: string } }
  }
  return { ...made, makeInvite, open, postTo, post, exchange }
}

describe('the sign-in ladder', () => {
  it('picks one step per row, as the README’s table says', () => {
    const rows = [
      [{ asked: 'named-root', owner: true, found: false }, 'kit'],
      [{ asked: 'named-root', owner: false, found: false }, 'wrong-address'],
      [{ asked: 'unnamed-root', owner: true, found: false }, 'kit'],
      [{ asked: 'unnamed-root', owner: false, found: false }, 'code'],
      [{ asked: 'space', owner: true, found: true }, 'owner'],
      [{ asked: 'space', owner: true, found: false }, 'no-such-space'],
      [{ asked: 'space', owner: false, found: true }, 'code'],
      [{ asked: 'space', owner: false, found: false }, 'code'],
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
      // A live ticket for the root, from the owner's consent page, posted here with the right code: the part refuses it itself
      const owners = await open({ resource, headers: { 'x-test-owner': OWNER } })
      const signedOut = await post(owners, { code: invite.code })
      expect([resource, signedOut.status, signedOut.headers.get('location'), await signedOut.text()]).toEqual([resource, 400, null, expect.stringContaining('connect it to the address in your invite instead')])
      const signedIn = await post(owners, { code: invite.code }, { 'x-test-owner': OWNER })
      expect([resource, signedIn.status, signedIn.headers.get('location'), await signedIn.text()]).toEqual([resource, 403, null, expect.stringContaining('Join from the page this site showed you')])
    }
    // A client that named nothing, at the owner's consent page: the owner's to approve there, never here
    const unnamed = await open({ headers: { 'x-test-owner': OWNER } })
    const kits = await post(unnamed, { code: invite.code }, { 'x-test-owner': OWNER })
    expect([kits.status, kits.headers.get('location'), await kits.text()]).toEqual([403, null, expect.stringContaining('Join from the page this site showed you')])
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
    for (const headers of [{}, { 'x-test-owner': OWNER }] as Record<string, string>[]) {
      const { html } = await open({ resource: SOUPS, name: 'Sam‮ppa​ <script>alert("x")</script>', headers })
      expect(html).not.toMatch(/[‮​]/)
      expect(html).not.toContain('<script')
      expect(html).toContain('calls itself <strong>Samppa &#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62;</strong>')
    }
  })

  it('escapes a space’s title on the owner’s page', async () => {
    const { open, shelves } = await box()
    shelves[0]!.title = 'Soups <script>alert("x")</script> & \'more\''
    const { html } = await open({ resource: SOUPS, headers: { 'x-test-owner': OWNER } })
    expect(html).not.toContain('<script')
    expect(html).toContain('Approve this app at Soups &#60;script&#62;alert(&#34;x&#34;)&#60;/script&#62; &#38; &#39;more&#39;')
  })

  it('carries the account line on every page that approves, the wrong code’s too', async () => {
    const { open, post, postTo } = await box()
    for (const resource of [SOUPS, undefined]) {
      const opened = await open({ resource })
      expect([resource, opened.html]).toEqual([resource, expect.stringContaining(ACCOUNT_LINE)])
      expect(await (await post(opened, { code: 'BDKM-QXTW' })).text()).toContain(ACCOUNT_LINE)
    }
    // The owner's page, as approve shows it, as the hop shows it, and shown again
    const owners = await open({ resource: SOUPS, scope: 'read', headers: { 'x-test-owner': OWNER } })
    expect(owners.html).toContain(ACCOUNT_LINE)
    expect(await (await postTo('/sharing/as-owner', await open({ resource: SOUPS }), {}, { 'x-test-owner': OWNER })).text()).toContain(ACCOUNT_LINE)
    expect(await (await postTo('/sharing/owner', owners, { decision: 'approve', write: 'on' }, { 'x-test-owner': OWNER })).text()).toContain(ACCOUNT_LINE)
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
    const [atSpace, atRoot, owners] = [await open({ resource: SOUPS }), await open(), await open({ resource: SOUPS, headers: { 'x-test-owner': OWNER } })]
    const wrong = await post(atSpace, { code: 'BDKM-QXTW' })
    for (const [answer, html] of [[atSpace.page, atSpace.html], [atRoot.page, atRoot.html], [wrong, await wrong.text()], [owners.page, owners.html]] as const) {
      expect(answer.headers.get('cache-control')).toBe('no-store')
      expect(answer.headers.get('x-robots-tag')).toBe('noindex')
      expect(answer.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://client-a.example.test")
      expect(html).toContain('<meta name="referrer" content="same-origin">')
      expect(html).not.toContain('<script')
    }
    const scheme = await open({ resource: SOUPS, redirect: 'sample-app:/callback' })
    expect(scheme.page.headers.get('content-security-policy')).toMatch(/form-action 'self' sample-app:$/)
  })

  it('carries the app’s brand on the page approve shows and on the page a post answers', async () => {
    const brand = createBrand(defineBrand({ name: 'sample', title: 'Sample Notes', description: 'Notes for agents.', accent: '#2563eb' }), ASSETS)
    const { open, post } = await box({ brand })
    const opened = await open({ resource: SOUPS })
    const wrong = await (await post(opened, { code: 'BDKM-QXTW' })).text()
    for (const [name, html] of [['code page', opened.html], ['wrong code', wrong]]) {
      for (const part of ['<link rel="icon" href="/icon.svg" type="image/svg+xml">', '<img src="/icon.svg"', 'Sample Notes', 'button{background:#2563eb']) expect([name, html]).toEqual([name, expect.stringContaining(part)])
    }
    const plain = await (await box()).open({ resource: SOUPS })
    for (const absent of ['<link rel="icon"', '<img', 'Sample Notes']) expect(plain.html).not.toContain(absent)
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

describe('the owner at a space', () => {
  const asOwner = { 'x-test-owner': OWNER }
  const checked = (html: string, box: string) => new RegExp(`name="${box}"[^>]*checked`).test(html)

  it('approves an app at an unknown return with one click: read, for 30 days, whatever it asked (probe T2)', async () => {
    const { oauth, open, postTo, exchange, memberOfToken } = await box()
    const completed = vi.spyOn(oauth, 'complete')
    // No scope sent: an approval without scopes would grant all the kit has
    const opened = await open({ resource: SOUPS, redirect: 'https://evil.example.test/cb', scope: null, headers: asOwner })
    expect([opened.page.status, wordsOf(opened.html)]).toEqual([200, expect.stringContaining('This app returns to evil.example.test')])
    expect(wordsOf(opened.html)).toContain('Soups')
    expect([checked(opened.html, 'write'), checked(opened.html, 'untilRevoked')]).toEqual([false, false])
    const answer = await postTo('/sharing/owner', opened, { decision: 'approve' }, asOwner)
    expect(answer.status).toBe(302)
    const { tokens } = await exchange(opened, answer)
    expect([tokens.scope, decodeJwt(tokens.access_token).sub]).toEqual(['read', `owner:${OWNER}`])
    expect(await memberOfToken(tokens.access_token)).toMatchObject({ via: 'owner', scope: 'read', lifetime: '30d', returnsTo: 'evil.example.test', expiresAt: expect.any(String) })
    // The part never completes an approval without naming its scopes
    const decisions = completed.mock.calls.map(([, , decision]) => decision as SignInDecision)
    expect(decisions.length).toBeGreaterThan(0)
    for (const decision of decisions) expect(decision === 'deny' || Array.isArray(decision.scopes)).toBe(true)
  })

  it('at a known return gives what the app asked, until revoked, and the owner can narrow both', async () => {
    const { open, postTo, exchange, memberOfToken } = await box()
    for (const [redirect, named] of [[REDIRECT, 'It returns to Client A'], ['http://127.0.0.1:33418/cb', 'It returns to an app on this computer']] as const) {
      const asked = await open({ resource: SOUPS, redirect, headers: asOwner })
      expect([redirect, wordsOf(asked.html), checked(asked.html, 'write'), checked(asked.html, 'untilRevoked')]).toEqual([redirect, expect.stringContaining(named), true, true])
      // The browser sends the boxes left ticked
      const whole = await exchange(asked, await postTo('/sharing/owner', asked, { decision: 'approve', write: 'on', untilRevoked: 'on' }, asOwner))
      expect(whole.tokens.scope).toBe('read write')
      expect(await memberOfToken(whole.tokens.access_token)).toMatchObject({ scope: 'write', lifetime: 'until_revoked', expiresAt: null })
      const narrowed = await open({ resource: SOUPS, redirect, headers: asOwner })
      const { tokens } = await exchange(narrowed, await postTo('/sharing/owner', narrowed, { decision: 'approve' }, asOwner))
      expect(tokens.scope).toBe('read')
      expect(await memberOfToken(tokens.access_token)).toMatchObject({ scope: 'read', lifetime: '30d' })
    }
  })

  it('only narrows: Allow changes for an app that asked to read is refused, one that asked only to make changes needs it, and neither spends the ticket', async () => {
    const { open, postTo, exchange } = await box()
    const reader = await open({ resource: SOUPS, scope: 'read', headers: asOwner })
    expect(reader.html).not.toContain('name="write"')
    const widened = await postTo('/sharing/owner', reader, { decision: 'approve', write: 'on' }, asOwner)
    expect([widened.status, widened.headers.get('location'), await widened.text()]).toEqual([400, null, expect.stringContaining('did not ask to make changes')])
    expect((await exchange(reader, await postTo('/sharing/owner', reader, { decision: 'approve' }, asOwner))).tokens.scope).toBe('read')

    const writer = await open({ resource: SOUPS, scope: 'write', redirect: 'https://evil.example.test/cb', headers: asOwner })
    const unticked = await postTo('/sharing/owner', writer, { decision: 'approve' }, asOwner)
    expect([unticked.status, unticked.headers.get('location'), await unticked.text()]).toEqual([400, null, expect.stringContaining('asks only to make changes')])
    expect((await exchange(writer, await postTo('/sharing/owner', writer, { decision: 'approve', write: 'on' }, asOwner))).tokens.scope).toBe('write')
  })

  it('refuses with one click: the app hears access_denied, and no member is made', async () => {
    const { open, postTo, repo } = await box()
    const opened = await open({ resource: SOUPS, headers: asOwner })
    const refused = await postTo('/sharing/owner', opened, { decision: 'deny', write: 'on' }, asOwner)
    expect(new URL(refused.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
    expect(await repo.listMembers('sp_soups', { limit: 10 })).toEqual([])
  })

  it('tells the owner a space does not exist on the approval page, never at the exchange (decision 6)', async () => {
    const { open, postTo, shelves } = await box()
    const pies = await open({ resource: `${ORIGIN}/s/pies/mcp`, headers: asOwner })
    expect([pies.page.status, wordsOf(pies.html)]).toEqual([404, expect.stringContaining('No space pies here')])
    expect(pies.html).not.toContain('<form')
    // A space deleted between the page and Approve
    const soups = await open({ resource: SOUPS, headers: asOwner })
    shelves.splice(0, 1)
    const gone = await postTo('/sharing/owner', soups, { decision: 'approve' }, asOwner)
    expect([gone.status, gone.headers.get('location'), wordsOf(await gone.text())]).toEqual([404, null, expect.stringContaining('No space soups here')])
  })

  it('makes a token that can neither share nor reach the root', async () => {
    const { open, postTo, exchange, call, as } = await box()
    const opened = await open({ resource: SOUPS, headers: asOwner })
    const { tokens } = await exchange(opened, await postTo('/sharing/owner', opened, { decision: 'approve', write: 'on', untilRevoked: 'on' }, asOwner))
    expect((await call('/s/soups/mcp', tokens.access_token)).status).toBe(200)
    for (const path of ['/mcp', '/api/spaces/soups/invites', '/api/spaces/soups/members']) expect([path, (await call(path, tokens.access_token)).status]).toEqual([path, 401])
    expect((await as(tokens.access_token)('/api/spaces/soups/invites', { method: 'POST', body: { label: 'Ada' } })).status).toBe(401)
  })

  it('lets an owner who arrived without their cookie through one same-origin POST, and sends anyone else to sign in', async () => {
    const { open, postTo, exchange } = await box({ options: { signInPath: '/sign-in' } })
    const arrived = await open({ resource: SOUPS })
    expect(arrived.html).toContain('action="/sharing/as-owner"')
    // A stranger hears the same at a space that exists and one that does not
    const stranger = await postTo('/sharing/as-owner', arrived, {})
    const strangerAtPies = await postTo('/sharing/as-owner', await open({ resource: `${ORIGIN}/s/pies/mcp` }), {})
    expect([stranger.status, wordsOf(await stranger.text())]).toEqual([401, expect.stringContaining('Sign in first')])
    expect([strangerAtPies.status, wordsOf(await strangerAtPies.text())]).toEqual([401, expect.stringContaining('Sign in first')])
    expect(await (await postTo('/sharing/as-owner', arrived, {})).text()).toContain('href="/sign-in"')
    const hop = await postTo('/sharing/as-owner', arrived, {}, asOwner)
    expect([hop.status, await hop.text()]).toEqual([200, expect.stringContaining('action="/sharing/owner"')])
    const { tokens } = await exchange(arrived, await postTo('/sharing/owner', arrived, { decision: 'approve' }, asOwner))
    expect(tokens.scope).toBe('read')
    // Only a space's code page offers the hop: at the root the owner starts again at the kit's page
    const root = await open()
    expect(root.html).not.toContain('/sharing/as-owner')
    expect((await postTo('/sharing/as-owner', root, {}, asOwner)).status).toBe(403)
  })

  it('asks who is signed in again on every post: the owner gone at Approve is refused and spends nothing', async () => {
    const { open, postTo } = await box()
    const opened = await open({ resource: SOUPS, headers: asOwner })
    const gone = await postTo('/sharing/owner', opened, { decision: 'approve' })
    expect([gone.status, gone.headers.get('location')]).toEqual([403, null])
    expect((await postTo('/sharing/owner', opened, { decision: 'approve' }, asOwner)).status).toBe(302)
  })

  it('refuses Approve and the hop from another site or another browser, before reading anything', async () => {
    const { open, postTo } = await box()
    for (const path of ['/sharing/owner', '/sharing/as-owner']) {
      const opened = await open({ resource: SOUPS, headers: asOwner })
      for (const site of ['cross-site', 'same-site', 'none']) {
        const answer = await postTo(path, opened, { decision: 'approve' }, { ...asOwner, 'sec-fetch-site': site })
        expect([path, site, answer.status, answer.headers.get('location')]).toEqual([path, site, 403, null])
      }
      const elsewhere = await postTo(path, { ...opened, cookie: '' }, { decision: 'approve' }, asOwner)
      expect([path, elsewhere.status, await elsewhere.text()]).toEqual([path, 400, expect.stringContaining('start again from your app')])
      expect((await postTo('/sharing/owner', opened, { decision: 'approve' }, asOwner)).status).toBe(302)
    }
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

  it('counts a typed code by an HMAC of its address, never the address itself', async () => {
    const inner = memoryGuardStore()
    const counted: string[] = []
    const store: GuardStore = { ...inner, count: (id, windowMs, now) => (counted.push(id), inner.count(id, windowMs, now)) }
    const { open, post } = await box({ options: { limits: { store } } })
    await post(await open({ resource: SOUPS }), { code: 'BDKM-QXTW' }, { 'x-forwarded-for': '192.0.2.1' })
    expect(counted.some((id) => id.startsWith('sharing-code ip:'))).toBe(true)
    expect(counted.filter((id) => id.includes('192.0.2.1'))).toEqual([])
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
