import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createAgentApi, errorHandler, problemResponse, rateLimit, sortQuery, decodeCursor, originOf, fillTemplate, guideFiles, guideModuleSource, HAL_JSON, linksOf, LinksSchema, mintApiKey, pageOf, pageSchema, parseApiKeys, pathWith, problemResponses, ProblemError, serveAiCatalog, serveGuide, snapshotEtag, tarGz, wantsMarkdown } from '../src/index.js'
import { guideSkills, inProcess, mcpResource, mcpServerFactory, mcpTool, mountMcp, routeOf } from '../src/mcp/index.js'
import { guideGaps, guideRoutes, lintOpenApi, toolRoutes } from '../src/testing/index.js'
import { migrate, openDb } from '../src/db/index.js'
import { OAUTH_MIGRATIONS } from '../src/oauth/schema.js'

const { key, hash } = mintApiKey('test')

/** A tiny catalog of two apps behind the whole standard. */
const sampleApi = async ({ private: hidden = false, toolsTtlMs }: { private?: boolean; toolsTtlMs?: number } = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'guide-'))
  await mkdir(join(dir, 'agents'))
  await mkdir(join(dir, 'skills/apps'), { recursive: true })
  await mkdir(join(dir, 'skills/apps/references'))
  await writeFile(join(dir, 'llms.txt'), '# Apps\n\n> {{counts.apps}} apps at {{origin}}.\n\n- List: `GET /api/v1/apps`\n\n## Playbooks\n\n{{skills.apps.playbooks}}\n\n## When stuck\n\n{{api.unblock}}\n')
  await writeFile(join(dir, 'agents/endpoints.md'), '# Endpoints\n\n`GET /api/v1/apps/{id}` · `GET /api/v1/nowhere`\n\n{{api.endpoints}}\n')
  await writeFile(join(dir, 'agents/mcp.md'), '# MCP\n\n{{mcp.count}} tools:\n\n{{mcp.tools}}\n\nResources:\n\n{{mcp.resources}}\n')
  await writeFile(join(dir, 'skills/apps/SKILL.md'), '---\nname: apps\ndescription: Use when finding apps at {{origin}}.\n---\n\n# Apps\n')
  await writeFile(join(dir, 'skills/apps/references/find-an-app.md'), '# Find an app\n\nLook an app up by name, then open it.\n\n## Steps\n')

  const apps = [{ id: 'a1', name: 'Alpha' }, { id: 'a2', name: 'Bravo' }]
  const app = createAgentApi({
    title: 'Sample',
    version: '1.0.0',
    description: 'A sample catalog.',
    tags: [{ name: 'Apps', description: 'The apps.' }],
    auth: { realm: 'sample', keys: parseApiKeys(`tester:${hash}`) },
    health: () => ({ snapshot: '2026-10-31' }),
    private: hidden,
  })
  app.use('/api/v1/*', snapshotEtag(() => '2026-10-31'))
  const AppSchema = z.object({ id: z.string(), name: z.string(), _links: LinksSchema }).openapi('App', { description: 'An app.' })
  const AppPageSchema = pageSchema('AppPage', 'apps', AppSchema, 'A page of apps.')
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/apps',
      operationId: 'listApps',
      summary: 'List apps',
      description: 'Every app, one page at a time; follow `_links.next`.',
      tags: ['Apps'],
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(10).default(1).openapi({ description: 'Per page.' }), cursor: z.string().optional().openapi({ description: 'From `_links.next`.' }) }) },
      responses: { 200: { description: 'A page.', content: { [HAL_JSON]: { schema: AppPageSchema } } }, ...problemResponses(400, 401) },
    }),
    (c) => {
      const { limit, cursor } = c.req.valid('query')
      const after = decodeCursor(cursor, z.object({ index: z.number() }))?.index ?? 0
      const origin = originOf(c)
      const items = apps.slice(after, after + limit).map((one) => ({ ...one, _links: linksOf(origin, { self: `/api/v1/apps/${one.id}` }) }))
      return c.json(pageOf({ origin, path: '/api/v1/apps', query: { limit }, name: 'apps', items, next: after + limit < apps.length ? { index: after + limit } : null }), 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/apps/{id}',
      operationId: 'getApp',
      summary: 'One app',
      description: 'An app by its id, with links to follow.',
      tags: ['Apps'],
      request: { params: z.object({ id: z.string().openapi({ description: 'The app id.', example: 'a1' }) }) },
      responses: { 200: { description: 'The app.', content: { [HAL_JSON]: { schema: AppSchema } } }, ...problemResponses(401, 404) },
    }),
    (c) => {
      const found = apps.find((one) => one.id === c.req.valid('param').id)
      if (!found) throw new ProblemError('not_found', { detail: 'No such app.' })
      return c.json({ ...found, _links: linksOf(originOf(c), { self: `/api/v1/apps/${found.id}` }) }, 200)
    },
  )
  let notes = 0
  app.use('/api/v1/notes', rateLimit({ policy: 'paid', limit: 3, windowSeconds: 60 }))
  app.openapi(
    createRoute({
      method: 'post', path: '/api/v1/notes', operationId: 'createNote', summary: 'Add a note', description: 'Adds a note and says how many exist.', tags: ['Apps'],
      request: { body: { required: true, content: { 'application/json': { schema: z.object({ text: z.string() }).openapi('NoteInput', { description: 'A note.' }) } } } },
      responses: { 201: { description: 'Added.', content: { [HAL_JSON]: { schema: z.object({ count: z.number() }).openapi('NoteCount', { description: 'How many notes.' }) } } }, ...problemResponses(400, 401, 409, 422, 429) },
    }),
    (c) => c.json({ count: ++notes }, 201),
  )
  app.get('/api/v1/apps/:id/logo', (c) => (c.req.param('id') === 'a1' ? c.json({ code: 'not_found' }, 404) : c.body(new Uint8Array([137, 80, 78, 71]), 200, { 'content-type': 'image/png' })))
  const { files } = serveGuide(app, { dir, vars: () => ({ counts: { apps: apps.length } }), full: ['llms.txt', 'agents/*', 'skills/*'] })
  const tools = [
    mcpTool({
      name: 'get_app',
      title: 'Get an app',
      description: 'One app by id.',
      input: z.object({ id: z.string().describe('The app id') }),
      output: AppSchema,
      call: ({ id }) => ({ path: `/api/v1/apps/${id}` }),
      summarize: (json) => `${json.name} (${json.id})`,
    }),
  ]
  const resources = [mcpResource({ name: 'app', title: 'An app', description: 'The app and its logo.', uriTemplate: 'sample://apps/{id}', read: ({ id }) => [{ path: `/api/v1/apps/${id}` }, { path: `/api/v1/apps/${id}/logo`, optional: true }] })]
  mountMcp(app, { factory: mcpServerFactory({ info: { name: 'sample', version: '1.0.0', title: 'Sample', description: 'Two apps.' }, instructions: 'Find apps.', tools, resources, callApi: inProcess(app), toolsTtlMs }), allowedHostnames: ['localhost'] })
  serveAiCatalog(app, { host: 'Sample', apiTitle: 'Sample', queries: { api: ['find an app by name', 'list apps'] } })
  return { app, files, tools, dir }
}

const auth = { authorization: `Bearer ${key}` }

describe('links', () => {
  it('builds absolute links and leaves out missing ones', () => {
    expect(linksOf('https://x.test', { self: '/a', next: null, img: { path: '/i.webp', type: 'image/webp' } })).toEqual({ self: { href: 'https://x.test/a' }, img: { href: 'https://x.test/i.webp', type: 'image/webp' } })
    expect(pathWith('/s', { q: 'pay wall', platform: ['ios', 'web'], empty: '', none: undefined })).toBe('/s?q=pay+wall&platform=ios&platform=web')
  })
})

describe('the standard API', () => {
  it('refuses a call without a key, with a problem and a Bearer challenge', async () => {
    const { app } = await sampleApi()
    const response = await app.request('/api/v1/apps')
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toBe('application/problem+json')
    expect(response.headers.get('www-authenticate')).toBe('Bearer realm="sample"')
    expect(await response.json()).toMatchObject({ code: 'unauthorized', status: 401, type: 'http://localhost/problems/unauthorized' })
    expect((await app.request('/api/v1/apps', { headers: { authorization: 'Bearer nope' } })).headers.get('www-authenticate')).toContain('error="invalid_token"')
  })

  it('renders a private service\u2019s guide for its callers, endpoints and all', async () => {
    const { app } = await sampleApi({ private: true })
    expect((await app.request('/agents/endpoints.md')).status).toBe(401)
    const endpoints = await (await app.request('/agents/endpoints.md', { headers: { authorization: `Bearer ${key}` } })).text()
    expect(endpoints).toContain('GET /api/v1/apps')
    expect((await app.request('/.well-known/ai-catalog.json', { headers: { authorization: `Bearer ${key}` } })).status).not.toBe(500)
  })

  it('sends same-site CORP by default and keeps a route\u2019s own', async () => {
    const { app } = await sampleApi()
    app.get('/frame/file.css', (c) => c.text('ok', 200, { 'cross-origin-resource-policy': 'cross-origin' }))
    expect((await app.request('/api/v1/apps')).headers.get('cross-origin-resource-policy')).toBe('same-site')
    expect((await app.request('/frame/file.css', { headers: { authorization: `Bearer ${key}` } })).headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect((await app.request('/robots.txt')).headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('pages with a cursor until next disappears', async () => {
    const { app } = await sampleApi()
    const first = await (await app.request('/api/v1/apps?limit=1', { headers: auth })).json()
    expect(first._embedded.apps.map((one: { name: string }) => one.name)).toEqual(['Alpha'])
    const second = await (await app.request(first._links.next.href.replace('http://localhost', ''), { headers: auth })).json()
    expect(second._embedded.apps.map((one: { name: string }) => one.name)).toEqual(['Bravo'])
    expect(second._links.next).toBeUndefined()
    expect((await app.request('/api/v1/apps', { headers: auth })).headers.get('content-type')).toBe('application/hal+json')
  })

  it('sends an upstream failure as 503 with Retry-After, never 502', async () => {
    const app = new Hono()
    app.get('/fails', () => {
      throw new ProblemError('upstream', { detail: 'The model failed.' })
    })
    app.get('/waits', (c) => problemResponse(c, 'upstream', { headers: { 'retry-after': '5' } }))
    app.onError(errorHandler)
    const fails = await app.request('/fails')
    expect(fails.status).toBe(503)
    expect(fails.headers.get('retry-after')).toBe('30')
    expect(await fails.json()).toMatchObject({ code: 'upstream', status: 503, detail: 'The model failed.' })
    expect((await app.request('/waits')).headers.get('retry-after')).toBe('5')
  })

  it('labels a thrown 503 unavailable, not upstream: only the app knows something behind it failed', async () => {
    const app = new Hono()
    app.get('/loading', () => {
      throw new HTTPException(503, { message: 'The index is loading.' })
    })
    app.onError(errorHandler)
    const loading = await app.request('/loading')
    expect(loading.status).toBe(503)
    expect(loading.headers.get('retry-after')).toBeNull()
    expect(await loading.json()).toMatchObject({ code: 'unavailable', detail: 'The index is loading.' })
  })

  it('answers bad input, bad cursors and unknown ids as problems', async () => {
    const { app } = await sampleApi()
    const invalid = await (await app.request('/api/v1/apps?limit=99', { headers: auth })).json()
    expect(invalid).toMatchObject({ code: 'bad_request', errors: [{ in: 'query', path: 'limit' }] })
    expect(await (await app.request('/api/v1/apps?cursor=zzz', { headers: auth })).json()).toMatchObject({ code: 'bad_request', errors: [{ path: 'cursor' }] })
    expect(await (await app.request('/api/v1/apps/a9', { headers: auth })).json()).toMatchObject({ code: 'not_found', detail: 'No such app.' })
    expect(await (await app.request('/api/v1/nope', { headers: auth })).json()).toMatchObject({ code: 'not_found' })
    expect(await (await app.request('/problems/not_found')).json()).toMatchObject({ code: 'not_found', status: 404 })
    expect(await (await app.request('/api/v1/apps?since=2025-01', { headers: auth })).json()).toMatchObject({ code: 'bad_request', detail: 'Unknown query parameter since. Allowed here: limit, cursor.', errors: [{ in: 'query', path: 'since' }] })
    expect(await (await app.request('/api/v1/apps/a1?x=1', { headers: auth })).json()).toMatchObject({ code: 'bad_request', detail: 'Unknown query parameter x. This operation takes no query parameters.' })
  })

  it('revalidates with ETags and never caches errors', async () => {
    const { app } = await sampleApi()
    const first = await app.request('/api/v1/apps/a1', { headers: auth })
    expect(first.headers.get('cache-control')).toBe('private, no-cache')
    const again = await app.request('/api/v1/apps/a1', { headers: { ...auth, 'if-none-match': first.headers.get('etag')! } })
    expect(again.status).toBe(304)
    expect((await app.request('/api/v1/apps/a9', { headers: auth })).headers.get('cache-control')).toBe('no-store')
  })

  it('never confirms an ETag from before a restart, the same snapshot or not', async () => {
    const { Hono } = await import('hono')
    const served = async () => {
      vi.resetModules()
      const { snapshotEtag: fresh } = await import('../src/core/cache.js')
      const app = new Hono().use('*', fresh(() => '2026-10-31')).get('/a', (c) => c.json({}))
      return app
    }
    const before = (await (await served()).request('/a')).headers.get('etag')!
    const after = await served()
    expect((await after.request('/a', { headers: { 'if-none-match': before } })).status).toBe(200)
  })

  it('keeps health, docs and the guide open, and fills the guide per request', async () => {
    const { app } = await sampleApi()
    expect(await (await app.request('/api/health')).json()).toEqual({ status: 'ok', version: '1.0.0', snapshot: '2026-10-31' })
    expect(await (await app.request('/llms.txt')).text()).toContain('> 2 apps at http://localhost.')
    const full = await (await app.request('/llms-full.txt')).text()
    expect(full.indexOf('# Apps\n\n> 2')).toBeLessThan(full.indexOf('# Endpoints'))
    expect((await app.request('/skills/apps/SKILL.md')).headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect((await app.request('/docs')).status).toBe(200)
  })

  it('publishes an OpenAPI 3.1 document that passes the lint, and the lint catches gaps', async () => {
    const { app } = await sampleApi()
    const doc = await (await app.request('/openapi.json')).json()
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' })
    expect(doc.paths['/api/health'].get.security).toEqual([])
    expect(lintOpenApi(doc)).toEqual([])
    expect(lintOpenApi({ paths: { '/x': { get: { operationId: 'Bad-Id', responses: { '200': {} } } } } })).toEqual([
      'GET /x: operationId "Bad-Id" is not camelCase',
      'GET /x: no summary',
      'GET /x: no description an agent can choose by',
      'GET /x: no tag',
      'GET /x: 200 has no body schema',
      'GET /x: documents no 4xx error',
    ])
  })

  it('finds guide mentions of routes that do not exist, and unfilled placeholders', async () => {
    const { app, files } = await sampleApi()
    const doc = await (await app.request('/openapi.json')).json()
    expect(guideRoutes(files, doc)).toEqual(['agents/endpoints.md: GET /api/v1/nowhere'])
    expect(guideGaps(files, {})).toEqual(['llms.txt: {{counts.apps}}'])
    expect(guideGaps(files, { counts: { apps: 2 } }, { doc })).toEqual([])
    expect(guideGaps(new Map([['x.md', '{{api.endpoint}}']]), {}, { doc })).toEqual(['x.md: {{api.endpoint}}'])
    expect(fillTemplate('{{a.b}} of {{n}}', { a: { b: 'x' }, n: 12000 }).text).toBe('x of 12,000')
    expect(fillTemplate('{{skills.sample-effects.playbooks}}', { skills: { 'sample-effects': { playbooks: '- find' } } }).text).toBe('- find')
  })
})

describe('the generated guide', () => {
  it('writes every operation from the spec, with example calls and parameters', async () => {
    const { app } = await sampleApi()
    const endpoints = await (await app.request('/agents/endpoints.md')).text()
    expect(endpoints).toContain('### Apps\n\nThe apps.')
    expect(endpoints).toContain('- `GET /api/v1/apps/a1` — An app by its id, with links to follow. Returns `App` { id, name, _links }. Spec: `getApp`.')
    expect(endpoints).toContain('Returns `AppPage` { count, total, _links, _embedded.apps[] }.')
    expect(endpoints).toContain('Query: `limit` (default 1).')
    expect(endpoints).toContain('`GET /api/health` — Answers without a key: `ok` while the service can serve, with the version it runs. No key needed.')
  })

  it('lists each MCP tool with the route its call reaches, and catches tools that reach none', async () => {
    const { app, tools } = await sampleApi()
    const mcp = await (await app.request('/agents/mcp.md')).text()
    expect(mcp).toContain('1 tools:\n\n- **`get_app`** → `GET /api/v1/apps/{id}` — One app by id.')
    const doc = await (await app.request('/openapi.json')).json()
    expect(toolRoutes(tools, doc)).toEqual([])
    expect(toolRoutes([mcpTool({ ...tools[0]!, name: 'lost', call: () => ({ path: '/api/v1/gone' }) })], doc)).toEqual(['lost'])
  })

  it('lists the playbooks and how to get unstuck, filled for the caller’s origin', async () => {
    const { app } = await sampleApi()
    const llms = await (await app.request('/llms.txt', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'apps.example' } })).text()
    expect(llms).toContain('- [Find an app](/skills/apps/references/find-an-app.md): Look an app up by name, then open it.')
    expect(llms).toContain('`curl -s https://apps.example/openapi.json | jq')
    expect(llms).not.toContain('{{')
  })
})

describe('discovery', () => {
  const get = async (app: Awaited<ReturnType<typeof sampleApi>>['app'], path: string, headers: Record<string, string> = {}) => {
    const response = await app.request(path, { headers })
    return { status: response.status, headers: response.headers, text: await response.text() }
  }

  it('publishes an RFC 9727 API catalog and RFC 8288 Link headers, on 401s too', async () => {
    const { app } = await sampleApi()
    const catalog = await get(app, '/.well-known/api-catalog')
    expect(catalog.headers.get('content-type')).toBe('application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"')
    expect(JSON.parse(catalog.text).linkset[0]).toMatchObject({ anchor: 'http://localhost/api', 'service-desc': [{ href: 'http://localhost/openapi.json' }], status: [{ href: 'http://localhost/api/health' }] })
    expect((await get(app, '/api/health')).headers.get('link')).toContain('</.well-known/api-catalog>; rel="api-catalog"')
    const refused = await get(app, '/api/v1/apps')
    expect(refused.status).toBe(401)
    expect(refused.headers.get('link')).toContain('rel="service-desc"')
    expect((await get(app, '/api/v1/apps', auth)).headers.get('link')).toBeNull()
  })

  it('serves robots.txt with Content Signals and answers Markdown to agents at / and /docs', async () => {
    const { app } = await sampleApi()
    const robots = await get(app, '/robots.txt')
    expect(robots.text).toContain('Content-Signal: ai-train=no, search=no, ai-input=no\nDisallow: /')
    expect(robots.text).toContain('Agentmap: http://localhost/.well-known/ai-catalog.json')
    const markdown = await get(app, '/', { accept: 'text/markdown, text/html;q=0.8' })
    expect(markdown.headers.get('content-type')).toBe('text/markdown; charset=utf-8')
    expect(Number(markdown.headers.get('x-markdown-tokens'))).toBeGreaterThan(10)
    expect(markdown.text).toContain('# Apps')
    expect((await get(app, '/', { accept: 'text/html' })).status).toBe(302)
    expect((await get(app, '/docs', { accept: 'text/html,text/markdown' })).headers.get('content-type')).toContain('text/html')
    expect(wantsMarkdown('text/html, text/markdown')).toBe(false)
  })

  it('sends people who open the address to the browser app when the app has one', async () => {
    const withApp = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], home: 'app', auth: { realm: 'sample', keys: parseApiKeys(undefined) } })
    const home = await withApp.request('/', { headers: { accept: 'text/html' } })
    expect([home.status, home.headers.get('location')]).toEqual([302, '/app/'])
    expect((await withApp.request('/app')).headers.get('location')).toBe('/app/')
    const kept = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], home: false, auth: { realm: 'sample', keys: parseApiKeys(undefined) } })
    expect((await kept.request('/')).status).toBe(401)
  })

  it('indexes skills with digests of the exact bytes served, as a stable archive when they have references', async () => {
    const { app } = await sampleApi()
    const index = JSON.parse((await get(app, '/.well-known/agent-skills/index.json')).text)
    expect(index.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json')
    expect(index.skills).toMatchObject([{ name: 'apps', type: 'archive', description: 'Use when finding apps at http://localhost.', url: 'http://localhost/.well-known/agent-skills/apps.tar.gz' }])
    const archive = await app.request('/.well-known/agent-skills/apps.tar.gz')
    const bytes = new Uint8Array(await archive.arrayBuffer())
    expect(archive.headers.get('content-type')).toBe('application/gzip')
    expect(index.skills[0].digest).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`)
    const tar = gunzipSync(bytes).toString('latin1')
    expect(tar.startsWith('SKILL.md')).toBe(true)
    expect(tar).toContain('references/find-an-app.md')
    expect(tarGz([['a.md', 'x']])).toEqual(tarGz([['a.md', 'x']]))
    expect(() => tarGz([['../a.md', 'x']])).toThrow('Unsafe')
    const again = await app.request('/.well-known/agent-skills/index.json', { headers: { 'if-none-match': archive.headers.get('etag') ?? '' } })
    expect(again.status).toBe(200)
  })

  it('publishes an MCP Server Card beside the endpoint and at the well-known path, with caching and CORS', async () => {
    const { app } = await sampleApi()
    const card = await get(app, '/mcp/server-card', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'apps.example' })
    expect(card.headers.get('content-type')).toBe('application/mcp-server-card+json')
    expect(card.headers.get('access-control-allow-origin')).toBe('*')
    expect(card.headers.get('cache-control')).toBe('public, max-age=3600')
    expect(JSON.parse(card.text)).toMatchObject({
      $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
      name: 'example.apps/sample', version: '1.0.0', title: 'Sample', description: 'Two apps.',
      remotes: [{ type: 'streamable-http', url: 'https://apps.example/mcp', headers: [{ name: 'Authorization', isSecret: true }], supportedProtocolVersions: expect.arrayContaining(['2026-07-28', '2025-11-25']) }],
    })
    expect((await get(app, '/.well-known/mcp/server-card.json')).status).toBe(200)
    expect((await app.request('/mcp/server-card', { headers: { 'if-none-match': card.headers.get('etag')! } })).status).toBe(200)
    const same = await app.request('/.well-known/mcp/server-card.json', { headers: { 'if-none-match': (await app.request('/.well-known/mcp/server-card.json')).headers.get('etag')! } })
    expect(same.status).toBe(304)
  })

  it('lists the API, the MCP server and each skill in an AI Catalog', async () => {
    const { app } = await sampleApi()
    const catalog = await get(app, '/.well-known/ai-catalog.json')
    expect(catalog.headers.get('content-type')).toBe('application/ai-catalog+json')
    expect(catalog.headers.get('access-control-allow-origin')).toBe('*')
    const body = JSON.parse(catalog.text)
    expect(body).toMatchObject({ specVersion: '1.0', host: { displayName: 'Sample', identifier: 'did:web:localhost' } })
    expect(body.entries.map((entry: { identifier: string; type: string }) => [entry.identifier, entry.type])).toEqual([
      ['urn:air:localhost:api:openapi', 'application/vnd.oai.openapi+json;version=3.1'],
      ['urn:air:localhost:mcp:sample', 'application/mcp-server-card+json'],
      ['urn:air:localhost:skill:apps', 'application/agent-skills+gzip'],
    ])
    for (const entry of body.entries) expect(Object.keys(entry).filter((member) => member === 'url' || member === 'data')).toEqual(['url'])
    for (const entry of body.entries) expect(entry.displayName).toEqual(expect.any(String))
    expect(body.entries[2].digest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('the copy-in CLI', () => {
  const KIT_VERSION: string = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).version
  const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), ...args], { cwd, encoding: 'utf8' })

  it('writes the guide folder as a module that serves the same guide (for Workers)', async () => {
    const { app, dir } = await sampleApi()
    const out = join(await mkdtemp(join(tmpdir(), 'kit-guide-')), 'src', 'guide.gen.ts')
    const written = cli(dir, 'guide', '--from', '.', '--out', out)
    expect(written.status, written.stderr).toBe(0)
    const source = await readFile(out, 'utf8')
    expect(source).toBe(guideModuleSource(guideFiles(dir)))
    expect(source).toContain('"skills/apps/references/find-an-app.md": ')
    const { GUIDE_FILES } = await import(out)
    const fromModule = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(undefined), open: ['/llms.txt', '/openapi.json'] } })
    serveGuide(fromModule, { files: GUIDE_FILES, vars: () => ({ counts: { apps: 2 } }), full: ['llms.txt'] })
    const fromFolder = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(undefined), open: ['/llms.txt', '/openapi.json'] } })
    serveGuide(fromFolder, { dir, vars: () => ({ counts: { apps: 2 } }), full: ['llms.txt'] })
    expect(await (await fromModule.request('/llms.txt')).text()).toBe(await (await fromFolder.request('/llms.txt')).text())
    expect((await app.request('/llms.txt', { headers: auth })).status).toBe(200)
  })

  it('copies modules with what they require, a generated index and a lock of hashes', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    const added = cli(app, 'add', 'mcp', 'testing', '--dir', 'src/kit')
    expect(added.status).toBe(0)
    expect(added.stdout).toContain('Copied core, guide, mcp, testing')
    expect(added.stdout).toContain('pnpm add hono@')
    const lock = JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8'))
    expect(lock.modules).toEqual(['core', 'guide', 'mcp', 'testing'])
    expect(Object.keys(lock.files)).toContain('guide/reference.ts')
    const index = await readFile(join(app, 'src/kit/index.ts'), 'utf8')
    expect(index).toContain("export * from './guide/guide.js'")
    expect(index).not.toContain('README')
    // Each module's README comes with it: what it is for, an example, its rules
    expect(await readFile(join(app, 'src/kit/mcp/README.md'), 'utf8')).toContain('# mcp')
    expect(await readFile(join(app, 'src/kit/core/README.md'), 'utf8')).toContain('createAgentApi')
    expect(index).not.toContain('mcp/')
    expect(added.stdout).toContain("'./src/kit/mcp/index.js'")
    expect(await readFile(join(app, 'src/kit/core/api.ts'), 'utf8')).toBe(await readFile(join(import.meta.dirname, '..', 'src/core/api.ts'), 'utf8'))
  })

  it('tells your edits from the kit’s and never overwrites an edit without --force', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'core', '--dir', 'kit')
    expect(cli(app, 'diff', '--dir', 'kit').status).toBe(0)
    await writeFile(join(app, 'kit/core/hal.ts'), '// mine\n')
    const lock = JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8'))
    await writeFile(join(app, 'kit/kit.json'), JSON.stringify({ ...lock, files: { ...lock.files, 'core/cache.ts': 'stale' } }))
    const diff = cli(app, 'diff', '--dir', 'kit')
    expect(diff.status).toBe(1)
    expect(diff.stdout).toMatch(/you edited\s+core\/hal\.ts/)
    expect(diff.stdout).toMatch(/both changed\s+core\/cache\.ts|kit changed\s+core\/cache\.ts/)
    cli(app, 'update', '--dir', 'kit')
    expect(await readFile(join(app, 'kit/core/hal.ts'), 'utf8')).toBe('// mine\n')
    cli(app, 'update', '--dir', 'kit', '--force')
    expect(await readFile(join(app, 'kit/core/hal.ts'), 'utf8')).not.toBe('// mine\n')
    expect(cli(app, 'add', 'nope', '--dir', 'kit').stderr).toContain('no module "nope"')
  })

  it('checks a copy against its record: missing, edited and behind, each with its fix, and exits 1', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    expect(cli(app, 'doctor').stdout).toContain('`kit adopt --dir src/kit`')
    expect(cli(app, 'doctor').status).toBe(1)
    cli(app, 'add', 'pagination')
    const clean = cli(app, 'doctor')
    expect([clean.status, clean.stdout]).toEqual([0, `src/kit matches kit ${KIT_VERSION}: core, pagination\n`])
    await writeFile(join(app, 'src/kit/core/hal.ts'), '// mine\n')
    await rm(join(app, 'src/kit/core/kv.ts'))
    const lock = JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8'))
    await writeFile(join(app, 'src/kit/kit.json'), JSON.stringify({ ...lock, version: '0.0.1', files: { ...lock.files, 'pagination/index.ts': 'older' } }))
    const sick = cli(app, 'doctor')
    expect(sick.status).toBe(1)
    expect(sick.stdout.trim().split('\n')).toEqual([
      'missing  core/kv.ts: `kit update --dir src/kit` writes it again',
      "edited   core/hal.ts: yours to keep; `kit diff --dir src/kit --patch` shows the change, `kit update --dir src/kit --force` takes the kit's",
      // The file on disk no longer matches what the older kit wrote, and the kit moved on: both, so update keeps it
      "edited   pagination/index.ts: yours to keep; `kit diff --dir src/kit --patch` shows the change, `kit update --dir src/kit --force` takes the kit's",
      `behind   pagination was copied from kit 0.0.1 and kit ${KIT_VERSION} changed it: \`kit diff --dir src/kit --patch\`, then \`kit update --dir src/kit\``,
      '4 to fix in src/kit',
    ])
    cli(app, 'update', '--force')
    expect(cli(app, 'doctor').status).toBe(0)
    // Only the version is behind: update records it
    await writeFile(join(app, 'src/kit/kit.json'), JSON.stringify({ ...lock, version: '0.0.1' }))
    expect(cli(app, 'doctor').stdout).toContain(`behind   kit.json says kit 0.0.1, this is ${KIT_VERSION} with the same files`)
  })

  it('adopts parts copied by the shadcn CLI: writes the record from what is on disk', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    const registry = JSON.parse(await readFile(join(import.meta.dirname, '..', 'registry.json'), 'utf8'))
    // What `shadcn add escalay/api-kit/pagination` leaves: each file at its target, no kit.json, no index.ts
    const shadcnAdd = async (name: string) => {
      for (const file of registry.items.find((item: { name: string }) => item.name === name).files) {
        const target = join(app, file.target.replace('~/', ''))
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, await readFile(join(import.meta.dirname, '..', file.path), 'utf8'))
      }
    }
    expect(cli(app, 'adopt').stderr).toContain('no parts in src/kit')
    await shadcnAdd('core')
    await shadcnAdd('pagination')
    await shadcnAdd('mcp')
    await writeFile(join(app, 'src/kit/core/hal.ts'), '// mine\n')
    const adopted = cli(app, 'doctor', '--adopt')
    expect(adopted.stdout).toContain(`Adopted core, pagination, mcp in src/kit as kit ${KIT_VERSION}`)
    // An edit made before adopting is still an edit, not the kit's text
    expect(adopted.stdout).toMatch(/^edited   core\/hal\.ts/m)
    expect(adopted.status).toBe(1)
    const lock = JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8'))
    expect(lock).toMatchObject({ source: '@escalay/kit', version: KIT_VERSION, modules: ['core', 'pagination', 'mcp'] })
    expect(await readFile(join(app, 'src/kit/index.ts'), 'utf8')).toContain("export * from './pagination/index.js'")
    expect(cli(app, 'adopt').stderr).toContain('already has a kit.json')
    cli(app, 'update', '--force')
    expect(cli(app, 'doctor').status).toBe(0)
    // A part whose required part is not on disk is recorded with it; doctor names the missing files
    const lone = await mkdtemp(join(tmpdir(), 'kit-app-'))
    const loneAdd = cli(lone, 'add', 'pagination')
    expect(loneAdd.status).toBe(0)
    await rm(join(lone, 'src/kit/kit.json'))
    await rm(join(lone, 'src/kit/core'), { recursive: true })
    expect(cli(lone, 'adopt').stdout).toContain('Recorded core too (they are required)')
    expect(cli(lone, 'doctor').stdout).toContain('missing  core/api.ts')
  })

  it('never reads a flag’s value as a name', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    expect(cli(app, 'add', '--dir', 'kit', 'core').stdout).toContain(`Copied core (kit ${KIT_VERSION}) into kit`)
  })

  it('puts vector search beside the server kit and the browser modules in the app’s frontend, without a server index', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    expect(cli(app, 'add', 'vector-search', 'web', '--dir', 'api/kit').stdout).toContain('Copied core, mcp, vectors, vector-search, web')
    const index = await readFile(join(app, 'api/kit/index.ts'), 'utf8')
    expect(index).toContain("export * from './vectors/index.js'")
    expect(index).toContain("export * from './web/index.js'")
    expect(index).not.toContain('vector-search')
    const web = cli(app, 'add', 'search-react', '--dir', 'web/search')
    expect(web.stdout).toContain('Copied search-client, search-react')
    expect(web.stdout).toContain("'./web/search/browser/search-react.js'")
    expect(web.stdout).not.toContain('index.js')
    expect(JSON.parse(await readFile(join(app, 'web/search/kit.json'), 'utf8')).files).toEqual({ 'browser/README.md': expect.any(String), 'browser/search-client.ts': expect.any(String), 'browser/search-react.ts': expect.any(String) })
    await expect(readFile(join(app, 'web/search/index.ts'), 'utf8')).rejects.toThrow()
    expect(cli(app, 'diff', '--dir', 'web/search').status).toBe(0)
  })

  it('tracks the browser modules in their own folder with the one kit.json', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    const added = cli(app, 'add', 'boards', 'boards-react', '--dir', 'src/kit', '--web-dir', '../web')
    expect(added.stdout).toContain("'./src/web/browser/boards-react.js'")
    const lock = JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8'))
    expect(lock.webDir).toBe('../web')
    expect(Object.keys(lock.files)).toEqual(expect.arrayContaining(['boards/index.ts', 'boards/refs.ts', '@web/browser/boards-client.ts', '@web/browser/boards-react.ts', '@web/boards/refs.ts']))
    expect(await readFile(join(app, 'src/web/boards/refs.ts'), 'utf8')).toBe(await readFile(join(app, 'src/kit/boards/refs.ts'), 'utf8'))
    await expect(readFile(join(app, 'src/kit/browser/boards-client.ts'), 'utf8')).rejects.toThrow()
    expect(cli(app, 'diff', '--dir', 'src/kit').status).toBe(0)
    // The web dir is remembered: a later add and an update keep using it
    await writeFile(join(app, 'src/web/browser/boards-client.ts'), 'stale')
    const lockWithStale = { ...lock, files: { ...lock.files, '@web/browser/boards-client.ts': (await import('node:crypto')).createHash('sha256').update('stale').digest('hex') } }
    await writeFile(join(app, 'src/kit/kit.json'), JSON.stringify(lockWithStale))
    expect(cli(app, 'update', '--dir', 'src/kit').stdout).toContain('updated       @web/browser/boards-client.ts')
    expect(await readFile(join(app, 'src/web/browser/boards-client.ts'), 'utf8')).toContain('createBoardsClient')
    // The front door module lives in a web/ folder of its own, beside the browser files' web dir, not inside it
    cli(app, 'add', 'web', '--dir', 'src/kit')
    expect(await readFile(join(app, 'src/kit/web/index.ts'), 'utf8')).toContain('serveFrontDoor')
    await expect(readFile(join(app, 'src/web/index.ts'), 'utf8')).rejects.toThrow()
    // A kit.json from 1.0.1 keyed web-dir files `web/…`: read as `@web/…`, so nothing is lost or rewritten
    const current = JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8'))
    await writeFile(join(app, 'src/kit/kit.json'), JSON.stringify({ ...current, files: Object.fromEntries(Object.entries(current.files as Record<string, string>).map(([key, hash]) => [key.replace(/^@web\//, 'web/'), hash])) }))
    expect(cli(app, 'diff', '--dir', 'src/kit').status).toBe(0)
    cli(app, 'add', 'search-client', '--dir', 'src/kit')
    expect(JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8')).files).toHaveProperty(['@web/browser/search-client.ts'])
  })

  it('makes a new app and features that typecheck and pass their own tests', async () => {
    // Inside the kit, so the app resolves the kit's installed packages without an install
    const parent = join(import.meta.dirname, '.generated', `run-${process.pid}`)
    await rm(parent, { recursive: true, force: true })
    await mkdir(parent, { recursive: true })
    try {
      // The way `npm create escalay demo-api` starts: create-escalay hands its arguments to `init`; flags may come first
      const made = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'packages/create-escalay/index.mjs'), '--preset', 'api', '--yes', '--title', 'Demo API', 'demo-api'], { cwd: parent, encoding: 'utf8' })
      expect(made.status, made.stderr).toBe(0)
      expect(existsSync(join(parent, 'api'))).toBe(false)
      const later = cli(parent, 'init', 'box', '--preset', 'selfhosted', '--yes')
      expect([later.status, later.stderr]).toEqual([1, 'kit: the selfhosted preset arrives with escalay/selfhost-kit; use --preset api\n'])
      expect(existsSync(join(parent, 'box'))).toBe(false)
      expect(cli(parent, 'init', 'box', '--preset', 'blog').stderr).toContain('--preset is one of api, app, selfhosted')
      expect(cli(parent, 'feature', 'reading-lists', '--app', 'demo-api').status).toBe(0)
      expect(cli(parent, 'feature', 'reading-lists', '--app', 'demo-api').stderr).toContain('already exists')
      expect(cli(parent, 'feature', 'Bad_Name', '--app', 'demo-api').stderr).toContain('plural kebab-case')
      const app = join(parent, 'demo-api')
      const features = await readFile(join(app, 'src/features/index.ts'), 'utf8')
      expect(features).toContain("import { feature as readingLists } from './reading-lists/index.js'")
      expect(await readFile(join(app, 'src/features/reading-lists/schema.ts'), 'utf8')).toContain("sqliteTable('reading_lists'")
      expect(await readFile(join(app, 'src/features/reading-lists/tools.ts'), 'utf8')).toContain("name: 'get_reading_list'")
      expect(JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8')).modules).toEqual(['core', 'db', 'oauth', 'guide', 'mcp', 'testing'])
      const bin = (name: string) => join(import.meta.dirname, '..', 'node_modules/.bin', name)
      // The product's own skill, the place for developer skills, and the link coding agents find them through
      for (const path of ['guide/skills/demo-api/SKILL.md', 'guide/skills/demo-api/references/find-your-way.md', '.agents/skills/README.md']) expect(existsSync(join(app, path)), path).toBe(true)
      expect(await readlink(join(app, '.claude/skills'))).toBe('../.agents/skills')
      // Installing from the repository must find the product's skill, which is not where the installer looks first
      expect(JSON.parse(await readFile(join(app, 'skills.sh.json'), 'utf8'))).toEqual({ paths: ['./guide/skills'] })
      expect(await readFile(join(app, 'guide/skills/demo-api/SKILL.md'), 'utf8')).toMatch(/^---\nname: demo-api\ndescription: Use when a task needs Demo API\./)
      expect(await readFile(join(app, 'src/guide.gen.ts'), 'utf8')).toContain('"skills/demo-api/references/find-your-way.md"')
      // Both runtimes by default: Node's server.ts and container, and Workers' worker.ts, wrangler.jsonc and D1 files
      for (const path of ['src/server.ts', 'Dockerfile', 'src/worker.ts', 'wrangler.jsonc', 'scripts/migrations.ts', 'src/guide.gen.ts', '.dev.vars.example']) expect(existsSync(join(app, path)), path).toBe(true)
      expect(JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).scripts).toMatchObject({ dev: 'tsx watch src/server.ts', 'dev:worker': 'wrangler dev', deploy: expect.stringContaining('wrangler d1 migrations apply DB --remote') })
      const migrations = spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' })
      expect(migrations.status, migrations.stderr).toBe(0)
      expect((await readdir(join(app, 'migrations'))).sort()).toEqual(['0000_kit_migrations.sql', '0001_oauth_1.sql', '0002_guards_1.sql', '0003_notes_1.sql', '0004_reading-lists_1.sql'])
      expect(spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' }).stdout).toContain('current')
      // A database `migrate()` already brought up (local dev) takes the files without a duplicate record
      const { DatabaseSync } = await import('node:sqlite')
      const sqlite = new DatabaseSync(':memory:')
      await migrate(await openDb(sqlite), 'oauth', OAUTH_MIGRATIONS)
      for (const file of ['0000_kit_migrations.sql', '0001_oauth_1.sql']) sqlite.exec(await readFile(join(app, 'migrations', file), 'utf8'))
      expect(sqlite.prepare("select count(*) as n from kit_migrations where feature = 'oauth'").get()).toEqual({ n: 1 })
      for (const project of ['tsconfig.json', 'test/workers/tsconfig.json']) {
        const typecheck = spawnSync(bin('tsc'), ['--noEmit', '-p', project], { cwd: app, encoding: 'utf8' })
        expect(typecheck.status, `${project}: ${typecheck.stdout}`).toBe(0)
      }
      // Node and workerd: the generated tests, the guide module current, D1 brought up by migrations/, MCP on Workers
      // Plain output: CI asks for colour, which would sit between the words matched below
      const tests = spawnSync(bin('vitest'), ['run', '--root', '.'], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
      expect(tests.status, tests.stdout + tests.stderr).toBe(0)
      expect(tests.stdout).toMatch(/Tests\s+11 passed/)

      // The client and its command line: `kit sdk` makes both; the CLI compiles on its own and offers the app's tools
      const sdk = cli(parent, 'sdk', '--app', 'demo-api')
      expect(sdk.status, sdk.stderr).toBe(0)
      for (const path of ['sdk/cli/bin.ts', 'sdk/cli/engine/index.ts', 'sdk/cli/jobs/index.ts', 'sdk/cli/tsconfig.json', 'sdk/test/cli.test.ts']) expect(existsSync(join(app, path)), path).toBe(true)
      expect(JSON.parse(await readFile(join(app, 'sdk/package.json'), 'utf8'))).toMatchObject({ name: 'demo-api-client', bin: { 'demo-api': './dist/cli/bin.js' }, engines: { node: '>=20.10' } })
      expect(await readFile(join(app, 'sdk/cli/bin.ts'), 'utf8')).toContain("createCli({ name: 'demo-api', envPrefix: 'DEMO_API', version, snapshot, jobs })")
      expect(JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).scripts.typecheck).toContain('tsc --noEmit -p sdk/cli/tsconfig.json')
      expect(JSON.parse(await readFile(join(app, '.oxfmtrc.json'), 'utf8')).ignorePatterns).toContain('sdk/cli/engine/**')
      // What `pnpm sdk:types` runs first: the OpenAPI document, and the commands the CLI packages
      const written = spawnSync(bin('tsx'), ['scripts/openapi.ts'], { cwd: app, encoding: 'utf8' })
      expect(written.status, written.stderr).toBe(0)
      const packaged = JSON.parse(await readFile(join(app, 'sdk/cli/commands.json'), 'utf8')) as { app: string; commands: { name: string }[] }
      expect(packaged.app).toBe('demo-api')
      expect(packaged.commands.map((command) => command.name)).toEqual(expect.arrayContaining(['note list', 'note view', 'reading-list create', 'reading-list delete']))
      for (const project of ['tsconfig.json', 'sdk/cli/tsconfig.json']) {
        const typecheck = spawnSync(bin('tsc'), ['--noEmit', '-p', project], { cwd: app, encoding: 'utf8' })
        expect(typecheck.status, `${project}: ${typecheck.stdout}`).toBe(0)
      }
      const cliTests = spawnSync(bin('vitest'), ['run', '--root', '.', 'sdk/test/cli.test.ts'], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
      expect(cliTests.status, cliTests.stdout + cliTests.stderr).toBe(0)
      expect(cliTests.stdout).toMatch(/Tests\s+3 passed/)
      // An app whose sdk/ came before the command line takes it with `kit cli`; `--update` takes a newer engine only
      await rm(join(app, 'sdk/cli'), { recursive: true })
      await rm(join(app, 'sdk/test/cli.test.ts'))
      expect(cli(parent, 'cli', '--app', 'demo-api', '--bin', 'demo').status).toBe(0)
      expect(JSON.parse(await readFile(join(app, 'sdk/package.json'), 'utf8')).bin).toMatchObject({ demo: './dist/cli/bin.js' })
      expect(await readFile(join(app, 'sdk/cli/bin.ts'), 'utf8')).toContain("name: 'demo', envPrefix: 'DEMO'")
      expect(existsSync(join(app, 'sdk/test/cli.test.ts'))).toBe(true)
      expect(cli(parent, 'cli', '--app', 'demo-api').stderr).toContain('sdk/cli already exists')
      await writeFile(join(app, 'sdk/cli/engine/index.ts'), '// edited\n')
      expect(cli(parent, 'cli', '--app', 'demo-api', '--update').status).toBe(0)
      expect(await readFile(join(app, 'sdk/cli/engine/index.ts'), 'utf8')).toBe(await readFile(join(import.meta.dirname, '..', 'templates/sdk/sdk/cli/engine/index.ts'), 'utf8'))
      expect(cli(parent, 'cli', '--app', 'edge-none').stderr).toContain('no sdk/package.json')

      expect(cli(parent, 'init', 'edge-api', '--runtime', 'cloudflare').status).toBe(0)
      for (const path of ['src/server.ts', 'Dockerfile', 'container']) expect(existsSync(join(parent, 'edge-api', path)), path).toBe(false)
      expect(JSON.parse(await readFile(join(parent, 'edge-api/package.json'), 'utf8')).scripts.dev).toBe('wrangler dev')
      // AGENTS.md speaks only of the runtimes the app has, and never of pnpm's own `deploy`
      const agentsOf = (name: string) => readFile(join(parent, name, 'AGENTS.md'), 'utf8')
      const [both, edge] = [await agentsOf('demo-api'), await agentsOf('edge-api')]
      expect(both).toContain('`pnpm dev:worker`')
      expect(both).toContain('src/server.ts')
      expect(edge).toContain('`pnpm dev`: the Worker locally')
      expect(edge).not.toMatch(/server\.ts|entrypoint/)
      for (const text of [both, edge]) {
        expect(text).not.toMatch(/runtime:|__worker_dev__/)
        expect(text).toContain('`pnpm run deploy`')
      }
      // Prebuilt binaries need no build scripts, so `pnpm install` doesn't stop to ask
      expect(await readFile(join(parent, 'edge-api/pnpm-workspace.yaml'), 'utf8')).toContain('workerd: false')
      expect(cli(parent, 'init', 'box-api', '--runtime', 'node').status).toBe(0)
      for (const path of ['src/worker.ts', 'wrangler.jsonc', 'test/workers']) expect(existsSync(join(parent, 'box-api', path)), path).toBe(false)
      const box = await readFile(join(parent, 'box-api/AGENTS.md'), 'utf8')
      expect(box).not.toMatch(/wrangler|worker\.ts|runtime:/)
      expect(box).toContain('`pnpm dev`: the API on Node')
      const nodeOnly = spawnSync(bin('tsc'), ['--noEmit', '-p', 'tsconfig.json'], { cwd: join(parent, 'box-api'), encoding: 'utf8' })
      expect(nodeOnly.status, nodeOnly.stdout).toBe(0)
      expect(cli(parent, 'init', 'odd-api', '--runtime', 'deno').stderr).toContain('--runtime is one of')
      // The compatibility date is the pinned Workers types' day, never today: workerd refuses a date ahead of its build
      const typesDay = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')).devDependencies['@cloudflare/workers-types'].match(/\.(\d{4})(\d{2})(\d{2})\./).slice(1).join('-')
      const edgeWrangler = await readFile(join(parent, 'edge-api/wrangler.jsonc'), 'utf8')
      expect(edgeWrangler).toContain(`"compatibility_date": "${typesDay}"`)
      // Every app lints and formats with oxlint and oxfmt, the kit's copy left out
      for (const name of ['demo-api', 'edge-api', 'box-api']) {
        expect(JSON.parse(await readFile(join(parent, name, 'package.json'), 'utf8')).scripts).toMatchObject({ lint: 'oxlint', format: 'oxfmt' })
        expect(JSON.parse(await readFile(join(parent, name, '.oxlintrc.json'), 'utf8')).ignorePatterns).toContain('src/kit/**')
        expect(JSON.parse(await readFile(join(parent, name, '.oxfmtrc.json'), 'utf8')).ignorePatterns).toContain('src/kit/**')
      }
      // Nothing of the app preset reaches an API-only app
      for (const text of [edgeWrangler, await readFile(join(parent, 'edge-api/src/app.ts'), 'utf8'), await readFile(join(parent, 'edge-api/vitest.config.ts'), 'utf8'), await agentsOf('edge-api')]) expect(text).not.toMatch(/preset:|"assets"|home: 'app'|plugin-react|vite build/)
      expect(existsSync(join(parent, 'edge-api/web'))).toBe(false)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('makes an app with a browser side that typechecks and passes its tests on all three sides', async () => {
    const parent = join(import.meta.dirname, '.generated', `run-app-${process.pid}`)
    await rm(parent, { recursive: true, force: true })
    await mkdir(parent, { recursive: true })
    try {
      const bin = (name: string) => join(import.meta.dirname, '..', 'node_modules/.bin', name)
      const refused = cli(parent, 'init', 'box', '--preset', 'app', '--runtime', 'node')
      expect([refused.status, refused.stderr]).toEqual([1, 'kit: the app preset runs on Cloudflare Workers; leave --runtime out or use --runtime cloudflare\n'])
      const made = cli(parent, 'init', 'desk', '--preset', 'app', '--title', 'Desk')
      expect(made.status, made.stderr).toBe(0)
      expect(made.stdout).toContain('for Cloudflare Workers, with a browser app in web/,')
      const app = join(parent, 'desk')
      const read = (path: string) => readFile(join(app, path), 'utf8')
      for (const path of ['index.html', 'vite.config.ts', 'tsconfig.web.json', 'web/main.tsx', 'web/router.tsx', 'web/routes/__root.tsx', 'web/routes/index.tsx', 'web/routeTree.gen.ts', 'web/styles.css', 'web/app.test.tsx', 'src/worker.ts', 'wrangler.jsonc']) expect(existsSync(join(app, path)), path).toBe(true)
      for (const path of ['src/server.ts', 'Dockerfile', 'container', 'public']) expect(existsSync(join(app, path)), path).toBe(false)
      const manifest = JSON.parse(await read('package.json'))
      expect(manifest.scripts).toMatchObject({ dev: 'vite', build: 'vite build', deploy: expect.stringContaining('vite build && wrangler d1 migrations apply DB --remote && wrangler deploy'), typecheck: expect.stringContaining('tsconfig.web.json'), lint: 'oxlint', format: 'oxfmt' })
      // The versions the kit tests with, so an app starts on a set that is known to work together
      const kitDev = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')).devDependencies
      for (const name of ['react', '@tanstack/react-router', '@tanstack/react-query']) expect(manifest.dependencies[name], name).toBe(kitDev[name])
      for (const name of ['vite', '@cloudflare/vite-plugin', '@vitejs/plugin-react', '@tanstack/router-plugin', 'tailwindcss', 'oxlint', 'oxfmt', 'wrangler']) expect(manifest.devDependencies[name], name).toBe(kitDev[name])
      // The Worker leaves only /app to the built files, and sends people who open the address there
      expect(await read('wrangler.jsonc')).toContain('"assets": { "not_found_handling": "single-page-application", "run_worker_first": ["/*", "!/app/*"] },')
      expect(await read('wrangler.jsonc')).not.toMatch(/account_id": "[0-9a-f]/)
      expect(await read('src/app.ts')).toContain("    home: 'app',\n")
      expect(await read('web/routes/index.tsx')).toContain('>Desk</h1>')
      const agents = await read('AGENTS.md')
      expect(agents).toContain('`pnpm dev`: Vite runs both sides')
      expect(agents).toContain('`vite build`, `wrangler d1 migrations apply`')
      expect(agents).not.toContain('the Worker locally over a local D1 (`/docs`')
      for (const path of ['AGENTS.md', 'src/app.ts', 'wrangler.jsonc', 'vitest.config.ts']) expect(await read(path), path).not.toMatch(/(?:\/\/|<!--) (?:preset|runtime):|__(?:name|title|kit|date|worker_dev)__/)
      expect(spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' }).status).toBe(0)
      for (const project of ['tsconfig.json', 'test/workers/tsconfig.json', 'tsconfig.web.json']) {
        const typecheck = spawnSync(bin('tsc'), ['--noEmit', '-p', project], { cwd: app, encoding: 'utf8' })
        expect(typecheck.status, `${project}: ${typecheck.stdout}`).toBe(0)
      }
      // Node, workerd and happy-dom: the API's tests, the Worker over D1, and the browser app's page
      const tests = spawnSync(bin('vitest'), ['run', '--root', '.'], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
      expect(tests.status, tests.stdout + tests.stderr).toBe(0)
      expect(tests.stdout).toMatch(/Test Files\s+4 passed/)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('keeps root items out of the kit folder: list names them, add points at the shadcn CLI, adopt and doctor never see them', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    expect(cli(app, 'list').stdout).toContain('at the repo root: npx shadcn add escalay/api-kit/npm-release')
    const refused = cli(app, 'add', 'npm-release')
    expect([refused.status, refused.stderr]).toEqual([1, 'kit: "npm-release" goes to the repo root, not into src/kit: `npx shadcn add escalay/api-kit/npm-release`\n'])
    expect(existsSync(join(app, 'src/kit'))).toBe(false)
    // What the shadcn CLI leaves at the root is no part: nothing to adopt, and a kit beside it stays clean
    const kitDir = join(import.meta.dirname, '..')
    const registry = JSON.parse(await readFile(join(kitDir, 'registry.json'), 'utf8'))
    for (const file of registry.items.find((item: { name: string }) => item.name === 'npm-release').files) {
      const target = join(app, file.target.replace('~/', ''))
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, await readFile(join(kitDir, file.path), 'utf8'))
    }
    expect(cli(app, 'adopt').stderr).toContain('no parts in src/kit')
    cli(app, 'add', 'pagination')
    const clean = cli(app, 'doctor')
    expect([clean.status, clean.stdout]).toEqual([0, `src/kit matches kit ${KIT_VERSION}: core, pagination\n`])
  })

  it('lists every part in the shadcn registry, with every file it has and nothing that is missing', async () => {
    const kitDir = join(import.meta.dirname, '..')
    const registry = JSON.parse(await readFile(join(kitDir, 'registry.json'), 'utf8'))
    expect(registry).toMatchObject({ $schema: 'https://ui.shadcn.com/schema/registry.json', name: 'escalay', homepage: 'https://github.com/escalay/api-kit' })
    type Item = { name: string; type: string; registryDependencies?: string[]; files: { path: string; type: string; target: string }[]; meta?: { root?: boolean } }
    const items: Item[] = registry.items
    const names = items.map((item) => item.name)
    const listed = new Set(items.flatMap((item) => item.files.map((file) => file.path)))
    // Every folder under src/ is a part of its name; browser/ holds one part per file
    const folders = (await readdir(join(kitDir, 'src'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    expect(folders.filter((folder) => folder !== 'browser' && !names.includes(folder))).toEqual([])
    const onDisk = (await readdir(join(kitDir, 'src'), { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(kitDir.length + 1))
    expect(onDisk.filter((path) => path !== 'src/index.ts' && !listed.has(path))).toEqual([])
    for (const item of items) {
      expect(item.type, item.name).toBe('registry:item')
      for (const file of item.files) {
        expect(existsSync(join(kitDir, file.path)), file.path).toBe(true)
        // Universal items: an explicit target under src/kit, the same place `kit add` writes; a root item's files go
        // anywhere in the repo but there, and come from outside src/
        if (!item.meta?.root) expect(file, file.path).toMatchObject({ type: 'registry:file', target: file.path.replace(/^src\//, '~/src/kit/') })
        else {
          expect(file, file.path).toMatchObject({ type: 'registry:file', target: expect.stringMatching(/^~\/(?!src\/kit\/)[\w.-]+(\/[\w.-]+)*$/) })
          expect(file.path.startsWith('src/'), file.path).toBe(false)
        }
      }
      // A part needs other parts by their GitHub address; a bare name is shadcn's own
      for (const needed of item.registryDependencies ?? []) expect(needed.startsWith('escalay/api-kit/') ? names.includes(needed.slice('escalay/api-kit/'.length)) : ['button', 'input'].includes(needed), `${item.name} → ${needed}`).toBe(true)
    }
    expect(items.filter((item) => item.meta?.root).map((item) => item.name)).toEqual(['npm-release'])
    const block = items.find((item) => item.name === 'vector-search-ui')!
    expect(block.registryDependencies).toEqual(['button', 'input', 'escalay/api-kit/search-react'])
  })
})

describe('the npm-release item', () => {
  const kitDir = join(import.meta.dirname, '..')
  const read = (path: string) => readFile(join(kitDir, path), 'utf8')

  it('installs the workflow this repo releases with, the check, the standard and a blank release-please setup', async () => {
    const registry = JSON.parse(await read('registry.json'))
    const item = registry.items.find((entry: { name: string }) => entry.name === 'npm-release')
    expect(Object.fromEntries(item.files.map((file: { path: string; target: string }) => [file.target, file.path]))).toEqual({
      // One source: the file that releases this repo is the file other repos get
      '~/.github/workflows/release.yml': '.github/workflows/release.yml',
      '~/release-please-config.json': 'templates/npm-release/release-please-config.json',
      '~/.release-please-manifest.json': 'templates/npm-release/release-please-manifest.json',
      '~/scripts/release-check.mjs': 'scripts/release-check.mjs',
      '~/docs/releasing.md': 'docs/releasing.md',
    })
    expect(item.dependencies ?? []).toEqual([])
    expect(item.registryDependencies ?? []).toEqual([])
  })

  it('ships nothing that names this repo’s packages or its history', async () => {
    const names = await Promise.all(['package.json', 'packages/create-escalay/package.json'].map(async (path) => JSON.parse(await read(path)).name))
    for (const path of ['.github/workflows/release.yml', 'scripts/release-check.mjs', 'templates/npm-release/release-please-config.json']) {
      const text = await read(path)
      for (const name of [...names, 'api-kit', 'escalay']) expect(text.includes(name), `${path} names ${name}`).toBe(false)
    }
    expect(JSON.parse(await read('templates/npm-release/release-please-manifest.json'))).toEqual({ '.': '0.0.0' })
  })

  it('gives other repos the release notes headings this repo uses, without its bootstrap commit or extra files', async () => {
    const [own, template] = await Promise.all(['release-please-config.json', 'templates/npm-release/release-please-config.json'].map(async (path) => JSON.parse(await read(path))))
    expect(own.packages['.']['extra-files']).toEqual([{ type: 'json', path: 'packages/create-escalay/package.json', jsonpath: '$.version' }])
    const { 'bootstrap-sha': bootstrap, packages, ...shared } = own
    expect(bootstrap).toMatch(/^[0-9a-f]{40}$/)
    expect(template).toEqual({ ...shared, packages: { '.': {} } })
    expect(template['changelog-sections'].filter((section: { hidden?: boolean }) => !section.hidden)).toEqual([
      { type: 'feat', section: 'New' },
      { type: 'fix', section: 'Fixed' },
      { type: 'perf', section: 'Faster' },
      { type: 'docs', section: 'Documentation' },
      { type: 'revert', section: 'Reverted' },
    ])
    // The manifest and every published package agree, or the release pull request would bump them apart
    const manifest = JSON.parse(await read('.release-please-manifest.json'))
    for (const path of ['package.json', 'packages/create-escalay/package.json']) expect(JSON.parse(await read(path)).version, path).toBe(manifest['.'])
  })
})

describe('a guide\'s skills over MCP', () => {
  it('offers each skill folder as a skill and each playbook as a prompt, from a folder or a module', async () => {
    const files = {
      'llms.txt': '# Apps',
      'skills/apps/SKILL.md': '---\nname: apps\ndescription: Use when finding apps at {{origin}}.\n---\n\n# Apps\n',
      'skills/apps/references/find-an-app.md': '# Find an app\n\nLook an app up by name, then open it.\n\n## Steps\n',
    }
    const { prompts, skills } = await guideSkills({ files, fill: (text) => text.replaceAll('{{origin}}', 'https://apps.test') })
    expect(prompts.map(({ name, title, description }) => ({ name, title, description }))).toEqual([{ name: 'find-an-app', title: 'Find an app', description: 'Look an app up by name, then open it.' }])
    expect(prompts[0]!.text({})).toContain('## Steps')
    expect(skills).toBeDefined()
    expect((await guideSkills({ files: new Map(Object.entries(files)) })).prompts).toHaveLength(1)
    // A guide without a skill folder offers none, and the factory takes that as it is
    expect(await guideSkills({ files: { 'llms.txt': '# Apps' } })).toEqual({ prompts: [], skills: undefined })
  })

  /** A server with one skill and ten playbooks, called like a plain MCP client: no extension methods needed. */
  const skillServer = async (references = 10) => {
    const files: Record<string, string> = { 'skills/mail/SKILL.md': '---\nname: mail\ndescription: Use when sending or reading mail.\n---\n\n# Mail\n' }
    for (let n = 1; n <= references; n++) files[`skills/mail/references/job-${String(n).padStart(2, '0')}.md`] = `# Job ${n}\n\nDoes job ${n}.\n`
    const { prompts, skills } = await guideSkills({ files })
    const app = new Hono()
    mountMcp(app, { factory: mcpServerFactory({ info: { name: 'mail', version: '1.0.0' }, instructions: 'Mail for agents.', tools: [], prompts, skills, callApi: inProcess(app) }), allowedHostnames: ['localhost'] })
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
    return async (method: string, params: Record<string, unknown> = {}) => {
      const response = await app.request('/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(params.uri ? { 'mcp-name': String(params.uri) } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
      })
      return (await response.json()) as { result?: any; error?: { message: string } }
    }
  }

  it('lists each skill file with words to start from, and says where to start in the template and instructions', async () => {
    const rpc = await skillServer()
    const { resources } = (await rpc('resources/list')).result
    expect(resources).toHaveLength(11)
    expect(resources[0]).toEqual({ uri: 'skill://mail/SKILL.md', name: 'mail skill: start here', title: 'mail skill: start here', description: 'Use when sending or reading mail.', mimeType: 'text/markdown', size: expect.any(Number) })
    expect(resources[1]).toEqual({ uri: 'skill://mail/references/job-01.md', name: 'mail skill: Job 1', title: 'mail skill: Job 1', description: 'Does job 1.', mimeType: 'text/markdown', size: expect.any(Number) })
    const [template] = (await rpc('resources/templates/list')).result.resourceTemplates
    expect(template).toMatchObject({ uriTemplate: 'skill://{+path}', title: 'Skills' })
    expect(template.description).toContain('Start with skill://mail/SKILL.md')
    expect((await rpc('server/discover')).result.instructions).toBe('Mail for agents.\n\nSkills: read skill://mail/SKILL.md first (resources/read); it names the playbook for each job.')
    // Many references: only SKILL.md is listed, and a folder read still names every file
    const crowded = await skillServer(21)
    expect((await crowded('resources/list')).result.resources.map((resource: { uri: string }) => resource.uri)).toEqual(['skill://mail/SKILL.md'])
  })

  it('answers a folder read with its files as skill:// URIs, and a miss with where to start', async () => {
    const rpc = await skillServer()
    for (const uri of ['skill://mail', 'skill://mail/']) {
      const [listing] = (await rpc('resources/read', { uri })).result.contents
      expect(listing).toMatchObject({ uri, mimeType: 'text/markdown' })
      expect(listing.text).toMatch(/^skill:\/\/mail\/ is a folder, not a file\. Read skill:\/\/mail\/SKILL\.md first/)
      expect(listing.text).toContain('- skill://mail/SKILL.md (mail skill: start here)\n- skill://mail/references/job-01.md (Job 1)')
      expect(listing.text.match(/^- skill:\/\//gm)).toHaveLength(11)
    }
    const references = (await rpc('resources/read', { uri: 'skill://mail/references' })).result.contents[0].text
    expect(references).toContain('Read skill://mail/SKILL.md first')
    expect(references).not.toContain('- skill://mail/SKILL.md')
    // The root too: every skill's files, from its SKILL.md
    expect((await rpc('resources/read', { uri: 'skill://' })).result.contents[0].text).toMatch(/^skill:\/\/ is a folder, not a file\. Read skill:\/\/mail\/SKILL\.md first[\s\S]*- skill:\/\/mail\/references\/job-10\.md \(Job 10\)$/)
    expect((await rpc('resources/read', { uri: 'skill://mail/references/job-02.md' })).result.contents[0].text).toBe('# Job 2\n\nDoes job 2.\n')
    expect((await rpc('resources/read', { uri: 'skill://index.json' })).error?.message).toBe('Resource not found: skill://index.json. Start with skill://mail/SKILL.md; resources/list names every skill file.')
  })

  it('keeps the skills extension: skills/list, skills/get, directory reads and prompts', async () => {
    const rpc = await skillServer()
    expect((await rpc('server/discover')).result.capabilities.extensions['io.modelcontextprotocol/skills']).toEqual({ directoryRead: true })
    const { skills } = (await rpc('skills/list')).result
    expect(skills.map((skill: { uri: string }) => skill.uri)).toEqual(['skill://mail/SKILL.md'])
    expect(skills[0].resources).toHaveLength(11)
    expect((await rpc('skills/get', { uri: 'skill://mail/SKILL.md' })).result.skill.frontmatter.name).toBe('mail')
    expect((await rpc('resources/directory/read', { uri: 'skill://mail' })).result.resources).toEqual([
      { uri: 'skill://mail/SKILL.md', name: 'SKILL.md', mimeType: 'text/markdown', size: expect.any(Number) },
      { uri: 'skill://mail/references', name: 'references', mimeType: 'inode/directory' },
    ])
    expect((await rpc('prompts/list')).result.prompts).toHaveLength(10)
  })
})

describe('the skills', () => {
  it('each has a name, says when to use it, stays short and names the command that checks its rule', async () => {
    const dir = join(import.meta.dirname, '..', 'skills')
    const names = (await readdir(dir)).sort()
    expect(names).toEqual(['api-kit-build', 'api-kit-cli', 'api-kit-feature', 'api-kit-review', 'api-kit-skills', 'npm-release'])
    for (const name of names) {
      const text = await readFile(join(dir, name, 'SKILL.md'), 'utf8')
      const [, frontmatter = ''] = text.match(/^---\n([\s\S]*?)\n---\n/) ?? []
      expect(frontmatter, name).toContain(`name: ${name}\n`)
      expect(frontmatter, name).toMatch(/^description: Use when /m)
      expect(text.split('\n').length, name).toBeLessThanOrEqual(150)
      expect(text, name).toMatch(/`pnpm test|`npx @escalay\/kit doctor`|^pnpm release:check/m)
      // Only commands the CLI has
      for (const [, command] of text.matchAll(/npx @escalay\/kit ([a-z]+)/g)) expect(['list', 'add', 'diff', 'update', 'doctor', 'adopt', 'init', 'feature', 'guide', 'sdk', 'cli'], `${name}: ${command}`).toContain(command)
    }
  })
})

describe('guards', () => {
  const post = (app: Awaited<ReturnType<typeof sampleApi>>['app'], body: object, key?: string) =>
    app.request('/api/v1/notes', { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) })

  it('answers a retried POST from the first answer, refuses the key with another body, and documents the header', async () => {
    const { app } = await sampleApi()
    const first = await post(app, { text: 'a' }, 'k1')
    expect(await first.json()).toEqual({ count: 1 })
    const again = await post(app, { text: 'a' }, 'k1')
    expect(again.headers.get('idempotent-replayed')).toBe('true')
    expect(await again.json()).toEqual({ count: 1 })
    expect((await post(app, { text: 'b' }, 'k1')).status).toBe(422)
    const doc = await (await app.request('/openapi.json')).json()
    expect(doc.paths['/api/v1/notes'].post.parameters).toContainEqual(expect.objectContaining({ name: 'Idempotency-Key', in: 'header' }))
    expect(doc.paths['/api/v1/apps'].get.parameters.some((parameter: { name: string }) => parameter.name === 'Idempotency-Key')).toBe(false)
  })

  it('limits calls per caller with RateLimit headers, then a 429 that says when', async () => {
    const { app } = await sampleApi()
    const first = await post(app, { text: 'x' })
    expect(first.headers.get('ratelimit-policy')).toBe('"paid";q=3;w=60')
    expect(first.headers.get('ratelimit')).toMatch(/^"paid";r=2;t=\d+$/)
    await post(app, { text: 'y' })
    await post(app, { text: 'z' })
    const refused = await post(app, { text: 'w' })
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await refused.json()).code).toBe('too_many_requests')
  })

  it('offers sortBy and order as one helper', () => {
    const schema = z.object(sortQuery(['saves', 'name'], 'saves'))
    expect(schema.parse({})).toEqual({ sortBy: 'saves' })
    expect(schema.parse({ sortBy: 'name', order: 'desc' })).toEqual({ sortBy: 'name', order: 'desc' })
    expect(schema.safeParse({ sortBy: 'size' }).success).toBe(false)
  })
})

describe('keys', () => {
  it('mints prefixed keys and refuses malformed key lists', () => {
    expect(key).toMatch(/^test_[A-Za-z0-9_-]{32}$/)
    expect(() => parseApiKeys('laptop:not-a-hash')).toThrow('not name:sha256')
    expect(parseApiKeys(` a:${hash} , `).get(hash)).toBe('a')
  })
})

describe('MCP (2026-07-28)', () => {
  const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
  const rpc = (app: Awaited<ReturnType<typeof sampleApi>>['app'], method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = auth) =>
    app.request('/mcp', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : method === 'resources/read' ? { 'mcp-name': String(params.uri) } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
    })

  it('needs a key like every other route', async () => {
    const { app } = await sampleApi()
    expect((await rpc(app, 'tools/list', {}, {})).status).toBe(401)
  })

  it('reads a tool’s route from its call, or takes the one it gives', () => {
    const base = { title: 'T', description: 'D', summarize: () => '' }
    expect(routeOf(mcpTool({ ...base, name: 'find', input: z.object({ q: z.string() }), call: ({ q }) => ({ path: '/api/v1/search', query: { q } }) }))).toBe('GET /api/v1/search')
    expect(routeOf(mcpTool({ ...base, name: 'save', input: z.object({ board: z.string() }), call: ({ board }) => ({ method: 'POST', path: `/api/v1/boards/${encodeURIComponent(board)}/items` }) }))).toBe('POST /api/v1/boards/{board}/items')
    expect(routeOf(mcpTool({ ...base, name: 'odd', input: z.object({}), route: 'GET /api/v1/odd', call: () => ({ path: '/x' }) }))).toBe('GET /api/v1/odd')
  })

  it('discovers, lists tools with their schemas and cache hints, and calls them through the API', async () => {
    const { app } = await sampleApi()
    const discover = await (await rpc(app, 'server/discover')).json()
    expect(discover.result.supportedVersions).toContain('2026-07-28')
    expect(discover.result.instructions).toBe('Find apps.')
    const list = await (await rpc(app, 'tools/list')).json()
    expect(list.result.ttlMs).toBe(3_600_000)
    const short = await sampleApi({ toolsTtlMs: 60_000 })
    expect((await (await rpc(short.app, 'tools/list')).json()).result.ttlMs).toBe(60_000)
    expect(list.result.tools[0]).toMatchObject({ name: 'get_app', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', required: ['id'] }, outputSchema: { type: 'object' } })
    // Its route, so a gateway can tell which tool a guide's `GET /api/v1/apps/{id}` means
    expect(list.result.tools[0]._meta).toEqual({ 'api-kit/route': 'GET /api/v1/apps/{id}', 'api-kit/cli': { name: 'app view', positional: ['id'], examples: [] }, 'api-kit/tools-hash': expect.stringMatching(/^[0-9a-f]{16}$/) })
    const call = await (await rpc(app, 'tools/call', { name: 'get_app', arguments: { id: 'a2' } })).json()
    expect(call.result.content[0]).toEqual({ type: 'text', text: 'Bravo (a2)' })
    // Every answer says which tool list it came from, so a client's cached list can tell it is stale
    expect(call.result._meta['api-kit/tools-hash']).toBe(list.result.tools[0]._meta['api-kit/tools-hash'])
    expect(call.result.structuredContent).toMatchObject({ id: 'a2', _links: { self: { href: 'http://localhost/api/v1/apps/a2' } } })
    const proxied = await (await app.request('/mcp', { method: 'POST', headers: { ...auth, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'apps.example', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'get_app' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_app', arguments: { id: 'a1' }, _meta: meta } }) })).json()
    expect(proxied.result.structuredContent._links.self.href).toBe('https://apps.example/api/v1/apps/a1')
    const missing = await (await rpc(app, 'tools/call', { name: 'get_app', arguments: { id: 'a9' } })).json()
    expect(missing.result).toMatchObject({ isError: true, content: [{ text: '404 not_found Not found: No such app.' }] })
    // The problem itself, so a client (the app's CLI) can pick its exit code without reading the text
    expect(missing.result._meta['api-kit/problem']).toMatchObject({ status: 404, code: 'not_found', detail: 'No such app.' })
  })

  it('answers an agent that opens with initialize instead of a method-not-found', async () => {
    const { app } = await sampleApi()
    const greeting = await (await rpc(app, 'initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'agent', version: '1' } })).json()
    expect(greeting.result).toMatchObject({ protocolVersion: '2026-07-28', capabilities: { tools: { listChanged: true } }, serverInfo: { name: expect.any(String) } })
    expect(greeting.result.instructions).toMatch(/^Find apps\.[\s\S]*no initialize or session is needed/)
    expect((await rpc(app, 'initialize', {}, {})).status).toBe(401)
  })

  it('reads a resource through the routes: JSON as text, an image as a blob', async () => {
    const { app } = await sampleApi()
    const templates = await (await rpc(app, 'resources/templates/list')).json()
    expect(templates.result.resourceTemplates[0]).toMatchObject({ uriTemplate: 'sample://apps/{id}', title: 'An app' })
    const read = await (await rpc(app, 'resources/read', { uri: 'sample://apps/a2' })).json()
    expect(JSON.parse(read.result.contents[0].text)).toMatchObject({ id: 'a2', name: 'Bravo' })
    expect(read.result.contents[1]).toMatchObject({ uri: 'sample://apps/a2', mimeType: 'image/png', blob: Buffer.from([137, 80, 78, 71]).toString('base64') })
    const withoutLogo = await (await rpc(app, 'resources/read', { uri: 'sample://apps/a1' })).json()
    expect(withoutLogo.result.contents).toHaveLength(1)
    expect((await (await rpc(app, 'resources/read', { uri: 'sample://apps/a9' })).json()).error.message).toContain('404 not_found')
    expect(await (await app.request('/agents/mcp.md')).text()).toContain('- `sample://apps/{id}` — An app: The app and its logo.')
  })

  it('answers GET with 405 as the spec asks', async () => {
    const { app } = await sampleApi()
    expect((await app.request('/mcp', { headers: auth })).status).toBe(405)
  })
})

describe('people through Cloudflare Access', () => {
  const people = () => {
    const app = createAgentApi({
      title: 'Sample',
      version: '1.0.0',
      description: 'A sample catalog.',
      tags: [{ name: 'Apps', description: 'The apps.' }],
      auth: { realm: 'sample', keys: parseApiKeys(`tester:${hash}`), access: { team: 'example', audience: 'aud', verify: async (token) => (token === 'good' ? 'me@example.com' : null) } },
      health: () => ({ snapshot: '2026-10-31' }),
    })
    app.get('/api/v1/me', (c) => c.json(c.get('caller' as never)))
    app.post('/api/v1/boards', (c) => c.json({ ok: true }, 201))
    return app
  }

  it('takes keys the service stores itself beside the ones it was started with', async () => {
    const stored = mintApiKey('st')
    const asked: string[] = []
    const app = createAgentApi({
      title: 'Sample',
      version: '1.0.0',
      description: 'A sample catalog.',
      tags: [],
      auth: { realm: 'sample', keys: parseApiKeys(`tester:${hash}`), storedKeys: async (h) => (asked.push(h), h === stored.hash ? 'made-by-api' : undefined) },
    })
    app.get('/api/v1/me', (c) => c.json(c.get('caller' as never)))
    const me = (key: string) => app.request('/api/v1/me', { headers: { authorization: `Bearer ${key}` } })
    expect(await (await me(stored.key)).json()).toEqual({ kind: 'key', name: 'made-by-api' })
    expect(await (await me(key)).json()).toEqual({ kind: 'key', name: 'tester' })
    expect((await me('st_revoked')).status).toBe(401)
    // A key from the start list is never looked up, nor is anything shaped like a token
    asked.length = 0
    await me(key)
    await me('a.b.c')
    expect(asked).toEqual([])
  })

  it('lets a browser in with the Access cookie, the same token as the header', async () => {
    const app = people()
    expect(await (await app.request('/api/v1/me', { headers: { cookie: 'CF_Authorization=good' } })).json()).toEqual({ kind: 'person', email: 'me@example.com' })
    expect(await (await app.request('/api/v1/me', { headers: { 'cf-access-jwt-assertion': 'good' } })).json()).toEqual({ kind: 'person', email: 'me@example.com' })
    expect((await app.request('/api/v1/me', { headers: { cookie: 'CF_Authorization=forged' } })).status).toBe(401)
  })

  it('takes writes with the cookie only from the same site', async () => {
    const app = people()
    const post = (headers: Record<string, string>) => app.request('http://app.test/api/v1/boards', { method: 'POST', headers: { cookie: 'CF_Authorization=good', ...headers } })
    expect((await post({ 'sec-fetch-site': 'same-origin' })).status).toBe(201)
    expect((await post({ origin: 'http://app.test' })).status).toBe(201)
    expect((await post({ 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post({ origin: 'http://evil.test' })).status).toBe(403)
    expect((await post({})).status).toBe(403)
    // The header is set by Access itself, never by another site
    expect((await app.request('http://app.test/api/v1/boards', { method: 'POST', headers: { 'cf-access-jwt-assertion': 'good' } })).status).toBe(201)
  })
})
