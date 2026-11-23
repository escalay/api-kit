import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBrand, defineBrand, type BrandAssets } from '../src/brand/index.js'
import { createOAuth, generateOAuthKey, memoryOAuthStore } from '../src/index.js'
import { mcpServerFactory } from '../src/mcp/index.js'
import { guideGaps, lintOpenApi } from '../src/testing/index.js'
import { ASSETS, AUTH, cookbookApi, mcpCall, pngOf, surfacesOf } from './brand-fixture.js'

const ORIGIN = 'https://gw.example.com'
const PROXIED = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'gw.example.com' }
const BRAND = defineBrand({ name: 'cookbook', title: 'Cookbook', description: 'Recipes and menus for agents.', websiteUrl: 'https://cookbook.example.com', termsUrl: 'https://cookbook.example.com/terms', accent: '#2563eb', background: '#ffffff' })
const SERVER_INFO = 'io.modelcontextprotocol/serverInfo'
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

const branded = (options: Parameters<typeof cookbookApi>[0] = {}, assets: BrandAssets = ASSETS) => cookbookApi({ brand: createBrand(BRAND, assets), ...options })
const get = (app: Awaited<ReturnType<typeof cookbookApi>>, path: string, headers: Record<string, string> = {}) => app.request(path, { headers: { ...PROXIED, ...headers } })
const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer())

/** The icons a brand with a dark variant names: the inline PNG first, this host's PNGs, the SVG last. */
const ICONS = [
  { src: expect.stringMatching(/^data:image\/png;base64,/), mimeType: 'image/png', sizes: ['96x96'], theme: 'light' },
  { src: `${ORIGIN}/icon-192.png`, mimeType: 'image/png', sizes: ['192x192'], theme: 'light' },
  { src: `${ORIGIN}/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'], theme: 'light' },
  { src: `${ORIGIN}/icon-dark-192.png`, mimeType: 'image/png', sizes: ['192x192'], theme: 'dark' },
  { src: `${ORIGIN}/icon-dark-512.png`, mimeType: 'image/png', sizes: ['512x512'], theme: 'dark' },
  { src: `${ORIGIN}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'], theme: 'light' },
  { src: `${ORIGIN}/icon-dark.svg`, mimeType: 'image/svg+xml', sizes: ['any'], theme: 'dark' },
]

describe('brand', () => {
  // Captured before the part existed. A dependency that changes these documents (Scalar's page, the MCP SDK) changes
  // them for apps without a brand too: check that diff, then `UPDATE_NO_BRAND=1 pnpm test test/brand.test.ts` writes it
  it('leaves every surface exactly as it was without a brand', async () => {
    const golden = new URL('./fixtures/no-brand.json', import.meta.url)
    const surfaces = await surfacesOf(await cookbookApi())
    if (process.env.UPDATE_NO_BRAND) writeFileSync(golden, `${JSON.stringify(surfaces, null, 2)}\n`)
    expect(surfaces).toEqual(JSON.parse(readFileSync(golden, 'utf8')))
  })

  it('checks a brand where it is defined', () => {
    const good = { name: 'cookbook', title: 'Cookbook', description: 'Recipes.', accent: '#2563eb' }
    expect(defineBrand(good)).toEqual(good)
    expect(() => defineBrand({ ...good, accent: 'blue' })).toThrow(/accent/)
    expect(() => defineBrand({ ...good, background: '#fff' })).toThrow(/background/)
    expect(() => defineBrand({ ...good, name: ' ' })).toThrow(/name/)
    expect(() => defineBrand({ ...good, websiteUrl: 'http://cookbook.example.com' })).toThrow(/websiteUrl/)
    expect(() => defineBrand({ ...good, organization: { name: 'Example', url: '/about' } })).toThrow(/organization\.url/)
    // The Server Card takes 1 to 100 characters
    expect(() => defineBrand({ ...good, description: 'x'.repeat(101) })).toThrow(/description/)
  })

  it('names the server with one identity on every MCP surface, the inline PNG first and the SVG last', async () => {
    const app = await branded()
    const discover = (await mcpCall(app, 'server/discover')).result._meta[SERVER_INFO]
    expect(discover).toEqual({ name: 'cookbook', version: '1.0.0', title: 'Cookbook', description: 'Recipes and menus for agents.', websiteUrl: 'https://cookbook.example.com', icons: ICONS })
    // Claude takes one inline PNG under 10 KB, and drops a serverInfo over about 16,000 characters
    const inline = Buffer.from(discover.icons[0].src.split(',')[1], 'base64')
    expect([...inline.subarray(0, 8)]).toEqual(PNG_SIGNATURE)
    expect(inline.length).toBeLessThan(10_240)
    expect(JSON.stringify(discover).length).toBeLessThan(16_000)
    // A 2025 client's initialize, an agent's habit initialize and the Server Card say the same
    expect((await mcpCall(app, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }, 'legacy')).result.serverInfo).toEqual(discover)
    expect((await mcpCall(app, 'initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'probe', version: '1' } })).result.serverInfo).toEqual(discover)
    const card = await (await get(app, '/mcp/server-card')).json()
    expect(card).toMatchObject({ title: 'Cookbook', description: 'Recipes and menus for agents.', websiteUrl: 'https://cookbook.example.com', icons: ICONS })
  })

  it('keeps the inline icon out of the serverInfo stamped on every other answer', async () => {
    const app = await branded()
    for (const method of ['tools/list', 'tools/call']) {
      const stamped = (await mcpCall(app, method, method === 'tools/call' ? { name: 'list_recipes', arguments: {} } : {})).result._meta[SERVER_INFO]
      expect(stamped, method).toEqual({ name: 'cookbook', version: '1.0.0', title: 'Cookbook', description: 'Recipes and menus for agents.', websiteUrl: 'https://cookbook.example.com', icons: ICONS.slice(1) })
    }
  })

  it('gives a stdio server, with no request to name a host, the inline icon alone', async () => {
    const factory = mcpServerFactory({ info: { name: 'cookbook', version: '1.0.0' }, instructions: 'Find recipes.', tools: [], callApi: async () => new Response(null), brand: createBrand(BRAND, ASSETS) })
    // The identity the SDK serves and stamps, as the server was built with it (the SDK keeps it private)
    const identity = (server: unknown) => (server as { server: { _serverInfo: { icons?: { src: string }[] } } }).server._serverInfo
    for (const era of ['modern', 'legacy'] as const) expect(identity(await factory({ era })).icons?.map((icon) => icon.src.slice(0, 22)), era).toEqual(['data:image/png;base64,'])
  })

  it('serves the favicon, icons, manifest and OG card without a key, with a long cache and an ETag', async () => {
    const app = await branded()
    const favicon = await get(app, '/favicon.ico')
    expect([favicon.status, favicon.headers.get('content-type')]).toEqual([200, 'image/x-icon'])
    expect(favicon.headers.get('cache-control')).toBe('public, max-age=604800')
    // ICO: a header, one entry per image, then each PNG where its entry says
    const ico = await bytesOf(favicon)
    const view = new DataView(ico.buffer)
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([0, 1, 3])
    const entries = [0, 1, 2].map((index) => ({ width: ico[6 + index * 16], size: view.getUint32(6 + index * 16 + 8, true), offset: view.getUint32(6 + index * 16 + 12, true) }))
    expect(entries.map((entry) => entry.width)).toEqual([16, 32, 48])
    for (const entry of entries) expect([...ico.subarray(entry.offset, entry.offset + 8)]).toEqual(PNG_SIGNATURE)
    expect(entries.at(-1)!.offset + entries.at(-1)!.size).toBe(ico.length)
    const etag = favicon.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{16}-\d+"$/)
    expect((await get(app, '/favicon.ico', { 'if-none-match': etag })).status).toBe(304)
    for (const [path, type, size] of [['/icon-192.png', 'image/png', 192], ['/icon-512.png', 'image/png', 512], ['/apple-touch-icon.png', 'image/png', 180], ['/icon-dark-192.png', 'image/png', 192], ['/icon-dark-512.png', 'image/png', 512], ['/og.png', 'image/png', 1200]] as const) {
      const response = await get(app, path)
      expect([response.status, response.headers.get('content-type')], path).toEqual([200, type])
      expect(new DataView((await bytesOf(response)).buffer).getUint32(16), path).toBe(size)
    }
    for (const [path, svg] of [['/icon.svg', ASSETS.svg], ['/icon-dark.svg', ASSETS.svgDark]] as const) {
      const response = await get(app, path)
      expect([response.status, response.headers.get('content-type'), await response.text()]).toEqual([200, 'image/svg+xml', svg])
    }
    const manifest = await get(app, '/site.webmanifest')
    expect(manifest.headers.get('content-type')).toBe('application/manifest+json')
    expect(await manifest.json()).toEqual({
      name: 'Cookbook', short_name: 'Cookbook', description: 'Recipes and menus for agents.', start_url: '/', display: 'standalone', theme_color: '#2563eb', background_color: '#ffffff',
      icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }, { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    })
  })

  it('never answers an OAuth metadata path that `resources` refuses', async () => {
    const oauth = createOAuth({ name: 'Cookbook', signingKey: await generateOAuthKey(), store: memoryOAuthStore(), owner: async () => null, resources: (path) => path === '/s/alpha/mcp' })
    const app = await branded({ oauth })
    expect((await app.request('/.well-known/oauth-protected-resource/s/alpha/files')).status).toBe(404)
    expect((await app.request('/.well-known/oauth-protected-resource/favicon.ico')).status).toBe(404)
    expect((await app.request('/.well-known/oauth-protected-resource/s/alpha/mcp')).status).toBe(200)
    expect((await app.request('/favicon.ico')).status).toBe(200)
  })

  it('changes a file’s ETag when its bytes change under the same inputs, as after the first `kit brand` or a new renderer', async () => {
    const svgOnly = await branded({}, { inputsHash: ASSETS.inputsHash, svg: ASSETS.svg })
    const rendered = await branded()
    const before = (await get(svgOnly, '/site.webmanifest')).headers.get('etag')!
    expect((await get(rendered, '/site.webmanifest', { 'if-none-match': before })).status).toBe(200)
    const og = (await get(rendered, '/og.png')).headers.get('etag')!
    const rerendered = await branded({}, { ...ASSETS, og: Buffer.from(pngOf(1200, 630, [220, 38, 38, 255])).toString('base64') })
    expect((await get(rerendered, '/og.png', { 'if-none-match': og })).status).toBe(200)
    // The same bytes keep their ETag
    expect((await get(await branded(), '/og.png', { 'if-none-match': og })).status).toBe(304)
  })

  it('keeps the headers set before it answers, such as the request id', async () => {
    const app = await branded()
    expect((await get(app, '/api/health')).headers.get('x-request-id')).toBeTruthy()
    for (const path of ['/favicon.ico', '/icon.svg']) {
      const response = await get(app, path)
      expect(response.headers.get('x-request-id'), path).toBeTruthy()
      expect(response.headers.get('content-type'), path).not.toMatch(/problem/)
      const fresh = await get(app, path, { 'if-none-match': response.headers.get('etag')! })
      expect([fresh.status, Boolean(fresh.headers.get('x-request-id'))], path).toEqual([304, true])
    }
  })

  it('documents the logo and terms in OpenAPI, and the lint finds nothing new', async () => {
    const doc = await (await get(await branded(), '/openapi.json', AUTH)).json()
    expect(doc.info).toEqual({ title: 'Cookbook', version: '1.0.0', description: 'Recipes and menus.', 'x-logo': { url: `${ORIGIN}/icon-512.png`, backgroundColor: '#ffffff', altText: 'Cookbook' }, termsOfService: 'https://cookbook.example.com/terms' })
    const plain = await (await get(await cookbookApi(), '/openapi.json', AUTH)).json()
    expect(lintOpenApi(doc)).toEqual(lintOpenApi(plain))
  })

  it('puts the head tags on the docs page and the front door, and a page with its own icon keeps it', async () => {
    const app = await branded({ frontDoor: { 'landing.html': '<!doctype html><html><head><link rel="icon" href="/mine.png"></head><body>the front page</body></html>' } })
    const tags = ['<link rel="icon" href="/favicon.ico" sizes="32x32">', '<link rel="icon" href="/icon.svg" type="image/svg+xml">', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">', '<link rel="manifest" href="/site.webmanifest">', '<meta name="theme-color" content="#2563eb">', '<meta property="og:title" content="Cookbook">', '<meta property="og:description" content="Recipes and menus for agents.">', `<meta property="og:image" content="${ORIGIN}/og.png">`, '<meta name="twitter:card" content="summary_large_image">']
    for (const path of ['/docs', '/app']) {
      const html = await (await get(app, path, AUTH)).text()
      for (const tag of tags) expect(html, `${path}: ${tag}`).toContain(tag)
    }
    const landing = await (await get(app, '/')).text()
    expect(landing).toContain('href="/mine.png"')
    expect(landing).not.toContain('/favicon.ico')
  })

  it('puts the head tags only in a head, never in a header element', async () => {
    const headless = '<!doctype html><body><header>Menu</header>the front page</body>'
    const app = await branded({ frontDoor: { 'landing.html': headless, 'index.html': '<!doctype html><html><head lang="en"><title>Cookbook</title></head><body>the app</body></html>' } })
    expect(await (await get(app, '/')).text()).toBe(headless)
    expect(await (await get(app, '/app', AUTH)).text()).toContain('<head lang="en"><link rel="icon" href="/favicon.ico" sizes="32x32">')
  })

  it('gives the A2A card the icon', async () => {
    const card = await (await get(await branded(), '/.well-known/agent-card.json')).json()
    expect(card.iconUrl).toBe(`${ORIGIN}/icon-512.png`)
  })

  it('fills the guide’s brand placeholders, and guideGaps asks for the brand when the guide uses them', async () => {
    const llms = '# {{brand.title}}\n\n> {{brand.description}}\n'
    expect(await (await get(await branded({ llms }), '/llms.txt')).text()).toBe('# Cookbook\n\n> Recipes and menus for agents.\n')
    const files = new Map([['llms.txt', llms]])
    expect(guideGaps(files, {}, { brand: BRAND })).toEqual([])
    expect(guideGaps(files, {})).toEqual(['llms.txt: {{brand.title}}', 'llms.txt: {{brand.description}}'])
  })

  it('leaves a path the app serves itself to the app, a file in the front door or a route', async () => {
    const app = await branded({ frontDoor: { 'favicon.ico': 'mine' } })
    app.get('/site.webmanifest', (c) => c.json({ name: 'mine' }))
    expect(await (await get(app, '/favicon.ico')).text()).toBe('mine')
    expect(await (await get(app, '/site.webmanifest')).json()).toEqual({ name: 'mine' })
  })

  it('lets other sites show its files, while the rest of the API stays same-site', async () => {
    const app = await branded()
    for (const path of ['/icon.svg', '/icon-512.png', '/og.png']) {
      const response = await get(app, path)
      expect([response.status, response.headers.get('cross-origin-resource-policy')], path).toEqual([200, 'cross-origin'])
      const fresh = await get(app, path, { 'if-none-match': response.headers.get('etag')! })
      expect([fresh.status, fresh.headers.get('cross-origin-resource-policy')], path).toEqual([304, 'cross-origin'])
    }
    expect((await get(app, '/openapi.json')).headers.get('cross-origin-resource-policy')).toBe('same-site')
  })

  it('sandboxes its SVGs, so a script in one never runs in the API’s origin when it is opened directly', async () => {
    const CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
    for (const app of [await branded(), await branded({ private: true })]) {
      for (const path of ['/icon.svg', '/icon-dark.svg']) {
        const response = await get(app, path, AUTH)
        expect([response.status, response.headers.get('content-security-policy')], path).toEqual([200, CSP])
        const fresh = await get(app, path, { ...AUTH, 'if-none-match': response.headers.get('etag')! })
        expect([fresh.status, fresh.headers.get('content-security-policy')], path).toEqual([304, CSP])
      }
    }
    // Only the SVGs: a PNG runs nothing
    expect((await get(await branded(), '/icon-512.png')).headers.get('content-security-policy')).toBeNull()
  })

  it('answers a weak or a wildcard If-None-Match with 304, as RFC 9110 compares them', async () => {
    const app = await branded()
    const etag = (await get(app, '/icon.svg')).headers.get('etag')!
    for (const sent of [`W/${etag}`, '*', `"other", W/${etag}`]) expect((await get(app, '/icon.svg', { 'if-none-match': sent })).status, sent).toBe(304)
    expect((await get(app, '/icon.svg', { 'if-none-match': 'W/"other"' })).status).toBe(200)
  })

  it('in a private service, needs credentials for the brand’s files, keeps them same-site and never lets a shared cache keep them', async () => {
    const app = await branded({ private: true })
    expect((await get(app, '/favicon.ico')).status).toBe(401)
    const withKey = await get(app, '/favicon.ico', AUTH)
    expect([withKey.status, withKey.headers.get('cache-control'), withKey.headers.get('cross-origin-resource-policy')]).toEqual([200, 'private, max-age=604800', 'same-site'])
  })

  it('serves the SVG alone until `kit brand` renders the PNGs', async () => {
    const svgOnly = { inputsHash: ASSETS.inputsHash, svg: ASSETS.svg }
    const app = await branded({}, svgOnly)
    expect((await get(app, '/icon.svg')).status).toBe(200)
    // Not served, so not opened: the answer an app without a brand gives
    expect((await get(app, '/favicon.ico')).status).toBe(401)
    expect((await mcpCall(app, 'server/discover')).result._meta[SERVER_INFO].icons).toEqual([{ src: `${ORIGIN}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }])
    const doc = await (await get(app, '/openapi.json', AUTH)).json()
    expect(doc.info['x-logo'].url).toBe(`${ORIGIN}/icon.svg`)
    const html = await (await get(app, '/docs')).text()
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">')
    expect(html).not.toContain('/favicon.ico')
    expect(html).not.toContain('og:image')
  })
})
