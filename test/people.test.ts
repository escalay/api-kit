import { afterEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  createAgentApi,
  hashApiKey,
  KEYS_TAG,
  memoryGuardStore,
  migrate,
  parseApiKeys,
  passkeyBaseName,
  peopleRepo,
  PEOPLE_MIGRATIONS,
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
  type AddressTrust,
  type PeopleOptions,
  type SetupStep,
} from '../src/index.js'
import { lintOpenApi, softAuthenticator, toolRoutes, toolsRun } from '../src/testing/index.js'

const KEY = 'deploy-key'
const CODE = 'K7Q2-9XMD'
const ORIGIN = 'http://app.test'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'

const setup = async (options: { code?: string | undefined; steps?: SetupStep[]; address?: AddressTrust; limits?: PeopleOptions['limits'] } = {}) => {
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
    address: options.address,
  })
  const teamChanges: unknown[] = []
  const passkeyChanges: unknown[] = []
  const recoveries: unknown[] = []
  await registerPeople(app, { db, rpName: 'Sample', fixedKeys, onTeamChange: (change) => void teamChanges.push(change), onPasskeyChange: (change) => void passkeyChanges.push(change), limits: options.limits })
  await registerSetup(app, { db, code, steps, guards: memoryGuardStore(), fixedKeys, onRecovery: (recovery) => void recoveries.push(recovery) })
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
  return { app, db, browser, asKey, claimAsOwner, teamChanges, passkeyChanges, recoveries }
}

afterEach(() => vi.useRealTimers())

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
    const wrong = await browser().call('POST', '/api/setup/claim', { code: 'WRONG-CODE', email: 'x@example.com' })
    expect(wrong.status).toBe(403)
    // The error says what to do next, not what the code is
    expect((await wrong.json()).detail).toBe('That setup code is not right. Check the SETUP_CODE secret on your deployment and try again.')
    const { owner, session } = await claimAsOwner()
    expect(session).toMatchObject({ signedIn: true, person: { email: 'owner@example.com', role: 'owner' }, passkeys: 1 })
    expect(await owner.json('GET', '/api/v1/me')).toEqual({ kind: 'person', email: 'owner@example.com', role: 'owner' })
    expect(await owner.json('GET', '/api/setup')).toMatchObject({ claimed: true, recovery: false })
    // The same code again claims nothing
    const again = await browser().call('POST', '/api/setup/claim', { code: CODE, email: 'thief@example.com' })
    expect(again.status).toBe(409)
    expect((await again.json()).detail).toMatch(/^This deployment is already claimed\. Lost the passkey\? Change the SETUP_CODE secret on this deployment/)
  })

  it('limits attempts: 5 an hour per address', async () => {
    const { browser } = await setup()
    const guesser = browser('198.51.100.7')
    for (let attempt = 0; attempt < 5; attempt++) expect((await guesser.call('POST', '/api/setup/claim', { code: `GUESS-${attempt}`, email: 'g@example.com' })).status).toBe(403)
    expect((await guesser.call('POST', '/api/setup/claim', { code: CODE, email: 'g@example.com' })).status).toBe(429)
  })

  it('the setup claim counts by the trusted address', async () => {
    const { browser } = await setup({ address: { header: 'x-forwarded-for' } })
    // A new cf-connecting-ip or a value put in front of x-forwarded-for each time: still one address
    for (let attempt = 0; attempt < 5; attempt++)
      expect((await browser(`192.0.2.${attempt}`).call('POST', '/api/setup/claim', { code: `GUESS-${attempt}`, email: 'g@example.com' }, { 'x-forwarded-for': `forged-${attempt}, 198.51.100.7` })).status).toBe(403)
    expect((await browser('192.0.2.9').call('POST', '/api/setup/claim', { code: CODE, email: 'g@example.com' }, { 'x-forwarded-for': 'forged-9, 198.51.100.7' })).status).toBe(429)
    // Another address the proxy wrote has its own count
    expect((await browser('192.0.2.9').call('POST', '/api/setup/claim', { code: 'GUESS-X', email: 'g@example.com' }, { 'x-forwarded-for': '198.51.100.8' })).status).toBe(403)
  })

  it('lets the owner back in after the setup code is changed, once, and tells the app when it starts and completes', async () => {
    const first = await setup()
    await first.claimAsOwner()
    // The same database with a rotated secret, as after `wrangler secret put SETUP_CODE`
    const rotated = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [PEOPLE_TAG, SETUP_TAG], auth: { realm: 'sample', keys: new Map(), open: [...PEOPLE_OPEN_PATHS, ...SETUP_OPEN_PATHS], session: sessionOf(first.db) } })
    const recoveries: unknown[] = []
    const passkeyChanges: unknown[] = []
    await registerPeople(rotated, { db: first.db, rpName: 'Sample', onPasskeyChange: (change) => void passkeyChanges.push(change) })
    await registerSetup(rotated, { db: first.db, code: 'NEW1-CODE', steps: [], guards: memoryGuardStore(), onRecovery: (recovery) => void recoveries.push(recovery) })
    const post = (path: string, body: unknown) => rotated.request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'user-agent': IPHONE }, body: JSON.stringify(body) })
    expect(await (await rotated.request(`${ORIGIN}/api/setup`)).json()).toMatchObject({ claimed: true, recovery: true })
    expect((await post('/api/setup/claim', { code: 'NEW1-CODE', email: 'someone@example.com' })).status).toBe(403)
    expect(recoveries).toEqual([])
    const recovered = await (await post('/api/setup/claim', { code: 'NEW1-CODE', email: 'owner@example.com' })).json()
    expect(recovered).toMatchObject({ mode: 'recover' })
    expect(recovered.enrolment).toEqual(expect.any(String))
    expect(recoveries).toEqual([{ stage: 'started', who: 'owner@example.com' }])
    expect((await post('/api/setup/claim', { code: 'NEW1-CODE', email: 'owner@example.com' })).status).toBe(409)
    // The enrolment makes the new passkey: the recovery is complete, told once, with the passkey it made
    const { enrolment } = recovered
    const { challengeId, options } = await (await post('/api/session/passkeys/register/options', { enrolment })).json()
    const made = await post('/api/session/passkeys/register/verify', { challengeId, enrolment, response: await (await softAuthenticator()).register(options, ORIGIN) })
    expect(made.status).toBe(200)
    const passkey = { id: expect.any(String), name: 'iPhone · Safari' }
    expect(recoveries).toEqual([
      { stage: 'started', who: 'owner@example.com' },
      { stage: 'completed', who: 'owner@example.com', passkey },
    ])
    expect(passkeyChanges).toEqual([{ action: 'added', who: 'owner@example.com', ...passkey, by: 'owner@example.com', via: 'recovery' }])
    // The first app's own claim was no recovery
    expect(first.recoveries).toEqual([])
  })
})

describe('recovering with a session still open, and hooks that fail', () => {
  /** The first app's database with a rotated code, its hooks given; `post` keeps one browser's cookie. */
  const rotate = async (db: Awaited<ReturnType<typeof setup>>['db'], hooks: Parameters<typeof registerPeople>[1] & Partial<Parameters<typeof registerSetup>[1]>) => {
    const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [PEOPLE_TAG, SETUP_TAG], auth: { realm: 'sample', keys: new Map(), open: [...PEOPLE_OPEN_PATHS, ...SETUP_OPEN_PATHS], session: sessionOf(db) } })
    await registerPeople(app, hooks)
    await registerSetup(app, { db, code: 'NEW1-CODE', steps: [], guards: memoryGuardStore(), onRecovery: hooks.onRecovery })
    return app
  }
  const browserOn = (app: Awaited<ReturnType<typeof rotate>>, cookie = '') => {
    const json = async (path: string, body: unknown) => {
      const answer = await app.request(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'user-agent': IPHONE, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
      const set = answer.headers.get('set-cookie')
      if (set) cookie = set.split(';')[0]!
      return { status: answer.status, body: (await answer.json()) as any }
    }
    const recover = async () => {
      const { body: claimed } = await json('/api/setup/claim', { code: 'NEW1-CODE', email: 'owner@example.com' })
      const { body: options } = await json('/api/session/passkeys/register/options', { enrolment: claimed.enrolment })
      const made = await json('/api/session/passkeys/register/verify', { challengeId: options.challengeId, enrolment: claimed.enrolment, response: await (await softAuthenticator()).register(options.options, ORIGIN) })
      return { claimed, made }
    }
    return { json, recover }
  }

  it('completes a recovery made in a browser still signed in, and spends its enrolment', async () => {
    const first = await setup()
    const { owner } = await first.claimAsOwner()
    const recoveries: unknown[] = []
    const passkeyChanges: { via?: string }[] = []
    const app = await rotate(first.db, { db: first.db, rpName: 'Sample', onPasskeyChange: (change) => void passkeyChanges.push(change), onRecovery: (recovery) => void recoveries.push(recovery) })
    const { claimed, made } = await browserOn(app, owner.cookie()).recover()
    expect(made.status).toBe(200)
    expect(passkeyChanges.map((change) => change.via)).toEqual(['recovery'])
    expect(recoveries).toMatchObject([{ stage: 'started' }, { stage: 'completed', passkey: { name: 'iPhone · Safari' } }])
    // The enrolment is spent, so nobody can make a second passkey with it
    expect((await browserOn(app).json('/api/session/passkeys/register/options', { enrolment: claimed.enrolment })).status).toBe(401)
  })

  it('keeps sign-in and recovery working when the app\'s hooks throw', async () => {
    const first = await setup()
    await first.claimAsOwner()
    const fail = () => {
      throw new Error('the log is down')
    }
    const app = await rotate(first.db, { db: first.db, rpName: 'Sample', onPasskeyChange: fail, onRecovery: fail })
    const { claimed, made } = await browserOn(app).recover()
    // The rotated code is spent either way, so the owner must still get the enrolment and their passkey
    expect(claimed).toMatchObject({ mode: 'recover', enrolment: expect.any(String) })
    expect(made).toMatchObject({ status: 200, body: { signedIn: true, passkeys: 2 } })
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

  it('names a passkey after its device and browser unless the person names it, and never twice the same', async () => {
    const { browser } = await setup()
    const owner = browser()
    const mac = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
    const make = async (name?: string, enrolment?: string) => {
      const { challengeId, options } = await owner.json('POST', '/api/session/passkeys/register/options', enrolment ? { enrolment } : {}, mac)
      const made = await owner.call('POST', '/api/session/passkeys/register/verify', { challengeId, enrolment, name, response: await (await softAuthenticator()).register(options, ORIGIN) }, mac)
      expect(made.status).toBe(200)
    }
    const { enrolment } = await owner.json('POST', '/api/setup/claim', { code: CODE, email: 'owner@example.com' })
    await make(undefined, enrolment)
    // A bare device word says less than the user agent; a chosen name is kept, and numbered when taken
    await make('Mac')
    await make('Work laptop')
    await make('Work laptop')
    const names = (await owner.json('GET', '/api/session/passkeys'))._embedded.passkeys.map((passkey: { name: string }) => passkey.name)
    expect(names).toEqual(['Mac · Chrome', 'Mac · Chrome (2)', 'Work laptop', 'Work laptop (2)'])
    expect(passkeyBaseName(undefined, 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari')
    expect(passkeyBaseName(undefined, undefined)).toBe('Passkey')
  })

  it('tells the app about every passkey added or removed, whose it is and how its maker got in', async () => {
    const { claimAsOwner, passkeyChanges } = await setup()
    const { owner } = await claimAsOwner()
    // Signed in, the owner adds a second passkey from another device, then removes the first
    const { challengeId, options } = await owner.json('POST', '/api/session/passkeys/register/options', {}, { 'user-agent': IPHONE })
    expect((await owner.call('POST', '/api/session/passkeys/register/verify', { challengeId, response: await (await softAuthenticator()).register(options, ORIGIN) }, { 'user-agent': IPHONE })).status).toBe(200)
    const [laptop] = (await owner.json('GET', '/api/session/passkeys'))._embedded.passkeys
    expect((await owner.call('DELETE', `/api/session/passkeys/${encodeURIComponent(laptop.id)}`)).status).toBe(204)
    const who = 'owner@example.com'
    expect(passkeyChanges).toEqual([
      { action: 'added', who, id: laptop.id, name: 'Laptop', by: who, via: 'claim' },
      { action: 'added', who, id: expect.any(String), name: 'iPhone · Safari', by: who, via: 'session' },
      { action: 'removed', who, id: laptop.id, name: 'Laptop', by: who },
    ])
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

  it('takes a challenge once when two verifies of it arrive together', async () => {
    const { browser, claimAsOwner, db } = await setup()
    const { authenticator } = await claimAsOwner()
    const again = browser()
    const { challengeId, options } = await again.json('POST', '/api/session/passkeys/login/options')
    const response = await authenticator.login(options, ORIGIN)
    const answers = await Promise.all([again.call('POST', '/api/session/passkeys/login/verify', { challengeId, response }), browser().call('POST', '/api/session/passkeys/login/verify', { challengeId, response })])
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 400])

    const repo = peopleRepo(db)
    await repo.addChallenge({ id: 'wch_twice', kind: 'enrol', challenge: 'c', personId: 'prs_1', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const taken = await Promise.all([repo.takeChallenge('wch_twice', 'enrol'), repo.takeChallenge('wch_twice', 'enrol')])
    expect(taken.filter(Boolean)).toHaveLength(1)
    // An expired one is taken out, never handed back
    await repo.addChallenge({ id: 'wch_old', kind: 'login', challenge: 'c', personId: null, expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect(await repo.takeChallenge('wch_old', 'login')).toBeUndefined()
    expect(await repo.peekChallenge('wch_old', 'login')).toBeUndefined()
  })

  it('sweeps expired challenges and sessions from its writes, at most once a minute', async () => {
    let at = Date.parse('2026-11-10T09:00:00Z')
    vi.useFakeTimers({ toFake: ['Date'], now: at })
    const db = await testDb()
    await migrate(db, 'people', PEOPLE_MIGRATIONS)
    const repo = peopleRepo(db)
    const rows = async () => Number((await db.all<[number]>(sql`select (select count(*) from webauthn_challenges) + (select count(*) from sessions)`))[0]![0])
    const inSeconds = (seconds: number) => new Date(at + seconds * 1000).toISOString()
    await repo.addChallenge({ id: 'wch_soon', kind: 'login', challenge: 'c', personId: null, expiresAt: inSeconds(10) })
    await repo.addSession('session-soon', 'prs_1', inSeconds(10), null)
    vi.setSystemTime((at += 30_000))
    // Both lapsed, but the last sweep was under a minute ago
    await repo.addChallenge({ id: 'wch_later', kind: 'login', challenge: 'c', personId: null, expiresAt: inSeconds(300) })
    expect(await rows()).toBe(3)
    vi.setSystemTime((at += 31_000))
    await repo.addSession('session-later', 'prs_1', inSeconds(3600), null)
    expect(await rows()).toBe(2)
    expect(await db.all(sql`select name from sqlite_master where type = 'index' and name = 'sessions_by_person'`)).toHaveLength(1)
  })

  it('limits the anonymous options routes per address when given limits, and not without', async () => {
    const limited = await setup({ limits: { store: memoryGuardStore() } })
    const caller = limited.browser('198.51.100.7')
    for (let call = 0; call < 30; call++) expect((await caller.call('POST', '/api/session/passkeys/login/options')).status).toBe(200)
    const refused = await caller.call('POST', '/api/session/passkeys/register/options', {})
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await limited.browser('198.51.100.8').call('POST', '/api/session/passkeys/login/options')).status).toBe(200)

    const open = (await setup()).browser('198.51.100.7')
    for (let call = 0; call < 31; call++) expect((await open.call('POST', '/api/session/passkeys/login/options')).status).toBe(200)
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

  it('tells the app about every change to the team, with the role before and after', async () => {
    const { asKey, teamChanges } = await setup()
    const send = (method: string, path: string, body?: unknown) => asKey(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) })
    await send('POST', '/api/team', { email: 'ana@example.org' })
    await send('POST', '/api/team', { domain: 'partner.example' })
    // Adding a domain already on the team changes nothing, so it is not told
    await send('POST', '/api/team', { domain: 'partner.example' })
    const ana = (await (await asKey('/api/team')).json()).people.find((person: { email: string }) => person.email === 'ana@example.org')
    await send('PATCH', `/api/team/people/${ana.id}`, { role: 'owner' })
    await send('PATCH', `/api/team/people/${ana.id}`, { role: 'owner' })
    // The last owner stays, so another comes first
    await send('POST', '/api/team', { email: 'bo@example.org', role: 'owner', notify: false })
    await send('DELETE', `/api/team/people/${ana.id}`)
    await send('DELETE', '/api/team/domains/partner.example')
    expect(teamChanges).toEqual([
      { who: 'ana@example.org', from: null, to: 'member', by: 'owner-key', notify: true },
      { who: '@partner.example', from: null, to: 'member', by: 'owner-key' },
      { who: 'ana@example.org', from: 'member', to: 'owner', by: 'owner-key' },
      { who: 'bo@example.org', from: null, to: 'owner', by: 'owner-key', notify: false },
      { who: 'ana@example.org', from: 'owner', to: null, by: 'owner-key' },
      { who: '@partner.example', from: 'member', to: null, by: 'owner-key' },
    ])
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
  it('checks every step for real, owner only, never hangs on a slow one, and leaves switched-off steps out of the count', async () => {
    const steps: SetupStep[] = [
      { id: 'domain', title: 'Choose the domain', why: 'Addresses live on it.', minutes: 1, check: async () => ({ ok: true, detail: 'mail.example.com' }) },
      { id: 'routing', title: 'Route mail here', why: 'Or nothing arrives.', minutes: 2, check: async () => ({ ok: false, detail: 'No mail yet.', fixUrl: 'https://dash.example/routing' }) },
      { id: 'broken', title: 'A check that throws', why: 'To prove it is caught.', minutes: 1, optional: true, check: async () => Promise.reject(new Error('boom')) },
      { id: 'sending', title: 'Send mail', why: 'Replies leave through it.', minutes: 5, optional: true, check: async () => ({ ok: false, detail: 'Switched off under Features.', switchedOff: true }) },
    ]
    const { browser, claimAsOwner } = await setup({ steps })
    const { owner } = await claimAsOwner()
    expect((await browser().call('GET', '/api/setup/checklist')).status).toBe(401)
    const checklist = await owner.json('GET', '/api/setup/checklist')
    // The switched-off step is listed, and counted neither as done nor as left
    expect(checklist).toMatchObject({ done: 1, total: 3 })
    expect(checklist._embedded.steps).toMatchObject([
      { id: 'domain', ok: true },
      { id: 'routing', ok: false, fixUrl: 'https://dash.example/routing' },
      { id: 'broken', ok: false, optional: true, detail: 'The check failed: boom', switchedOff: false },
      { id: 'sending', ok: false, switchedOff: true },
    ])
  })
})
