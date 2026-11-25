/** The sharing part's owner side: who may share, the space's settings, and invites made, listed and revoked. */
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createAgentApi, createOAuth, dbGuardStore, generateOAuthKey, hashApiKey, kitGuards, memoryGuardStore, memoryOAuthStore, parseApiKeys, pathWith, testDb, type Caller, type Db, type GuardStore, type StoredAnswer } from '../src/index.js'
import { inProcess, mcpServerFactory, mountMcp } from '../src/mcp/index.js'
import { createSharing, newInviteCode, registerSharing, sharerOf, sharingRepo, sharingTools, SHARING_TAG, type SharingOptions } from '../src/sharing/index.js'
import { cliGaps, lintOpenApi, toolRoutes, toolsRun } from '../src/testing/index.js'
import { approvedCode, signedIn } from './oauth-store-contract.js'
import { inviteRow, memberRow, requestRow } from './sharing-rows.js'

// The real code maker, unless a test asks for the same code twice (a collision)
vi.mock('../src/sharing/secrets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/sharing/secrets.js')>()
  return { ...real, newInviteCode: vi.fn(real.newInviteCode) }
})

const ORIGIN = 'http://localhost'
const OWNER = 'owner@example.test'
const KEY = 'owner-key'
const SPARE_KEY = 'spare-key'
const SECRET = 'a sharing secret of thirty-two bytes or more, for tests only'
const SPACES = [
  { id: 'sp_soups', name: 'soups', title: 'Soups' },
  { id: 'sp_bakes', name: 'bakes', title: 'Bakes' },
]
const spaces = { byName: async (name: string) => SPACES.find((space) => space.name === name) ?? null, byId: async (id: string) => SPACES.find((space) => space.id === id) ?? null }
/** The single sign-on, as the tests stand in for it: the kit's consent page by header, the API by Access's assertion. */
const owner = async (c: { req: { header: (name: string) => string | undefined } }) => c.req.header('x-test-owner') ?? (c.req.header('cf-access-jwt-assertion') === 'owner-token' ? OWNER : null)
const PEOPLE: Record<string, string> = { 'owner-token': OWNER, 'ada-token': 'ada@example.test' }

/** A recipe box whose shelves are spaces, with every kind of caller: keys, people through Access, and OAuth agents. */
const sharingApi = async ({ guards = 'memory', options = {}, publicOrigin = ORIGIN }: { guards?: 'memory' | 'database'; options?: Partial<SharingOptions>; publicOrigin?: string } = {}) => {
  const db = await testDb()
  const store = guards === 'database' ? await dbGuardStore(db) : memoryGuardStore()
  // Every answer the guard keeps, as it handed it to the store
  const kept: StoredAnswer[] = []
  const recording: GuardStore = { ...store, save: (id, answer, expiresAt) => (kept.push(answer), store.save(id, answer, expiresAt)) }
  const oauth = createOAuth({
    name: 'Sample', signingKey: await generateOAuthKey(), store: memoryOAuthStore(), owner, owners: [OWNER], publicOrigin,
    resources: (path) => /^\/s\/[a-z0-9-]+\/mcp$/.test(path),
    // Every token reaches the API here, so the owner routes' own rule is what refuses a space token
    accepts: async () => true,
  })
  const sharing = await createSharing({ db, secret: SECRET, spaces, owner, fixedKeys: ['owner'], askToJoin: true, ...options })
  const app = createAgentApi({
    title: 'Sample', version: '1.0.0', description: 'A recipe box.', tags: [SHARING_TAG],
    auth: { realm: 'sample', keys: parseApiKeys(`owner:${hashApiKey(KEY)},spare:${hashApiKey(SPARE_KEY)}`), access: { team: 'sample', audience: 'sample', verify: async (token) => PEOPLE[token] ?? null }, relay: ['/mcp', '/a2a', sharing.relay] },
    oauth,
    guards: { store: recording, skip: sharing.neverKept },
  })
  await registerSharing(app, sharing, { oauth })
  const as = (headers: Record<string, string>) => (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
    app.request(path, { method: init.method ?? 'GET', headers: { 'content-type': 'application/json', ...headers, ...init.headers }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
  return { app, db, kept, sharing, as, byKey: as({ authorization: `Bearer ${KEY}` }), byOwner: as({ 'cf-access-jwt-assertion': 'owner-token', 'sec-fetch-site': 'same-origin' }) }
}

type Api = Awaited<ReturnType<typeof sharingApi>>
type NewInvite = { id: string; label: string; invitedBy: string; scope: string; lifetime: string; state: string; link: string; code: string; message: string; redeemBy: string }

const makeInvite = async (call: Api['byKey'], space = 'soups', body: Record<string, unknown> = { label: 'Sam' }, headers: Record<string, string> = {}) => {
  const made = await call(`/api/spaces/${space}/invites`, { method: 'POST', body, headers })
  expect(made.status, await made.clone().text()).toBe(201)
  return (await made.json()) as NewInvite
}
const invitesAt = async (call: Api['byKey'], space = 'soups') => ((await (await call(`/api/spaces/${space}/invites`)).json()) as { _embedded: { invites: (NewInvite & Record<string, unknown>)[] } })._embedded.invites
/** A problem's body without the request's own id, so two answers compare whole. */
const problemOf = async (answer: Response) => {
  const { instance: _instance, ...body } = (await answer.json()) as Record<string, unknown>
  return { status: answer.status, body }
}

describe('who may share', () => {
  const facts = { owner: null, fixedKeys: ['owner'], root: ORIGIN, mcpPath: '/mcp' }
  const agent = (resource?: string, grant: string | null = 'grant-1'): Caller => ({ kind: 'agent', name: 'Sample', client: 'client-1', grant: grant ?? undefined, scopes: ['read', 'write'], owner: OWNER, resource })
  it.each([
    ['a key from API_KEYS', { kind: 'key', name: 'owner' }, facts, { kind: 'key', by: 'owner' }],
    ['a key made through the API', { kind: 'key', name: 'spare' }, facts, null],
    ['the owner, signed in', { kind: 'person', email: OWNER }, { ...facts, owner: OWNER }, { kind: 'owner', by: OWNER }],
    ['a person the app does not call the owner', { kind: 'person', email: 'ada@example.test' }, facts, null],
    ['a team member, even when owner answers', { kind: 'person', email: 'ada@example.test', role: 'member' }, { ...facts, owner: 'ada@example.test' }, null],
    ['an agent with no audience', agent(), facts, { kind: 'agent', by: 'agent:client-1', client: 'client-1', grant: 'grant-1' }],
    ['an agent for the root', agent(ORIGIN), facts, { kind: 'agent', by: 'agent:client-1', client: 'client-1', grant: 'grant-1' }],
    ['an agent for the root MCP', agent(`${ORIGIN}/mcp`), facts, { kind: 'agent', by: 'agent:client-1', client: 'client-1', grant: 'grant-1' }],
    ['an agent for a space', agent(`${ORIGIN}/s/soups/mcp`), facts, null],
    ['an agent for another origin', agent('https://elsewhere.example.test'), facts, null],
    ['an agent with no grant (a token from before grants)', agent(ORIGIN, null), facts, null],
    ['no caller', undefined, facts, null],
  ] as const)('%s', (_name, caller, given, sharer) => {
    expect(sharerOf(caller as Caller | undefined, given)).toEqual(sharer)
  })
})

describe('createSharing', () => {
  it('derives the relay and the MCP mount from the space address, and never keeps the sign-in pages', async () => {
    const db = await testDb()
    const sharing = await createSharing({ db, secret: SECRET, spaces, owner })
    expect([sharing.relay, sharing.mcpPath, sharing.neverKept]).toEqual(['/s/*/mcp', '/s/:space/mcp', ['/sharing/*']])
    const moved = await createSharing({ db, secret: SECRET, spaces, owner, resourcePath: '/box/{space}/mcp' })
    expect([moved.relay, moved.mcpPath]).toEqual(['/box/*/mcp', '/box/:space/mcp'])
  })

  it.each([
    ['a short secret', { secret: 'short' }, /the secret holds 5 bytes/],
    ['an address with no space', { resourcePath: '/s/mcp' }, /one \{space\} segment/],
    ['an address with two spaces', { resourcePath: '/s/{space}/{space}/mcp' }, /one \{space\} segment/],
    ['a space inside a segment', { resourcePath: '/s/x{space}/mcp' }, /one \{space\} segment/],
    ['a space as the last segment, which would relay everything under it', { resourcePath: '/s/{space}' }, /with a segment after it/],
  ])('refuses %s', async (_name, change, message) => {
    await expect(createSharing({ db: await testDb(), secret: SECRET, spaces, owner, ...change })).rejects.toThrow(message)
  })
})

describe('invites', () => {
  it('are made, listed and revoked by those who may share', async () => {
    const { byKey, byOwner, as } = await sharingApi()
    const made = await byKey('/api/spaces/soups/invites', { method: 'POST', body: { label: 'Sam' } })
    expect([made.status, made.headers.get('cache-control'), made.headers.get('shown-once')]).toEqual([201, 'no-store', 'true'])
    const invite = (await made.json()) as NewInvite
    expect(invite).toMatchObject({ label: 'Sam', invitedBy: 'owner', scope: 'read', lifetime: '30d', state: 'open' })
    expect(invite.link).toMatch(new RegExp(`^${ORIGIN}/sharing/join/[\\w-]{32}$`))
    expect(invite.code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(invite.message).toContain(invite.link)
    expect(invite.message).toContain(invite.code)
    expect(invite.message).toContain('Soups')

    // The owner, signed in, makes one too
    const ownerMade = await makeInvite(byOwner, 'soups', { label: 'Ada', scope: 'write', lifetime: 'until_revoked' })
    expect(ownerMade).toMatchObject({ invitedBy: OWNER, scope: 'write', lifetime: 'until_revoked' })

    const listed = await byKey('/api/spaces/soups/invites')
    expect([listed.status, listed.headers.get('cache-control')]).toEqual([200, 'no-store'])
    const page = await listed.json() as { count: number; _embedded: { invites: Record<string, unknown>[] } }
    expect(page._embedded.invites.map((one) => [one.id, one.state])).toEqual([[ownerMade.id, 'open'], [invite.id, 'open']])
    // A listed invite never shows its link, its code, or what is kept of them
    const text = JSON.stringify(page)
    for (const secret of [invite.link, invite.code, ownerMade.code, 'linkHash', 'codeHash', 'madeByGrant']) expect(text).not.toContain(secret)

    expect((await byOwner(`/api/spaces/soups/invites/${invite.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await byOwner(`/api/spaces/soups/invites/${invite.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await invitesAt(byKey)).map((one) => [one.id, one.state])).toEqual([[ownerMade.id, 'open'], [invite.id, 'revoked']])

    // Ada is signed in, but the app does not call her the owner
    const ada = as({ 'cf-access-jwt-assertion': 'ada-token', 'sec-fetch-site': 'same-origin' })
    expect((await ada('/api/spaces/soups/invites', { method: 'POST', body: { label: 'Bea' } })).status).toBe(404)
    expect(await invitesAt(byKey)).toHaveLength(2)
  })

  it('each have a self, from the 201 (and its Location) and the list, that answers the card without a link or code', async () => {
    const { byKey } = await sharingApi()
    const made = await byKey('/api/spaces/soups/invites', { method: 'POST', body: { label: 'Sam' } })
    const invite = (await made.json()) as NewInvite & { _links: { self: { href: string } } }
    expect(invite._links.self.href).toBe(`${ORIGIN}/api/spaces/soups/invites/${invite.id}`)
    expect(made.headers.get('location')).toBe(`/api/spaces/soups/invites/${invite.id}`)
    const listed = (await invitesAt(byKey))[0] as unknown as { _links: { self: { href: string } } }
    expect(listed._links.self.href).toBe(invite._links.self.href)

    const one = await byKey(invite._links.self.href.replace(ORIGIN, ''))
    expect([one.status, one.headers.get('cache-control')]).toEqual([200, 'no-store'])
    const card = (await one.json()) as Record<string, unknown>
    expect(card).toMatchObject({ id: invite.id, label: 'Sam', state: 'open', _links: { self: { href: invite._links.self.href } } })
    const text = JSON.stringify(card)
    for (const secret of [invite.link, invite.code, 'linkHash', 'codeHash', 'madeByGrant']) expect(text).not.toContain(secret)

    expect((await byKey(`/api/spaces/soups/invites/${invite.id}`, { method: 'DELETE' })).status).toBe(204)
    expect(((await (await byKey(`/api/spaces/soups/invites/${invite.id}`)).json()) as { state: string }).state).toBe('revoked')
  })

  it('refuses a label with control, bidi or zero-width characters, and one over 80', async () => {
    const { byKey } = await sharingApi()
    for (const label of ['Sam‮gnp.exe', 'Sa​m', 'Sam\nAda', '', 'x'.repeat(81)]) expect((await byKey('/api/spaces/soups/invites', { method: 'POST', body: { label } })).status, label).toBe(400)
    expect(await invitesAt(byKey)).toEqual([])
  })

  it('name publicOrigin in their links, whatever the host header says', async () => {
    const { byKey } = await sharingApi({ publicOrigin: 'https://sample.example.test' })
    const invite = await makeInvite(byKey, 'soups', { label: 'Sam' }, { 'x-forwarded-host': 'evil.example.test', host: 'evil.example.test' })
    expect(invite.link.startsWith('https://sample.example.test/sharing/join/')).toBe(true)
  })

  it('answers 409 once redeemed, and records the revoke all the same: its member keeps access', async () => {
    const { byKey, db } = await sharingApi()
    const invite = await makeInvite(byKey)
    const now = new Date()
    expect(await sharingRepo(db).claimInvite(invite.id, { grantId: 'grant-1', clientId: 'client-1', spaceId: 'sp_soups', label: 'Sam', appName: 'Sample', returnsTo: 'this computer', scope: 'read', lifetime: '30d', joinedAt: now.toISOString(), expiresAt: null, lastSeenAt: now.toISOString() }, now)).not.toBeNull()
    const refused = await byKey(`/api/spaces/soups/invites/${invite.id}`, { method: 'DELETE' })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { detail: string }).detail).toMatch(/used already/)
    expect((await invitesAt(byKey))[0]).toMatchObject({ state: 'redeemed', revokedAt: expect.any(String) })
    expect((await sharingRepo(db).memberByGrant('grant-1'))?.endedAt).toBeNull()
    expect((await byKey(`/api/spaces/soups/invites/${invite.id}`, { method: 'DELETE' })).status).toBe(409)
  })

  it('stop at 100 open at a space', async () => {
    const { byKey, db } = await sharingApi()
    const repo = sharingRepo(db)
    for (let index = 0; index < 100; index++) await repo.addInvite(inviteRow('sp_soups', new Date(), `cap-${index}`))
    const refused = await byKey('/api/spaces/soups/invites', { method: 'POST', body: { label: 'Sam' } })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { detail: string }).detail).toMatch(/100 open invites/)
    // Another space has its own 100
    await makeInvite(byKey, 'bakes')
  })

  it('stop at 100 open when many are made at once', async () => {
    const { byKey, db } = await sharingApi()
    const repo = sharingRepo(db)
    for (let index = 0; index < 95; index++) await repo.addInvite(inviteRow('sp_soups', new Date(), `cap-${index}`))
    const answers = await Promise.all(Array.from({ length: 20 }, (_, index) => byKey('/api/spaces/soups/invites', { method: 'POST', body: { label: `Guest ${index}` } })))
    const statuses = answers.map((answer) => answer.status)
    expect([statuses.filter((status) => status === 201).length, statuses.filter((status) => status === 409).length]).toEqual([5, 15])
    const sharing = (await (await byKey('/api/spaces/soups/sharing')).json()) as { openInvites: number }
    expect(sharing.openInvites).toBe(100)
  })

  it('make a new code when one is taken', async () => {
    const { byKey } = await sharingApi()
    const first = await makeInvite(byKey)
    vi.mocked(newInviteCode).mockClear().mockReturnValueOnce(first.code).mockReturnValueOnce(first.code)
    const second = await makeInvite(byKey)
    // Two taken codes, then a fresh one: the maker ran three times for this invite
    expect(vi.mocked(newInviteCode)).toHaveBeenCalledTimes(3)
    expect(second.code).not.toBe(first.code)
    expect(await invitesAt(byKey)).toHaveLength(2)
  })

  it('page newest first, and a revoke between pages moves nothing', async () => {
    const { byKey } = await sharingApi()
    const made: string[] = []
    for (const label of ['A', 'B', 'C', 'D', 'E']) made.push((await makeInvite(byKey, 'soups', { label })).id)
    const seen: string[] = []
    let next: string | undefined = '/api/spaces/soups/invites?limit=2'
    while (next) {
      const page = (await (await byKey(next)).json()) as { count: number; _links: { next?: { href: string } }; _embedded: { invites: { id: string }[] } }
      seen.push(...page._embedded.invites.map((one) => one.id))
      if (seen.length === 2) expect((await byKey(`/api/spaces/soups/invites/${made[1]}`, { method: 'DELETE' })).status).toBe(204)
      next = page._links.next?.href.replace(ORIGIN, '')
    }
    expect(seen).toEqual([...made].reverse())
    expect((await byKey('/api/spaces/soups/invites?cursor=not-ours')).status).toBe(400)
  })
})

describe('the same 404', () => {
  const routes = (space: string) => [
    ['GET', `/api/spaces/${space}/sharing`, undefined],
    ['PATCH', `/api/spaces/${space}/sharing`, { askToJoin: true }],
    ['POST', `/api/spaces/${space}/invites`, { label: 'Sam' }],
    ['GET', `/api/spaces/${space}/invites`, undefined],
    ['GET', `/api/spaces/${space}/invites/inv_x`, undefined],
    ['DELETE', `/api/spaces/${space}/invites/inv_x`, undefined],
  ] as const

  it('for anyone who may not share, at a real space and a missing one, as for the owner at a missing one', async () => {
    const api = await sharingApi()
    const { app, as, byKey } = api
    const spaceToken = (await signedIn(app, { resource: `${ORIGIN}/s/soups/mcp` })).tokens.access_token
    const strangers = {
      'a key made through the API': as({ authorization: `Bearer ${SPARE_KEY}` }),
      'a signed-in person who is not the owner': as({ 'cf-access-jwt-assertion': 'ada-token', 'sec-fetch-site': 'same-origin' }),
      'a space token': as({ authorization: `Bearer ${spaceToken}` }),
    }
    for (const [method, path, body] of routes('pantry')) {
      const missing = await problemOf(await byKey(path, { method, body }))
      expect(missing.status, `${method} ${path}`).toBe(404)
      for (const [who, call] of Object.entries(strangers)) {
        expect(await problemOf(await call(path, { method, body })), `${who}: ${method} ${path}`).toEqual(missing)
        const real = await problemOf(await call(path.replace('pantry', 'soups'), { method, body }))
        expect(real, `${who} at soups: ${method} ${path}`).toEqual({ status: 404, body: { ...missing.body, detail: (missing.body.detail as string).replace('pantry', 'soups') } })
      }
    }
    expect(await invitesAt(byKey)).toEqual([])
  })

  it('for a name the app could never have: cased, dotted or encoded', async () => {
    const { byKey } = await sharingApi()
    for (const space of ['Soups', '%2e%2e', 'soups%2Fx', '-soups', 'x'.repeat(64)]) {
      const answer = await byKey(`/api/spaces/${space}/invites`)
      expect(answer.status, space).toBe(404)
      expect(((await answer.json()) as { code: string }).code).toBe('not_found')
    }
  })

  it('for an invite id from Bakes at Soups: a made-up id answers the same, and the Bakes invite stays open', async () => {
    const { byKey } = await sharingApi()
    const bakes = await makeInvite(byKey, 'bakes')
    for (const method of ['GET', 'DELETE']) {
      const crossed = await problemOf(await byKey(`/api/spaces/soups/invites/${bakes.id}`, { method }))
      const madeUp = await problemOf(await byKey('/api/spaces/soups/invites/inv_madeup', { method }))
      expect(crossed, method).toEqual({ status: 404, body: { ...madeUp.body, detail: (madeUp.body.detail as string).replace('inv_madeup', bakes.id) } })
    }
    expect((await invitesAt(byKey, 'bakes')).map((one) => one.state)).toEqual(['open'])
  })
})

describe('an agent with a root token', () => {
  it('invites for 7 or 30 days, never until revoked, and each invite names its client and grant', async () => {
    const { app, db, as } = await sharingApi()
    const { client_id, tokens } = await signedIn(app)
    const agent = as({ authorization: `Bearer ${tokens.access_token}` })
    const refused = await agent('/api/spaces/soups/invites', { method: 'POST', body: { label: 'Sam', lifetime: 'until_revoked' } })
    expect(refused.status).toBe(400)
    expect(((await refused.json()) as { detail: string }).detail).toMatch(/7 or 30 days/)

    const week = await makeInvite(agent, 'soups', { label: 'Sam', lifetime: '7d' })
    const month = await makeInvite(agent, 'soups', { label: 'Ada' })
    expect([week.invitedBy, week.lifetime, month.lifetime]).toEqual([`agent:${client_id}`, '7d', '30d'])
    const row = await sharingRepo(db).inviteAt('sp_soups', week.id)
    expect(row?.madeByClient).toBe(client_id)
    expect(row?.madeByGrant).toMatch(/\S/)

    // So does one signed in for the root MCP
    const mcp = (await signedIn(app, { resource: `${ORIGIN}/mcp` })).tokens.access_token
    await makeInvite(as({ authorization: `Bearer ${mcp}` }))
  })

  it('needs write to invite', async () => {
    const { app, as } = await sharingApi()
    const { exchange } = await approvedCode(app, { scope: 'read' })
    const readOnly = (await (await exchange()).json()) as { access_token: string }
    const agent = as({ authorization: `Bearer ${readOnly.access_token}` })
    expect((await agent('/api/spaces/soups/invites')).status).toBe(200)
    expect((await agent('/api/spaces/soups/invites', { method: 'POST', body: { label: 'Sam' } })).status).toBe(403)
  })
})

describe('an invite made with an Idempotency-Key (probe T5)', () => {
  it.each(['memory', 'database'] as const)('keeps only its replay sentence, and a retry is a 409 shown_once (%s guards)', async (guards) => {
    const { byKey, db, kept } = await sharingApi({ guards })
    const first = await byKey('/api/spaces/soups/invites', { method: 'POST', body: { label: 'Sam' }, headers: { 'idempotency-key': 'k1' } })
    expect([first.status, first.headers.get('shown-once')]).toEqual([201, 'true'])
    const invite = (await first.json()) as NewInvite
    const token = invite.link.split('/').at(-1)!

    const retried = await byKey('/api/spaces/soups/invites', { method: 'POST', body: { label: 'Sam' }, headers: { 'idempotency-key': 'k1' } })
    expect([retried.status, retried.headers.get('idempotent-replayed')]).toEqual([409, 'true'])
    const text = await retried.text()
    for (const secret of [token, invite.code]) expect(text).not.toContain(secret)
    expect(JSON.parse(text)).toMatchObject({ code: 'shown_once', detail: expect.stringContaining(invite.id) })
    expect(JSON.parse(text).detail).toMatch(/never shown again/)

    expect(kept).toEqual([{ version: 2, bodyHash: expect.any(String), shownOnce: expect.stringContaining(invite.id) }])
    for (const secret of [token, invite.code]) expect(JSON.stringify(kept)).not.toContain(secret)
    if (guards === 'database') {
      const rows = await (db as Db).select().from(kitGuards).where(eq(kitGuards.kind, 'key'))
      expect(rows.map((row) => JSON.parse(row.value))).toEqual(kept)
    }
    expect(await invitesAt(byKey)).toHaveLength(1)
  })

  it('through MCP: the code is answered once and kept nowhere', async () => {
    const { app, byKey, kept } = await sharingApi()
    mountMcp(app, { factory: mcpServerFactory({ info: { name: 'sample', version: '1.0.0' }, instructions: 'Sharing.', tools: sharingTools(), callApi: inProcess(app) }), allowedHostnames: ['localhost'] })
    const call = async (idempotencyKey: string) =>
      (await app.request('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': idempotencyKey, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'create_invite' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_invite', arguments: { space: 'soups', label: 'Sam' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
      })).text()
    const first = await call('k1')
    const code = /[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}/.exec(first)?.[0]
    expect(code, first).toBeDefined()
    const again = await call('k1')
    expect(again).not.toContain(code)
    expect(again).toMatch(/never shown again/)
    expect(kept).toEqual([{ version: 2, bodyHash: expect.any(String), shownOnce: expect.stringContaining('Sam') }])
    expect(await invitesAt(byKey)).toHaveLength(1)
  })

  it('is never kept on the sign-in pages: neverKept skips /sharing/*', async () => {
    const { app, kept } = await sharingApi()
    app.post('/sharing/probe', (c) => c.redirect('https://client-a.example.test/callback?code=code_secret', 302))
    const answer = await app.request('/sharing/probe', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': 'k3' } })
    expect(answer.status).toBe(302)
    expect(kept).toEqual([])
  })
})

describe("the space's sharing settings", () => {
  it('show asking off, switch it on, and switching it off refuses who is waiting', async () => {
    const { byKey, byOwner, db } = await sharingApi()
    const settings = await byKey('/api/spaces/soups/sharing')
    expect(settings.status).toBe(200)
    expect(await settings.json()).toMatchObject({ space: 'soups', title: 'Soups', askToJoin: 'off', askToJoinOffered: true, openInvites: 0 })
    await makeInvite(byKey)

    const on = await byOwner('/api/spaces/soups/sharing', { method: 'PATCH', body: { askToJoin: true } })
    expect(on.status).toBe(200)
    expect(await on.json()).toMatchObject({ askToJoin: 'on', openInvites: 1 })
    // Bakes keeps its own setting
    expect(await (await byKey('/api/spaces/bakes/sharing')).json()).toMatchObject({ askToJoin: 'off' })

    const repo = sharingRepo(db)
    const waiting = await repo.addRequest(requestRow('sp_soups', new Date(), 'ada'))
    const off = await byKey('/api/spaces/soups/sharing', { method: 'PATCH', body: { askToJoin: false } })
    expect(await off.json()).toMatchObject({ askToJoin: 'off' })
    expect(await repo.requestAt('sp_soups', waiting!)).toMatchObject({ state: 'refused', decidedBy: 'owner' })
  })

  it('answer 409 to the switch when the app does not offer asking', async () => {
    const { byKey } = await sharingApi({ options: { askToJoin: false } })
    expect(await (await byKey('/api/spaces/soups/sharing')).json()).toMatchObject({ askToJoin: 'off', askToJoinOffered: false })
    const refused = await byKey('/api/spaces/soups/sharing', { method: 'PATCH', body: { askToJoin: true } })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { detail: string }).detail).toMatch(/askToJoin/)
  })
})

describe('the owner routes and tools', () => {
  it('pass the OpenAPI lint, every tool names a route, and the command line has no gaps', async () => {
    const { app } = await sharingApi()
    const doc = (await (await app.request('/openapi.json')).json()) as Parameters<typeof lintOpenApi>[0]
    expect(lintOpenApi(doc)).toEqual([])
    expect(toolRoutes(sharingTools(), doc as never)).toEqual([])
    expect(cliGaps({ tools: sharingTools() })).toEqual([])
    expect(cliGaps({ tools: sharingTools({ path: '/api/shelves', noun: 'shelf' }) })).toEqual([])
  })

  it('run with toolsRun, the way an agent calls them', async () => {
    const { app, byKey, db } = await sharingApi()
    const open = await makeInvite(byKey)
    const member = (await sharingRepo(db).addOwnerMember(memberRow('sp_soups', new Date(), 'grant-tools')))!
    const args = {
      get_sharing: { space: 'soups' },
      set_ask_to_join: { space: 'soups', askToJoin: true },
      create_invite: { space: 'soups', label: 'Sam', scope: 'write', lifetime: '7d' },
      list_invites: { space: 'soups', limit: 5 },
      revoke_invite: { space: 'soups', id: open.id },
      list_members: { space: 'soups', limit: 5 },
      invite_again: { space: 'soups', id: member },
      remove_member: { space: 'soups', id: member },
    }
    expect(await toolsRun(sharingTools(), app, args, { headers: { authorization: `Bearer ${KEY}` } })).toEqual([])
  })

  it('list_invites says in its text when more invites exist, with the cursor that continues, and nothing more on the last page', async () => {
    const { byKey } = await sharingApi()
    const older = await makeInvite(byKey, 'soups', { label: 'Sam' })
    const newer = await makeInvite(byKey, 'soups', { label: 'Ada' })
    const listInvites = sharingTools().find((tool) => tool.name === 'list_invites')!
    const textOf = async (input: { space: string; limit: number; cursor?: string }) => {
      const { path, query } = listInvites.call(input)
      return listInvites.summarize!(await (await byKey(pathWith(path, query as Parameters<typeof pathWith>[1]))).json(), input)
    }
    const first = await textOf({ space: 'soups', limit: 1 })
    const cursor = /cursor (\S+)/.exec(first)?.[1]
    expect(first.split('\n')).toEqual([expect.stringContaining(newer.id), `More invites: call list_invites again with cursor ${cursor}`])
    const last = await textOf({ space: 'soups', limit: 1, cursor })
    expect(last.split('\n')).toEqual([expect.stringContaining(older.id)])
  })

  it('say they act only on the user’s word, and create_invite never sends the message', () => {
    for (const tool of sharingTools()) expect(tool.description, tool.name).toMatch(/only when the user (asks|says so)/)
    expect(sharingTools().find((tool) => tool.name === 'create_invite')?.description).toMatch(/never sends it/)
  })
})
