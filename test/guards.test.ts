import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { addressOf, createAgentApi, dbGuardStore, memoryGuardStore, parseApiKeys, rateLimit, testDb, type AddressTrust, type GuardStore } from '../src/index.js'
import { guardStoreContract } from './guard-store-contract.js'
import { describe, expect, it } from 'vitest'
import * as dbModule from '../src/db/index.js'

guardStoreContract('memory', async () => memoryGuardStore())
guardStoreContract('database (node:sqlite)', async () => dbGuardStore(await testDb()))

describe('the db module entry', () => {
  // An app's generated kit index re-exports only db/index.ts
  it('exports the guard store', () => expect(typeof dbModule.dbGuardStore).toBe('function'))
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
      'paid ip:fe80:0:0:0::/64',
      'paid ip:0:0:0:0::/64',
      'paid ip:203.0.113.4',
      'paid ip:203.0.113.4',
    ])
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
