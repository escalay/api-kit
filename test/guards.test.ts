import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { addressOf, createAgentApi, dbGuardStore, idempotency, memoryGuardStore, parseApiKeys, rateLimit, testDb, type AddressTrust, type GuardStore } from '../src/index.js'
import { countedDbStore, guardStoreContract } from './guard-store-contract.js'
import { describe, expect, it } from 'vitest'
import * as dbModule from '../src/db/index.js'

guardStoreContract('memory', async () => memoryGuardStore())
guardStoreContract('database (node:sqlite)', async () => dbGuardStore(await testDb()), async () => countedDbStore(await testDb()))

describe('memoryGuardStore past maxEntries', () => {
  const answer = { bodyHash: 'h', status: 201, headers: [] as [string, string][], body: btoa('{}') }

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
