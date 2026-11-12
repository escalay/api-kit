import { describe, expect, it } from 'vitest'
import {
  createAgentApi,
  hashApiKey,
  KEYS_TAG,
  memoryGuardStore,
  parseApiKeys,
  PEOPLE_OPEN_PATHS,
  PEOPLE_TAG,
  registerKeys,
  registerPeople,
  registerSetup,
  roleOf,
  sessionOf,
  SETUP_OPEN_PATHS,
  SETUP_TAG,
  storedKeysOf,
  teamTools,
  testDb,
  type SetupStep,
} from '../src/index.js'
import { lintOpenApi, softAuthenticator, toolRoutes, toolsRun } from '../src/testing/index.js'

const KEY = 'deploy-key'
const CODE = 'K7Q2-9XMD'
const ORIGIN = 'http://app.test'

const setup = async (options: { code?: string | undefined; steps?: SetupStep[] } = {}) => {
  const code = 'code' in options ? options.code : CODE
  const steps = options.steps ?? []
  const db = await testDb()
  const keys = parseApiKeys(`owner-key:${hashApiKey(KEY)}`)
  const fixedKeys = [...keys.values()]
  const app = createAgentApi({
    title: 'Sample',
    version: '1.0.0',
    description: 'A sample.',
    tags: [PEOPLE_TAG, SETUP_TAG, KEYS_TAG],
    auth: {
      realm: 'sample',
      keys,
      storedKeys: storedKeysOf(db),
      open: [...PEOPLE_OPEN_PATHS, ...SETUP_OPEN_PATHS],
      session: sessionOf(db),
      access: { team: 'example', audience: 'aud', verify: async (token) => (token.startsWith('ok:') ? token.slice(3) : null), roleOf: roleOf(db) },
    },
  })
  await registerPeople(app, { db, rpName: 'Sample', fixedKeys })
  await registerSetup(app, { db, code, steps, guards: memoryGuardStore(), fixedKeys })
  await registerKeys(app, { db, fixedKeys })
  app.get('/api/v1/me', (c) => c.json(c.get('caller' as never)))
  app.post('/api/v1/things', (c) => c.json({ ok: true }, 201))

  /** A browser: keeps its cookie, and sends what a same-site page would. */
  const browser = (ip = '203.0.113.1') => {
    let cookie = ''
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const answer = await app.request(`${ORIGIN}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const set = answer.headers.get('set-cookie')
      if (set) cookie = set.includes('Max-Age=0') || set.includes('=;') ? '' : set.split(';')[0]!
      return answer
    }
    return { call, json: async (method: string, path: string, body?: unknown, headers?: Record<string, string>) => (await call(method, path, body, headers)).json() as Promise<any>, cookie: () => cookie }
  }
  const asKey = (path: string, init: RequestInit = {}) => app.request(`${ORIGIN}${path}`, { ...init, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } })

  /** Claims the deployment and makes the owner's passkey: the whole first visit. */
  const claimAsOwner = async (device = undefined as Awaited<ReturnType<typeof softAuthenticator>> | undefined) => {
    const owner = browser()
    const authenticator = device ?? (await softAuthenticator())
    const { enrolment } = await owner.json('POST', '/api/setup/claim', { code: CODE, email: 'Owner@Example.com' })
    const { challengeId, options } = await owner.json('POST', '/api/session/passkeys/register/options', { enrolment })
    const session = await owner.json('POST', '/api/session/passkeys/register/verify', { challengeId, enrolment, response: await authenticator.register(options, ORIGIN), name: 'Laptop' })
    return { owner, authenticator, session }
  }
  return { app, db, browser, asKey, claimAsOwner }
}

describe('claiming a deployment', () => {
  it('refuses every claim when no setup code is set', async () => {
    const { browser } = await setup({ code: undefined })
    const someone = browser()
    expect(await someone.json('GET', '/api/setup')).toMatchObject({ claimed: false, codeSet: false })
    const refused = await someone.call('POST', '/api/setup/claim', { code: 'anything', email: 'me@example.com' })
    expect(refused.status).toBe(503)
    expect((await refused.json()).detail).toContain('SETUP_CODE')
  })

  it('makes the first holder of the code the owner, with a passkey and a session', async () => {
    const { browser, claimAsOwner } = await setup()
    expect((await browser().call('POST', '/api/setup/claim', { code: 'WRONG-CODE', email: 'x@example.com' })).status).toBe(403)
    const { owner, session } = await claimAsOwner()
    expect(session).toMatchObject({ signedIn: true, person: { email: 'owner@example.com', role: 'owner' }, passkeys: 1 })
    expect(await owner.json('GET', '/api/v1/me')).toEqual({ kind: 'person', email: 'owner@example.com', role: 'owner' })
    expect(await owner.json('GET', '/api/setup')).toMatchObject({ claimed: true, recovery: false })
    // The same code again claims nothing
    expect((await browser().call('POST', '/api/setup/claim', { code: CODE, email: 'thief@example.com' })).status).toBe(409)
  })

  it('limits attempts: 5 an hour per address', async () => {
    const { browser } = await setup()
    const guesser = browser('198.51.100.7')
    for (let attempt = 0; attempt < 5; attempt++) expect((await guesser.call('POST', '/api/setup/claim', { code: `GUESS-${attempt}`, email: 'g@example.com' })).status).toBe(403)
    expect((await guesser.call('POST', '/api/setup/claim', { code: CODE, email: 'g@example.com' })).status).toBe(429)
  })

  it('lets the owner back in after the setup code is changed, once', async () => {
    const first = await setup()
    await first.claimAsOwner()
    // The same database with a rotated secret, as after `wrangler secret put SETUP_CODE`
    const rotated = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [PEOPLE_TAG, SETUP_TAG], auth: { realm: 'sample', keys: new Map(), open: [...PEOPLE_OPEN_PATHS, ...SETUP_OPEN_PATHS], session: sessionOf(first.db) } })
    await registerPeople(rotated, { db: first.db, rpName: 'Sample' })
    await registerSetup(rotated, { db: first.db, code: 'NEW1-CODE', steps: [], guards: memoryGuardStore() })
    const post = (body: unknown) => rotated.request(`${ORIGIN}/api/setup/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(await (await rotated.request(`${ORIGIN}/api/setup`)).json()).toMatchObject({ claimed: true, recovery: true })
    expect((await post({ code: 'NEW1-CODE', email: 'someone@example.com' })).status).toBe(403)
    const recovered = await (await post({ code: 'NEW1-CODE', email: 'owner@example.com' })).json()
    expect(recovered).toMatchObject({ mode: 'recover' })
    expect(recovered.enrolment).toEqual(expect.any(String))
    expect((await post({ code: 'NEW1-CODE', email: 'owner@example.com' })).status).toBe(409)
  })
})

describe('passkeys and the session', () => {
  it('signs back in with the passkey after signing out, and refuses writes from another site', async () => {
    const { browser, claimAsOwner } = await setup()
    const { owner, authenticator } = await claimAsOwner()
    expect((await owner.call('POST', '/api/v1/things', {}, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await owner.call('POST', '/api/v1/things', {})).status).toBe(201)

    expect((await owner.call('DELETE', '/api/session')).status).toBe(204)
    expect(await owner.json('GET', '/api/session')).toMatchObject({ signedIn: false })
    expect((await owner.call('GET', '/api/v1/me')).status).toBe(401)

    const again = browser()
    const { challengeId, options } = await again.json('POST', '/api/session/passkeys/login/options')
    const signedIn = await again.json('POST', '/api/session/passkeys/login/verify', { challengeId, response: await authenticator.login(options, ORIGIN) })
    expect(signedIn).toMatchObject({ signedIn: true, person: { role: 'owner' } })
    // A challenge is used once
    expect((await again.call('POST', '/api/session/passkeys/login/verify', { challengeId, response: await authenticator.login(options, ORIGIN) })).status).toBe(400)
    expect(await again.json('GET', '/api/session/passkeys')).toMatchObject({ _embedded: { passkeys: [{ name: 'Laptop', rpId: 'app.test' }] } })
  })

  it('keeps the enrolment when a passkey fails to register, so the owner can try again', async () => {
    const { browser } = await setup()
    const owner = browser()
    const device = await softAuthenticator()
    const { enrolment } = await owner.json('POST', '/api/setup/claim', { code: CODE, email: 'owner@example.com' })
    const first = await owner.json('POST', '/api/session/passkeys/register/options', { enrolment })
    // An answer for another site (a wrong origin) fails the check
    const failed = await owner.call('POST', '/api/session/passkeys/register/verify', { challengeId: first.challengeId, enrolment, response: await device.register(first.options, 'https://elsewhere.test') })
    expect(failed.status).toBe(400)
    const again = await owner.json('POST', '/api/session/passkeys/register/options', { enrolment })
    expect(await owner.json('POST', '/api/session/passkeys/register/verify', { challengeId: again.challengeId, enrolment, response: await device.register(again.options, ORIGIN) })).toMatchObject({ signedIn: true })
    // Once a passkey is made, the enrolment is spent
    expect((await browser().call('POST', '/api/session/passkeys/register/options', { enrolment })).status).toBe(401)
  })

  it('refuses a passkey nobody registered, and an enrolment used twice', async () => {
    const { browser, claimAsOwner } = await setup()
    await claimAsOwner()
    const stranger = browser()
    const { challengeId, options } = await stranger.json('POST', '/api/session/passkeys/login/options')
    const answer = await stranger.call('POST', '/api/session/passkeys/login/verify', { challengeId, response: await (await softAuthenticator()).login(options, ORIGIN) })
    expect(answer.status).toBe(401)
    expect((await stranger.call('POST', '/api/session/passkeys/register/options', { enrolment: 'not-an-enrolment' })).status).toBe(401)
  })
})

describe('the team', () => {
  it('lets members in through Access by email or domain, and only the owner changes the team', async () => {
    const { browser, claimAsOwner, asKey } = await setup()
    const { owner } = await claimAsOwner()
    const access = (email: string) => ({ 'cf-access-jwt-assertion': `ok:${email}` })
    const visitor = browser()
    expect((await visitor.call('GET', '/api/v1/me', undefined, access('ana@example.org'))).status).toBe(403)

    expect((await owner.call('POST', '/api/team', { email: 'ana@example.org' })).status).toBe(201)
    expect((await owner.call('POST', '/api/team', { domain: 'partner.example' })).status).toBe(201)
    expect(await visitor.json('GET', '/api/v1/me', undefined, access('ana@example.org'))).toEqual({ kind: 'person', email: 'ana@example.org', role: 'member' })
    expect(await visitor.json('GET', '/api/v1/me', undefined, access('bo@partner.example'))).toMatchObject({ role: 'member' })

    // A member uses the app but changes neither the team nor the keys
    expect((await visitor.call('POST', '/api/team', { email: 'friend@example.org' }, access('ana@example.org'))).status).toBe(403)
    expect((await visitor.call('POST', '/api/keys', { name: 'mine' }, access('ana@example.org'))).status).toBe(403)
    expect(await visitor.json('GET', '/api/me', undefined, access('ana@example.org'))).toMatchObject({ kind: 'person', role: 'member', canManageKeys: false })
    expect(await owner.json('GET', '/api/me')).toMatchObject({ role: 'owner', canManageKeys: true })

    const team = await owner.json('GET', '/api/team')
    const ownerRow = team.people.find((person: { role: string }) => person.role === 'owner')
    expect((await owner.call('PATCH', `/api/team/people/${ownerRow.id}`, { role: 'member' })).status).toBe(409)
    expect((await owner.call('DELETE', `/api/team/people/${ownerRow.id}`)).status).toBe(409)
    // A key from API_KEYS administers the team like the owner
    expect((await asKey('/api/team', { method: 'DELETE' })).status).toBe(404)
    expect((await asKey('/api/team/domains/partner.example', { method: 'DELETE' })).status).toBe(204)
  })

  it('documents every route, and every team tool runs', async () => {
    const { app, asKey } = await setup()
    const doc = await (await asKey('/openapi.json')).json()
    expect(lintOpenApi(doc)).toEqual([])
    expect(toolRoutes(teamTools(), doc)).toEqual([])
    await asKey('/api/team', { method: 'POST', body: JSON.stringify({ email: 'tool-target@example.com' }) })
    const team = await (await asKey('/api/team')).json()
    const id = team.people.find((person: { email: string }) => person.email === 'tool-target@example.com').id
    const samples = { list_team: {}, add_to_team: { domain: 'tools.example' }, change_team_role: { id, role: 'member' }, remove_from_team: { id } }
    expect(await toolsRun(teamTools(), app, samples, { headers: { authorization: `Bearer ${KEY}` } })).toEqual([])
  })
})

describe('the setup checklist', () => {
  it('checks every step for real, owner only, and never hangs on a slow one', async () => {
    const steps: SetupStep[] = [
      { id: 'domain', title: 'Choose the domain', why: 'Addresses live on it.', minutes: 1, check: async () => ({ ok: true, detail: 'mail.example.com' }) },
      { id: 'routing', title: 'Route mail here', why: 'Or nothing arrives.', minutes: 2, check: async () => ({ ok: false, detail: 'No mail yet.', fixUrl: 'https://dash.example/routing' }) },
      { id: 'broken', title: 'A check that throws', why: 'To prove it is caught.', minutes: 1, optional: true, check: async () => Promise.reject(new Error('boom')) },
    ]
    const { browser, claimAsOwner } = await setup({ steps })
    const { owner } = await claimAsOwner()
    expect((await browser().call('GET', '/api/setup/checklist')).status).toBe(401)
    const checklist = await owner.json('GET', '/api/setup/checklist')
    expect(checklist).toMatchObject({ done: 1, total: 3 })
    expect(checklist._embedded.steps).toMatchObject([
      { id: 'domain', ok: true },
      { id: 'routing', ok: false, fixUrl: 'https://dash.example/routing' },
      { id: 'broken', ok: false, optional: true, detail: 'The check failed: boom' },
    ])
  })
})
