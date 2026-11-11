import { z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { inProcess } from '../src/mcp/index.js'
import { lintOpenApi, toolRoutes } from '../src/testing/index.js'
import { registerVectorSearch, vectorSearchTools } from '../src/vector-search/index.js'
import { createAgentApi, hashApiKey, parseApiKeys } from '../src/index.js'
import { createEmbedder } from '../src/vectors/index.js'
import { auth, KEY, meaning, png, sampleApi } from './logos-fixture.js'

const keysOf = async (response: Response) => ((await response.json())._embedded.results as { item: { id: string } }[]).map((result) => result.item.id)

describe('vector search', () => {
  it('finds items by words in either space, merged on how far they stand out', async () => {
    const app = sampleApi()
    const response = await app.request('/api/search?q=fox', { headers: auth })
    expect(response.headers.get('content-type')).toContain('application/hal+json')
    const body = await response.json()
    expect(body).toMatchObject({ query: 'fox', by: 'both', count: 2, _links: { self: { href: 'http://localhost/api/search?q=fox' } } })
    expect(body._embedded.results.map((result: { item: { id: string }; space: string }) => `${result.item.id} ${result.space}`)).toEqual(['logo:fox look', 'logo:fox2 look'])
    expect(await keysOf(await app.request('/api/search?q=bird&by=meaning', { headers: auth }))).toEqual(['logo:bird'])
    expect(await keysOf(await app.request('/api/search?q=bird&by=look', { headers: auth }))).toEqual([])
    expect(await keysOf(await app.request('/api/search?q=fox&decade=1980s', { headers: auth }))).toEqual(['logo:fox2'])
    expect(await keysOf(await app.request('/api/search?q=nothing+like+it', { headers: auth }))).toEqual([])
  })

  it('shows the nearest few below the bar when nothing clears it, marked apart from the results', async () => {
    const strict = (await (await sampleApi({ minZ: { look: 99, meaning: 99 } }).request('/api/search?q=fox', { headers: auth })).json())._embedded
    expect(strict.results).toEqual([])
    expect(strict.closest.map((row: { item: { id: string }; z: number | null }) => [row.item.id, row.z])).toEqual([['logo:fox', null], ['logo:fox2', null]])
    expect((await (await sampleApi().request('/api/search?q=fox', { headers: auth })).json())._embedded.closest).toBeUndefined()
  })

  it('declares its filters, so an unknown one is a 400 and the spec lints clean', async () => {
    const app = sampleApi()
    expect((await app.request('/api/search?q=fox&colour=red', { headers: auth })).status).toBe(400)
    expect((await app.request('/api/search?q=x', { headers: auth })).status).toBe(400)
    expect((await app.request('/api/search?q=fox')).status).toBe(401)
    const doc = await (await app.request('/openapi.json')).json()
    expect(lintOpenApi(doc)).toEqual([])
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/api/search', '/api/logos/{slug}/similar']))
    expect(doc.paths['/api/search'].post.operationId).toBe('searchLogosByImage')
  })

  it('answers what an agent can act on when it cannot search', async () => {
    const noKey = await sampleApi({ embedder: null }).request('/api/search?q=fox', { headers: auth })
    expect([noKey.status, (await noKey.json()).code]).toEqual([503, 'unavailable'])
    const notBuilt = await sampleApi({ spaces: {} }).request('/api/search?q=fox', { headers: auth })
    expect([notBuilt.status, notBuilt.headers.get('retry-after')]).toEqual([503, '3600'])
    const capped = createEmbedder({ apiKey: 'k', fetchImpl: (async () => new Response('{"error":{"message":"Key limit exceeded"}}', { status: 402 })) as typeof fetch })
    const spent = await sampleApi({ embedder: capped }).request('/api/search?q=fox', { headers: auth })
    expect([spent.status, (await spent.json()).code]).toEqual([429, 'spend_cap'])
    // Likeness needs no embedding, so it still works
    expect((await sampleApi({ embedder: null }).request('/api/logos/fox/similar', { headers: auth })).status).toBe(200)
  })

  it('takes a picture as an upload, a data URL, or a URL on an allowed host only', async () => {
    const image = await png()
    const fetched: string[] = []
    const fetchImpl = (async (url: URL) => {
      fetched.push(String(url))
      return new Response(new Uint8Array(image), { headers: { 'content-type': 'image/png' } })
    }) as unknown as typeof fetch
    const app = sampleApi({ fetchImpl })
    // The API's own image links are read in-process with the caller's credentials, never over the network
    app.get('/files/fox.png', (c) => c.body(new Uint8Array(image), 200, { 'content-type': 'image/png' }))
    const form = new FormData()
    form.append('image', new File([new Uint8Array(image)], 'sketch.png', { type: 'image/png' }))
    expect(await keysOf(await app.request('/api/search', { method: 'POST', headers: auth, body: form }))).toEqual(['logo:fox', 'logo:fox2'])
    const json = (image: string, query = '') => app.request(`/api/search${query}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ image }) })
    expect(await keysOf(await json(`data:image/png;base64,${image.toString('base64')}`, '?decade=1980s'))).toEqual(['logo:fox2'])
    expect(await keysOf(await json('https://assets.example.com/fox.png'))).toEqual(['logo:fox', 'logo:fox2'])
    expect(fetched).toEqual(['https://assets.example.com/fox.png'])
    expect(await keysOf(await json('http://localhost/files/fox.png'))).toEqual(['logo:fox', 'logo:fox2'])
    expect(fetched).toEqual(['https://assets.example.com/fox.png'])
    for (const refused of ['https://evil.example.org/x.png', 'http://assets.example.com/x.png', 'http://192.168.0.1/', 'file:///etc/passwd']) expect((await json(refused)).status).toBe(400)
    expect(fetched).toHaveLength(1)
    expect((await json('data:image/png;base64,bm90IGFuIGltYWdl')).status).toBe(400)
    const text = new FormData()
    text.append('image', new File(['hello'], 'a.txt', { type: 'text/plain' }))
    expect((await app.request('/api/search', { method: 'POST', headers: auth, body: text })).status).toBe(415)
  })

  it('leaves picture search out for a catalog without pictures', async () => {
    const app = createAgentApi({ title: 'Ideas', version: '1.0.0', description: 'Ideas.', tags: [{ name: 'Search', description: 'Find.' }], auth: { realm: 'ideas', keys: parseApiKeys(`agent:${hashApiKey(KEY)}`) } })
    registerVectorSearch(app, { path: '/api/search', name: 'Idea', noun: 'ideas', tag: 'Search', item: z.object({ slug: z.string() }).openapi('IdeaCard', { description: 'An idea.' }), spaces: () => ({}), embedder: () => undefined, itemOf: () => undefined, pictures: false, offers: ['meaning'] })
    const doc = await (await app.request('/openapi.json')).json()
    expect(Object.keys(doc.paths['/api/search'])).toEqual(['get'])
    // A text-only catalog offers only meaning: by=look is not advertised, and asking for it is a 400, not a 503
    expect(doc.paths['/api/search'].get.parameters.find((parameter: { name: string }) => parameter.name === 'by').schema.enum).toEqual(['meaning'])
    expect((await app.request('/api/search?q=daycare&by=look', { headers: auth })).status).toBe(400)
    expect(vectorSearchTools({ path: '/api/search', noun: 'ideas', label: () => '', pictures: false }).map((tool) => tool.name)).toEqual(['search_ideas'])
  })

  it('holds pictures to their own bar, separate from words', async () => {
    const strict = sampleApi({ minZ: { picture: 99 } })
    const picture = await strict.request('/api/search', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ image: `data:image/png;base64,${(await png()).toString('base64')}` }) })
    expect(await keysOf(picture)).toEqual([])
    expect(await keysOf(await strict.request('/api/search?q=fox', { headers: auth }))).toEqual(['logo:fox', 'logo:fox2'])
  })

  it('finds items like one, without the item itself, by look by default', async () => {
    const app = sampleApi()
    const body = await (await app.request('/api/logos/fox/similar?limit=2', { headers: auth })).json()
    expect(body).toMatchObject({ query: null, by: 'look' })
    expect(body._embedded.results[0]).toMatchObject({ item: { id: 'logo:fox2' }, z: null, space: 'look' })
    expect(body._embedded.results).toHaveLength(1) // the second nearest is noise, which has no card
    expect((await app.request('/api/logos/nope/similar', { headers: auth })).status).toBe(404)
    expect((await (await sampleApi({ spaces: { meaning } }).request('/api/logos/fox/similar', { headers: auth })).json()).by).toBe('meaning')
  })

  it('takes a board ref for an id, and an id that itself holds a colon', async () => {
    const similarTo = async (app: ReturnType<typeof sampleApi>, id: string) => {
      const response = await app.request(`/api/logos/${encodeURIComponent(id)}/similar?limit=1`, { headers: auth })
      return response.ok ? (await response.json())._embedded.results.map((result: { item: { id: string } }) => result.item.id) : response.status
    }
    expect(await similarTo(sampleApi(), 'logo:fox')).toEqual(['logo:fox2'])
    // Ids are the vector keys here, colon and all (`episode:intro`): nothing is stripped that matches as given
    const colonIds = sampleApi({ keyOf: null })
    expect(await similarTo(colonIds, 'logo:fox')).toEqual(['logo:fox2'])
    expect(await similarTo(colonIds, 'fox')).toBe(404)
  })

  it('gives agents the same three routes as MCP tools', async () => {
    const app = sampleApi()
    const tools = vectorSearchTools({ path: '/api/search', similarPath: '/api/logos/{slug}/similar', noun: 'logos', imageHosts: ['assets.example.com'], label: (logo) => logo.client, filters: { decade: z.string().optional() } })
    expect(tools.map((tool) => tool.name)).toEqual(['search_logos', 'search_logos_by_image', 'similar_logos'])
    expect(toolRoutes(tools, await (await app.request('/openapi.json')).json())).toEqual([])
    const callApi = inProcess(app)
    const run = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name)!
      const response = await callApi(tool.call(tool.input.parse(args) as never), { token: KEY, clientId: 'agent', scopes: [], extra: { headers: auth } })
      return tool.summarize(await response.json(), args as never)
    }
    expect(await run('search_logos', { q: 'fox', decade: '1970s' })).toMatch(/^1\. Fox Films · look 1 \(z \d+(\.\d+)?\) · http:\/\/localhost\/api\/logos\/fox$/)
    expect(await run('search_logos', { q: 'nothing at all' })).toBe('Nothing stands out for "nothing at all" by both. Try other words, by=both, or fewer filters.')
    expect(await run('search_logos_by_image', { image: `data:image/png;base64,${(await png()).toString('base64')}` })).toContain('Fox Films')
    expect(await run('similar_logos', { slug: 'fox', limit: 1 })).toContain('Red Fox')
    // A board ref works as well as the bare id
    expect(await run('similar_logos', { slug: 'logo:fox', limit: 1 })).toContain('Red Fox')
    // The tool passes the id on as given, so an app whose ids hold a colon needs no override
    const colonIds = inProcess(sampleApi({ keyOf: null }))
    const similar = tools.find((tool) => tool.name === 'similar_logos')!
    expect((await colonIds(similar.call(similar.input.parse({ slug: 'logo:fox', limit: 1 }) as never), { token: KEY, clientId: 'agent', scopes: [], extra: { headers: auth } })).status).toBe(200)
    expect(tools[1]!.description).toContain('assets.example.com')
  })
})
