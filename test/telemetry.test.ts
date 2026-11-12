import { afterEach, describe, expect, it, vi } from 'vitest'
import { coarseReport, countRange, createAgentApi, dayRange, hashApiKey, parseApiKeys, telemetry, TELEMETRY_TAG, telemetryTools, testDb, type Db, type TelemetryConfig } from '../src/index.js'
import { lintOpenApi, toolRoutes, toolsRun } from '../src/testing/index.js'

const OWNER_KEY = 'owner-key'
const MEMBER_KEY = 'member-key'
const DAY = 86_400_000
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Only Date moves, so the database and fetch keep working
const clock = () => {
  let at = Date.parse('2026-11-10T09:00:00Z')
  vi.useFakeTimers({ toFake: ['Date'], now: at })
  return (ms: number) => vi.setSystemTime((at += ms))
}

const setup = async (overrides: Partial<TelemetryConfig> = {}) => {
  const db = await testDb()
  const sent: { url: string; body: unknown; signal: unknown }[] = []
  const answer = { current: Response.json({ latest: '1.5.0' }) as Response | Error }
  const usage = telemetry({
    product: 'notes',
    schemaVersion: 2,
    version: '1.4.2',
    url: 'https://pulse.example.test/',
    collect: async () => ({ notes: countRange(42), oldest_note: dayRange(12), search_used: true }),
    fetch: async (url, init) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal })
      if (answer.current instanceof Error) throw answer.current
      return answer.current.clone()
    },
    ...overrides,
  })
  const keys = parseApiKeys(`owner:${hashApiKey(OWNER_KEY)},member:${hashApiKey(MEMBER_KEY)}`)
  const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [TELEMETRY_TAG], auth: { realm: 'sample', keys } })
  await usage.register(app, { db, isOwner: (c) => (c.get('caller' as never) as { name?: string } | undefined)?.name === 'owner', env: () => ({}) })
  const as = (key: string) => (init: RequestInit = {}) => app.request('/api/telemetry', { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } })
  return { app, db, usage, sent, answer, owner: as(OWNER_KEY), member: as(MEMBER_KEY) }
}

afterEach(() => vi.useRealTimers())

describe('telemetry', () => {
  it('shows exactly the body it sends, from the second day, once a day', async () => {
    const tick = clock()
    const { db, usage, sent, owner } = await setup()
    const shown = (await (await owner()).json()) as { on: boolean; endpoint: string; body: { instance: string } }
    expect(shown).toMatchObject({ on: true, endpoint: 'https://pulse.example.test/v1/notes', lastSentAt: null })
    expect(shown.body).toEqual({ schema: 2, instance: expect.stringMatching(UUID_V4), version: '1.4.2', report: { notes: '11-100', oldest_note: '8-30', search_used: true } })

    expect(await usage.sendDaily(db)).toEqual({ sent: false, why: 'Nothing is sent in the first 24 hours.' })
    tick(DAY)
    expect(await usage.sendDaily(db)).toEqual({ sent: true, why: 'Sent.' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.url).toBe('https://pulse.example.test/v1/notes')
    expect(sent[0]!.body).toEqual(shown.body)
    expect(sent[0]!.signal).toBeInstanceOf(AbortSignal)
    expect(await usage.sendDaily(db)).toEqual({ sent: false, why: 'Already sent today.' })
    tick(DAY)
    expect((await usage.sendDaily(db)).sent).toBe(true)
    expect(sent).toHaveLength(2)
    // The instance stays the same, and the newest version the collector named is kept
    expect((sent[1]!.body as { instance: string }).instance).toBe(shown.body.instance)
    expect(await (await owner()).json()).toMatchObject({ latest: '1.5.0', lastSentAt: new Date().toISOString() })
  })

  it('sends nothing when the environment or the owner says no', async () => {
    const tick = clock()
    const { db, usage, sent, owner, member } = await setup()
    tick(2 * DAY)
    expect(await usage.sendDaily(db, { DO_NOT_TRACK: '1' })).toEqual({ sent: false, why: 'DO_NOT_TRACK is set in the environment.' })
    expect(await usage.sendDaily(db, { TELEMETRY: 'off' })).toEqual({ sent: false, why: 'TELEMETRY=off is set in the environment.' })

    expect((await member({ method: 'PATCH', body: JSON.stringify({ enabled: false }) })).status).toBe(403)
    const off = await owner({ method: 'PATCH', body: JSON.stringify({ enabled: false }) })
    expect(await off.json()).toMatchObject({ on: false, enabled: false, why: 'The owner switched it off.' })
    expect((await usage.sendDaily(db)).why).toBe('The owner switched it off.')
    expect(sent).toEqual([])

    await owner({ method: 'PATCH', body: JSON.stringify({ enabled: true }) })
    expect(await usage.sendDaily(db)).toEqual({ sent: true, why: 'Sent.' })
  })

  it('shows the environment switch on the route', async () => {
    const db = await testDb()
    const usage = telemetry({ product: 'notes', schemaVersion: 1, version: '1.0.0', url: 'https://pulse.example.test', collect: () => ({}) })
    const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [TELEMETRY_TAG], auth: { realm: 'sample', keys: parseApiKeys(`owner:${hashApiKey(OWNER_KEY)}`) } })
    await usage.register(app, { db, isOwner: () => true, env: () => ({ DO_NOT_TRACK: '1' }) })
    expect(await (await app.request('/api/telemetry', { headers: { authorization: `Bearer ${OWNER_KEY}` } })).json()).toMatchObject({ on: false, enabled: true, why: 'DO_NOT_TRACK is set in the environment.' })
  })

  it('never throws into the app: a dead collector, a failing collect, a bad version', async () => {
    const tick = clock()
    const { db, usage, sent, answer } = await setup()
    tick(DAY)
    answer.current = new Error('connect ECONNREFUSED')
    expect(await usage.sendDaily(db)).toEqual({ sent: false, why: 'Not sent: connect ECONNREFUSED' })
    // Tried once today: a dead collector isn't hit again until tomorrow
    expect((await usage.sendDaily(db)).why).toBe('Already sent today.')
    tick(DAY)
    answer.current = new Response('nope', { status: 500 })
    expect(await usage.sendDaily(db)).toEqual({ sent: false, why: 'The collector answered 500.' })
    expect(sent).toHaveLength(2)

    const failing = telemetry({ product: 'notes', schemaVersion: 1, version: '1.0.0', url: 'https://pulse.example.test', collect: () => { throw new Error('no table') }, fetch: async () => Response.json({}) })
    tick(DAY)
    expect(await failing.sendDaily(db)).toEqual({ sent: false, why: 'Not sent: no table' })
    const unversioned = telemetry({ product: 'notes', schemaVersion: 1, version: 'dev', url: 'https://pulse.example.test', collect: () => ({}), fetch: async () => Response.json({}) })
    expect(await unversioned.sendDaily(db)).toEqual({ sent: false, why: 'The version "dev" is not like 1.2.3.' })
  })

  it('reports only coarse ranges and booleans, never ids, text or counts', () => {
    expect([0, 1, 10, 11, 100, 101, 1000, 1001, 10_000, 10_001].map(countRange)).toEqual(['0', '1-10', '1-10', '11-100', '11-100', '101-1k', '101-1k', '1k-10k', '1k-10k', '10k+'])
    expect([0, 0.5, 1, 7, 8, 30, 31, 90, 91, 365, 366].map(dayRange)).toEqual(['0', '0', '1-7', '1-7', '8-30', '8-30', '31-90', '31-90', '91-365', '91-365', '365+'])
    expect(coarseReport({ notes: '11-100', search_used: false, count: 42, owner: 'me@example.com', note_title: 'Soup', 'Bad-Key': true, schema: '0' })).toEqual({ notes: '11-100', search_used: false, schema: '0' })
  })

  it('keeps the collector’s keys its own: collect can’t add or replace top-level fields', async () => {
    const db: Db = await testDb()
    const usage = telemetry({ product: 'notes', schemaVersion: 1, version: '1.0.0-beta.2', url: 'https://pulse.example.test', collect: () => ({ instance: true, version: '0', product: '1-10' }) as never })
    const body = await usage.bodyOf(db)
    expect(Object.keys(body)).toEqual(['schema', 'instance', 'version', 'report'])
    expect(body).toMatchObject({ version: '1.0.0-beta.2', instance: expect.stringMatching(UUID_V4), report: { instance: true, version: '0', product: '1-10' } })
  })

  it('documents every route to the standard, and its tool runs', async () => {
    const { app } = await setup()
    const spec = await (await app.request('/openapi.json', { headers: { authorization: `Bearer ${OWNER_KEY}` } })).json()
    expect(lintOpenApi(spec)).toEqual([])
    expect(toolRoutes(telemetryTools(), spec)).toEqual([])
    expect(await toolsRun(telemetryTools(), app, { get_telemetry: {} }, { headers: { authorization: `Bearer ${OWNER_KEY}` } })).toEqual([])
  })
})
