import { createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it, vi } from 'vitest'
import {
  createAgentApi,
  databaseProvider,
  defineFeatures,
  fromSdk,
  hashApiKey,
  HAL_JSON,
  memoryProvider,
  parseApiKeys,
  parseFeatureList,
  problemResponses,
  SWITCHES_TAG,
  switches,
  switchesRepo,
  switchTools,
  featureTools,
  testDb,
  type FlagProvider,
} from '../src/index.js'
import { lintOpenApi, toolRoutes, toolsRun } from '../src/testing/index.js'

const OWNER = 'owner-key'
const LAPTOP = 'laptop-key'
const CI = 'ci-key'

const CATALOG = defineFeatures({
  sending: { title: 'Sending', description: 'Mail out from the app.' },
  digest: { title: 'Daily digest', description: 'One mail a day with what changed.', needs: ['sending'] },
  webhooks: { title: 'Webhooks', description: 'Events posted to other services.', renamedFrom: ['hooks'] },
  beta: { title: 'Beta', description: 'Something new.', default: false },
})

/** A sample app: one route per feature, each added through `gated`, and the switches' own routes. */
const setup = async ({ providers, off }: { providers?: (db: Awaited<ReturnType<typeof testDb>>) => FlagProvider[]; off?: string[] } = {}) => {
  const db = await testDb()
  const flags = switches({ catalog: CATALOG, providers: providers?.(db) ?? [databaseProvider(db)], off })
  const keys = parseApiKeys(`owner:${hashApiKey(OWNER)},laptop:${hashApiKey(LAPTOP)},ci:${hashApiKey(CI)}`)
  const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [SWITCHES_TAG, { name: 'Work', description: 'The features.' }], auth: { realm: 'sample', keys } })
  const switched: unknown[] = []
  await flags.register(app, { isOwner: (c) => (c.get('caller' as never) as { name?: string }).name === 'owner', onSwitch: (change) => void switched.push(change) })
  for (const key of flags.keys as (keyof typeof CATALOG)[]) {
    const route = createRoute({
      method: 'post',
      path: `/api/${key}`,
      operationId: `run${key[0]!.toUpperCase()}${key.slice(1)}`,
      tags: ['Work'],
      summary: `Run ${key}`,
      description: `Runs ${key}, for the tests.`,
      request: { body: { required: true, content: { 'application/json': { schema: z.object({ n: z.number().openapi({ description: 'A number.', example: 1 }) }).openapi(`${key}Input`, { description: 'Input.' }) } } } },
      responses: { 200: { content: { [HAL_JSON]: { schema: z.object({ ran: z.string() }).openapi(`${key}Ran`, { description: 'Ran.' }) } }, description: 'Ran.' }, ...problemResponses(400, 401) },
    })
    flags.gated(app, key).openapi(route, (c) => c.json({ ran: key }, 200))
  }
  const call = (key: string) => (path: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, { method: init.method ?? 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) })
  const run = (key: string, feature: string, body: unknown = { n: 1 }) => call(key)(`/api/${feature}`, { method: 'POST', body })
  const flip = (feature: string, body: unknown, query = '') => call(OWNER)(`/api/features/${feature}${query}`, { method: 'PATCH', body })
  return { db, app, flags, call, run, flip, switched, owner: call(OWNER) }
}

describe('the catalog', () => {
  it('refuses keys, needs and old names that would break a store', () => {
    expect(() => defineFeatures({ Bad_Key: { title: 'x', description: 'x' } })).toThrow(/lowercase words/)
    expect(() => defineFeatures({ a: { title: 'x', description: 'x', needs: ['b'] } })).toThrow(/not in the catalog/)
    expect(() => defineFeatures({ a: { title: 'x', description: 'x', needs: ['b'] }, b: { title: 'x', description: 'x', needs: ['a'] } })).toThrow(/loop: a → b → a/)
    expect(() => defineFeatures({ a: { title: 'x', description: 'x', renamedFrom: ['b'] }, b: { title: 'x', description: 'x' } })).toThrow(/already a key/)
    expect(parseFeatureList(' webhooks, digest ,,beta ')).toEqual(['webhooks', 'digest', 'beta'])
  })
})

describe('switches', () => {
  it('lets a feature work until the owner switches it off, then answers 403 "This feature is disabled."', async () => {
    const { run, flip, switched, owner } = await setup()
    expect((await run(LAPTOP, 'webhooks')).status).toBe(200)
    expect((await flip('webhooks', { on: false })).status).toBe(200)
    const refused = await run(LAPTOP, 'webhooks')
    expect(refused.status).toBe(403)
    const problem = await refused.json()
    expect(problem).toMatchObject({ code: 'feature_disabled', feature: 'webhooks', blockedBy: [], scope: 'everyone', changedBy: 'owner', switchOn: '/api/features/webhooks' })
    expect(problem.detail).toMatch(/^This feature is disabled\. Webhooks \(`webhooks`\) is off for everyone, switched off by owner at \d{4}-\d\d-\d\d \d\d:\d\d UTC\. An owner switches it on with switch_feature \{"key": "webhooks", "state": "on"\} or PATCH \/api\/features\/webhooks \{"on": true\}; ask them rather than retrying, and never switch it yourself to finish a task\.$/)
    expect(switched).toEqual([{ key: 'webhooks', scope: 'everyone', on: false, by: 'owner' }])
    const listed = (await (await owner('/api/features')).json()) as { _embedded: { features: { key: string; on: boolean; overrides: unknown[] }[] } }
    expect(listed._embedded.features.find((feature) => feature.key === 'webhooks')).toMatchObject({ on: false, source: 'database', reason: 'STATIC', overrides: [{ scope: 'everyone', on: false, changedBy: 'owner' }] })
    expect((await flip('webhooks', { on: null })).status).toBe(200)
    expect((await run(LAPTOP, 'webhooks')).status).toBe(200)
  })

  it('asks for a key before the switch, and the switch before the body', async () => {
    const { app, run, flip } = await setup()
    await flip('webhooks', { on: false })
    expect((await app.request('/api/webhooks', { method: 'POST', body: '{}' })).status).toBe(401)
    expect((await run(LAPTOP, 'webhooks', { n: 'not a number' })).status).toBe(403)
    expect((await run(LAPTOP, 'sending', { n: 'not a number' })).status).toBe(400)
  })

  it('runs a feature’s own middleware only while it is on, so a refused call spends nothing', async () => {
    const db = await testDb()
    const flags = switches({ catalog: CATALOG, providers: [databaseProvider(db, { cacheMs: 0 })] })
    const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(`owner:${hashApiKey(OWNER)}`) } })
    let counted = 0
    const webhooks = flags.gated(app, 'webhooks')
    webhooks.use('/api/hooks', async (_c, next) => {
      counted += 1
      await next()
    })
    webhooks.get('/api/hooks', (c) => c.json({ ok: true }))
    const call = () => app.request('/api/hooks', { headers: { authorization: `Bearer ${OWNER}` } })
    expect((await call()).status).toBe(200)
    await flags.set({ key: 'webhooks', on: false, by: 'owner' })
    expect((await call()).status).toBe(403)
    expect(counted).toBe(1)
  })

  it('lets only the owner switch', async () => {
    const { call } = await setup()
    const answer = await call(LAPTOP)('/api/features/webhooks', { method: 'PATCH', body: { on: false } })
    expect(answer.status).toBe(403)
    expect(await answer.json()).toMatchObject({ code: 'forbidden' })
  })

  it('stops what needs a feature, and says so before with dryRun', async () => {
    const { run, flip, flags } = await setup()
    const preview = await flip('sending', { on: false }, '?dryRun=true')
    expect(await preview.json()).toMatchObject({ dryRun: true, changes: [{ key: 'sending', on: false, was: true }, { key: 'digest', on: false, was: true }] })
    expect((await run(LAPTOP, 'digest')).status).toBe(200)
    await flip('sending', { on: false })
    const refused = await run(LAPTOP, 'digest')
    const problem = await refused.json()
    expect(problem).toMatchObject({ code: 'feature_disabled', feature: 'digest', blockedBy: ['sending'], switchOn: '/api/features/sending' })
    expect(problem.detail).toMatch(/^This feature is disabled\. Daily digest \(`digest`\) needs Sending \(`sending`\), which is off for everyone, switched off by owner at /)
    expect(await flags.stateOf()).toMatchObject({ digest: { on: false, own: true, blockedBy: ['sending'] } })
  })

  it('switches for one person or one key, the caller’s own switch winning over everyone’s', async () => {
    const { run, flip, flags } = await setup()
    expect((await run(LAPTOP, 'beta')).status).toBe(403)
    await flip('beta', { on: true, scope: 'key:laptop' })
    expect((await run(LAPTOP, 'beta')).status).toBe(200)
    expect((await run(CI, 'beta')).status).toBe(403)
    await flip('webhooks', { on: false })
    await flip('webhooks', { on: true, scope: 'key:ci' })
    expect((await run(CI, 'webhooks')).status).toBe(200)
    expect((await run(LAPTOP, 'webhooks')).status).toBe(403)
    expect(await flags.isOn('beta', { targetingKey: 'person:ana@example.com' })).toBe(false)
    await flip('beta', { on: true, scope: 'person:ana@example.com' })
    expect(await flags.isOn('beta', { targetingKey: 'person:ana@example.com' })).toBe(true)
    expect(await flags.isOn('beta')).toBe(false)
    expect((await flip('beta', { on: true, scope: 'team:x' })).status).toBe(400)
  })

  it('shows other people’s and keys’ switches only to an owner', async () => {
    const { flip, call } = await setup()
    await flip('beta', { on: true, scope: 'key:laptop' })
    await flip('beta', { on: true, scope: 'person:ana@example.com' })
    await flip('webhooks', { on: false })
    const overridesFor = async (key: string, feature: string) => (await (await call(key)(`/api/features/${feature}`)).json()).overrides.map((override: { scope: string }) => override.scope)
    expect(await overridesFor(OWNER, 'beta')).toEqual(['key:laptop', 'person:ana@example.com'])
    expect(await overridesFor(LAPTOP, 'beta')).toEqual(['key:laptop'])
    expect(await overridesFor(CI, 'beta')).toEqual([])
    expect(await overridesFor(CI, 'webhooks')).toEqual(['everyone'])
    const listed = JSON.stringify(await (await call(CI)('/api/features')).json())
    expect(listed).not.toContain('ana@example.com')
    expect(listed).not.toContain('key:laptop')
  })

  it('keeps FEATURES_OFF off whatever is stored, and lists names it does not know', async () => {
    const { run, flip, owner, flags } = await setup({ off: ['hooks', 'sendng'] })
    expect((await (await run(LAPTOP, 'webhooks')).json()).detail).toBe('This feature is disabled. Webhooks (`webhooks`) is switched off by FEATURES_OFF in the deployment’s settings. Only the deployment’s settings can switch it on: remove it from FEATURES_OFF.')
    const refused = await flip('webhooks', { on: true })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ detail: expect.stringContaining('FEATURES_OFF') })
    expect(await (await owner('/api/features')).json()).toMatchObject({ locked: ['webhooks'], unknownOff: ['sendng'] })
    expect(flags.unknownOff).toEqual(['sendng'])
  })

  it('reads a switch stored under a feature’s old name, and moves it on the next switch', async () => {
    const { db, run, flip } = await setup()
    await databaseProvider(db).write!({ key: 'hooks', scope: 'everyone', on: false, by: 'owner' })
    expect((await run(LAPTOP, 'webhooks')).status).toBe(403)
    expect((await run(LAPTOP, 'hooks')).status).toBe(404)
    await flip('hooks', { on: true })
    expect((await switchesRepo(db).all()).map((row) => `${row.key} ${row.on}`)).toEqual(['webhooks true'])
  })

  it('keeps the table read for 5 s, and reads it again for an action that leaves the app', async () => {
    const { db, flags } = await setup()
    expect(await flags.isOn('webhooks')).toBe(true)
    await switchesRepo(db).put({ key: 'webhooks', scope: 'everyone', on: false, changedBy: 'elsewhere', changedAt: new Date().toISOString() })
    expect(await flags.isOn('webhooks')).toBe(true)
    expect(await flags.isOn('webhooks', {}, { fresh: true })).toBe(false)
  })

  it('swaps the database for a flag service in the providers line, and keeps the database behind it', async () => {
    const calls: (string | undefined)[] = []
    const vendor = { 'app-webhooks': false, 'app-beta': 'variant-b' } as Record<string, boolean | string>
    const { run, flip, owner } = await setup({
      providers: (db) => [fromSdk({ name: 'vendor', flagKeyOf: (key) => `app-${key}`, allFlags: (context) => (calls.push(context.targetingKey), vendor) }), databaseProvider(db)],
    })
    expect((await run(LAPTOP, 'webhooks')).status).toBe(403)
    expect((await run(LAPTOP, 'beta')).status).toBe(200)
    expect(calls).toEqual(['key:laptop'])
    const managed = await flip('webhooks', { on: true })
    expect(managed.status).toBe(409)
    expect(await managed.json()).toMatchObject({ detail: '"webhooks" is managed in vendor for everyone: change it there.' })
    // What the service does not name, the database decides
    await flip('sending', { on: false })
    expect((await run(LAPTOP, 'sending')).status).toBe(403)
    expect(await (await owner('/api/features')).json()).toMatchObject({ providers: ['vendor', 'database'], writable: 'database' })
  })

  it('skips a flag service that fails or is slow, so the default decides', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const slow = fromSdk({ name: 'slow', timeoutMs: 20, isOn: () => new Promise((resolve) => setTimeout(() => resolve(false), 200)) })
    const broken = fromSdk({ name: 'broken', allFlags: () => Promise.reject(new Error('down')) })
    const flags = switches({ catalog: CATALOG, providers: [slow, broken, memoryProvider({ beta: true })] })
    expect(await flags.stateOf()).toMatchObject({ webhooks: { on: true, source: 'default' }, beta: { on: true, source: 'memory' } })
    vi.restoreAllMocks()
  })

  it('says where to switch when no provider can be written', async () => {
    const { flip, owner } = await setup({ providers: () => [memoryProvider({ beta: true })] })
    const refused = await flip('webhooks', { on: false })
    expect(refused.status).toBe(409)
    expect(await (await owner('/api/features')).json()).toMatchObject({ writable: null })
  })

  it('documents every route to the standard, with the 403 on gated ones, and its tools run', async () => {
    const { app, owner } = await setup()
    const spec = await (await owner('/openapi.json')).json()
    expect(lintOpenApi(spec)).toEqual([])
    expect(Object.keys(spec.paths['/api/webhooks'].post.responses)).toContain('403')
    expect(toolRoutes(switchTools(), spec)).toEqual([])
    const [marked] = featureTools(switchTools().slice(0, 1), CATALOG, 'webhooks')
    expect(marked!.description).toMatch(/Part of the feature Webhooks \(`webhooks`\), which an owner can switch off: then it answers 403 feature_disabled\.$/)
    expect(await toolsRun(switchTools(), app, { list_features: {}, switch_feature: { key: 'webhooks', state: 'off', preview: true } }, { headers: { authorization: `Bearer ${OWNER}` } })).toEqual([])
  })
})
