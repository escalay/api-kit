import { describe, expect, it, vi } from 'vitest'
import { createAgentApi, hashApiKey, holderOf, KEYS_TAG, keyTools, parseApiKeys, registerKeys, storedKeysOf, testDb, type KeyChange } from '../src/index.js'
import { lintOpenApi, toolRoutes, toolsRun } from '../src/testing/index.js'

const KEY = 'owner-key'

const setup = async ({ onKeyChange }: { onKeyChange?: (change: KeyChange) => void } = {}) => {
  const db = await testDb()
  const keys = parseApiKeys(`owner:${hashApiKey(KEY)}`)
  const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [KEYS_TAG], auth: { realm: 'sample', keys, storedKeys: storedKeysOf(db) } })
  const changes: unknown[] = []
  await registerKeys(app, { db, fixedKeys: [...keys.values()], keyPrefix: 'sk', onKeyChange: onKeyChange ?? ((change) => void changes.push(change)) })
  const as = (key: string) => (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } })
  return { app, owner: as(KEY), as, changes }
}

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
