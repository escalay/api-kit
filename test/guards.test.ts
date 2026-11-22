import { Hono } from 'hono'
import { dbGuardStore, idempotency, memoryGuardStore, testDb } from '../src/index.js'
import { countedDbStore, guardStoreContract } from './guard-store-contract.js'
import { describe, expect, it } from 'vitest'
import * as dbModule from '../src/db/index.js'

guardStoreContract('memory', async () => memoryGuardStore())
guardStoreContract('database (node:sqlite)', async () => dbGuardStore(await testDb()), async () => countedDbStore(await testDb()))

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
