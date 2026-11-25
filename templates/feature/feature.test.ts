import { describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { hashApiKey, testDb } from '../../kit/index.js'

const headers = { authorization: 'Bearer test-key', 'content-type': 'application/json' }
/** A new app over its own empty database: each test counts only what it made. */
const freshApp = async () => createApp({ db: await testDb(), env: { API_KEYS: `tester:${hashApiKey('test-key')}` } })
const sample = __sample__
const patch = { __patch_entries__ }

describe('__labels__', () => {
  it('makes, lists, changes and deletes a __label__, a PATCH leaving the fields it doesn’t send', async () => { // feature:remove
  it('makes, lists and changes a __label__, a PATCH leaving the fields it doesn’t send', async () => { // feature:no-remove
    const app = await freshApp()
    const made = await app.request('/api/__name__', { method: 'POST', headers, body: JSON.stringify(sample) })
    expect(made.status).toBe(201)
    const { id } = (await made.json()) as { id: string }
    expect(made.headers.get('location')).toBe(`/api/__name__/${id}`)
    expect(await (await app.request('/api/__name__', { headers })).json()).toMatchObject({ count: 1 })
    const changed = await app.request(`/api/__name__/${id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) })
    expect(await changed.json()).toMatchObject({ ...sample, ...patch })
    expect((await app.request(`/api/__name__/${id}`, { method: 'DELETE', headers })).status).toBe(204) // feature:remove
    expect((await app.request(`/api/__name__/${id}`, { headers })).status).toBe(404) // feature:remove
  })

  it('pages the list: _links.next until there is no more', async () => {
    const app = await freshApp()
    for (let at = 0; at < 3; at++) await app.request('/api/__name__', { method: 'POST', headers, body: JSON.stringify(sample) })
    const first = (await (await app.request('/api/__name__?limit=2', { headers })).json()) as { count: number; _links: { next?: { href: string } } }
    expect(first.count).toBe(2)
    const next = new URL(first._links.next!.href)
    const rest = (await (await app.request(next.pathname + next.search, { headers })).json()) as { count: number; _links: { next?: unknown } }
    expect([rest.count, rest._links.next]).toEqual([1, undefined])
  })
})
