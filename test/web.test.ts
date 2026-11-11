import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentApi, frontDoorOpen, hashApiKey, parseApiKeys, serveFrontDoor, versionAssets } from '../src/index.js'

/** A plain viewer (index.html with relative files) plus a front page, behind an API with one key. */
const sampleSite = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'web-'))
  await mkdir(join(dir, 'assets'))
  await writeFile(join(dir, 'index.html'), '<script src="app.js"></script>the app')
  await writeFile(join(dir, 'landing.html'), 'the front page')
  await writeFile(join(dir, 'app.js'), 'console.log(1)')
  await writeFile(join(dir, 'assets/app-1a2b.js'), 'built')
  const web = { dir, moved: ['/logos'] }
  const app = createAgentApi({ title: 'Logos', version: '1.0.0', description: 'Logos.', tags: [], home: false, auth: { realm: 'logos', keys: parseApiKeys(`me:${hashApiKey('k')}`), open: frontDoorOpen(web) } })
  app.get('/api/logos', (c) => c.json({ logos: [] }))
  serveFrontDoor(app, web)
  return app
}

describe('front door', () => {
  it('opens the front page and the page files, and nothing else, without a key', async () => {
    const app = await sampleSite()
    const front = await app.request('/')
    expect([front.status, await front.text(), front.headers.get('cache-control')]).toEqual([200, 'the front page', 'no-cache'])
    expect((await app.request('/app.js')).status).toBe(200)
    expect((await app.request('/assets/app-1a2b.js')).headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect((await app.request('/app')).status).toBe(401)
    expect((await app.request('/api/logos')).status).toBe(401)
    expect((await app.request('/index.html')).status).toBe(401)
  })

  it('serves the app for every page under /app, its files relatively, and redirects old addresses', async () => {
    const app = await sampleSite()
    const key = { headers: { authorization: 'Bearer k' } }
    expect(await (await app.request('/app', key)).text()).toMatch(/^<script src="app\.js\?v=[0-9a-f]{8}"><\/script>the app$/)
    expect(await (await app.request('/app/', key)).text()).toMatch(/app\.js\?v=/)
    expect(await (await app.request('/app/designers/jane-doe', key)).text()).toContain('the app')
    expect(await (await app.request('/app/app.js', key)).text()).toBe('console.log(1)')
    const deepLink = await app.request('/?item=fox-123')
    expect([deepLink.status, deepLink.headers.get('location')]).toEqual([301, '/app?item=fox-123'])
    const old = await app.request('/logos/fox?by=look')
    expect([old.status, old.headers.get('location')]).toEqual([301, '/app/logos/fox?by=look'])
    expect((await app.request('/api/nowhere', key)).status).toBe(404)
  })

  it('versions the pages\u2019 own scripts and styles by content, and leaves other links alone', () => {
    const dir = join(tmpdir(), 'web-version')
    expect(versionAssets('<script src="/nowhere.js"></script><a href="https://x.test/a.js">', dir)).toBe('<script src="/nowhere.js"></script><a href="https://x.test/a.js">')
  })

  it('leaves hashed build output under its own name, so its chunks load once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'web-hashed-'))
    await mkdir(join(dir, 'assets'))
    await writeFile(join(dir, 'assets', 'app-By-s8OGz.js'), 'import "./routes-Ct.js"')
    await writeFile(join(dir, 'landing.js'), 'console.log(1)')
    const page = versionAssets('<script type="module" src="/assets/app-By-s8OGz.js"></script><script src="/landing.js"></script>', dir)
    expect(page).toMatch(/^<script type="module" src="\/assets\/app-By-s8OGz\.js"><\/script><script src="\/landing\.js\?v=[0-9a-f]{8}"><\/script>$/)
  })

  it('keeps a private service closed: no front page, no guide, noindex, nothing in a shared cache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'web-private-'))
    await mkdir(join(dir, 'assets'))
    await writeFile(join(dir, 'index.html'), '<html><head><title>x</title></head><body>the app</body></html>')
    await writeFile(join(dir, 'landing.html'), 'a front page naming the source')
    await writeFile(join(dir, 'landing.js'), 'console.log(1)')
    await writeFile(join(dir, 'assets/app-1a2b.js'), 'built')
    const web = { dir, moved: ['/logos'], private: true }
    const app = createAgentApi({ title: 'Logos', version: '1.0.0', description: 'Logos.', tags: [], home: false, private: true, health: () => ({ logos: 5000 }), discovery: { sitemap: ['/'] }, auth: { realm: 'logos', keys: parseApiKeys(`me:${hashApiKey('k')}`), open: frontDoorOpen(web) } })
    app.get('/llms.txt', (c) => c.text('# Logos guide', 200, { 'cache-control': 'public, max-age=300' }))
    serveFrontDoor(app, web)
    const key = { headers: { authorization: 'Bearer k' } }
    const home = await app.request('/')
    expect([home.status, home.headers.get('location'), home.headers.get('x-robots-tag')]).toEqual([302, '/app', 'noindex, nofollow, noarchive, nosnippet, noimageindex'])
    for (const path of ['/app', '/assets/app-1a2b.js', '/landing.js', '/llms.txt', '/openapi.json', '/docs', '/sitemap.xml', '/.well-known/api-catalog']) expect([path, (await app.request(path)).status]).toEqual([path, 401])
    const unauthorized = await app.request('/llms.txt', { headers: { accept: 'text/markdown' } })
    expect(unauthorized.headers.get('link')).toBeNull()
    expect(await (await app.request('/robots.txt')).text()).toBe('User-agent: *\nContent-Signal: ai-train=no, search=no, ai-input=no\nDisallow: /\n')
    expect(await (await app.request('/api/health')).json()).toEqual({ status: 'ok', version: '1.0.0' })
    expect(await (await app.request('/app', key)).text()).toContain('<head><meta name="robots" content="noindex, nofollow">')
    expect((await app.request('/assets/app-1a2b.js', key)).headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect((await app.request('/llms.txt', key)).headers.get('cache-control')).toBe('private, max-age=300')
    expect((await app.request('/logos/fox')).headers.get('location')).toBe('/app/logos/fox')
  })

  it('still answers agents asking / for Markdown with the guide', async () => {
    const app = await sampleSite()
    app.get('/llms.txt', (c) => c.text('# Logos guide'))
    const response = await app.request('/', { headers: { accept: 'text/markdown' } })
    expect(response.headers.get('content-type')).toContain('text/markdown')
  })
})
