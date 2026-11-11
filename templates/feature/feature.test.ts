import { describe, expect, it } from 'vitest'
import { createApp } from '../../app.js'
import { hashApiKey, testDb } from '../../kit/index.js'

const headers = { authorization: 'Bearer test-key', 'content-type': 'application/json' }
const app = await createApp({ db: await testDb(), env: { API_KEYS: `tester:${hashApiKey('test-key')}` } })

describe('__labels__', () => {
  it('makes, lists, changes and deletes a __label__', async () => {
    const made = await app.request('/api/__name__', { method: 'POST', headers, body: JSON.stringify({ title: 'First' }) })
    expect(made.status).toBe(201)
    const { id } = (await made.json()) as { id: string }
    expect(made.headers.get('location')).toBe(`/api/__name__/${id}`)
    expect(await (await app.request('/api/__name__', { headers })).json()).toMatchObject({ count: 1 })
    expect(await (await app.request(`/api/__name__/${id}`, { method: 'PATCH', headers, body: JSON.stringify({ body: 'more' }) })).json()).toMatchObject({ title: 'First', body: 'more' })
    expect((await app.request(`/api/__name__/${id}`, { method: 'DELETE', headers })).status).toBe(204)
    expect((await app.request(`/api/__name__/${id}`, { headers })).status).toBe(404)
  })
})
