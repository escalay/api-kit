import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { createAgentApi, dbGuardStore, hashApiKey, holderOf, KEYS_TAG, keyTools, kitGuards, memoryGuardStore, parseApiKeys, registerKeys, storedKeysOf, testDb, type Db, type GuardStore, type KeyChange, type StoredAnswer } from '../src/index.js'
import { inProcess, mcpServerFactory, mountMcp } from '../src/mcp/index.js'
import { cliSnapshot, lintOpenApi, toolRoutes, toolsRun } from '../src/testing/index.js'
import { createCli } from '../templates/sdk/sdk/cli/engine/index.js'
import { createRequest } from '../templates/sdk/sdk/src/client.js'

const KEY = 'owner-key'

/** Where an app keeps its idempotency answers. */
const GUARD_STORES = { memory: async () => memoryGuardStore(), database: (db: Db) => dbGuardStore(db) }

const setup = async ({ onKeyChange, guards = 'memory' }: { onKeyChange?: (change: KeyChange) => void; guards?: keyof typeof GUARD_STORES } = {}) => {
  const db = await testDb()
  const store = await GUARD_STORES[guards](db)
  // Every answer the guard keeps, as it handed it to the store
  const kept: StoredAnswer[] = []
  const recording: GuardStore = { ...store, save: (id, answer, expiresAt) => (kept.push(answer), store.save(id, answer, expiresAt)) }
  const keys = parseApiKeys(`owner:${hashApiKey(KEY)}`)
  const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [KEYS_TAG], auth: { realm: 'sample', keys, storedKeys: storedKeysOf(db) }, guards: { store: recording } })
  const changes: unknown[] = []
  await registerKeys(app, { db, fixedKeys: [...keys.values()], keyPrefix: 'sk', onKeyChange: onKeyChange ?? ((change) => void changes.push(change)) })
  const as = (key: string) => (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } })
  return { app, db, kept, owner: as(KEY), as, changes }
}

/** POST /api/keys as the owner with an Idempotency-Key, as the kit's client sends every create. */
const makeKey = (app: Awaited<ReturnType<typeof setup>>['app'], name: string, idempotencyKey: string) =>
  app.request('/api/keys', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: JSON.stringify({ name }) })

const keyNamesOf = async (owner: Awaited<ReturnType<typeof setup>>['owner']) =>
  ((await (await owner('/api/keys')).json()) as { _embedded: { keys: { name: string }[] } })._embedded.keys.map((key) => key.name)

describe('keys', () => {
  it('makes a key that opens the API at once, shows it once, and revokes it', async () => {
    const { owner, as } = await setup()
    const made = await owner('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'billing-app' }) })
    expect(made.status).toBe(201)
    const key = (await made.json()) as { id: string; key: string; start: string }
    expect(key.key).toMatch(/^sk_/)
    expect(key.start).toBe(key.key.slice(0, 7))
    expect(key).not.toHaveProperty('hash')

    const billing = as(key.key)
    expect(await (await billing('/api/me')).json()).toMatchObject({ kind: 'key', name: 'billing-app', keyId: key.id, canManageKeys: false })
    const listed = (await (await owner('/api/keys')).json()) as { fixedKeys: string[]; _embedded: { keys: { lastUsedAt: string | null }[] } }
    expect(listed.fixedKeys).toEqual(['owner'])
    expect(listed._embedded.keys[0]!.lastUsedAt).not.toBeNull()
    expect(JSON.stringify(listed)).not.toContain(key.key)

    // A key made here makes no keys, and revokes none
    expect((await billing('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'spare' }) })).status).toBe(403)
    expect((await billing(`/api/keys/${key.id}`, { method: 'DELETE' })).status).toBe(403)

    expect((await owner(`/api/keys/${key.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await billing('/api/me')).status).toBe(401)
    expect((await owner(`/api/keys/${key.id}`)).status).toBe(404)
  })

  it('tells the app about every key made or deleted, by id and name, never its value', async () => {
    const { owner, changes } = await setup()
    const made = (await (await owner('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'ci' }) })).json()) as { id: string; key: string }
    await owner(`/api/keys/${made.id}`, { method: 'DELETE' })
    expect(changes).toEqual([
      { id: made.id, name: 'ci', action: 'created', by: 'owner' },
      { id: made.id, name: 'ci', action: 'deleted', by: 'owner' },
    ])
    expect(JSON.stringify(changes)).not.toContain(made.key)
  })

  it('makes and revokes the key even when the app\'s hook throws, and logs the throw', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { owner, as } = await setup({ onKeyChange: () => { throw new Error('the log is down') } })
      const made = await owner('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'ci' }) })
      expect(made.status).toBe(201)
      const key = (await made.json()) as { id: string; key: string }
      expect((await as(key.key)('/api/me')).status).toBe(200)
      expect((await owner(`/api/keys/${key.id}`, { method: 'DELETE' })).status).toBe(204)
      expect(logged.mock.calls.map(([line]) => line)).toEqual(['onKeyChange failed: the log is down', 'onKeyChange failed: the log is down'])
    } finally {
      logged.mockRestore()
    }
  })

  it('refuses a name already taken, by a made key or the deployment', async () => {
    const { owner } = await setup()
    const make = (name: string) => owner('/api/keys', { method: 'POST', body: JSON.stringify({ name }) })
    await make('laptop')
    expect((await make('laptop')).status).toBe(409)
    expect((await make('owner')).status).toBe(409)
    expect((await make('Not A Name')).status).toBe(400)
  })

  it('lets only a deployment key or a signed-in person manage keys', () => {
    const caller = (value: unknown) => value as never
    expect(holderOf(caller({ kind: 'key', name: 'owner' }), ['owner'])).toBe('owner')
    expect(holderOf(caller({ kind: 'person', email: 'me@example.com' }), [])).toBe('me@example.com')
    expect(() => holderOf(caller({ kind: 'key', name: 'app' }), ['owner'])).toThrow('Keys made through the API')
    expect(() => holderOf(caller({ kind: 'agent', name: 'a', scopes: ['write'], owner: 'me' }), [])).toThrow('OAuth tokens cannot')
  })

  it('documents every route to the standard, and every tool runs', async () => {
    const { app, owner } = await setup()
    const doc = await (await owner('/openapi.json')).json()
    expect(lintOpenApi(doc)).toEqual([])
    expect(toolRoutes(keyTools(), doc)).toEqual([])
    const made = (await (await owner('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'to-revoke' }) })).json()) as { id: string }
    const samples = { who_am_i: {}, list_keys: {}, get_key: { id: made.id }, create_key: { name: 'by-a-tool' }, delete_key: { id: made.id } }
    expect(await toolsRun(keyTools(), app, samples, { headers: { authorization: `Bearer ${KEY}` } })).toEqual([])
  })
})

describe('a made key and Idempotency-Key', () => {
  it.each(['memory', 'database'] as const)('never keeps the key to replay (%s guards): the same Idempotency-Key answers 409 shown_once', async (guards) => {
    const { app, db, kept, owner } = await setup({ guards })
    const made = await makeKey(app, 'ci', 'k1')
    expect(made.status).toBe(201)
    const { id, key } = (await made.json()) as { id: string; key: string }

    const replayed = await makeKey(app, 'ci', 'k1')
    expect(replayed.status).toBe(409)
    expect(replayed.headers.get('idempotent-replayed')).toBe('true')
    const text = await replayed.text()
    expect(text).not.toContain(key)
    expect(JSON.parse(text)).toMatchObject({ code: 'shown_once', detail: expect.stringContaining(`/api/keys/${id}`) })
    expect(JSON.parse(text).detail).toMatch(/never shown again/)

    // What the guard kept says the key was made, and holds nothing of it
    expect(kept).toEqual([{ bodyHash: expect.any(String), shownOnce: expect.stringContaining(`/api/keys/${id}`) }])
    expect(JSON.stringify(kept)).not.toContain(key)
    if (guards === 'database') {
      const rows = await db.select().from(kitGuards).where(eq(kitGuards.kind, 'key'))
      expect(rows.map((row) => JSON.parse(row.value))).toEqual(kept)
    }

    // A different Idempotency-Key makes a second key, as before
    const second = await makeKey(app, 'ci-2', 'k2')
    expect(second.status).toBe(201)
    expect(((await second.json()) as { key: string }).key).not.toBe(key)
    expect(await keyNamesOf(owner)).toEqual(['ci', 'ci-2'])
  })

  it('never keeps a key made by a tool over /mcp, whose answer the guard cannot see', async () => {
    const { app, kept, owner } = await setup()
    mountMcp(app, { factory: mcpServerFactory({ info: { name: 'sample', version: '1.0.0' }, instructions: 'Keys.', tools: keyTools(), callApi: inProcess(app) }), allowedHostnames: ['localhost'] })
    const call = () =>
      app.request('/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': 'k1', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'create_key' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_key', arguments: { name: 'agent' }, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }),
      })
    const first = await (await call()).text()
    const key = /sk_[\w-]+/.exec(first)?.[0]
    expect(key).toBeDefined()
    const again = await call()
    expect(again.headers.get('idempotent-replayed')).toBeNull()
    expect(await again.text()).not.toContain(key)
    expect(kept).toEqual([])
    expect(await keyNamesOf(owner)).toEqual(['agent'])
  })

  it("the kit's client: a lost answer retried with the same key is a shown_once error, never the key twice", async () => {
    const { app, owner } = await setup()
    let loseNext = true
    const { request } = createRequest({
      baseUrl: 'http://localhost',
      apiKey: KEY,
      // The first create reaches the app, and its answer is lost on the way back
      fetch: async (input, init) => {
        const answer = await app.request(String(input), init)
        if (loseNext && init?.method === 'POST') {
          loseNext = false
          throw new TypeError('the connection was reset')
        }
        return answer
      },
    })
    await expect(request('/api/keys', { method: 'POST', body: { name: 'laptop' } })).rejects.toMatchObject({ status: 409, code: 'shown_once', detail: expect.stringContaining('laptop') })
    expect(await keyNamesOf(owner)).toEqual(['laptop'])

    // Creates that arrive keep working: a fresh Idempotency-Key each time
    const phone = await request<{ key: string }>('/api/keys', { method: 'POST', body: { name: 'phone' } })
    const tablet = await request<{ key: string }>('/api/keys', { method: 'POST', body: { name: 'tablet' } })
    expect([phone.key, tablet.key].every((key) => key.startsWith('sk_'))).toBe(true)
    expect(await keyNamesOf(owner)).toEqual(['laptop', 'phone', 'tablet'])
  })

  it("the kit's command line makes keys as before", async () => {
    const { app, owner } = await setup()
    const tools = keyTools()
    mountMcp(app, { factory: mcpServerFactory({ info: { name: 'sample', version: '1.0.0' }, instructions: 'Keys.', tools, callApi: inProcess(app) }), allowedHostnames: ['localhost'] })
    const configDir = await mkdtemp(join(tmpdir(), 'keys-cli-'))
    const run = async (argv: string[]) => {
      let out = ''
      const cli = createCli({
        name: 'sample',
        envPrefix: 'SAMPLE',
        version: '1.0.0',
        snapshot: cliSnapshot({ app: 'sample', version: '1.0.0', tools }),
        fetch: async (input, init) => app.request(String(input), init),
        io: { stdout: { write: (text: string) => ((out += text), true) }, stderr: { write: () => true }, stdin: Readable.from(['']) as never, env: { SAMPLE_URL: 'http://localhost', SAMPLE_API_KEY: KEY }, configDir },
      })
      return { code: await cli.run(argv), out }
    }
    for (const name of ['ci', 'deploy']) {
      const made = await run(['key', 'create', '--name', name])
      expect(made.code).toBe(0)
      expect(made.out).toMatch(/The key, shown only now: sk_/)
    }
    expect(await keyNamesOf(owner)).toEqual(['ci', 'deploy'])
  })
})
