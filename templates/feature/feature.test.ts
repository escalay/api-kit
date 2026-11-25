import { describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { hashApiKey, testDb } from '../../kit/index.js'
import { feature as __parent_camel__ } from '../__parent__/index.js' // feature:under

const headers = { authorization: 'Bearer test-key', 'content-type': 'application/json' }
/** A new app over its own empty database: each test counts only what it made. */
const freshApp = async () => createApp({ db: await testDb(), env: { API_KEYS: `tester:${hashApiKey('test-key')}` } })
const sample = __sample__
const patch = { __patch_entries__ }
/** Where this test's __labels__ live: a new __parent_label__'s list, the __parent_label__ made as its own samples make one. */ // feature:under
const at = async (app: Awaited<ReturnType<typeof freshApp>>) => { // feature:under
  const request = (path: string, init: RequestInit = {}) => Promise.resolve(app.request(path, { ...init, headers })) // feature:under
  const one = (await __parent_camel__.samples(request)).create___parent_snake_singular__ // feature:under
  return `/api/__parent__/${((await (await request('/api/__parent__', { method: 'POST', body: JSON.stringify(one) })).json()) as { id: string }).id}/__name__` // feature:under
} // feature:under

describe('__labels__', () => {
  it('makes, lists, changes and deletes a __label__, a PATCH leaving the fields it doesn’t send', async () => { // feature:remove
  it('makes, lists and changes a __label__, a PATCH leaving the fields it doesn’t send', async () => { // feature:no-remove
    const app = await freshApp()
    const list = '/api/__name__' // feature:flat
    const list = await at(app) // feature:under
    const made = await app.request(list, { method: 'POST', headers, body: JSON.stringify(sample) })
    expect(made.status).toBe(201)
    const { id } = (await made.json()) as { id: string }
    expect(made.headers.get('location')).toBe(`/api/__name__/${id}`)
    expect(await (await app.request(list, { headers })).json()).toMatchObject({ count: 1 })
    const changed = await app.request(`/api/__name__/${id}`, { method: 'PATCH', headers, body: JSON.stringify(patch) })
    expect(await changed.json()).toMatchObject({ ...sample, ...patch })
    expect((await app.request(`/api/__name__/${id}`, { method: 'DELETE', headers })).status).toBe(204) // feature:remove
    expect((await app.request(`/api/__name__/${id}`, { headers })).status).toBe(404) // feature:remove
  })

  it('pages the list: _links.next until there is no more', async () => {
    const app = await freshApp()
    const list = '/api/__name__' // feature:flat
    const list = await at(app) // feature:under
    for (let made = 0; made < 3; made++) await app.request(list, { method: 'POST', headers, body: JSON.stringify(sample) })
    const first = (await (await app.request(`${list}?limit=2`, { headers })).json()) as { count: number; _links: { next?: { href: string } } }
    expect(first.count).toBe(2)
    const next = new URL(first._links.next!.href)
    const rest = (await (await app.request(next.pathname + next.search, { headers })).json()) as { count: number; _links: { next?: unknown } }
    expect([rest.count, rest._links.next]).toEqual([1, undefined])
  })

  it('answers 404 for a __parent_label__ that does not exist, listing or making', async () => { // feature:under
    const app = await freshApp() // feature:under
    expect((await app.request('/api/__parent__/nope/__name__', { headers })).status).toBe(404) // feature:under
    expect((await app.request('/api/__parent__/nope/__name__', { method: 'POST', headers, body: JSON.stringify(sample) })).status).toBe(404) // feature:under
  }) // feature:under
})
