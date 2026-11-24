import { serve } from '@hono/node-server'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { z } from '@hono/zod-openapi'
import { mountA2A } from '../src/a2a/index.js'
import { addressOf, createAgentApi, dbGuardStore, hashApiKey, idempotency, memoryGuardStore, parseApiKeys, rateLimit, showOnce, testDb, type AddressTrust, type GuardStore } from '../src/index.js'
import { inProcess, mcpServerFactory, mcpTool, mountMcp } from '../src/mcp/index.js'
import { countedDbStore, guardStoreContract, guardTableUpgrade } from './guard-store-contract.js'
import { describe, expect, it } from 'vitest'
import * as dbModule from '../src/db/index.js'

guardStoreContract('memory', async () => memoryGuardStore())
guardStoreContract('database (node:sqlite)', async () => dbGuardStore(await testDb()), async () => countedDbStore(await testDb()))
guardTableUpgrade('node:sqlite', testDb)

describe('memoryGuardStore past maxEntries', () => {
  const answer = { version: 2 as const, bodyHash: 'h', status: 201, headers: [] as [string, string][], body: btoa('{}') }

  it('never lets go of a running lock, however many answers come after it', async () => {
    const store = memoryGuardStore({ maxEntries: 2 })
    expect(await store.claim('running', 60_000, 1_000)).toBeNull()
    for (let n = 0; n < 5; n++) {
      expect(await store.claim(`done-${n}`, 60_000, 1_000)).toBeNull()
      await store.save(`done-${n}`, answer, 100_000)
    }
    expect(await store.claim('running', 60_000, 2_000)).toBe('running')
    // The oldest answers went instead
    expect(await store.claim('done-4', 60_000, 2_000)).toEqual(answer)
    expect(await store.claim('done-0', 60_000, 2_000)).toBeNull()
  })

  it('passes over running locks when it caps, however many there are', async () => {
    const store = memoryGuardStore({ maxEntries: 100 })
    const started = performance.now()
    // Each claim scanning every lock before it would take seconds here
    for (let n = 0; n < 50_000; n++) expect(await store.claim(`running-${n}`, 60_000, 1_000)).toBeNull()
    expect(performance.now() - started).toBeLessThan(1_000)
    expect(await store.claim('running-0', 60_000, 2_000)).toBe('running')
    expect(await store.claim('running-49999', 60_000, 2_000)).toBe('running')
  })

  it('keeps at most maxEntries rate windows, letting go of the one counted longest ago', async () => {
    const store = memoryGuardStore({ maxEntries: 3 })
    for (const id of ['a', 'b', 'c', 'd']) await store.count(id, 3_600_000, 1_000)
    expect(await store.count('d', 3_600_000, 2_000)).toMatchObject({ used: 2 })
    expect(await store.count('a', 3_600_000, 2_000)).toMatchObject({ used: 1 })
  })
})

describe('the db module entry', () => {
  // An app's generated kit index re-exports only db/index.ts
  it('exports the guard store', () => expect(typeof dbModule.dbGuardStore).toBe('function'))
})

describe('idempotency', () => {
  /** A route that answers whatever status the test sets, counting the times it really ran. */
  const answering = (options: Parameters<typeof idempotency>[0] = {}) => {
    const state = { status: 201, runs: 0 }
    const app = new Hono()
    app.use('*', idempotency(options))
    for (const path of ['/api/v1/notes', '/oauth/token', '/agent/identity', '/join/abc']) app.post(path, (c) => c.json({ run: ++state.runs }, state.status as 201))
    const post = (path = '/api/v1/notes') => app.request(path, { method: 'POST', headers: { 'idempotency-key': 'k1', 'content-type': 'application/json' }, body: '{}' })
    return { state, post }
  }

  it('keeps a success and replays it', async () => {
    const { post } = answering()
    expect(await (await post()).json()).toEqual({ run: 1 })
    const again = await post()
    expect(again.headers.get('idempotent-replayed')).toBe('true')
    expect(await again.json()).toEqual({ run: 1 })
  })

  it("doesn't keep a handler's 403, so a retry after the cause is fixed runs again", async () => {
    const { state, post } = answering()
    state.status = 403
    expect((await post()).status).toBe(403)
    state.status = 201
    const retried = await post()
    expect(retried.status).toBe(201)
    expect(retried.headers.get('idempotent-replayed')).toBeNull()
    expect(await retried.json()).toEqual({ run: 2 })
  })

  it("doesn't keep a 429 from a limiter behind it, or a 401 or 408", async () => {
    for (const status of [429, 401, 408]) {
      const { state, post } = answering()
      state.status = status
      expect((await post()).status).toBe(status)
      state.status = 201
      expect(await (await post()).json(), String(status)).toEqual({ run: 2 })
    }
  })

  it("doesn't keep a 404, 409, 422 or any other refusal either", async () => {
    for (const status of [400, 404, 409, 410, 422]) {
      const { state, post } = answering()
      state.status = status
      expect((await post()).status).toBe(status)
      state.status = 201
      expect(await (await post()).json(), String(status)).toEqual({ run: 2 })
    }
  })

  it('keeps what `keep` says, and still never a server error unless asked', async () => {
    const { state, post } = answering({ keep: (status) => status < 500 })
    state.status = 404
    await post()
    state.status = 201
    const replayed = await post()
    expect(replayed.status).toBe(404)
    expect(replayed.headers.get('idempotent-replayed')).toBe('true')
    const failing = answering({ keep: (status) => status < 500 })
    failing.state.status = 503
    await failing.post()
    failing.state.status = 201
    expect(await (await failing.post()).json()).toEqual({ run: 2 })
  })

  it('keeps a server error when `keep` passes one: the kit adds no guard of its own', async () => {
    const { state, post } = answering({ keep: () => true })
    state.status = 503
    await post()
    state.status = 201
    const replayed = await post()
    expect(replayed.status).toBe(503)
    expect(replayed.headers.get('idempotent-replayed')).toBe('true')
  })

  it('never keeps an answer from the OAuth endpoints, whatever `skip` adds', async () => {
    for (const options of [{}, { skip: ['/join/*'] }]) {
      const { state, post } = answering(options)
      state.status = 200
      for (const path of ['/oauth/token', '/agent/identity']) {
        await post(path)
        const again = await post(path)
        expect(again.headers.get('idempotent-replayed'), path).toBeNull()
      }
      expect(state.runs).toBe(4)
    }
  })

  it('skips the paths an app adds to `skip`', async () => {
    const { state, post } = answering({ skip: ['/join/*'] })
    await post('/join/abc')
    expect((await post('/join/abc')).headers.get('idempotent-replayed')).toBeNull()
    expect(state.runs).toBe(2)
    await post()
    expect((await post()).headers.get('idempotent-replayed')).toBe('true')
  })

  describe('an answer shown once', () => {
    const REPLAY = 'Made the key ci (GET /api/keys/key_1) with this Idempotency-Key; the key was shown once and is never shown again.'
    /** A route that answers a new secret each run and marks it shown once, beside one that doesn't. */
    const secrets = () => {
      const state = { runs: 0, kept: [] as unknown[] }
      const store = memoryGuardStore()
      const app = new Hono()
      app.use('*', idempotency({ store: { ...store, save: (id, answer, expiresAt) => (state.kept.push(answer), store.save(id, answer, expiresAt)) } }))
      app.post('/api/keys', (c) => {
        showOnce(c, REPLAY)
        return c.json({ key: `sk_secret_${++state.runs}` }, 201, { location: '/api/keys/key_1', 'set-cookie': `session=token_${state.runs}` })
      })
      const post = (key: string, body = '{"name":"ci"}') => app.request('/api/keys', { method: 'POST', headers: { 'idempotency-key': key, 'content-type': 'application/json' }, body })
      return { state, post }
    }

    it('answers a replay with a 409 shown_once that says what was made, never the secret', async () => {
      const { state, post } = secrets()
      const first = await post('k1')
      expect(await first.json()).toEqual({ key: 'sk_secret_1' })
      expect(first.headers.get('location')).toBe('/api/keys/key_1')
      const replayed = await post('k1')
      expect(replayed.status).toBe(409)
      expect(replayed.headers.get('idempotent-replayed')).toBe('true')
      expect(replayed.headers.get('set-cookie')).toBeNull()
      expect(await replayed.json()).toMatchObject({ code: 'shown_once', status: 409, detail: REPLAY })
      expect(state.runs).toBe(1)
    })

    it('keeps only what a replay is told: no body, no headers', async () => {
      const { state, post } = secrets()
      await post('k1')
      expect(state.kept).toEqual([{ version: 2, bodyHash: expect.any(String), shownOnce: REPLAY }])
      expect(JSON.stringify(state.kept)).not.toContain('secret')
      expect(JSON.stringify(state.kept)).not.toContain('token')
    })

    it('refuses a blank replay, so a marked answer is never kept whole', async () => {
      const app = new Hono()
      const store = memoryGuardStore()
      const kept: unknown[] = []
      app.use('*', idempotency({ store: { ...store, save: (id, answer, expiresAt) => (kept.push(answer), store.save(id, answer, expiresAt)) } }))
      for (const blank of ['', '  ']) app.post(`/blank/${blank.length}`, (c) => (showOnce(c, blank), c.json({ key: 'sk_secret' }, 201)))
      for (const path of ['/blank/0', '/blank/2']) {
        const answer = await app.request(path, { method: 'POST', headers: { 'idempotency-key': `k${path}` }, body: '{}' })
        expect(answer.status, path).toBe(500)
      }
      expect(() => showOnce({ set: () => {} } as never, '')).toThrow('showOnce needs the words a retry is told')
      expect(kept).toEqual([])
    })

    it('still answers another body under the same key with a 422, and a new key runs again', async () => {
      const { state, post } = secrets()
      await post('k1')
      expect((await post('k1', '{"name":"other"}')).status).toBe(422)
      const second = await post('k2')
      expect(second.status).toBe(201)
      expect(await second.json()).toEqual({ key: 'sk_secret_2' })
      expect(state.runs).toBe(2)
    })
  })

  it.each(['memory', 'database'] as const)('never replays an answer kept whole by 1.30.0, unversioned (%s store): the request runs again', async (kind) => {
    const store = kind === 'memory' ? memoryGuardStore() : await dbGuardStore(await testDb())
    // What a 1.30.0 instance writes, even after the migration ran (a rolling deploy): the whole answer, no version
    const id = 'ip:local POST /api/keys k1'
    const now = Date.now()
    expect(await store.claim(id, 60_000, now)).toBeNull()
    const old = { bodyHash: createHash('sha256').update('{}').digest('hex'), status: 201, headers: [['content-type', 'application/json']], body: btoa('{"key":"sk_from_1_30"}') }
    await store.save(id, old as never, now + 86_400_000)
    const app = new Hono()
    let runs = 0
    app.use('*', idempotency({ store }))
    app.post('/api/keys', (c) => (showOnce(c, 'Made a key; it is never shown again.'), c.json({ key: `sk_new_${++runs}` }, 201)))
    const post = () => app.request('/api/keys', { method: 'POST', headers: { 'idempotency-key': 'k1' }, body: '{}' })
    const first = await post()
    expect([first.status, await first.text()]).toEqual([201, '{"key":"sk_new_1"}'])
    const again = await post()
    expect([again.status, (await again.json()).code]).toEqual([409, 'shown_once'])
    expect(runs).toBe(1)
  })

  describe('a relay', () => {
    const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
    /** MCP and A2A over one tool that POSTs to `route`, each called with an Idempotency-Key. */
    const relays = (app: Hono<any, any, any>, route: string) => {
      const tool = mcpTool({ name: 'add_note', title: 'Add a note', description: 'Adds a note.', input: z.object({ text: z.string().describe('The note.') }), call: (body) => ({ method: 'POST', path: route, body }), summarize: (json) => JSON.stringify(json) })
      mountMcp(app, { factory: mcpServerFactory({ info: { name: 'sample', version: '1.0.0' }, instructions: 'Notes.', tools: [tool], callApi: inProcess(app) }), allowedHostnames: ['localhost'] })
      mountA2A(app, { info: { name: 'Sample', description: 'Notes.', version: '1.0.0' }, skills: [{ tool, text: 'text', tags: ['notes'] }], callApi: inProcess(app), waitMs: 0 })
      const headers = (key: string) => ({ authorization: `Bearer ${KEY}`, 'idempotency-key': key, 'content-type': 'application/json' })
      return {
        mcp: async (key: string) =>
          (await app.request('/mcp', { method: 'POST', headers: { ...headers(key), accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'add_note' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add_note', arguments: { text: 'hi' }, _meta: META } }) })).text(),
        a2a: async (key: string) =>
          (await app.request('/a2a', { method: 'POST', headers: { ...headers(key), 'a2a-version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] } } }) })).text(),
      }
    }
    const KEY = 'relay-key'

    it('runs a retried tool call once: its route gets the same Idempotency-Key', async () => {
      for (const kind of ['mcp', 'a2a'] as const) {
        const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(`tester:${hashApiKey(KEY)}`) } })
        let runs = 0
        app.post('/api/notes', (c) => c.json({ note: ++runs }, 201))
        const call = relays(app, '/api/notes')[kind]
        const first = await call('k1')
        expect(first, kind).toContain('{\\"note\\":1}')
        expect(await call('k1'), kind).toContain('{\\"note\\":1}')
        expect(runs, kind).toBe(1)
        await call('k2')
        expect(runs, kind).toBe(2)
      }
    })

    it('gets a slow route\'s result once its run is done, not the 202 kept under the same key', async () => {
      for (const kind of ['mcp', 'a2a'] as const) {
        const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(`tester:${hashApiKey(KEY)}`) } })
        let started = 0
        // The first call starts a run; once it is done (and names no result), calling the route again answers it
        app.post('/api/reports', (c) => (started++ ? c.json({ report: 'ready' }, 200) : c.json({ status: 'running' }, 202, { location: '/api/runs/r1' })))
        app.get('/api/runs/r1', (c) => c.json({ status: 'done' }))
        const answer = await relays(app, '/api/reports')[kind]('k1')
        expect(answer, kind).toContain('ready')
        expect(started, kind).toBe(2)
      }
    })

    it('runs each call of a keyed JSON-RPC batch once: every call gets a key of its own', async () => {
      const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(`tester:${hashApiKey(KEY)}`) } })
      let runs = 0
      app.post('/api/notes', (c) => c.json({ note: ++runs }, 201))
      relays(app, '/api/notes')
      const call = (id: number, text: string) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'add_note', arguments: { text } } })
      // Protocol 2025-03-26 still takes a batch: two calls in one request, under one Idempotency-Key
      const batch = async () =>
        (await app.request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'idempotency-key': 'batch-1', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' }, body: JSON.stringify([call(1, 'e'), call(2, 'f')]) })).text()
      const first = await batch()
      expect(first).not.toMatch(/isError|still running|different body/)
      expect(runs).toBe(2)
      // The same batch again: each call is answered as it was, and nothing runs twice
      const again = await batch()
      expect(again).not.toMatch(/isError/)
      expect(again).toContain('{\\"note\\":2}')
      expect(runs).toBe(2)
    })

    it('marks an answer shown once that a route built itself, so A2A keeps its task without it', async () => {
      const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(`tester:${hashApiKey(KEY)}`) } })
      app.post('/api/secrets', (c) => {
        showOnce(c, 'Made a secret; it is never shown again.')
        return new Response(JSON.stringify({ secret: 'sk_built_by_hand' }), { status: 201, headers: { 'content-type': 'application/json' } })
      })
      relays(app, '/api/secrets')
      const direct = await app.request('/api/secrets', { method: 'POST', headers: { authorization: `Bearer ${KEY}` } })
      expect(direct.headers.get('shown-once')).toBe('true')
      const rpc = async (method: string, params: unknown) =>
        (await app.request('/a2a', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'a2a-version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as Promise<any>
      const sent = await rpc('SendMessage', { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'hi' }] } })
      expect(JSON.stringify(sent)).toContain('sk_built_by_hand')
      expect(JSON.stringify(await rpc('GetTask', { id: sent.result.task.id }))).not.toContain('sk_built_by_hand')
    })

    it('keeps no secret when idempotency is wired by hand: the relay marks its own answer', async () => {
      const app = new Hono()
      const store = memoryGuardStore()
      const kept: unknown[] = []
      app.use('*', idempotency({ store: { ...store, save: (id, answer, expiresAt) => (kept.push(answer), store.save(id, answer, expiresAt)) } }))
      app.use('*', async (c, next) => (c.set('caller' as never, { kind: 'key', name: 'tester' } as never), next()))
      let made = 0
      app.post('/api/secrets', (c) => (showOnce(c, `Made secret ${++made}; it is never shown again.`), c.json({ secret: `sk_secret_${made}` }, 201)))
      const { mcp, a2a } = relays(app, '/api/secrets')
      for (const [kind, call] of [['mcp', mcp], ['a2a', a2a]] as const) {
        const key = `k-${kind}`
        expect(await call(key), kind).toContain('sk_secret_')
        const again = await call(key)
        expect(again, kind).not.toContain('sk_secret_')
        expect(again, kind).toContain('it is never shown again')
      }
      expect(made).toBe(2)
      expect(kept).toEqual([0, 1].map(() => ({ version: 2, bodyHash: expect.any(String), shownOnce: expect.any(String) })))
    })
  })
})

/** A memory store that also keeps every bucket id it was asked to count. */
const recording = () => {
  const store = memoryGuardStore()
  const ids: string[] = []
  return { ids, store: { ...store, count: (id, windowMs, now) => (ids.push(id), store.count(id, windowMs, now)) } satisfies GuardStore }
}

const limited = (options: { address?: AddressTrust; key?: (c: Parameters<typeof addressOf>[0]) => string | null; limit?: number } = {}) => {
  const { ids, store } = recording()
  const app = new Hono()
  app.use('/paid/*', rateLimit({ policy: 'paid', limit: options.limit ?? 100, windowSeconds: 60, store, address: options.address, key: options.key }))
  app.get('/paid/:pack', (c) => c.json({ ok: true }))
  const call = (headers: Record<string, string> = {}, path = '/paid/loud', env?: unknown) => app.request(path, { headers }, env)
  return { ids, call }
}

describe("the caller's address", () => {
  it('the default reads as before', async () => {
    const { ids, call } = limited()
    await call({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' })
    await call({ 'x-forwarded-for': '198.51.100.1, 10.0.0.2' })
    await call({ 'x-forwarded-for': '2001:DB8:1:2::a' })
    await call()
    expect(ids).toEqual(['paid ip:203.0.113.7', 'paid ip:198.51.100.1, 10.0.0.2', 'paid ip:2001:DB8:1:2::a', 'paid ip:local'])
  })

  it('a forged x-forwarded-for does not make a new bucket when hops is set', async () => {
    const nearest = limited({ address: { header: 'x-forwarded-for' }, limit: 2 })
    expect((await nearest.call({ 'x-forwarded-for': 'forged-1, 203.0.113.9' })).status).toBe(200)
    expect((await nearest.call({ 'x-forwarded-for': 'forged-2,203.0.113.9 ' })).status).toBe(200)
    expect((await nearest.call({ 'x-forwarded-for': '203.0.113.9' })).status).toBe(429)
    expect(nearest.ids).toEqual(['paid ip:203.0.113.9', 'paid ip:203.0.113.9', 'paid ip:203.0.113.9'])

    // Two proxies that both append: the second from the right is the caller the first proxy saw
    const two = limited({ address: { header: 'x-forwarded-for', hops: 2 } })
    await two.call({ 'x-forwarded-for': 'forged, 198.51.100.4, 10.0.0.2' })
    await two.call({ 'x-forwarded-for': '198.51.100.4, 10.0.0.3' })
    // Fewer values than hops, or none: the request did not come the way the app said, so it is never read as sent
    await two.call({ 'x-forwarded-for': '198.51.100.5' })
    await two.call()
    expect(two.ids).toEqual(['paid ip:198.51.100.4', 'paid ip:198.51.100.4', 'paid ip:local', 'paid ip:local'])
  })

  it('cf-connecting-ip is read only when trusted', async () => {
    const proxied = limited({ address: { header: 'x-forwarded-for' } })
    await proxied.call({ 'cf-connecting-ip': '192.0.2.50', 'x-forwarded-for': '203.0.113.9' })
    await proxied.call({ 'cf-connecting-ip': '192.0.2.51' })
    expect(proxied.ids).toEqual(['paid ip:203.0.113.9', 'paid ip:local'])

    const cloudflare = limited({ address: { header: 'cf-connecting-ip' } })
    await cloudflare.call({ 'cf-connecting-ip': '192.0.2.50', 'x-forwarded-for': '203.0.113.9' })
    expect(cloudflare.ids).toEqual(['paid ip:192.0.2.50'])
  })

  it('socket is local where there is no connection, never a header', async () => {
    const { ids, call } = limited({ address: 'socket' })
    await call({ 'cf-connecting-ip': '192.0.2.50', 'x-forwarded-for': '203.0.113.9' })
    // @hono/node-server hands the connection over as the env (`server` under some dev servers)
    await call({ 'x-forwarded-for': '203.0.113.9' }, '/paid/loud', { incoming: { socket: { remoteAddress: '198.51.100.20' } } })
    await call({}, '/paid/loud', { server: { incoming: { socket: { remoteAddress: '198.51.100.21' } } } })
    // A dual-stack listener reports IPv4 callers mapped into IPv6: still one bucket per IPv4 address
    await call({}, '/paid/loud', { incoming: { socket: { remoteAddress: '::ffff:198.51.100.22' } } })
    expect(ids).toEqual(['paid ip:local', 'paid ip:198.51.100.20', 'paid ip:198.51.100.21', 'paid ip:198.51.100.22'])
  })

  it('socket reads the connection on a real Node server', async () => {
    const { ids, store } = recording()
    const app = new Hono()
    app.use('*', rateLimit({ policy: 'paid', limit: 100, windowSeconds: 60, store, address: 'socket' }))
    app.get('/', (c) => c.text('ok'))
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    await new Promise((resolve) => server.once('listening', resolve))
    try {
      const { port } = server.address() as AddressInfo
      expect((await fetch(`http://127.0.0.1:${port}/`, { headers: { 'x-forwarded-for': '203.0.113.9', 'cf-connecting-ip': '192.0.2.50' } })).status).toBe(200)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
    expect(ids).toEqual(['paid ip:127.0.0.1'])
  })

  it('two addresses in one /64 share a bucket', async () => {
    const { ids, call } = limited({ address: { header: 'x-real-ip' } })
    for (const address of ['2001:db8:1:2::a', '2001:DB8:1:2:ffff::b', '[2001:0db8:0001:0002:0:0:0:c]', '2001:db8:1:3::a', 'fe80::1%eth0', '::1', '::ffff:203.0.113.4', '203.0.113.4'])
      await call({ 'x-real-ip': address })
    expect(ids).toEqual([
      'paid ip:2001:db8:1:2::/64',
      'paid ip:2001:db8:1:2::/64',
      'paid ip:2001:db8:1:2::/64',
      'paid ip:2001:db8:1:3::/64',
      'paid ip:fe80::1',
      'paid ip:::1',
      'paid ip:203.0.113.4',
      'paid ip:203.0.113.4',
    ])
  })

  it('a port after the address is not part of it', async () => {
    const { ids, call } = limited({ address: { header: 'x-forwarded-for' }, limit: 2 })
    // A proxy that appends `ip:port`: a new connection is not a new caller
    expect((await call({ 'x-forwarded-for': '203.0.113.4:5678' })).status).toBe(200)
    expect((await call({ 'x-forwarded-for': '203.0.113.4:9999' })).status).toBe(200)
    expect((await call({ 'x-forwarded-for': '203.0.113.4' })).status).toBe(429)
    await call({ 'x-forwarded-for': '[2001:db8:1:2::a]:443' })
    await call({ 'x-forwarded-for': '[fe80::1%eth0]:8080' })
    expect(ids).toEqual(['paid ip:203.0.113.4', 'paid ip:203.0.113.4', 'paid ip:203.0.113.4', 'paid ip:2001:db8:1:2::/64', 'paid ip:fe80::1'])
  })

  it('only a global address folds to its /64; an IPv4 one in IPv6 counts as IPv4', async () => {
    const { ids, call } = limited({ address: { header: 'x-real-ip' } })
    const addresses = [
      // IPv4-mapped, written in hex: the IPv4 address, as when written dotted
      '::ffff:c000:0201',
      '::FFFF:0102:0304',
      // NAT64 (64:ff9b::/96) carries an IPv4 address in its last 32 bits: one bucket per IPv4 address
      '64:ff9b::192.0.2.1',
      '64:ff9b::c633:6407',
      // Not one site's /64: each address on its own
      '::2',
      '::3',
      'fe80::2',
      'fd00:1:2:3::4',
      'fd00:1:2:3::5',
    ]
    for (const address of addresses) await call({ 'x-real-ip': address })
    expect(ids).toEqual(['192.0.2.1', '1.2.3.4', '192.0.2.1', '198.51.100.7', '::2', '::3', 'fe80::2', 'fd00:1:2:3::4', 'fd00:1:2:3::5'].map((id) => `paid ip:${id}`))
  })

  it('a custom key splits buckets, and null skips counting', async () => {
    const packOf = (path: string) => path.split('/')[2]
    const perPack = limited({ key: (c) => (packOf(c.req.path) === 'open' ? null : `pack:${packOf(c.req.path)}`), limit: 1 })
    expect((await perPack.call({ 'cf-connecting-ip': '192.0.2.1' }, '/paid/loud')).status).toBe(200)
    // Another address, same pack: the same bucket
    expect((await perPack.call({ 'cf-connecting-ip': '192.0.2.2' }, '/paid/loud')).status).toBe(429)
    expect((await perPack.call({ 'cf-connecting-ip': '192.0.2.1' }, '/paid/desk')).status).toBe(200)
    for (let attempt = 0; attempt < 3; attempt++) {
      const open = await perPack.call({}, '/paid/open')
      expect([open.status, open.headers.get('ratelimit')]).toEqual([200, null])
    }
    expect(perPack.ids).toEqual(['paid pack:loud', 'paid pack:loud', 'paid pack:desk'])
  })

  it('createAgentApi({ address }) sets the source for every guard on the request, and a rateLimit of its own wins', async () => {
    const { ids, store } = recording()
    const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(undefined), open: ['/open/*'] }, address: { header: 'x-forwarded-for' }, guards: { store } })
    app.use('/open/paid', rateLimit({ policy: 'paid', limit: 100, windowSeconds: 60, store }))
    app.use('/open/socket', rateLimit({ policy: 'socket', limit: 100, windowSeconds: 60, store, address: 'socket' }))
    app.get('/open/:what', (c) => c.json({ address: addressOf(c) }))
    app.post('/open/:what', (c) => c.json({ ok: true }, 201))
    const headers = { 'cf-connecting-ip': '192.0.2.50', 'x-forwarded-for': 'forged, 203.0.113.9' }
    expect(await (await app.request('/open/paid', { headers })).json()).toEqual({ address: '203.0.113.9' })
    await app.request('/open/socket', { headers })
    expect(ids).toEqual(['paid ip:203.0.113.9', 'socket ip:local'])
    // Idempotency-Key answers are kept per caller: a forged value no longer makes another caller
    const first = await app.request('/open/things', { method: 'POST', headers: { ...headers, 'idempotency-key': 'k1' } })
    const again = await app.request('/open/things', { method: 'POST', headers: { 'x-forwarded-for': 'other, 203.0.113.9', 'idempotency-key': 'k1' } })
    expect([first.status, again.headers.get('idempotent-replayed')]).toEqual([201, 'true'])
  })
})
