import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createApp } from '../../src/app.js'
import { hashApiKey, testDb } from '../../src/kit/index.js'
import { create__Pascal__ } from '../src/index.js'

const KEY = 'test-key'
const BASE = 'https://api.example.test/under-a-path'

/**
 * The client over the whole app in this process, served under a path prefix. A request without the prefix fails, so a
 * client that followed a `_links` href (which names the origin the server saw) instead of its own base fails too.
 */
const setup = async () => {
  const app = await createApp({ db: await testDb(), env: { API_KEYS: `tester:${hashApiKey(KEY)}` } })
  return create__Pascal__({
    baseUrl: BASE,
    apiKey: KEY,
    fetch: async (input, init) => {
      const url = String(input)
      if (!url.startsWith(`${BASE}/`)) throw new Error(`the client left its base address: ${url}`)
      return app.request(url.replace('/under-a-path', ''), init)
    },
  })
}

describe('the client', () => {
  it('calls the API under its own base address', async () => {
    expect(await (await setup()).getHealth()).toMatchObject({ status: 'ok' })
  })

  it('covers every operation of the API it was generated from', () => {
    const doc = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, { operationId: string }>> }
    const operations = Object.values(doc.paths).flatMap((methods) => Object.values(methods).map((operation) => operation.operationId))
    // Each operation, and the client method that calls it. A new route fails here until it has one
    const covered: Record<string, string> = {
      getHealth: 'getHealth',
      // kit:covered
    }
    expect(operations.sort()).toEqual(Object.keys(covered).sort())
  })
})

describe('the document the client is generated from', () => {
  it('is the API as it is now (run `pnpm sdk:types` after changing a route)', async () => {
    const app = await createApp({ db: await testDb(), env: {} })
    const doc = (await (await app.request('/openapi.json')).json()) as Record<string, unknown>
    delete doc.servers
    delete doc.externalDocs
    expect(`${JSON.stringify(doc, null, 2)}\n`).toBe(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'))
  })
})
