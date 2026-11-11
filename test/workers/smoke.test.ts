import { env, exports } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vitest'
import { migrate, openDb, type Db } from '../../src/index.js'

// worker.ts imports the whole kit at global scope, so a top-level Node-only import or a random value made at global
// scope stops the Worker from starting and every request here fails
describe('the kit in workerd', () => {
  it('starts, migrates D1 and serves the standard routes', async () => {
    const probe = await exports.default.fetch('https://kit.test/probe')
    expect(probe.status).toBe(200)
    expect(await probe.json()).toEqual({ rows: [{ n: 2 }] })
    const etag = probe.headers.get('etag')
    expect(etag).toMatch(/^W\//)
    expect((await exports.default.fetch('https://kit.test/probe', { headers: { 'if-none-match': etag! } })).status).toBe(304)
    const llms = await exports.default.fetch('https://kit.test/llms.txt')
    expect(llms.status).toBe(200)
    expect(await llms.text()).toContain('Served from https://kit.test.')
    for (const path of ['/api/health', '/openapi.json', '/docs', '/robots.txt', '/.well-known/api-catalog', '/agents/notes.md', '/llms-full.txt'])
      expect((await exports.default.fetch(`https://kit.test${path}`)).status, path).toBe(200)
  })

  it('replays an Idempotency-Key and limits calls, with the guards in D1', async () => {
    const post = (body: string, key?: string) => exports.default.fetch('https://kit.test/probe/notes', { method: 'POST', body, headers: key ? { 'idempotency-key': key } : {} })
    const first = await post('a', 'k1')
    expect(first.status).toBe(201)
    const count = (await first.json() as { count: number }).count
    const again = await post('a', 'k1')
    expect(again.headers.get('idempotent-replayed')).toBe('true')
    expect(await again.json()).toEqual({ count })
    expect((await post('b', 'k1')).status).toBe(422)
    await post('c')
    await post('d')
    const refused = await post('e')
    expect(refused.status).toBe(429)
    expect(refused.headers.get('ratelimit-policy')).toBe('"probe";q=3;w=60')
  })

  it('applies each migration step once, atomically, on D1', async () => {
    const db = await openDb(drizzle(env.DB) as unknown as Db)
    const steps = ['create table once (id integer primary key)', 'insert into once (id) values (1); insert into once (id) values (2)']
    await migrate(db, 'once', steps)
    await migrate(db, 'once', steps)
    const { results } = await env.DB.prepare('select count(*) as n from once').all<{ n: number }>()
    expect(results[0]?.n).toBe(2)
    // A failing step leaves nothing behind: neither its statements nor its record
    await expect(migrate(db, 'broken', ['create table half (id integer); insert into missing values (1)'])).rejects.toThrow()
    expect((await env.DB.prepare("select count(*) as n from sqlite_master where name = 'half'").all<{ n: number }>()).results[0]?.n).toBe(0)
  })
})

describe('testDb in workerd', () => {
  it('is the D1 binding, through Drizzle', async () => {
    const { testDb } = await import('../../src/index.js')
    const db = await testDb()
    await migrate(db, 'testdb', ['create table testdb_rows (id text primary key)', "insert into testdb_rows (id) values ('a')"])
    const { results } = await env.DB.prepare('select id from testdb_rows').all<{ id: string }>()
    expect(results).toEqual([{ id: 'a' }])
  })
})
