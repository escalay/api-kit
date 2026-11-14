import { env, exports } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import { describe, expect, it } from 'vitest'
import { migrate, openDb, type Db } from '../../src/index.js'
import { softAuthenticator } from '../../src/testing/index.js'
import { probeTelemetry } from './probe-telemetry.js'

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

describe('passkeys in workerd', () => {
  it('claims the probe, registers a passkey and signs in with it', async () => {
    let cookie = ''
    const call = async (path: string, body?: unknown) => {
      const answer = await exports.default.fetch(`https://kit.test${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const set = answer.headers.get('set-cookie')
      if (set) cookie = set.split(';')[0]!
      return answer.json() as Promise<any>
    }
    const device = await softAuthenticator()
    const { enrolment } = await call('/api/setup/claim', { code: 'PROBE-CODE', email: 'owner@example.com' })
    const created = await call('/api/session/passkeys/register/options', { enrolment })
    expect(await call('/api/session/passkeys/register/verify', { challengeId: created.challengeId, enrolment, response: await device.register(created.options, 'https://kit.test') })).toMatchObject({ signedIn: true })
    expect(cookie).toMatch(/^__Host-session=/)
    cookie = ''
    const login = await call('/api/session/passkeys/login/options', {})
    expect(await call('/api/session/passkeys/login/verify', { challengeId: login.challengeId, response: await device.login(login.options, 'https://kit.test') })).toMatchObject({ signedIn: true, person: { role: 'owner' } })
    expect(await call('/api/session')).toMatchObject({ signedIn: true, person: { email: 'owner@example.com' } })
  })
})

describe('the usage report in workerd', () => {
  it('makes its instance on the first run, shows its body, and sends it with a timeout', async () => {
    const shown = (await (await exports.default.fetch('https://kit.test/api/telemetry')).json()) as { on: boolean; body: { instance: string } }
    expect(shown).toMatchObject({ on: true, body: { schema: 1, version: '1.0.0', report: { notes: '1-10', signed_in: false } } })
    expect(shown.body.instance).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    // A day older, the next scheduled run sends exactly that
    await env.DB.prepare('update telemetry set since = ?').bind(new Date(Date.now() - 2 * 86_400_000).toISOString()).run()
    const sent: { body: unknown; signal: unknown }[] = []
    const usage = probeTelemetry(async (_url, init) => {
      sent.push({ body: JSON.parse(String(init?.body)), signal: init?.signal })
      return Response.json({ latest: '1.0.1' })
    })
    expect(await usage.sendDaily(await openDb(drizzle(env.DB) as unknown as Db), env)).toEqual({ sent: true, why: 'Sent.' })
    expect(sent).toEqual([{ body: shown.body, signal: expect.any(AbortSignal) }])
    expect(await (await exports.default.fetch('https://kit.test/api/telemetry')).json()).toMatchObject({ latest: '1.0.1' })
  })
})

describe('feature switches in workerd', () => {
  it('reads a switch stored in D1 and answers 403 while the feature is off', async () => {
    expect(await (await exports.default.fetch('https://kit.test/probe-beta')).json()).toEqual({ beta: true })
    await env.DB.prepare('insert into feature_switches (key, scope, "on", changed_by, changed_at) values (?, ?, ?, ?, ?)').bind('beta', 'everyone', 0, 'test', new Date().toISOString()).run()
    const refused = await exports.default.fetch('https://kit.test/probe-beta')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: 'feature_disabled', detail: 'This feature is disabled.', feature: 'beta' })
    expect(await (await exports.default.fetch('https://kit.test/api/features')).json()).toMatchObject({ providers: ['database'], _embedded: { features: [{ key: 'beta', on: false, source: 'database' }] } })
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
