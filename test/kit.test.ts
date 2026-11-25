import { existsSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { parseEnv } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createAgentApi, errorHandler, problemResponse, rateLimit, sortQuery, decodeCursor, originOf, fillTemplate, guideFiles, guideModuleSource, HAL_JSON, linksOf, LinksSchema, mintApiKey, pageOf, pageSchema, parseApiKeys, pathWith, problemResponses, ProblemError, serveAiCatalog, serveGuide, snapshotEtag, tarGz, wantsMarkdown } from '../src/index.js'
import { guideSkillProblems, guideSkills, inProcess, mcpResource, mcpServerFactory, mcpTool, mountMcp, routeOf } from '../src/mcp/index.js'
import { callMcp, guideGaps, guideRoutes, lintOpenApi, toolRoutes } from '../src/testing/index.js'
import { migrate, openDb } from '../src/db/index.js'
import { OAUTH_MIGRATIONS } from '../src/oauth/schema.js'
import { createOAuth, generateOAuthKey, memoryOAuthStore } from '../src/oauth/index.js'
import { approvedCode, oauthApp, signedIn } from './oauth-store-contract.js'

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

  it('names the scopes on the 401 challenge only with OAuth on, and the metadata on insufficient_scope', async () => {
    const { app } = await oauthApp(memoryOAuthStore())
    app.post('/api/v1/notes', (c) => c.json({}, 201))
    const metadata = 'resource_metadata="http://localhost/.well-known/oauth-protected-resource"'
    expect((await app.request('/api/v1/things')).headers.get('www-authenticate')).toBe(`Bearer realm="sample", ${metadata}, scope="read write"`)
    const { access_token } = await (await (await approvedCode(app, { scope: 'read' })).exchange()).json()
    const short = await app.request('/api/v1/notes', { method: 'POST', headers: { authorization: `Bearer ${access_token}` } })
    expect(short.status).toBe(403)
    expect(short.headers.get('www-authenticate')).toBe(`Bearer realm="sample", error="insufficient_scope", scope="write", ${metadata}`)
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
    const etag = (await app.request('/.well-known/mcp/server-card.json')).headers.get('etag')!
    const same = await app.request('/.well-known/mcp/server-card.json', { headers: { 'if-none-match': etag } })
    expect(same.status).toBe(304)
    // RFC 9110: If-None-Match compares weakly, and * matches any
    for (const sent of [`W/${etag}`, '*', `"other", W/${etag}`]) expect((await app.request('/.well-known/mcp/server-card.json', { headers: { 'if-none-match': sent } })).status, sent).toBe(304)
    expect((await app.request('/.well-known/mcp/server-card.json', { headers: { 'if-none-match': 'W/"other"' } })).status).toBe(200)
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
  const hashOfText = (text: string) => createHash('sha256').update(text).digest('hex')
  /** A friend's agent joins Soups with its code and loses it with the shelf: the worked test in the sharing part's REFERENCE.md, as written there. */
  const SHARING_FRIEND_TEST = (() => {
    const reference = readFileSync(join(import.meta.dirname, '..', 'src/sharing/REFERENCE.md'), 'utf8')
    const block = reference.slice(reference.indexOf("## A friend's agent, as a test")).match(/```ts\n\/\/ test\/sharing\.test\.ts\n([\s\S]*?)```/)
    if (!block) throw new Error("src/sharing/REFERENCE.md has no ```ts block starting // test/sharing.test.ts under ## A friend's agent, as a test")
    return block[1]!
  })()
  const kitText = (file: string) => readFile(join(import.meta.dirname, '..', 'src', file), 'utf8')

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

  it('prints a dev key and the API_KEYS line that lets it in, keeping nothing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-key-'))
    const made = cli(parent, 'key')
    expect(made.status, made.stderr).toBe(0)
    const [, key] = /^Key       (\S+)$/m.exec(made.stdout)!
    expect(key).toMatch(/^dev_[\w-]{32}$/)
    expect(made.stdout).toContain(`\nAPI_KEYS=dev:${hashOfText(key!)}\n`)
    // The app takes the line as it is
    expect([...parseApiKeys(`dev:${hashOfText(key!)}`).values()]).toEqual(['dev'])
    // Each run makes a new pair: the key and its line come from one
    expect(made.stdout).toContain('Keep the key and this line from this one run: each run makes a new pair, and a key with another run’s line is a 401')
    const named = cli(parent, 'key', 'reader')
    expect(named.stdout).toMatch(/^Key       reader_[\w-]{32}$/m)
    expect(named.stdout).toMatch(/^API_KEYS=reader:[0-9a-f]{64}$/m)
    expect(cli(parent, 'key', 'Bad Name').stderr).toContain('a key name is lowercase')
    expect(await readdir(parent)).toEqual([])
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

  it('re-exports boards from the kit’s index like people and setup, and keeps its own folder importable', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    const added = cli(app, 'add', 'boards', 'people', '--dir', 'src/kit')
    expect(added.status, added.stderr).toBe(0)
    const index = await readFile(join(app, 'src/kit/index.ts'), 'utf8')
    for (const part of ['boards', 'people']) expect(index).toContain(`export * from './${part}/index.js'`)
    expect(existsSync(join(app, 'src/kit/boards/index.ts'))).toBe(true)
  })

  it('names the migrations line an older app’s scripts/migrations.ts lacks for a part with tables', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    await writeFile(join(app, 'package.json'), '{ "name": "older" }')
    await mkdir(join(app, 'scripts'))
    await writeFile(join(app, 'scripts/migrations.ts'), "const sets = [['oauth', OAUTH_MIGRATIONS], ['guards', GUARD_MIGRATIONS]]\n")
    const added = cli(app, 'add', 'people', 'pagination')
    expect(added.stdout).toContain("scripts/migrations.ts lacks people's tables: `import { PEOPLE_MIGRATIONS } from '../src/kit/index.js'` and `['people', PEOPLE_MIGRATIONS]` in its sets, then `pnpm migrations` writes their D1 files")
    expect(added.stdout).not.toMatch(/'(pagination|db)'/)
    // An entry part's tables come from its own folder
    expect(cli(app, 'add', 'sharing').stdout).toContain("scripts/migrations.ts lacks sharing's tables: `import { SHARING_MIGRATIONS } from '../src/kit/sharing/index.js'` and `['sharing', SHARING_MIGRATIONS]` in its sets")
  })

  it('never names the migrations line for a part an app made by init wires as a feature: the feature brings its tables', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    await writeFile(join(app, 'package.json'), '{ "name": "older" }')
    await mkdir(join(app, 'scripts'))
    await mkdir(join(app, 'src/features'), { recursive: true })
    await writeFile(join(app, 'src/features/index.ts'), '// kit:imports\n')
    await writeFile(join(app, 'scripts/migrations.ts'), "const sets = [['oauth', OAUTH_MIGRATIONS], ['guards', GUARD_MIGRATIONS]]\n")
    const added = cli(app, 'add', 'people', 'boards')
    expect(added.stdout).not.toContain('lacks')
    expect(added.stdout).toContain("Wire people: a feature in src/features/people/ listed in src/features/index.ts (its migrations reach migrations/ through it: add no line to scripts/migrations.ts), and the lines in src/app.ts: src/kit/people/README.md › In an app made by `kit init`")
  })

  it('tells your edits from the kit’s and never overwrites an edit without --force', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'core', '--dir', 'kit')
    expect(cli(app, 'diff', '--dir', 'kit').status).toBe(0)
    await writeFile(join(app, 'kit/core/hal.ts'), '// mine\n')
    // Edited here, and recorded from an older kit: both changed
    await writeFile(join(app, 'kit/core/cache.ts'), '// mine too\n')
    const lock = JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8'))
    await writeFile(join(app, 'kit/kit.json'), JSON.stringify({ ...lock, version: '0.0.1', files: { ...lock.files, 'core/cache.ts': 'stale' } }))
    const diff = cli(app, 'diff', '--dir', 'kit')
    expect(diff.status).toBe(1)
    expect(diff.stdout).toMatch(/you edited\s+core\/hal\.ts/)
    expect(diff.stdout).toMatch(/both changed\s+core\/cache\.ts/)
    cli(app, 'update', '--dir', 'kit')
    expect(await readFile(join(app, 'kit/core/hal.ts'), 'utf8')).toBe('// mine\n')
    expect(await readFile(join(app, 'kit/core/cache.ts'), 'utf8')).toBe('// mine too\n')
    cli(app, 'update', '--dir', 'kit', '--force', '--all')
    expect(await readFile(join(app, 'kit/core/hal.ts'), 'utf8')).not.toBe('// mine\n')
    expect(await readFile(join(app, 'kit/core/cache.ts'), 'utf8')).not.toBe('// mine too\n')
    expect(cli(app, 'add', 'nope', '--dir', 'kit').stderr).toContain('no module "nope"')
  })

  it('update <part> --force takes the kit’s files only in the parts it names, and names each edit it overwrites or keeps', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'pagination', '--dir', 'kit')
    const lock = JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8'))
    // Edited here, and the kit changed both since: one in core, one in pagination; one more edit in core the kit left alone
    await writeFile(join(app, 'kit/core/hal.ts'), '// mine\n')
    await writeFile(join(app, 'kit/pagination/index.ts'), '// mine too\n')
    await writeFile(join(app, 'kit/core/cache.ts'), (await kitText('core/cache.ts')) + '// ours\n')
    await writeFile(join(app, 'kit/kit.json'), JSON.stringify({ ...lock, version: '0.0.1', files: { ...lock.files, 'core/hal.ts': 'older', 'pagination/index.ts': 'older' } }))
    const named = cli(app, 'update', 'pagination', '--dir', 'kit', '--force')
    expect(named.stdout).toContain("  overwrote     pagination/index.ts (your edit: --force names pagination)")
    expect(named.stdout).toContain("  kept          core/hal.ts: your edit, and the kit changed it; --force names pagination, not core: `kit update core --dir kit --force` takes the kit's")
    expect(named.stdout).toContain("  kept          core/cache.ts: your edit; --force names pagination, not core")
    expect(await readFile(join(app, 'kit/pagination/index.ts'), 'utf8')).toBe(await kitText('pagination/index.ts'))
    expect(await readFile(join(app, 'kit/core/hal.ts'), 'utf8')).toBe('// mine\n')
    expect(await readFile(join(app, 'kit/core/cache.ts'), 'utf8')).toBe((await kitText('core/cache.ts')) + '// ours\n')
    // core/hal.ts still holds the older kit's code
    expect([named.status, JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8')).version]).toEqual([1, '0.0.1'])
    // Naming no part, --force refuses while an edit would go, and writes nothing
    const bare = cli(app, 'update', '--dir', 'kit', '--force')
    expect([bare.status, bare.stdout]).toEqual([1, ''])
    expect(bare.stderr.trim().split('\n')).toEqual([
      'kit: update --force names no part, and would overwrite 2 edits:',
      '  core/cache.ts (core)',
      '  core/hal.ts (core)',
      "Take the kit's part by part: `kit update core --dir kit --force`; or every part's, these edits too: `kit update --dir kit --force --all`",
    ])
    expect(await readFile(join(app, 'kit/core/hal.ts'), 'utf8')).toBe('// mine\n')
    // --force --all takes every edit, and says so for each
    const all = cli(app, 'update', '--dir', 'kit', '--force', '--all')
    expect(all.status).toBe(0)
    expect(all.stdout).toContain('  overwrote     core/hal.ts (your edit: --force --all)')
    expect(all.stdout).toContain('  overwrote     core/cache.ts (your edit: --force --all)')
    // With no edit to overwrite (hal.ts is what an older kit wrote), a bare --force goes ahead
    const taken = JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8'))
    await writeFile(join(app, 'kit/core/hal.ts'), '// older\n')
    await writeFile(join(app, 'kit/kit.json'), JSON.stringify({ ...taken, version: '0.0.1', files: { ...taken.files, 'core/hal.ts': hashOfText('// older\n') } }))
    const clean = cli(app, 'update', '--dir', 'kit', '--force')
    expect([clean.status, clean.stdout]).toEqual([0, expect.stringContaining('  updated       core/hal.ts')])
    expect(await readFile(join(app, 'kit/core/cache.ts'), 'utf8')).toBe(await kitText('core/cache.ts'))
  })

  it('names `kit` for the generated index.ts, so the command doctor prints for it overwrites no other part’s edit', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'pagination', 'mcp', '--dir', 'kit')
    const kitIndex = await readFile(join(app, 'kit/index.ts'), 'utf8')
    const mcpIndex = await readFile(join(app, 'kit/mcp/index.ts'), 'utf8')
    await writeFile(join(app, 'kit/index.ts'), `${kitIndex}// mine\n`)
    await writeFile(join(app, 'kit/mcp/index.ts'), `${mcpIndex}// mine too\n`)
    const doctor = cli(app, 'doctor', '--dir', 'kit')
    expect(doctor.stdout).toContain("edited   index.ts: yours to keep; `kit diff --dir kit --patch` shows the change, `kit update kit --dir kit --force` takes the kit's")
    const forced = cli(app, 'update', 'kit', '--dir', 'kit', '--force')
    expect(forced.status, forced.stderr).toBe(0)
    expect(forced.stdout).toContain('  overwrote     index.ts (your edit: --force names kit)')
    expect(forced.stdout).toContain('  kept          mcp/index.ts: your edit; --force names kit, not mcp')
    expect(await readFile(join(app, 'kit/index.ts'), 'utf8')).toBe(kitIndex)
    expect(await readFile(join(app, 'kit/mcp/index.ts'), 'utf8')).toBe(`${mcpIndex}// mine too\n`)
    expect(JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8')).modules).not.toContain('kit')
    // With a part beside it, both
    await writeFile(join(app, 'kit/index.ts'), `${kitIndex}// mine\n`)
    expect(cli(app, 'update', 'kit', 'mcp', '--dir', 'kit', '--force').status).toBe(0)
    expect([await readFile(join(app, 'kit/index.ts'), 'utf8'), await readFile(join(app, 'kit/mcp/index.ts'), 'utf8')]).toEqual([kitIndex, mcpIndex])
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
    // The file is still what the older kit wrote, and the kit moved on
    await writeFile(join(app, 'src/kit/pagination/index.ts'), '// older\n')
    const lock = JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8'))
    await writeFile(join(app, 'src/kit/kit.json'), JSON.stringify({ ...lock, version: '0.0.1', files: { ...lock.files, 'pagination/index.ts': hashOfText('// older\n') } }))
    const sick = cli(app, 'doctor')
    expect(sick.status).toBe(1)
    expect(sick.stdout.trim().split('\n')).toEqual([
      `Kit ${KIT_VERSION} (this command) checks src/kit, a copy of kit 0.0.1`,
      'note     kit.json says kit 0.0.1: `kit upgrading --dir src/kit` prints what changed for its parts since, and what to do',
      'missing  core/kv.ts: `kit update --dir src/kit` writes it again',
      "edited   core/hal.ts: yours to keep; `kit diff --dir src/kit --patch` shows the change, `kit update core --dir src/kit --force` takes the kit's",
      `behind   pagination was copied from kit 0.0.1 and kit ${KIT_VERSION} changed it: \`kit diff --dir src/kit --patch\`, then \`kit update --dir src/kit\``,
      '3 to fix in src/kit',
    ])
    cli(app, 'update', '--force', '--all')
    expect(cli(app, 'doctor').status).toBe(0)
    // Only the version is behind: update records it
    await writeFile(join(app, 'src/kit/kit.json'), JSON.stringify({ ...lock, version: '0.0.1' }))
    expect(cli(app, 'doctor').stdout).toContain(`behind   kit.json says kit 0.0.1, this is ${KIT_VERSION} with the same files`)
  })

  it('doctor --keep records an edit the team keeps: exit 0 while the file stays as kept, an edit again once it changes', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'pagination')
    await writeFile(join(app, 'src/kit/core/hal.ts'), '// ours\n')
    expect(cli(app, 'doctor').status).toBe(1)
    expect(cli(app, 'doctor', '--keep', 'core/kv.ts').stderr).toContain('core/kv.ts is not an edit')
    const kept = cli(app, 'doctor', '--keep', 'core/hal.ts')
    expect(kept.status, kept.stdout).toBe(0)
    expect(JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8')).kept).toEqual({ 'core/hal.ts': hashOfText('// ours\n') })
    const again = cli(app, 'doctor')
    expect([again.status, again.stdout.trim().split('\n')]).toEqual([0, ["kept     core/hal.ts: an edit kit.json records as kept; `kit diff --dir src/kit --patch` shows it", `src/kit matches kit ${KIT_VERSION}, with 1 kept edit: core, pagination`]])
    // add and update carry the record
    cli(app, 'add', 'db')
    cli(app, 'update')
    expect(cli(app, 'doctor').status).toBe(0)
    await writeFile(join(app, 'src/kit/core/hal.ts'), '// ours, changed\n')
    expect(cli(app, 'doctor').stdout).toContain('edited   core/hal.ts')
    expect(cli(app, 'doctor').status).toBe(1)
    // Taking the kit's file drops the record
    cli(app, 'update', '--force', '--all')
    expect(JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8')).kept).toBeUndefined()
  })

  it('names doctor --keep after update and upgrading leave edits, and diff --patch shows only changed files, app to kit', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'pagination')
    await writeFile(join(app, 'src/kit/core/hal.ts'), '// ours\n')
    await writeFile(join(app, 'src/kit/pagination/index.ts'), '// older\n')
    const lock = JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8'))
    await writeFile(join(app, 'src/kit/kit.json'), JSON.stringify({ ...lock, version: '0.0.1', files: { ...lock.files, 'pagination/index.ts': hashOfText('// older\n') } }))
    const patch = cli(app, 'diff', '--patch')
    expect(patch.stdout).not.toMatch(/^ +unchanged /m)
    expect(patch.stdout).toMatch(/^ +you edited +core\/hal\.ts$/m)
    expect(patch.stdout).toMatch(/^ +and \d+ unchanged$/m)
    // Each side named, in the direction update goes: from the app's file to the kit's
    expect(patch.stdout).toContain(`# core/hal.ts, you edited it: - the app's, + kit ${KIT_VERSION}'s; update keeps the app's (--force takes the kit's)\n`)
    expect(patch.stdout).toContain('--- app/core/hal.ts\n+++ kit/core/hal.ts\n')
    expect(patch.stdout).toContain(`# pagination/index.ts, the kit changed it: - the app's, + kit ${KIT_VERSION}'s; update takes this\n`)
    expect(patch.stdout).toMatch(/^-\/\/ older$/m)
    expect(patch.stdout).not.toContain(tmpdir())
    const keep = "Kept edits: `kit doctor --dir src/kit --keep core/hal.ts` records it as the app's, so doctor notes it instead of failing"
    expect(cli(app, 'upgrading').stdout.trim().split('\n').at(-1)).toBe(keep)
    const updated = cli(app, 'update')
    expect(updated.stdout.trim().split('\n').at(-1)).toBe(keep)
    expect(cli(app, 'doctor', '--keep', 'core/hal.ts').status).toBe(0)
    // Once kept, neither names it again
    expect(cli(app, 'update').stdout).not.toContain('Kept edits')
  })

  it('prints no pnpm add for what package.json already has', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'app', dependencies: { hono: '^4.13.18' } }))
    const added = cli(app, 'add', 'core')
    expect(added.stdout).toContain('Dependencies: pnpm add @hono/zod-openapi@')
    expect(added.stdout).not.toContain('hono@^4')
    const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'))
    const ranges = Object.fromEntries((added.stdout.match(/pnpm add (.+)/)![1]!.split(' ')).map((spec) => [spec.slice(0, spec.lastIndexOf('@')), spec.slice(spec.lastIndexOf('@') + 1)]))
    await writeFile(join(app, 'package.json'), JSON.stringify({ ...manifest, dependencies: { ...manifest.dependencies, ...ranges } }))
    const updated = cli(app, 'update')
    expect(updated.stdout).not.toContain('pnpm add')
    expect(updated.stdout).toContain('Dependencies: package.json has them')
  })

  it('a file equal to the kit’s is unchanged even when kit.json recorded another hash', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'core', '--dir', 'kit')
    const lock = JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8'))
    await writeFile(join(app, 'kit/kit.json'), JSON.stringify({ ...lock, version: '0.0.1', files: { ...lock.files, 'core/cache.ts': 'stale' } }))
    const diff = cli(app, 'diff', '--dir', 'kit')
    expect(diff.stdout).toMatch(/unchanged\s+core\/cache\.ts/)
    expect(diff.status).toBe(0)
    expect(cli(app, 'doctor', '--dir', 'kit').stdout.trim().split('\n')).toEqual([
      `Kit ${KIT_VERSION} (this command) checks kit, a copy of kit 0.0.1`,
      'note     kit.json says kit 0.0.1: `kit upgrading --dir kit` prints what changed for its parts since, and what to do',
      `behind   kit.json says kit 0.0.1, this is ${KIT_VERSION} with the same files: \`kit update --dir kit\` records it`,
      '1 to fix in kit',
    ])
    const updated = cli(app, 'update', '--dir', 'kit')
    expect(updated.status).toBe(0)
    expect(updated.stdout).not.toContain('core/cache.ts')
    expect(JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8'))).toMatchObject({ version: KIT_VERSION, files: { 'core/cache.ts': hashOfText(await kitText('core/cache.ts')) } })
    expect(cli(app, 'doctor', '--dir', 'kit').status).toBe(0)
  })

  it('update that keeps an edited file does not stamp the new version', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'core', '--dir', 'kit')
    const lock = JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8'))
    // hal.ts is what the older kit wrote (the kit changed it); cache.ts was edited here and the kit changed it too
    await writeFile(join(app, 'kit/core/hal.ts'), '// older\n')
    await writeFile(join(app, 'kit/core/cache.ts'), '// mine\n')
    await writeFile(join(app, 'kit/kit.json'), JSON.stringify({ ...lock, version: '0.0.1', files: { ...lock.files, 'core/hal.ts': hashOfText('// older\n'), 'core/cache.ts': 'older' } }))
    const kept = cli(app, 'update', '--dir', 'kit')
    expect(kept.status).toBe(1)
    expect(kept.stdout).toContain('  updated       core/hal.ts')
    expect(kept.stdout).toContain("1 file kept at kit 0.0.1: core/cache.ts. `kit diff --dir kit --patch` shows both; `kit update core --dir kit --force` takes the kit's, then make your edits again")
    expect(kept.stdout).not.toContain(`kit.json → ${KIT_VERSION}`)
    expect(await readFile(join(app, 'kit/core/cache.ts'), 'utf8')).toBe('// mine\n')
    expect(await readFile(join(app, 'kit/core/hal.ts'), 'utf8')).toBe(await kitText('core/hal.ts'))
    expect(JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8'))).toMatchObject({ version: '0.0.1', files: { 'core/hal.ts': hashOfText(await kitText('core/hal.ts')), 'core/cache.ts': 'older' } })
    // Taking the kit's and making the edit again ends at the new version with the edit kept
    expect(cli(app, 'update', 'core', '--dir', 'kit', '--force').status).toBe(0)
    await writeFile(join(app, 'kit/core/cache.ts'), (await kitText('core/cache.ts')) + '// mine\n')
    const again = cli(app, 'update', '--dir', 'kit')
    expect(again.status).toBe(0)
    expect(again.stdout).toContain(`kit.json → ${KIT_VERSION}`)
    expect(JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8')).version).toBe(KIT_VERSION)
    expect(await readFile(join(app, 'kit/core/cache.ts'), 'utf8')).toBe((await kitText('core/cache.ts')) + '// mine\n')
  })

  it('doctor notes an app served on Node that names no source for the caller\'s address, without failing', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'core')
    await writeFile(join(app, 'src/server.ts'), "import { serve } from '@hono/node-server'\n")
    await writeFile(join(app, 'src/app.ts'), "const app = createAgentApi({ title: 'Sample', auth })\n")
    const noted = cli(app, 'doctor')
    expect(noted.status).toBe(0)
    expect(noted.stdout.trim().split('\n')).toEqual([
      "note     the app runs on Node (@hono/node-server) and names no source for the caller's address, so anonymous callers are counted by cf-connecting-ip or x-forwarded-for as sent: set createAgentApi({ address }) to the header your proxy writes, or 'socket' with nothing in front (STANDARD §9)",
      `src/kit matches kit ${KIT_VERSION}: core`,
    ])
    await writeFile(join(app, 'src/app.ts'), "const app = createAgentApi({ title: 'Sample', auth, address: 'socket' })\n")
    expect(cli(app, 'doctor').stdout).toBe(`src/kit matches kit ${KIT_VERSION}: core\n`)
    // An `address` outside the createAgentApi call (a seed's email address) names no source
    await writeFile(join(app, 'src/app.ts'), "const seed = { address: 'sample@example.test' }\nconst app = createAgentApi({\n  title: 'Sample',\n  auth: authOf({ realm: 'sample' }),\n})\n")
    expect(cli(app, 'doctor').stdout).toContain("note     the app runs on Node (@hono/node-server) and names no source for the caller's address")
    await writeFile(join(app, 'src/app.ts'), "const app = createAgentApi({\n  title: 'Sample',\n  auth: authOf({ realm: 'sample' }),\n  address,\n})\n")
    expect(cli(app, 'doctor').stdout).toBe(`src/kit matches kit ${KIT_VERSION}: core\n`)
    // On Workers alone there is no hint: cf-connecting-ip is Cloudflare's own
    await writeFile(join(app, 'src/app.ts'), "const app = createAgentApi({ title: 'Sample', auth })\n")
    await rm(join(app, 'src/server.ts'))
    expect(cli(app, 'doctor').stdout).toBe(`src/kit matches kit ${KIT_VERSION}: core\n`)
  })

  it('doctor notes an app whose own sign-in page opens OAuth without limits or publicOrigin, and a passkey app whose owner never asks personOf', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'core', 'oauth')
    const approving = "const oauth = createOAuth({ name: 'Sample', signingKey, store, owner, approve: async (c, ask) => c.html(page(ask)) })\n"
    await writeFile(join(app, 'src/app.ts'), approving)
    const open = "note     createOAuth has approve, so its sign-in page answers anyone, but no limits or publicOrigin: pass both (oauth README, Open endpoints; STANDARD §7)"
    const noted = cli(app, 'doctor')
    expect(noted.status).toBe(0)
    expect(noted.stdout).toContain(open)
    await writeFile(join(app, 'src/app.ts'), approving.replace('approve:', "limits: { store: guards }, approve:"))
    expect(cli(app, 'doctor').stdout).toContain(open)
    await writeFile(join(app, 'src/app.ts'), approving.replace('approve:', "limits: { store: guards }, publicOrigin: env.PUBLIC_ORIGIN, approve:"))
    expect(cli(app, 'doctor').stdout).not.toContain('createOAuth has approve')
    // limits: false is no limits, as createOAuth reads it; a URL in the call is code, not a comment
    await writeFile(join(app, 'src/app.ts'), approving.replace('approve:', "limits: false, publicOrigin: 'https://sample.example.test', approve:"))
    expect(cli(app, 'doctor').stdout).toContain(open)
    // Options only in a comment are not passed
    await writeFile(join(app, 'src/app.ts'), `// pass limits: { store: guards }, publicOrigin: env.PUBLIC_ORIGIN\n/* or limits: guards, publicOrigin, */\n${approving}`)
    expect(cli(app, 'doctor').stdout).toContain(open)
    // The owner of a deploy signed in by passkey: only personOf knows them
    cli(app, 'add', 'people')
    await writeFile(join(app, 'src/app.ts'), "const oauth = createOAuth({ name: 'Sample', signingKey, store, owner: access ? accessOwner(access) : async () => null })\n")
    const passkeys = "note     the app has the people part, but no createOAuth owner asks personOf: a deploy signed in by passkey alone can never approve a sign-in (oauth README)"
    expect(cli(app, 'doctor').stdout).toContain(passkeys)
    await writeFile(join(app, 'src/app.ts'), "const oauth = createOAuth({ name: 'Sample', signingKey, store, owner: async (c) => (await personOf(c, db))?.email ?? null })\n")
    expect(cli(app, 'doctor').stdout).not.toContain('people part')
    // The starter's own lines: its comment suggests personOf, its owner does not ask it
    const starter = await readFile(join(import.meta.dirname, '..', 'templates/app/src/app.ts'), 'utf8')
    const starterOwner = starter.slice(starter.indexOf('  // Who may approve a sign-in'), starter.indexOf('  const app = createAgentApi('))
    expect(starterOwner).toContain('personOf(c, db)')
    await writeFile(join(app, 'src/app.ts'), starterOwner)
    expect(cli(app, 'doctor').stdout).toContain(passkeys)
    // Its suggestion taken: the owner asks personOf
    const suggested = /\/\/ (async \(c\) => .*personOf.*)\n/.exec(starterOwner)![1]!
    await writeFile(join(app, 'src/app.ts'), starterOwner.replace('access ? accessOwner(access) : async () => null', suggested))
    expect(cli(app, 'doctor').stdout).not.toContain('people part')
    // personOf asked in another file (a route of the app's) says nothing of the server's owner
    await writeFile(join(app, 'src/app.ts'), starterOwner)
    await writeFile(join(app, 'src/rooms.ts'), 'export const roomsOf = async (c, db) => (await personOf(c, db))?.rooms ?? []\n')
    expect(cli(app, 'doctor').stdout).toContain(passkeys)
  })

  it('doctor notes an app with the sharing part that never sweeps, and one on Workers that names no address header', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    expect(cli(app, 'add', 'sharing').status).toBe(0)
    const sweep = 'note     the app has the sharing part, but nothing calls sharing.sweep(): call it from the scheduled handler, or members past their lifetime or unused for 30 days keep their grants and old rows are never deleted (sharing README, Wire it)'
    const workers = "note     the app runs on Workers with the sharing part, but names no header for the caller's address, so typed codes are counted per IPv6 address rather than per /64: pass address: { header: 'cf-connecting-ip' } (sharing README, Limits; STANDARD §9)"
    const sharingApp = "const sharing = await createSharing({ db, secret: env.SHARING_SECRET, spaces, owner })\n"
    await writeFile(join(app, 'src/app.ts'), sharingApp)
    const noted = cli(app, 'doctor')
    expect(noted.status).toBe(0)
    expect(noted.stdout).toContain(sweep)
    expect(noted.stdout).not.toContain('runs on Workers')
    // The README's line pasted as a comment is not a call
    await writeFile(join(app, 'src/app.ts'), `${sharingApp}// the scheduled handler: await sharing.sweep()\n`)
    expect(cli(app, 'doctor').stdout).toContain(sweep)
    await writeFile(join(app, 'src/app.ts'), `${sharingApp}export const scheduled = async () => { await sharing.sweep() }\n`)
    expect(cli(app, 'doctor').stdout).not.toContain('sharing.sweep()')
    // On Workers, the address left at 'headers' counts each IPv6 address on its own
    const worker = "export default { fetch: (request, env, ctx) => createApp({ db, env }).then((app) => app.fetch(request, env, ctx)) } satisfies ExportedHandler<Bindings>\n"
    await writeFile(join(app, 'src/worker.ts'), worker)
    const onWorkers = cli(app, 'doctor')
    expect(onWorkers.status).toBe(0)
    expect(onWorkers.stdout).toContain(workers)
    await writeFile(join(app, 'src/worker.ts'), worker.replace('createApp({ db, env })', "createApp({ db, env, address: { header: 'cf-connecting-ip' } })"))
    expect(cli(app, 'doctor').stdout).not.toContain('runs on Workers')
    await writeFile(join(app, 'src/worker.ts'), `// address: { header: 'cf-connecting-ip' }\n${worker}`)
    expect(cli(app, 'doctor').stdout).toContain(workers)
    // Without the sharing part, or without createSharing, neither note
    await writeFile(join(app, 'src/app.ts'), "const oauth = createOAuth({ name: 'Sample', signingKey, store, owner })\n")
    expect(cli(app, 'doctor').stdout).not.toMatch(/sharing\.sweep|runs on Workers/)
  })

  it('doctor notes a Node app with no address source wherever its kit sits under src', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'core', '--dir', 'src/lib/kit')
    await writeFile(join(app, 'src/server.ts'), "import { serve } from '@hono/node-server'\n")
    await writeFile(join(app, 'src/app.ts'), "const app = createAgentApi({ title: 'Sample', auth })\n")
    const noted = cli(app, 'doctor', '--dir', 'src/lib/kit')
    expect(noted.status).toBe(0)
    expect(noted.stdout).toContain("note     the app runs on Node (@hono/node-server) and names no source for the caller's address")
    await writeFile(join(app, 'src/app.ts'), "const app = createAgentApi({ title: 'Sample', auth, address: 'socket' })\n")
    expect(cli(app, 'doctor', '--dir', 'src/lib/kit').stdout).toBe(`src/lib/kit matches kit ${KIT_VERSION}: core\n`)
    // A kit outside src: the app's own src is read
    await rm(join(app, 'src/lib'), { recursive: true })
    cli(app, 'add', 'core', '--dir', 'kit')
    expect(cli(app, 'doctor', '--dir', 'kit').stdout).toBe(`kit matches kit ${KIT_VERSION}: core\n`)
    await writeFile(join(app, 'src/app.ts'), "const app = createAgentApi({ title: 'Sample', auth })\n")
    expect(cli(app, 'doctor', '--dir', 'kit').stdout).toContain("note     the app runs on Node (@hono/node-server) and names no source for the caller's address")
  })

  it('doctor never reads above the app for the address note', async () => {
    // The app sits in a folder named src beside another project served on Node
    const projects = join(await mkdtemp(join(tmpdir(), 'kit-projects-')), 'src')
    const app = join(projects, 'sample')
    await mkdir(join(projects, 'other'), { recursive: true })
    await mkdir(app)
    await writeFile(join(projects, 'other/server.ts'), "import { serve } from '@hono/node-server'\n")
    cli(app, 'add', 'core', '--dir', 'kit')
    expect(cli(app, 'doctor', '--dir', 'kit').stdout).toBe(`kit matches kit ${KIT_VERSION}: core\n`)
  })

  it('doctor names a kept file as edited here and changed in the kit', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'core', '--dir', 'kit')
    const lock = JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8'))
    await writeFile(join(app, 'kit/core/cache.ts'), '// mine\n')
    const keptLine = `edited   core/cache.ts: you edited it, and kit ${KIT_VERSION} changed it: \`kit diff --dir kit --patch\` shows both; \`kit update core --dir kit --force\` takes the kit's, then make your edits again`
    // Kept by an update that left kit.json at the older version
    await writeFile(join(app, 'kit/kit.json'), JSON.stringify({ ...lock, version: '0.0.1', files: { ...lock.files, 'core/cache.ts': 'older' } }))
    const kept = cli(app, 'doctor', '--dir', 'kit')
    expect(kept.status).toBe(1)
    // Which kit runs, against which copy: an npx without a version runs the newest kit
    expect(kept.stdout.trim().split('\n')).toEqual([`Kit ${KIT_VERSION} (this command) checks kit, a copy of kit 0.0.1`, 'note     kit.json says kit 0.0.1: `kit upgrading --dir kit` prints what changed for its parts since, and what to do', keptLine, '1 to fix in kit'])
    // At this kit's version (an older CLI stamped it over the kept file) the record is all there is: the edit is yours, never 'copied from' the new kit
    await writeFile(join(app, 'kit/kit.json'), JSON.stringify({ ...lock, files: { ...lock.files, 'core/cache.ts': 'older' } }))
    const stamped = cli(app, 'doctor', '--dir', 'kit')
    expect(stamped.stdout.trim().split('\n')).toEqual([
      "edited   core/cache.ts: yours to keep; `kit diff --dir kit --patch` shows the change, `kit update core --dir kit --force` takes the kit's",
      '1 to fix in kit',
    ])
    expect(stamped.stdout).not.toContain('copied from')
  })

  it('an edited file whose record is wrong at this kit version stays yours, and update records the kit’s hash', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'core', '--dir', 'kit')
    const lock = JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8'))
    const edited = (await kitText('core/cache.ts')) + '// mine\n'
    await writeFile(join(app, 'kit/core/cache.ts'), edited)
    await writeFile(join(app, 'kit/kit.json'), JSON.stringify({ ...lock, files: { ...lock.files, 'core/cache.ts': 'bad' } }))
    expect(cli(app, 'doctor', '--dir', 'kit').stdout.trim().split('\n')).toEqual([
      "edited   core/cache.ts: yours to keep; `kit diff --dir kit --patch` shows the change, `kit update core --dir kit --force` takes the kit's",
      '1 to fix in kit',
    ])
    for (const run of [1, 2]) {
      const updated = cli(app, 'update', '--dir', 'kit')
      expect([run, updated.status]).toEqual([run, 0])
      expect(updated.stdout).toContain(`kit.json → ${KIT_VERSION}`)
    }
    expect(await readFile(join(app, 'kit/core/cache.ts'), 'utf8')).toBe(edited)
    expect(JSON.parse(await readFile(join(app, 'kit/kit.json'), 'utf8'))).toMatchObject({ version: KIT_VERSION, files: { 'core/cache.ts': hashOfText(await kitText('core/cache.ts')) } })
  })

  it('update that adds a part keeps an edited index.ts and says so, at the same kit version', async () => {
    const app = await mkdtemp(join(tmpdir(), 'kit-app-'))
    cli(app, 'add', 'core', '--dir', 'kit')
    const edited = (await readFile(join(app, 'kit/index.ts'), 'utf8')) + '// mine\n'
    await writeFile(join(app, 'kit/index.ts'), edited)
    const added = cli(app, 'update', 'pagination', '--dir', 'kit')
    expect(added.status).toBe(1)
    expect(added.stdout).toContain('1 file kept at kit')
    expect(added.stdout).toContain(': index.ts.')
    expect(await readFile(join(app, 'kit/index.ts'), 'utf8')).toBe(edited)
    expect(cli(app, 'doctor', '--dir', 'kit').stdout).toMatch(/edited {3}index\.ts: you edited it, and kit/)
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
    cli(app, 'update', 'core', '--force')
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
      // The way `npm create escalay@latest demo-api` starts: create-escalay hands its arguments to `init`; flags may come first
      // --no-install: the kit's own packages resolve the app here, without a download
      const made = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'packages/create-escalay/index.mjs'), '--preset', 'api', '--yes', '--no-install', '--title', 'Demo API', 'demo-api'], { cwd: parent, encoding: 'utf8' })
      expect(made.status, made.stderr).toBe(0)
      expect(existsSync(join(parent, 'api'))).toBe(false)
      // Without the install, init's Next line names what it would have run; api-kit-build gives it for that case
      const next = made.stdout.match(/^Next: cd demo-api && (.+) && pnpm dev$/m)?.[1]
      expect(next).toBe('pnpm install && pnpm format && pnpm migrations && pnpm test')
      expect(await readFile(join(import.meta.dirname, '..', 'skills/api-kit-build/SKILL.md'), 'utf8')).toContain(`\`cd my-api && ${next}\``)
      // and the line before it gives the coding agent the kit's skills, first, so it reads them before it builds
      // -y: without it the installer stops to ask, which an agent's shell never answers
      expect(made.stdout).toMatch(/^Skills first: npx skills add escalay\/api-kit -y .*\nNext: /m)
      // and that doctor fails on a new app until the starter's text is the product's, with the commands that render the brand
      expect(made.stdout).toContain("Doctor: `npx @escalay/kit doctor` fails on a new app until the starter's text is yours, in the files it names: guide/skills/demo-api/SKILL.md (its description), brand/brand.ts (its description), src/features/catalog.ts (each switch's description, once `feature --switch` writes one); then `pnpm add -D @resvg/resvg-js` and `npx @escalay/kit brand` render the brand")
      const later = cli(parent, 'init', 'box', '--preset', 'selfhosted', '--yes')
      expect([later.status, later.stderr]).toEqual([1, 'kit: the selfhosted preset arrives with escalay/selfhost-kit; use --preset api\n'])
      expect(existsSync(join(parent, 'box'))).toBe(false)
      expect(cli(parent, 'init', 'box', '--preset', 'blog').stderr).toContain('--preset is one of api, app, selfhosted')
      expect(cli(parent, 'feature', 'reading-lists', '--app', 'demo-api', '--switch').status).toBe(0)
      expect(cli(parent, 'feature', 'reading-lists', '--app', 'demo-api').stderr).toContain('already exists')
      expect(cli(parent, 'feature', 'Bad_Name', '--app', 'demo-api').stderr).toContain('plural kebab-case')
      const app = join(parent, 'demo-api')
      const features = await readFile(join(app, 'src/features/index.ts'), 'utf8')
      expect(features).toContain("import { feature as readingLists } from './reading-lists/index.js'")
      expect(await readFile(join(app, 'src/features/reading-lists/schema.ts'), 'utf8')).toContain("sqliteTable('reading_lists'")
      expect(await readFile(join(app, 'src/features/reading-lists/tools.ts'), 'utf8')).toContain("name: 'get_reading_list'")
      // --switch: listed in the catalog, so an owner can switch it off, and the feature names its switch
      expect(await readFile(join(app, 'src/features/catalog.ts'), 'utf8')).toContain("  'reading-lists': { title: 'ReadingLists', description: 'ReadingLists: say here what switching it off stops.' },\n  // kit:catalog")
      expect(await readFile(join(app, 'src/features/reading-lists/index.ts'), 'utf8')).toContain("  name: 'reading-lists',\n  switch: 'reading-lists',")
      // pagination too: a feature's list pages by cursor
      expect(JSON.parse(await readFile(join(app, 'src/kit/kit.json'), 'utf8')).modules).toEqual(['core', 'db', 'oauth', 'pagination', 'guide', 'mcp', 'brand', 'switches', 'testing'])
      // The starter brand: a monogram of the title, served as SVG until `kit brand` renders it
      expect(await readFile(join(app, 'brand/brand.ts'), 'utf8')).toContain("  name: 'demo-api',\n  title: 'Demo API',")
      expect(await readFile(join(app, 'brand/icon.svg'), 'utf8')).toContain('>D</text>')
      expect(await readFile(join(app, 'src/brand.gen.ts'), 'utf8')).not.toContain('png:')
      const doctor = cli(app, 'doctor')
      expect(doctor.stdout).toContain('note     brand: src/brand.gen.ts has the SVG only')
      // server.ts and worker.ts each name where a caller's address comes from
      expect(doctor.stdout).not.toContain('names no source for the caller')
      // The text the starter leaves for the app to write fails doctor until it is written
      expect(doctor.status).toBe(1)
      const starterLines = (text: string) => text.split('\n').filter((line) => line.startsWith('starter  '))
      // Under one heading that says they are expected on a new app
      expect(doctor.stdout.split('\n').find((line) => line.startsWith('starter  ')) && doctor.stdout).toContain("Expected on a new app: the starter's text, until it is yours (doctor passes once each is written and `kit brand` has rendered the brand):\nstarter  ")
      expect(starterLines(doctor.stdout)).toEqual([
        'starter  guide/skills/demo-api/SKILL.md: its description is still the starter’s ("Replace this line with"): say when an agent should use the product, in its users’ words',
        'starter  brand/brand.ts: its description is still the starter’s (", an agent-ready API."): say what the product does, in at most 100 characters, then `pnpm add -D @resvg/resvg-js` && `kit brand`',
        'starter  src/features/catalog.ts: a description is still the starter’s ("say here what switching it off stops"): say what switching the feature off stops',
      ])
      // init named each file doctor names
      const doctorLine = made.stdout.split('\n').find((line) => line.startsWith('Doctor: '))!
      for (const line of starterLines(doctor.stdout)) expect(doctorLine).toContain(` ${/^starter +([^:]+):/.exec(line)![1]} (`)
      // The count names where they are: none is in src/kit
      expect(doctor.stdout.trim().split('\n').at(-1)).toBe('3 to fix in guide/skills/demo-api/SKILL.md, brand/brand.ts and src/features/catalog.ts')
      const productSkill = join(app, 'guide/skills/demo-api/SKILL.md')
      await writeFile(productSkill, (await readFile(productSkill, 'utf8')).replace(/Replace this line with[^"\n]*/, 'For reading lists: making one, adding books.'))
      await writeFile(join(app, 'brand/brand.ts'), (await readFile(join(app, 'brand/brand.ts'), 'utf8')).replace('Demo API, an agent-ready API.', 'Reading lists, shared with your agents.'))
      const catalog = join(app, 'src/features/catalog.ts')
      await writeFile(catalog, (await readFile(catalog, 'utf8')).replace('ReadingLists: say here what switching it off stops.', 'Reading lists: off, nobody can make or read one.'))
      expect(starterLines(cli(app, 'doctor').stdout)).toEqual([])
      // A description the MCP server can't read: its skill would be skipped, so doctor fails, in the server's words
      const quoted = await readFile(productSkill, 'utf8')
      await writeFile(productSkill, quoted.replace(/^description: "(.*)"$/m, 'description: $1'))
      const unreadable = cli(app, 'doctor')
      expect([unreadable.status, unreadable.stdout.split('\n').filter((line) => line.startsWith('skill    '))]).toEqual([1, ['skill    guide/skills/demo-api/SKILL.md: SKILL.md frontmatter: line 3: a plain value cannot contain ": "; quote the value (skill skipped)', 'skill    guide/skills/: no skills found (a skill is a folder containing SKILL.md)']])
      await writeFile(productSkill, quoted)
      cli(app, 'guide')
      const bin = (name: string) => join(import.meta.dirname, '..', 'node_modules/.bin', name)
      // The product's own skill, the place for developer skills, and the link coding agents find them through
      for (const path of ['guide/skills/demo-api/SKILL.md', 'guide/skills/demo-api/references/find-your-way.md', '.agents/skills/README.md']) expect(existsSync(join(app, path)), path).toBe(true)
      expect(await readlink(join(app, '.claude/skills'))).toBe('../.agents/skills')
      // Installing from the repository must find the product's skill, which is not where the installer looks first
      expect(JSON.parse(await readFile(join(app, 'skills.sh.json'), 'utf8'))).toEqual({ paths: ['./guide/skills'] })
      expect(await readFile(join(app, 'guide/skills/demo-api/SKILL.md'), 'utf8')).toMatch(/^---\nname: demo-api\ndescription: "Use when a task needs Demo API\./)
      expect(await readFile(join(app, 'src/guide.gen.ts'), 'utf8')).toContain('"skills/demo-api/references/find-your-way.md"')
      // Two tabs or a retried refresh never sign a person out of the starter
      expect(await readFile(join(app, 'src/app.ts'), 'utf8')).toContain('reuseGraceSeconds: 30')
      // Both runtimes by default: Node's server.ts and container, and Workers' worker.ts, wrangler.jsonc and D1 files
      for (const path of ['src/server.ts', 'Dockerfile', 'src/worker.ts', 'wrangler.jsonc', 'scripts/migrations.ts', 'src/guide.gen.ts', '.dev.vars.example']) expect(existsSync(join(app, path)), path).toBe(true)
      expect(JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).scripts).toMatchObject({ dev: 'tsx watch --env-file-if-exists=.env src/server.ts', 'dev:worker': 'wrangler dev', deploy: expect.stringContaining('wrangler d1 migrations apply DB --remote') })
      const migrations = spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' })
      expect(migrations.status, migrations.stderr).toBe(0)
      expect((await readdir(join(app, 'migrations'))).sort()).toEqual(['0000_kit_migrations.sql', '0001_oauth_1.sql', '0002_oauth_2.sql', '0003_guards_1.sql', '0004_guards_2.sql', '0005_switches_1.sql', '0006_notes_1.sql', '0007_reading-lists_1.sql'])
      expect(spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' }).stdout).toContain('current')
      // An app made with 1.30.0 had no guards step 2: `--check` (CI) asks for it, and `pnpm migrations` adds it at the end
      const current = join(app, 'migrations')
      await rm(join(current, '0004_guards_2.sql'))
      for (const [from, to] of [['0005_switches_1', '0004_switches_1'], ['0006_notes_1', '0005_notes_1'], ['0007_reading-lists_1', '0006_reading-lists_1']]) await rename(join(current, `${from}.sql`), join(current, `${to}.sql`))
      const behind = spawnSync(bin('tsx'), ['scripts/migrations.ts', '--check'], { cwd: app, encoding: 'utf8' })
      expect([behind.status, behind.stderr]).toEqual([1, expect.stringContaining('guards_2')])
      expect(spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' }).status).toBe(0)
      expect((await readdir(current)).sort().at(-1)).toBe('0007_guards_2.sql')
      expect(await readFile(join(current, '0007_guards_2.sql'), 'utf8')).toContain("delete from kit_guards where kind = 'key' and value <> '';")
      // A database `migrate()` already brought up (local dev) takes the files without a duplicate record
      const { DatabaseSync } = await import('node:sqlite')
      const sqlite = new DatabaseSync(':memory:')
      await migrate(await openDb(sqlite), 'oauth', OAUTH_MIGRATIONS)
      for (const file of ['0000_kit_migrations.sql', '0001_oauth_1.sql', '0002_oauth_2.sql']) sqlite.exec(await readFile(join(app, 'migrations', file), 'utf8'))
      expect(sqlite.prepare("select count(*) as n from kit_migrations where feature = 'oauth'").get()).toEqual({ n: 2 })
      // A feature with its own fields, not the sample's title and body
      const fields = 'name:string minutes:int tags:string[] vegan:bool? rating:number? story:text?'
      const recipes = cli(parent, 'feature', 'recipes', '--app', 'demo-api', '--fields', fields)
      expect(recipes.status, recipes.stderr).toBe(0)
      const recipeSchema = await readFile(join(app, 'src/features/recipes/schema.ts'), 'utf8')
      for (const column of ["name: text('name').notNull(),", "minutes: integer('minutes').notNull(),", "tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),", "vegan: integer('vegan', { mode: 'boolean' }),", "rating: real('rating'),", "story: text('story'),"]) expect(recipeSchema).toContain(column)
      expect(recipeSchema).toContain('create table if not exists recipes (id text primary key, "name" text not null, "minutes" integer not null, "tags" text not null, "vegan" integer, "rating" real, "story" text, created_at text not null, updated_at text not null)')
      expect(recipeSchema).not.toMatch(/title|body/)
      expect(await readFile(join(app, 'src/features/recipes/routes.ts'), 'utf8')).toContain('never .default()')
      expect(cli(parent, 'feature', 'meals', '--app', 'demo-api', '--fields', 'name:strin').stderr).toContain('name:strin: a field is <name>:<type>, the type one of string, text, int, number, bool, string[]')
      expect(cli(parent, 'feature', 'meals', '--app', 'demo-api', '--fields', 'id:string').stderr).toContain('id is the kit’s own field')
      expect(cli(parent, 'feature', 'meals', '--app', 'demo-api', '--fields', 'a:string a:int').stderr).toContain('a is named twice')
      expect(existsSync(join(app, 'src/features/meals'))).toBe(false)
      expect(spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' }).status).toBe(0)
      expect((await readdir(current)).sort().at(-1)).toBe('0008_recipes_1.sql')
      // A feature taken out leaves its files behind: --check names them, `pnpm migrations` removes them, and numbering goes on from the highest
      await writeFile(join(current, '0009_gone_1.sql'), `-- kit: gone step 1 sha256 ${'0'.repeat(64)}\ncreate table if not exists gone (id text primary key);\n`)
      const orphaned = spawnSync(bin('tsx'), ['scripts/migrations.ts', '--check'], { cwd: app, encoding: 'utf8' })
      expect([orphaned.status, orphaned.stderr]).toEqual([1, expect.stringContaining('0009_gone_1.sql is for gone, which nothing here migrates: run pnpm migrations')])
      const pruned = spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' })
      expect(pruned.stdout).toContain('Removed 0009_gone_1.sql')
      await rm(join(current, '0005_notes_1.sql'))
      expect(spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' }).status).toBe(0)
      expect((await readdir(current)).sort().slice(-2)).toEqual(['0008_recipes_1.sql', '0009_notes_1.sql'])
      for (const project of ['tsconfig.json', 'test/workers/tsconfig.json']) {
        const typecheck = spawnSync(bin('tsc'), ['--noEmit', '-p', project], { cwd: app, encoding: 'utf8' })
        expect(typecheck.status, `${project}: ${typecheck.stdout}`).toBe(0)
      }
      // Node and workerd: the generated tests, the guide module current, D1 brought up by migrations/, MCP on Workers
      // Plain output: CI asks for colour, which would sit between the words matched below
      const tests = spawnSync(bin('vitest'), ['run', '--root', '.'], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
      expect(tests.status, tests.stdout + tests.stderr).toBe(0)
      expect(tests.stdout).toMatch(/Tests\s+19 passed/)
      // AGENTS.md's Try it, as written: a key from `kit key`, the REST call and the MCP call it gives
      const agents = await readFile(join(app, 'AGENTS.md'), 'utf8')
      const tryIt = agents.slice(agents.indexOf('## Try it'), agents.indexOf('## How changes ship'))
      expect(tryIt).toContain('- Node: `API_KEYS=dev:<hash> pnpm dev`, at http://localhost:4400')
      expect(tryIt).toContain('- Workers: the line in `.dev.vars` (copy `.dev.vars.example`), then `pnpm dev:worker`, at http://localhost:8787')
      expect(tryIt).toMatch(/^BASE=http:\/\/localhost:4400\n/m)
      const keyed = cli(parent, 'key')
      const [, key] = /^Key {7}(\S+)$/m.exec(keyed.stdout)!
      const [, keys] = /^API_KEYS=(\S+)$/m.exec(keyed.stdout)!
      const { createApp: createDemo } = await import(join(app, 'src/app.ts'))
      const { testDb } = await import(join(app, 'src/kit/index.ts'))
      const demo = await createDemo({ db: await testDb(), env: { API_KEYS: keys } })
      const [rest, mcp] = [...tryIt.matchAll(/^curl ((?:.*\\\n)*.*)$/gm)].map(([, call]) => call!.replaceAll('\\\n', ' '))
      const pathOf = (call: string) => /"\$BASE(\/[^"]*)"/.exec(call)![1]!
      expect((await demo.request(pathOf(rest!), { headers: { authorization: `Bearer ${key}` } })).status).toBe(200)
      const sent = Object.fromEntries([...mcp!.matchAll(/-H ['"]([^:]+): ([^'"]+)['"]/g)].map(([, name, value]) => [name, value!.replace('$KEY', key!)]))
      const called = await demo.request(pathOf(mcp!), { method: 'POST', headers: sent, body: /-d '([^']+)'/.exec(mcp!)![1] })
      expect(called.status).toBe(200)
      expect(JSON.stringify(await called.json())).toContain('None yet.')

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

      expect(cli(parent, 'init', 'edge-api', '--runtime', 'cloudflare', '--no-install').status).toBe(0)
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
      // AGENTS.md says how to add the kit's skills, naming only skills the kit has
      const skillsLine = both.split('\n').find((line) => line.startsWith('- `npx skills add escalay/api-kit -y`'))
      expect(skillsLine).toBeDefined()
      const named = [...skillsLine!.matchAll(/`(api-kit-[a-z]+)`/g)].map(([, name]) => name!)
      expect(named).toEqual(expect.arrayContaining(['api-kit-build', 'api-kit-feature', 'api-kit-review']))
      for (const name of named) expect(existsSync(join(import.meta.dirname, '..', 'skills', name, 'SKILL.md')), name).toBe(true)
      // Prebuilt binaries need no build scripts, so `pnpm install` doesn't stop to ask
      expect(await readFile(join(parent, 'edge-api/pnpm-workspace.yaml'), 'utf8')).toContain('workerd: false')
      expect(cli(parent, 'init', 'box-api', '--runtime', 'node', '--no-install').status).toBe(0)
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
        const lintConfig = JSON.parse(await readFile(join(parent, name, '.oxlintrc.json'), 'utf8'))
        expect(lintConfig.ignorePatterns).toContain('src/kit/**')
        // Only worker.ts and src/bindings/ may name the provider: features, app.ts and the browser app are linted for it
        const [provider] = lintConfig.overrides
        expect(provider.files).toEqual(['src/features/**', 'src/app.ts', 'web/**'])
        expect(provider.rules['eslint/no-restricted-imports'][1].patterns[0].group).toEqual(expect.arrayContaining(['cloudflare:*', 'drizzle-orm/d1', '**/bindings/*/cloudflare*']))
        expect(JSON.parse(await readFile(join(parent, name, '.oxfmtrc.json'), 'utf8')).ignorePatterns).toContain('src/kit/**')
      }
      // Every app gets CI, Dependabot, a secrets scan and the Node the kit runs on; each workflow keeps only its runtime's steps
      const kitNode = (await readFile(join(import.meta.dirname, '..', '.node-version'), 'utf8')).trim()
      // Pinned in cli.mjs, since the published package.json loses it: it must follow the kit's own
      const kitPnpm = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')).packageManager
      expect(kitPnpm).toMatch(/^pnpm@\d+\.\d+\.\d+$/)
      expect((await readFile(join(import.meta.dirname, '..', 'cli.mjs'), 'utf8')).match(/KIT_PACKAGE_MANAGER = '([^']+)'/)?.[1]).toBe(kitPnpm)
      for (const name of ['demo-api', 'edge-api', 'box-api']) {
        for (const path of ['.github/dependabot.yml', '.gitleaks.toml', '.github/workflows/codeql.yml', '.github/workflows/scorecard.yml']) expect(existsSync(join(parent, name, path)), `${name}: ${path}`).toBe(true)
        expect((await readFile(join(parent, name, '.node-version'), 'utf8')).trim()).toBe(kitNode)
        // corepack in CI installs this pnpm, the one that wrote the lockfile, not whatever is newest that day
        expect(JSON.parse(await readFile(join(parent, name, 'package.json'), 'utf8')).packageManager).toBe(kitPnpm)
        // CI runs the app's own `check` and `test`, so a push the pre-push hook let through passes CI
        const ci = await readFile(join(parent, name, '.github/workflows/ci.yml'), 'utf8')
        expect(ci).not.toMatch(/runtime:|preset:/)
        for (const line of ['      - run: pnpm check\n', '      - run: pnpm test\n']) expect(ci).toContain(line)
        const scripts = JSON.parse(await readFile(join(parent, name, 'package.json'), 'utf8')).scripts
        expect(scripts).toMatchObject({ gate: 'pnpm check && pnpm test', prepare: 'tsx scripts/hooks.ts' })
        expect(scripts.check).toMatch(/^pnpm typecheck && pnpm lint && \(oxfmt --check \|\| \(echo 'Not formatted: run pnpm format' >&2 && exit 1\)\)/)
        expect(scripts.check.includes('scripts/migrations.ts --check'), name).toBe(name !== 'box-api')
        expect(scripts.check).not.toContain('vite build')
        // AGENTS.md says what this app's check runs, and no more
        const gateLine = (await agentsOf(name)).split('\n').filter((line) => line.startsWith('- `pnpm gate`'))
        expect(gateLine, name).toHaveLength(1)
        expect(gateLine[0]!.includes('`migrations/`'), name).toBe(scripts.check.includes('scripts/migrations.ts --check'))
        expect(gateLine[0]!.includes('the build'), name).toBe(false)
        expect(await readFile(join(parent, name, '.githooks/pre-push'), 'utf8')).toContain('exec pnpm gate')
        expect(statSync(join(parent, name, '.githooks/pre-push')).mode & 0o111, `${name}: the hook is executable`).not.toBe(0)
        // Ready for the Deploy to Cloudflare button: no ids to leave out, a form description for each setting, the block in the README
        const manifestOf = JSON.parse(await readFile(join(parent, name, 'package.json'), 'utf8'))
        const readme = await readFile(join(parent, name, 'README.md'), 'utf8')
        expect(readme).not.toMatch(/runtime:|__title__/)
        if (name === 'box-api') {
          expect(manifestOf.cloudflare).toBeUndefined()
          expect(readme).not.toContain('deploy-button')
        } else {
          expect(await readFile(join(parent, name, 'wrangler.jsonc'), 'utf8')).not.toMatch(/database_id|account_id"\s*:/)
          expect(Object.keys(manifestOf.cloudflare.bindings).sort()).toEqual(['ACCESS_AUD', 'ACCESS_TEAM', 'API_KEYS', 'OAUTH_SIGNING_KEY', 'PUBLIC_HOST'])
          expect(readme).toContain('<!-- deploy-button -->\n')
          const ready = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'button', '--check'], { cwd: join(parent, name), encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } })
          expect(ready.stdout, ready.stderr).toContain('is ready for the Deploy to Cloudflare button')
        }
        // Made inside the kit's own repository: no repository of its own inside another
        expect(existsSync(join(parent, name, '.git'))).toBe(false)
      }
      // Nothing of the app preset reaches an API-only app
      for (const text of [edgeWrangler, await readFile(join(parent, 'edge-api/src/app.ts'), 'utf8'), await readFile(join(parent, 'edge-api/vitest.config.ts'), 'utf8'), await agentsOf('edge-api')]) expect(text).not.toMatch(/preset:|"assets"|home: 'app'|plugin-react|vite build/)
      expect(existsSync(join(parent, 'edge-api/web'))).toBe(false)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('takes people, setup and boards the way their READMEs say, and passes its own tests on both runtimes', async () => {
    const parent = join(import.meta.dirname, '.generated', `run-team-${process.pid}`)
    await rm(parent, { recursive: true, force: true })
    await mkdir(parent, { recursive: true })
    const bin = (name: string) => join(import.meta.dirname, '..', 'node_modules/.bin', name)
    try {
      expect(cli(parent, 'init', 'team-api', '--no-install').status).toBe(0)
      const app = join(parent, 'team-api')
      const read = (path: string) => readFile(join(app, path), 'utf8')
      const edit = async (path: string, from: string, to: string) => {
        const text = await read(path)
        expect(text, `${path}: ${from}`).toContain(from)
        await writeFile(join(app, path), text.replace(from, to))
      }
      expect(cli(app, 'feature', 'things', '--switch').status).toBe(0)
      expect(cli(app, 'feature', 'recipes', '--fields', 'name:string').status).toBe(0)
      const added = cli(app, 'add', 'people', 'setup', 'boards')
      expect(added.stdout).toContain('Wire people: a feature in src/features/people/ listed in src/features/index.ts (its migrations reach migrations/ through it: add no line to scripts/migrations.ts), and the lines in src/app.ts: src/kit/people/README.md › In an app made by `kit init`')
      // The starter's script finds the parts' tables itself
      expect(added.stdout).not.toContain('scripts/migrations.ts lacks')
      // Each part's feature as its README writes it, listed in the order it says
      for (const part of ['people', 'setup', 'boards']) {
        const readme = await read(`src/kit/${part}/README.md`)
        const block = readme.slice(readme.indexOf('### In an app made by `kit init`')).match(/```ts\n([\s\S]*?)```/)![1]!
        expect(block.split('\n')[0]).toMatch(new RegExp(`^// src/features/${part}/index\\.ts, listed in src/features/index\\.ts`))
        await mkdir(join(app, 'src/features', part))
        await writeFile(join(app, 'src/features', part, 'index.ts'), block)
        await edit('src/features/index.ts', '// kit:imports', `import { feature as ${part} } from './${part}/index.js'\n// kit:imports`)
        await edit('src/features/index.ts', '  // kit:features', `  ${part},\n  // kit:features`)
      }
      // src/app.ts as the READMEs say: the setup secret, and people's owner and auth lines with the imports they name
      const people = await read('src/kit/people/README.md')
      const wiring = people.slice(people.indexOf('Then in `src/app.ts`')).match(/```ts\n([\s\S]*?)```/)![1]!.split('\n')
      const owner = wiring.slice(0, wiring.indexOf('  }') + 1).join('\n')
      const auth = wiring.find((line) => line.startsWith('    auth: '))!.replace("realm: 'postbox'", "realm: 'team-api'")
      await edit('src/app.ts', 'FEATURES_OFF?: string }', 'FEATURES_OFF?: string; SETUP_CODE?: string }')
      // and in the container's allowlist, as the printed step says (the app's test/env.test.ts holds them in step)
      const passSetupCode = '${SETUP_CODE:+SETUP_CODE="$SETUP_CODE"}'
      expect(added.stdout).toContain(`Setting SETUP_CODE (the code the first person types to claim the deployment, a secret: \`openssl rand -base64 18\`): add it to Env in src/app.ts, .env.example, .dev.vars.example, container/entrypoint.sh as ${passSetupCode}\n`)
      await edit('container/entrypoint.sh', ' \\\n  node_modules/.bin/tsx', ` ${passSetupCode} \\\n  node_modules/.bin/tsx`)
      await edit('src/app.ts', "    auth: { realm: 'team-api', keys: parseApiKeys(env.API_KEYS), access },", auth)
      await edit('src/app.ts', '  const owner = access ? accessOwner(access) : async () => null', owner)
      await edit('src/app.ts', 'featureTools, parseApiKeys,', 'featureTools, parseApiKeys, PEOPLE_OPEN_PATHS, personOf, roleOf, sessionOf, SETUP_OPEN_PATHS,')
      await edit('src/app.ts', 'import BRAND from', "import type { Context } from 'hono'\nimport BRAND from")
      // people's whole sign-in as a test, and the owner it signs in switches a feature, as a deployment key can
      const flow = people.slice(people.indexOf('// test/owner.test.ts')).split('```')[0]!
      const switched = "\nit('lets the owner signed in by passkey switch a feature off', async () => {\n  expect(await send('PATCH', '/api/features/things', { on: false })).toMatchObject({ key: 'things', on: false })\n})\n"
      await writeFile(join(app, 'test/owner.test.ts'), flow + switched)
      const migrations = spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' })
      expect(migrations.status, migrations.stderr).toBe(0)
      const files = await readdir(join(app, 'migrations'))
      for (const step of ['people_1', 'setup_1', 'boards_1']) expect(files.filter((file) => file.endsWith(`_${step}.sql`)), step).toHaveLength(1)
      for (const project of ['tsconfig.json', 'test/workers/tsconfig.json']) {
        const typecheck = spawnSync(bin('tsc'), ['--noEmit', '-p', project], { cwd: app, encoding: 'utf8' })
        expect(typecheck.status, `${project}: ${typecheck.stdout}`).toBe(0)
      }
      const tests = spawnSync(bin('vitest'), ['run', '--root', '.', '--reporter', 'verbose'], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
      expect(tests.status, tests.stdout + tests.stderr).toBe(0)
      for (const name of ['claims the deployment, makes a passkey, signs in again, and approves an agent', 'lets the owner signed in by passkey switch a feature off', 'answers every feature list route with a key, and refuses without one', 'runs every MCP tool against its route']) expect(tests.stdout).toContain(name)
      // The boards' tools are on MCP, so toolsRun ran them with the README's samples
      expect(await read('src/features/boards/index.ts')).toContain('save_to_board: { id, ref }')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('takes sharing the way kit add and its README say, and a friend’s agent joins one shelf and loses it with the shelf', async () => {
    const parent = join(import.meta.dirname, '.generated', `run-share-${process.pid}`)
    await rm(parent, { recursive: true, force: true })
    await mkdir(parent, { recursive: true })
    const bin = (name: string) => join(import.meta.dirname, '..', 'node_modules/.bin', name)
    try {
      expect(cli(parent, 'init', 'shelves', '--no-install').status).toBe(0)
      const app = join(parent, 'shelves')
      const read = (path: string) => readFile(join(app, path), 'utf8')
      expect(cli(app, 'feature', 'shelves', '--singular', 'shelf', '--fields', 'name:string').status).toBe(0)
      // Every step the part needs, from its registry data, only where the app lacks it
      const added = cli(app, 'add', 'sharing')
      expect(added.status, added.stderr).toBe(0)
      const steps = added.stdout.split('\n').filter((line) => /^(Wire|Setting|Schedule)[: ]/.test(line))
      expect(steps).toEqual([
        'Wire sharing: src/kit/sharing/README.md › Wire it; or `kit add sharing --wire --spaces <feature>` writes it all, settings too',
        "Setting OAUTH_SIGNING_KEY (the OAuth server's ES256 key, a secret: `generateOAuthKey()` from ./kit/index.js makes one): add it to .env.example, .dev.vars.example, vitest.config.ts's miniflare bindings as OAUTH_SIGNING_KEY: await generateOAuthKey() (import { generateOAuthKey } from './src/kit/index.js')",
        "Setting SHARING_SECRET (32 random bytes or more, a secret of its own: `openssl rand -base64 32`): add it to Env in src/app.ts, .env.example, .dev.vars.example, container/entrypoint.sh as ${SHARING_SECRET:+SHARING_SECRET=\"$SHARING_SECRET\"}, vitest.config.ts's miniflare bindings as SHARING_SECRET: 'a sharing secret of thirty-two bytes or more, for tests only'",
        "Setting PUBLIC_ORIGIN (the origin people and agents reach the app at, createOAuth's publicOrigin): add it to Env in src/app.ts, .env.example, .dev.vars.example, container/entrypoint.sh as ${PUBLIC_ORIGIN:+PUBLIC_ORIGIN=\"$PUBLIC_ORIGIN\"}, vitest.config.ts's miniflare bindings as PUBLIC_ORIGIN: 'https://api.test'",
        'Schedule: "triggers": { "crons": ["17 * * * *"] } in wrangler.jsonc, and a scheduled handler in src/worker.ts that calls sharing\'s sweep()',
        "Schedule: src/server.ts calls sharing's sweep() on a timer (hourly is enough)",
      ])
      // The starter's script finds the part's tables itself
      expect(added.stdout).not.toContain('lacks')
      // The README's Wire it, block by block, each where its first line says
      const readme = await read('src/kit/sharing/README.md')
      const block = readme.slice(readme.indexOf('## Wire it')).match(/```ts\n([\s\S]*?)```/)![1]!
      const groups = block.split(/^\/\/ (src\/[^\n]*)\n/m).slice(1)
      // A line's key: what it declares or sets, at its indent
      const keyOf = (line: string) => /^\s*(export type \w+|const \w+|\w+:|\w+\()/.exec(line)?.[0]
      for (let at = 0; at < groups.length; at += 2) {
        const [, first, second, where] = /^([^,]+?)(?: and (src\/\S+))?, (.*)$/.exec(groups[at]!)!
        const lines = groups[at + 1]!.replace(/\n$/, '').split('\n')
        for (const file of [first!, ...(second ? [second] : [])]) {
          if (where!.startsWith('new')) {
            await writeFile(join(app, file), groups[at + 1]!)
            continue
          }
          const text = (await read(file)).split('\n')
          const find = (match: (line: string) => boolean, what: string) => {
            const found = text.flatMap((line, index) => (match(line) ? [index] : []))
            expect(found, `${file}: ${what}`).toHaveLength(1)
            return found[0]!
          }
          if (where!.startsWith('in place of')) for (const line of lines) text[find((one) => keyOf(one) === keyOf(line), keyOf(line)!)] = line
          else if (where!.startsWith('inside')) {
            const index = find((one) => one.startsWith(/`([^`]+)`/.exec(where!)![1]!), where!)
            text[index] = text[index]!.replace(/ \}$/, `; ${lines.join(' ')} }`)
          } else {
            const [, side, anchor] = /^(before|after) `([^`]+)`/.exec(where!)!
            text.splice(find((one) => one.trimStart().startsWith(anchor!), anchor!) + (side === 'after' ? 1 : 0), 0, ...lines)
          }
          await writeFile(join(app, file), text.join('\n'))
        }
      }
      expect(await read('src/app.ts')).toContain('PUBLIC_ORIGIN?: string }')
      // Its hooks chain, for an app with hooks of its own, typechecks as written, with every name it uses
      const chain = [...readme.slice(readme.indexOf('## Wire it'), readme.indexOf('## Options')).matchAll(/```ts\n([\s\S]*?)```/g)][1]![1]!
      await writeFile(join(app, 'src/hooks.ts'), chain)
      // The printed steps as printed: each setting in the workerd tests' bindings (so sharing is on there too), the schedule
      const config = join(app, 'vitest.config.ts')
      for (const line of steps.filter((step) => step.startsWith('Setting '))) {
        const [, binding, imported] = /miniflare bindings as (\w+: .+?)(?: \((import .+)\))?$/.exec(line)!
        const text = await readFile(config, 'utf8')
        await writeFile(config, (imported ? `${imported}\n` : '') + text.replace("TEST_MIGRATIONS: await readD1Migrations('./migrations')", `$&, ${binding}`))
      }
      // and each in the container's allowlist, as printed
      const entrypoint = join(app, 'container/entrypoint.sh')
      for (const step of steps) {
        const line = /container\/entrypoint\.sh as (\$\{\w+:\+\w+="\$\w+"\})/.exec(step)?.[1]
        if (line) await writeFile(entrypoint, (await readFile(entrypoint, 'utf8')).replace(' \\\n  node_modules/.bin/tsx', ` ${line} \\\n  node_modules/.bin/tsx`))
      }
      const wrangler = join(app, 'wrangler.jsonc')
      await writeFile(wrangler, (await readFile(wrangler, 'utf8')).replace(/^(\s*"compatibility_date": .*)$/m, '$1\n  "triggers": { "crons": ["17 * * * *"] },'))
      expect(cli(app, 'add', 'sharing').stdout).not.toMatch(/^Schedule: "triggers"/m)
      // A friend's agent joins Soups with its code, as the README's test line says, and loses it with the shelf
      await writeFile(
        join(app, 'test/sharing.test.ts'),
        SHARING_FRIEND_TEST,
      )
      const migrations = spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' })
      expect(migrations.status, migrations.stderr).toBe(0)
      expect((await readdir(join(app, 'migrations'))).filter((file) => file.endsWith('_sharing_1.sql'))).toHaveLength(1)
      for (const project of ['tsconfig.json', 'test/workers/tsconfig.json']) {
        const typecheck = spawnSync(bin('tsc'), ['--noEmit', '-p', project], { cwd: app, encoding: 'utf8' })
        expect(typecheck.status, `${project}: ${typecheck.stdout}`).toBe(0)
      }
      const tests = spawnSync(bin('vitest'), ['run', '--root', '.', '--reporter', 'verbose'], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
      expect(tests.status, tests.stdout + tests.stderr).toBe(0)
      for (const name of ['lets a friend’s agent read the shelf it was invited to, and no other, until the shelf goes', 'runs every MCP tool against its route']) expect(tests.stdout).toContain(name)
      // What the README wired, doctor finds: a sweep, and the Workers address header
      const doctor = cli(app, 'doctor')
      expect(doctor.stdout).not.toMatch(/sharing part, but/)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('wires people, setup, boards and sharing with add --wire into a formatted app, once, and both READMEs’ tests pass', async () => {
    const parent = join(import.meta.dirname, '.generated', `run-wire-${process.pid}`)
    await rm(parent, { recursive: true, force: true })
    await mkdir(parent, { recursive: true })
    const bin = (name: string) => join(import.meta.dirname, '..', 'node_modules/.bin', name)
    // What `pnpm format` formats in the app, with its own settings, each file named: the kit's .gitignore has test/.generated,
    // so oxfmt walks past every folder there
    const format = async (app: string) => {
      const files = (await readdir(app, { recursive: true })).filter((path) => /^(src|test)[\\/].*\.ts$/.test(path) && !/^src[\\/]kit[\\/]|\.gen\.ts$/.test(path))
      const formatted = spawnSync(bin('oxfmt'), ['-c', '.oxfmtrc.json', ...files, 'vitest.config.ts'], { cwd: app, encoding: 'utf8' })
      expect(formatted.status, formatted.stdout + formatted.stderr).toBe(0)
    }
    /** Every file outside src/kit and node_modules, hashed: what --wire may change. */
    const treeOf = async (app: string) => {
      const files = (await readdir(app, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile() && !/[\\/](src[\\/]kit|node_modules)([\\/]|$)/.test(join(entry.parentPath, entry.name).slice(app.length)))
      return Object.fromEntries(await Promise.all(files.map(async (entry) => [join(entry.parentPath, entry.name).slice(app.length + 1), hashOfText(await readFile(join(entry.parentPath, entry.name), 'utf8'))])))
    }
    const checked = async (app: string) => {
      expect(spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' }).status).toBe(0)
      for (const project of ['tsconfig.json', 'test/workers/tsconfig.json']) {
        const typecheck = spawnSync(bin('tsc'), ['--noEmit', '-p', project], { cwd: app, encoding: 'utf8' })
        expect(typecheck.status, `${project}: ${typecheck.stdout}`).toBe(0)
      }
      const tests = spawnSync(bin('vitest'), ['run', '--root', '.', '--reporter', 'verbose'], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
      expect(tests.status, tests.stdout + tests.stderr).toBe(0)
      return tests.stdout
    }
    try {
      expect(cli(parent, 'init', 'wired', '--no-install').status).toBe(0)
      const app = join(parent, 'wired')
      const read = (path: string) => readFile(join(app, path), 'utf8')
      expect(cli(app, 'feature', 'recipes', '--fields', 'name:string').status).toBe(0)
      expect(cli(app, 'feature', 'shelves', '--singular', 'shelf', '--fields', 'name:string').status).toBe(0)
      // Refused before anything is copied: a feature to work over is named, and exists
      const before = await treeOf(app)
      expect(cli(app, 'add', 'sharing', '--wire').stderr).toContain('--wire sharing needs --spaces <feature>, the feature whose rows are the spaces')
      expect(cli(app, 'add', 'boards', '--wire', '--items', 'books').stderr).toContain('--items books: no src/features/books/')
      expect(existsSync(join(app, 'src/kit/sharing'))).toBe(false)
      expect(await treeOf(app)).toEqual(before)
      // As an installed app has it: formatted, the long Env type wrapped
      await format(app)
      expect(await read('src/app.ts')).toMatch(/^export type Env = \{\n/m)
      const wired = cli(app, 'add', 'people', 'setup', 'boards', 'sharing', '--wire', '--no-install', '--items', 'recipes', '--spaces', 'shelves')
      expect(wired.status, wired.stdout + wired.stderr).toBe(0)
      expect(wired.stdout).toMatch(/^Wired people, setup, boards, sharing: /m)
      // With --no-install, people's dependency comes first in Next
      expect(wired.stdout).toContain('Next: pnpm add @simplewebauthn/server@^14.1.0 && pnpm format && pnpm migrations && pnpm test')
      expect(wired.stdout).not.toMatch(/^(Wire|Setting|Schedule)[: ]/m)
      // Twice, formatted or not, changes nothing
      const once = await treeOf(app)
      const again = cli(app, 'add', 'people', 'setup', 'boards', 'sharing', '--wire', '--no-install', '--items', 'recipes', '--spaces', 'shelves')
      expect(again.stdout).toContain('Wired already: people, setup, boards, sharing; nothing changed')
      expect(await treeOf(app)).toEqual(once)
      await format(app)
      const formatted = await treeOf(app)
      expect(cli(app, 'add', 'people', 'setup', 'boards', 'sharing', '--wire', '--no-install', '--items', 'recipes', '--spaces', 'shelves').stdout).toContain('Wired already')
      expect(await treeOf(app)).toEqual(formatted)
      // people's sign-in as its README tests it, the owner switching a feature, and the sharing friend's agent
      const people = await read('src/kit/people/README.md')
      const flow = people.slice(people.indexOf('// test/owner.test.ts')).split('```')[0]!
      expect(cli(app, 'feature', 'things', '--switch').status).toBe(0)
      await writeFile(join(app, 'test/owner.test.ts'), `${flow}\nit('lets the owner signed in by passkey switch a feature off', async () => {\n  expect(await send('PATCH', '/api/features/things', { on: false })).toMatchObject({ key: 'things', on: false })\n})\n`)
      await writeFile(join(app, 'test/sharing.test.ts'), SHARING_FRIEND_TEST)
      const ran = await checked(app)
      for (const name of ['claims the deployment, makes a passkey, signs in again, and approves an agent', 'lets the owner signed in by passkey switch a feature off', 'lets a friend’s agent read the shelf it was invited to, and no other, until the shelf goes', 'runs every MCP tool against its route', 'passes every setting Env in src/app.ts reads through container/entrypoint.sh, and nothing else']) expect(ran, name).toContain(name)
      // What it wired, doctor finds: the sweep, the container's settings; and the deploy form describes each setting
      const doctor = cli(app, 'doctor')
      expect(doctor.stdout).not.toMatch(/sharing part, but|^env {6}/m)
      const ready = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'button', '--check'], { cwd: app, encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } })
      expect(ready.stdout, ready.stderr).toContain('is ready for the Deploy to Cloudflare button')

      // The other order, a part at a time: sharing, then people and setup
      expect(cli(parent, 'init', 'later', '--no-install').status).toBe(0)
      const later = join(parent, 'later')
      expect(cli(later, 'feature', 'shelves', '--singular', 'shelf', '--fields', 'name:string').status).toBe(0)
      await format(later)
      const sharingOnly = cli(later, 'add', 'sharing', '--wire', '--no-install', '--spaces', 'shelves')
      expect(sharingOnly.status).toBe(0)
      // A part whose dependencies package.json has leaves Next as it was
      expect(sharingOnly.stdout).toContain('Next: pnpm format && pnpm migrations && pnpm test')
      // On both runtimes: both files, and the one command that makes them
      expect(sharingOnly.stdout).toContain('its settings are in .env.example, .dev.vars.example and container/entrypoint.sh; `npx @escalay/kit env --write` makes .env and .dev.vars from them, a value for each')
      // Where the owner's routes are, what an invite answers, and the worked test: not under /api/shelves
      expect(sharingOnly.stdout).toContain("Owner routes: /api/spaces/{shelf id}/invites (POST answers 201 with code, shown once, address and message) and /api/spaces/{shelf id}/members ({ count, _embedded: { members } }); a friend's agent, as a test: src/kit/sharing/REFERENCE.md")
      const wireIt = (await readFile(join(later, 'src/kit/sharing/README.md'), 'utf8')).split('## Wire it')[1]!.split('```')[0]!
      for (const said of ['/api/spaces/{shelf id}/invites', '`code`', '`address`', 'members', '](REFERENCE.md#a-friends-agent-as-a-test)']) expect(wireIt, said).toContain(said)
      await format(later)
      expect(cli(later, 'add', 'setup', 'people', '--wire', '--no-install').status).toBe(0)
      const auth = (await readFile(join(later, 'src/app.ts'), 'utf8')).replace(/\s+/g, ' ')
      for (const open of ['...PEOPLE_OPEN_PATHS', '...SETUP_OPEN_PATHS', '...(sharing ? SHARING_OPEN_PATHS : [])', 'session: sessionOf(db)']) expect(auth, open).toContain(open)
      expect(await readFile(join(later, 'src/features/index.ts'), 'utf8')).toMatch(/ {2}people,\n {2}setup,\n/)
      // kit env --write: the same key and secrets for both runtimes, each its own origin
      expect(cli(later, 'env', '--write').stdout).toContain('Wrote .env and .dev.vars')
      const nodeEnv = parseEnv(await readFile(join(later, '.env'), 'utf8'))
      const workersEnv = parseEnv(await readFile(join(later, '.dev.vars'), 'utf8'))
      expect(Object.keys(nodeEnv).sort()).toEqual(['API_KEYS', 'OAUTH_SIGNING_KEY', 'PUBLIC_ORIGIN', 'SETUP_CODE', 'SHARING_SECRET'])
      expect([nodeEnv.PUBLIC_ORIGIN, workersEnv.PUBLIC_ORIGIN]).toEqual(['http://localhost:4400', 'http://localhost:8787'])
      for (const name of ['API_KEYS', 'OAUTH_SIGNING_KEY', 'SETUP_CODE', 'SHARING_SECRET']) expect(workersEnv[name], name).toBe(nodeEnv[name])
      await writeFile(join(later, 'test/sharing.test.ts'), SHARING_FRIEND_TEST)
      expect(await checked(later)).toContain('lets a friend’s agent read the shelf it was invited to')

      // An app made before the markers: told every edit, and nothing outside src/kit changes
      expect(cli(parent, 'init', 'older', '--no-install').status).toBe(0)
      const older = join(parent, 'older')
      for (const path of ['src/app.ts', 'src/server.ts', 'src/worker.ts', 'wrangler.jsonc', 'vitest.config.ts']) await writeFile(join(older, path), (await readFile(join(older, path), 'utf8')).replace(/^\s*\/\/ kit:(?!features|imports$).*\n/gm, '').replace(/^\/\/ kit:imports .*\n/m, ''))
      const untouched = await treeOf(older)
      const told = cli(older, 'add', 'people', 'setup', '--wire')
      expect(told.status).toBe(1)
      expect(told.stdout).toContain('Wired nothing: this app has no wiring markers')
      expect(told.stdout).toContain("src/app.ts, in place of the statement that starts `const owner =`:\n      const owner = async (c: Context) => {")
      expect(told.stdout).toContain('src/features/people/index.ts, new:')
      // Each setting as add prints it, only where the app lacks it, with the container's line
      expect(told.stdout).toContain('Setting SETUP_CODE (the code the first person types to claim the deployment, a secret: `openssl rand -base64 18`): add it to Env in src/app.ts, .env.example, .dev.vars.example, container/entrypoint.sh as ${SETUP_CODE:+SETUP_CODE="$SETUP_CODE"}')
      expect(await treeOf(older)).toEqual(untouched)
      // Even a part whose edits need no marker of their own writes nothing there
      for (const parts of [['setup'], ['boards', '--items', 'notes']]) {
        const alone = cli(older, 'add', ...parts, '--wire')
        expect([parts[0], alone.status, alone.stdout]).toEqual([parts[0], 1, expect.stringContaining('Wired nothing: this app has no wiring markers')])
        expect(await treeOf(older)).toEqual(untouched)
      }

      // Each runtime alone: Node (no worker.ts, no D1) and Workers (no server.ts, no container)
      for (const runtime of ['node', 'cloudflare']) {
        expect(cli(parent, 'init', `only-${runtime}`, '--runtime', runtime, '--no-install').status).toBe(0)
        const one = join(parent, `only-${runtime}`)
        expect(cli(one, 'feature', 'shelves', '--singular', 'shelf', '--fields', 'name:string').status).toBe(0)
        await format(one)
        const done = cli(one, 'add', 'people', 'setup', 'boards', 'sharing', '--wire', '--no-install', '--items', 'notes', '--spaces', 'shelves')
        expect([runtime, done.status, done.stderr]).toEqual([runtime, 0, ''])
        if (runtime === 'node') expect(await readFile(join(one, 'src/server.ts'), 'utf8')).toContain('sharingOf(app)?.sweep()')
        else expect(await readFile(join(one, 'src/worker.ts'), 'utf8')).toContain('scheduled: ')
        // Each runtime's own settings file, named in Next, and no other
        const [own, other] = runtime === 'node' ? ['.env', '.dev.vars'] : ['.dev.vars', '.env']
        expect(done.stdout, runtime).toContain(`its settings are in ${own}.example${runtime === 'node' ? ' and container/entrypoint.sh' : ''}; \`npx @escalay/kit env --write\` makes ${own} from it`)
        expect([runtime, existsSync(join(one, `${other}.example`))]).toEqual([runtime, false])
        expect(await readFile(join(one, `${own}.example`), 'utf8')).toMatch(/^# SHARING_SECRET: .*\nSHARING_SECRET=""$/m)
        await writeFile(join(one, 'test/sharing.test.ts'), SHARING_FRIEND_TEST)
        if (runtime === 'cloudflare') expect(spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: one, encoding: 'utf8' }).status).toBe(0)
        for (const project of ['tsconfig.json', ...(runtime === 'node' ? [] : ['test/workers/tsconfig.json'])]) {
          const typecheck = spawnSync(bin('tsc'), ['--noEmit', '-p', project], { cwd: one, encoding: 'utf8' })
          expect(typecheck.status, `${runtime} ${project}: ${typecheck.stdout}`).toBe(0)
        }
        const tests = spawnSync(bin('vitest'), ['run', '--root', '.'], { cwd: one, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
        expect(tests.status, `${runtime}: ${tests.stdout}${tests.stderr}`).toBe(0)
      }
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 240_000)

  it('runs a wired Node app locally: .env.example lists every setting and how to make it, kit env --write makes .env, and pnpm dev reads it', async () => {
    const parent = join(import.meta.dirname, '.generated', `run-env-file-${process.pid}`)
    await rm(parent, { recursive: true, force: true })
    await mkdir(parent, { recursive: true })
    try {
      expect(cli(parent, 'init', 'local-api', '--runtime', 'node', '--no-install', '--no-git').status).toBe(0)
      const app = join(parent, 'local-api')
      const read = (path: string) => readFile(join(app, path), 'utf8')
      // A new Node app: the file pnpm dev reads, git-ignored, and its example
      expect(JSON.parse(await read('package.json')).scripts.dev).toBe('tsx watch --env-file-if-exists=.env src/server.ts')
      expect((await read('.gitignore')).split('\n')).toContain('.env')
      expect(await read('.env.example')).toMatch(/^API_KEYS=""$/m)
      expect(existsSync(join(app, '.dev.vars.example'))).toBe(false)
      expect(await read('AGENTS.md')).toContain('`npx @escalay/kit env --write`')
      expect(cli(app, 'feature', 'shelves', '--singular', 'shelf', '--fields', 'name:string').status).toBe(0)
      const wired = cli(app, 'add', 'setup', 'sharing', '--wire', '--spaces', 'shelves', '--no-install')
      expect(wired.status, wired.stdout + wired.stderr).toBe(0)
      // Each setting with how to make it, and Next names the file and the one command that makes the values
      const example = await read('.env.example')
      for (const [name, how] of [['SETUP_CODE', 'openssl rand -base64 18'], ['OAUTH_SIGNING_KEY', 'generateOAuthKey()'], ['SHARING_SECRET', 'openssl rand -base64 32'], ['PUBLIC_ORIGIN', 'publicOrigin']] as const) {
        expect(example, name).toMatch(new RegExp(`^# ${name}: .*${how.replace(/[()]/g, '\\$&')}.*\\n${name}=""$`, 'm'))
      }
      expect(wired.stdout).toContain('its settings are in .env.example and container/entrypoint.sh; `npx @escalay/kit env --write` makes .env from it, a value for each')
      expect(wired.stdout).not.toContain('.dev.vars')
      // The values, made once, kept nowhere but the file; a second run refuses to overwrite it
      const made = cli(app, 'env', '--write')
      expect(made.status, made.stderr).toBe(0)
      const [, key] = /Key {7}(\S+)/.exec(made.stdout)!
      expect(made.stdout).toContain('Wrote .env')
      const again = cli(app, 'env', '--write')
      expect([again.status, again.stderr]).toEqual([1, expect.stringContaining('.env exists')])
      const values = parseEnv(await read('.env'))
      expect(Object.keys(values).sort()).toEqual(['API_KEYS', 'OAUTH_SIGNING_KEY', 'PUBLIC_ORIGIN', 'SETUP_CODE', 'SHARING_SECRET'])
      expect(values.PUBLIC_ORIGIN).toBe('http://localhost:4400')
      expect(Buffer.from(values.SHARING_SECRET!, 'base64')).toHaveLength(32)
      // The app takes them as they are: the key lets it in, and sharing is on (its OAuth server signs with the key)
      const { createApp: createLocal } = await import(join(app, 'src/app.ts'))
      const { testDb: dbOf } = await import(join(app, 'src/kit/index.ts'))
      const local = await createLocal({ db: await dbOf(), env: values })
      expect((await local.request('/api/shelves', { headers: { authorization: `Bearer ${key}` } })).status).toBe(200)
      const metadata = await local.request('http://localhost:4400/.well-known/oauth-authorization-server')
      expect([metadata.status, ((await metadata.json()) as { issuer: string }).issuer]).toEqual([200, 'http://localhost:4400'])
      // Printed without --write, nothing written
      await rm(join(app, '.env'))
      const printed = cli(app, 'env')
      expect(printed.stdout).toMatch(/^SHARING_SECRET="[A-Za-z0-9+/=]{44}"$/m)
      expect(existsSync(join(app, '.env'))).toBe(false)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('wires the settings into an older Node app’s .env.example, made when missing, and its dev script', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-env-older-'))
    try {
      expect(cli(parent, 'init', 'older-api', '--runtime', 'node', '--no-install', '--no-git').status).toBe(0)
      const app = join(parent, 'older-api')
      // As 1.35.0 made it: no .env.example, a dev script that reads no file
      await rm(join(app, '.env.example'))
      const manifest = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'))
      await writeFile(join(app, 'package.json'), JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, dev: 'tsx watch src/server.ts' } }, null, 2))
      const wired = cli(app, 'add', 'setup', 'people', '--wire', '--no-install')
      expect(wired.stdout).toMatch(/^Wired setup, people: .*\.env\.example/m)
      expect(await readFile(join(app, '.env.example'), 'utf8')).toMatch(/^SETUP_CODE=""$/m)
      expect(JSON.parse(await readFile(join(app, 'package.json'), 'utf8')).scripts.dev).toBe('tsx watch --env-file-if-exists=.env src/server.ts')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  it('installs what the wired parts need with add --wire, with the app’s package manager, or names the command when it cannot', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-wire-install-'))
    // Stand-ins for the package managers: each logs where it ran and what it was asked, and fails when told to
    const bins = join(parent, 'bin')
    await mkdir(bins)
    const log = join(parent, 'calls.log')
    for (const name of ['pnpm', 'npm']) await writeFile(join(bins, name), `#!/bin/sh\necho "$(pwd -P) ${name} $*" >> "${log}"\nexit \${FAKE_PM_EXIT:-0}\n`, { mode: 0o755 })
    const wire = (cwd: string, more: string[] = [], exit = '0') =>
      spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'add', 'people', 'setup', '--wire', ...more], { cwd, encoding: 'utf8', env: { ...process.env, PATH: `${bins}:${process.env.PATH}`, FAKE_PM_EXIT: exit } })
    const calls = async () => (existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n') : [])
    try {
      for (const name of ['by-pnpm', 'by-npm', 'told', 'failed']) expect(cli(parent, 'init', name, '--runtime', 'node', '--no-install', '--no-git').status).toBe(0)
      const app = join(parent, 'by-pnpm')
      // In the app's folder, with the package manager package.json names, before Next
      const wired = wire(join(app, 'src'), ['--dir', 'kit'])
      expect(wired.status, wired.stdout + wired.stderr).toBe(0)
      expect(await calls()).toEqual([`${await realpath(app)} pnpm add @simplewebauthn/server@^14.1.0`])
      expect(wired.stdout).toContain('Next: pnpm format && pnpm test')
      expect(wired.stdout).not.toContain('Dependencies: pnpm add')
      // An app on npm: npm install
      const npmApp = join(parent, 'by-npm')
      const manifest = JSON.parse(await readFile(join(npmApp, 'package.json'), 'utf8'))
      delete manifest.packageManager
      await writeFile(join(npmApp, 'package.json'), JSON.stringify(manifest))
      await writeFile(join(npmApp, 'package-lock.json'), '{}')
      await rm(log)
      expect(wire(npmApp).status).toBe(0)
      expect(await calls()).toEqual([`${await realpath(npmApp)} npm install @simplewebauthn/server@^14.1.0`])
      // --no-install installs nothing and puts the command first in Next, as before
      await rm(log)
      const told = wire(join(parent, 'told'), ['--no-install'])
      expect(told.stdout).toContain('Next: pnpm add @simplewebauthn/server@^14.1.0 && pnpm format && pnpm test')
      expect(await calls()).toEqual([])
      // A failed install fails the command, naming what to run
      const failed = wire(join(parent, 'failed'), [], '1')
      expect([failed.status, failed.stderr]).toEqual([1, expect.stringContaining('`pnpm add @simplewebauthn/server@^14.1.0` failed: run it in the app')])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('makes a feature with a field of fixed values, its own singular and no delete, that passes its own tests', async () => {
    const parent = join(import.meta.dirname, '.generated', `run-shapes-${process.pid}`)
    await rm(parent, { recursive: true, force: true })
    await mkdir(parent, { recursive: true })
    const bin = (name: string) => join(import.meta.dirname, '..', 'node_modules/.bin', name)
    try {
      expect(cli(parent, 'init', 'shelf-api', '--bare', '--no-install').status).toBe(0)
      const app = join(parent, 'shelf-api')
      const read = (path: string) => readFile(join(app, path), 'utf8')
      // Refused with the rule, and nothing written
      for (const [spec, error] of [
        ['status:enum()', 'a field is <name>:<type>'],
        ['status:enum(To-Read|done)', 'a field is <name>:<type>'],
        ["status:enum(a|b'c)", 'a field is <name>:<type>'],
        ['status:enum(done|done)', 'status names done twice'],
        [', ', '--fields names no field'],
      ]) expect(cli(app, 'feature', 'books', '--fields', spec!).stderr, spec).toContain(error)
      expect(cli(app, 'feature', 'books', '--singular', 'Book').stderr).toContain('"Book" isn\'t a kebab-case name like book or reading-list')
      expect(existsSync(join(app, 'src/features/books'))).toBe(false)
      // The naive singular is said, with how to name another
      const naive = cli(app, 'feature', 'leaves', '--fields', 'name:string')
      expect(naive.stdout).toContain('each one a leave (--singular names it otherwise)')
      // What to run next, and where an action beyond the five routes is shown
      expect(naive.stdout.trim().split('\n').slice(-2)).toEqual([
        'Next: pnpm format (what feature writes is in the kit\'s long-line style), then pnpm test',
        'An action beyond make, list, change and delete (mark one done): the api-kit-feature skill › An action route; one inside another (recipes on a shelf): `kit feature <name> --under <parent>`',
      ])
      // Fields split by commas as well as spaces, a stray comma ignored; then taken out again
      const commas = cli(app, 'feature', 'tasks', '--fields', 'title:string,status:enum(todo|done), due:int?,')
      expect(commas.status, commas.stderr).toBe(0)
      expect(await read('src/features/tasks/schema.ts')).toContain("status: text('status', { enum: ['todo', 'done'] }).notNull(),")
      expect(cli(app, 'feature', 'tasks', '--remove').status).toBe(0)
      const made = cli(app, 'feature', 'shelves', '--singular', 'shelf', '--no-remove', '--fields', 'name:string status:enum(to-read|reading|done) mood:enum(calm|busy)?')
      expect(made.status, made.stderr).toBe(0)
      expect(made.stdout).toContain('each one a shelf')
      expect(made.stdout).toContain('no delete')
      const schema = await read('src/features/shelves/schema.ts')
      expect(schema).toContain("status: text('status', { enum: ['to-read', 'reading', 'done'] }).notNull(),")
      expect(schema).toContain("mood: text('mood', { enum: ['calm', 'busy'] }),")
      expect(schema).toContain(`"status" text not null check ("status" in (\\'to-read\\', \\'reading\\', \\'done\\')), "mood" text check ("mood" in (\\'calm\\', \\'busy\\'))`)
      expect(schema).toContain('export type ShelfRow')
      const routes = await read('src/features/shelves/routes.ts')
      expect(routes).toContain("status: z.enum(['to-read', 'reading', 'done']).openapi(")
      expect(routes).toContain("operationId: 'getShelf'")
      expect(routes).not.toMatch(/delete|remove/i)
      const tools = await read('src/features/shelves/tools.ts')
      expect(tools).toContain("name: 'get_shelf'")
      expect(tools).not.toContain('delete_shelf')
      for (const file of ['repo.ts', 'handlers.ts', 'index.ts', 'shelves.test.ts']) expect(await read(`src/features/shelves/${file}`), file).not.toMatch(/remove|delete|\/\/ feature:/i)
      // The action route api-kit-feature gives, pasted where its blocks say
      expect(cli(app, 'feature', 'books', '--fields', 'title:string status:enum(to-read|reading|done)').status).toBe(0)
      const skill = await readFile(join(import.meta.dirname, '..', 'skills/api-kit-feature/SKILL.md'), 'utf8')
      const action = skill.slice(skill.indexOf('## An action route')).match(/```ts\n([\s\S]*?)```/)![1]!
      const blocks = Object.fromEntries(action.split(/^\/\/ /m).filter(Boolean).map((block) => [block.slice(0, block.indexOf(',')), block.slice(block.indexOf('\n') + 1)]))
      expect(Object.keys(blocks)).toEqual(['routes.ts', 'handlers.ts', 'index.ts', 'tools.ts'])
      const paste = async (file: string, at: (text: string) => number, block: string) => {
        const path = join(app, 'src/features/books', file)
        const text = await readFile(path, 'utf8')
        expect(at(text), file).toBeGreaterThan(0)
        await writeFile(path, text.slice(0, at(text)) + block + text.slice(at(text)))
      }
      await paste('routes.ts', (text) => text.lastIndexOf('}\n'), blocks['routes.ts']!)
      await paste('handlers.ts', (text) => text.indexOf('  return { list'), blocks['handlers.ts']!)
      await paste('index.ts', (text) => text.indexOf('  },\n  tools:'), blocks['index.ts']!)
      await paste('index.ts', (text) => text.indexOf('    }\n  },\n}'), '      mark_book_done: { id },\n')
      await paste('tools.ts', (text) => text.indexOf("  mcpTool({\n    name: 'delete_book'"), blocks['tools.ts']!)
      const handlers = join(app, 'src/features/books/handlers.ts')
      await writeFile(handlers, (await readFile(handlers, 'utf8')).replace('return { list, get, create, update, remove }', 'return { list, get, create, update, remove, done }'))
      // The database refuses a value outside the list too, not only the route
      expect(spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' }).status).toBe(0)
      const { DatabaseSync } = await import('node:sqlite')
      const sqlite = new DatabaseSync(':memory:')
      const step = (await readdir(join(app, 'migrations'))).find((file) => file.endsWith('_shelves_1.sql'))!
      for (const file of ['0000_kit_migrations.sql', step]) sqlite.exec(await readFile(join(app, 'migrations', file), 'utf8'))
      expect(() => sqlite.exec("insert into shelves values ('1', 'Fiction', 'lost', null, 'now', 'now')")).toThrow(/CHECK/)
      for (const project of ['tsconfig.json', 'test/workers/tsconfig.json']) {
        const typecheck = spawnSync(bin('tsc'), ['--noEmit', '-p', project], { cwd: app, encoding: 'utf8' })
        expect(typecheck.status, `${project}: ${typecheck.stdout}`).toBe(0)
      }
      const tests = spawnSync(bin('vitest'), ['run', '--root', '.', '--project', 'node', '--reporter', 'verbose'], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
      expect(tests.status, tests.stdout + tests.stderr).toBe(0)
      expect(tests.stdout).toContain('makes, lists and changes a shelf')
      // Its MCP lines name the fields an agent filters on (an enum, a short one), so list_shelves shows which is done
      const { shelvesTools } = await import(join(app, 'src/features/shelves/tools.ts'))
      const tool = (name: string) => shelvesTools.find((one: { name: string }) => one.name === name)
      const row = { id: 's1', name: 'Fiction', status: 'done', mood: null, createdAt: '2026-11-25T10:00:00Z', updatedAt: '2026-11-25T10:00:00Z' }
      expect(tool('list_shelves').summarize({ _embedded: { shelves: [row] }, _links: {} }, {})).toBe('Fiction · status done · mood – · id s1 · changed 2026-11-25')
      expect(tool('update_shelf').summarize({ ...row, mood: 'calm' }, {})).toBe('Changed: Fiction · status done · mood calm · id s1 · changed 2026-11-25')
      expect(tests.stdout).toMatch(/books\.test\.ts > books > makes, lists, changes and deletes a book/)
      expect(tests.stdout).toContain('runs every MCP tool against its route')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('keeps the container’s env allowlist and Env in step: a test in every new app, and a doctor finding each way', async () => {
    const parent = join(import.meta.dirname, '.generated', `run-env-${process.pid}`)
    await rm(parent, { recursive: true, force: true })
    await mkdir(parent, { recursive: true })
    const bin = (name: string) => join(import.meta.dirname, '..', 'node_modules/.bin', name)
    try {
      expect(cli(parent, 'init', 'env-api', '--runtime', 'node', '--no-install').status).toBe(0)
      expect(cli(parent, 'init', 'edge-env', '--runtime', 'cloudflare', '--no-install').status).toBe(0)
      const app = join(parent, 'env-api')
      const entrypoint = join(app, 'container/entrypoint.sh')
      const starter = await readFile(entrypoint, 'utf8')
      // The starter passes what its Env reads, FEATURES_OFF too
      expect(starter).toContain('${FEATURES_OFF:+FEATURES_OFF="$FEATURES_OFF"}')
      const envLines = (text: string) => text.split('\n').filter((line) => line.startsWith('env      '))
      expect(envLines(cli(app, 'doctor').stdout)).toEqual([])
      // A Worker has no container, so no such test
      expect(existsSync(join(parent, 'edge-env/test/env.test.ts'))).toBe(false)
      const run = () => spawnSync(bin('vitest'), ['run', '--root', '.', 'test/env.test.ts'], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
      expect(run().status, run().stdout).toBe(0)
      // doctor and the app's test read by one rule: Env's members with comments taken out, and process.env in every
      // file under src/, so a word before a colon in a comment is no setting, and a key a feature reads is read
      const appTs = join(app, 'src/app.ts')
      const oneLineEnv = 'export type Env = { API_KEYS?: string; OAUTH_SIGNING_KEY?: string; ACCESS_TEAM?: string; ACCESS_AUD?: string; PUBLIC_HOST?: string; FEATURES_OFF?: string }'
      const starterApp = await readFile(appTs, 'utf8')
      expect(starterApp).toContain(oneLineEnv)
      const commentedEnv = [
        'export type Env = {',
        '  API_KEYS?: string; OAUTH_SIGNING_KEY?: string',
        '  /* ACCESS_TEAM and ACCESS_AUD: both, or neither. note: see {access} */',
        '  ACCESS_TEAM?: string',
        '  ACCESS_AUD?: string',
        '  PUBLIC_HOST?: string // the host, e.g. api.example.com: behind a proxy only',
        '  // FEATURES_OFF: a comma list',
        '  FEATURES_OFF?: string // optional, e.g. the first-run code: only set in prod',
        '}',
      ].join('\n')
      await writeFile(appTs, starterApp.replace(oneLineEnv, commentedEnv))
      await mkdir(join(app, 'src/features/billing'), { recursive: true })
      await writeFile(join(app, 'src/features/billing/stripe.ts'), "export const stripeKeys = () => [process.env.STRIPE_KEY, process.env['STRIPE_WEBHOOK'], process.env[\"STRIPE_PRICE\"]]\n")
      await writeFile(entrypoint, starter.replace('${FEATURES_OFF:+FEATURES_OFF="$FEATURES_OFF"} ', '${FEATURES_OFF:+FEATURES_OFF="$FEATURES_OFF"} ${STRIPE_KEY:+STRIPE_KEY="$STRIPE_KEY"} ${STRIPE_WEBHOOK:+STRIPE_WEBHOOK="$STRIPE_WEBHOOK"} ${STRIPE_PRICE:+STRIPE_PRICE="$STRIPE_PRICE"} '))
      expect(envLines(cli(app, 'doctor').stdout)).toEqual([])
      const ruled = run()
      expect(ruled.status, ruled.stdout).toBe(0)
      await writeFile(appTs, starterApp)
      await rm(join(app, 'src/features/billing'), { recursive: true })
      await writeFile(entrypoint, starter)
      // A setting Env gains that the container never passes, and one the container passes that nothing reads
      await writeFile(appTs, (await readFile(appTs, 'utf8')).replace('FEATURES_OFF?: string }', 'FEATURES_OFF?: string; SETUP_CODE?: string }'))
      await writeFile(entrypoint, starter.replace('${FEATURES_OFF:+FEATURES_OFF="$FEATURES_OFF"} ', '${FEATURES_OFF:+FEATURES_OFF="$FEATURES_OFF"} ${OLD_TOKEN:+OLD_TOKEN="$OLD_TOKEN"} '))
      const doctor = cli(app, 'doctor')
      expect(doctor.status).toBe(1)
      expect(envLines(doctor.stdout)).toEqual([
        'env      container/entrypoint.sh: passes no SETUP_CODE, which Env in src/app.ts reads, so the container never sees it: add ${SETUP_CODE:+SETUP_CODE="$SETUP_CODE"} before node_modules/.bin/tsx',
        'env      container/entrypoint.sh: passes OLD_TOKEN, which neither Env in src/app.ts nor any file under src/ reads: take ${OLD_TOKEN:+OLD_TOKEN="$OLD_TOKEN"} out, or add it to Env',
      ])
      const failed = run()
      expect(failed.status).toBe(1)
      expect(failed.stdout + failed.stderr).toContain('SETUP_CODE')
      expect(failed.stdout + failed.stderr).toContain('OLD_TOKEN')
      // An app made before test/env.test.ts (1.33.0 never passed FEATURES_OFF) gets notes, not failures, so doctor stays as it was
      const toFix = (stdout: string) => Number(/^(\d+) to fix in /m.exec(stdout)?.[1] ?? 0)
      await writeFile(appTs, (await readFile(appTs, 'utf8')).replace('FEATURES_OFF?: string; SETUP_CODE?: string }', 'FEATURES_OFF?: string }'))
      await writeFile(entrypoint, starter.replace('${FEATURES_OFF:+FEATURES_OFF="$FEATURES_OFF"} ', ''))
      const withTest = cli(app, 'doctor').stdout
      expect(envLines(withTest)).toHaveLength(1)
      await rm(join(app, 'test/env.test.ts'))
      const older = cli(app, 'doctor').stdout
      expect(envLines(older)).toEqual([])
      expect(older).toContain('note     env container/entrypoint.sh: passes no FEATURES_OFF, which Env in src/app.ts reads, so the container never sees it: add ${FEATURES_OFF:+FEATURES_OFF="$FEATURES_OFF"} before node_modules/.bin/tsx (a failure once the app has test/env.test.ts, which a new app from `kit init` has)')
      expect(toFix(older)).toBe(toFix(withTest) - 1)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('removes a feature whole with feature --remove: its folder, its lines, its switch and, on Workers, its migrations', async () => {
    const parent = join(import.meta.dirname, '.generated', `run-remove-${process.pid}`)
    await rm(parent, { recursive: true, force: true })
    await mkdir(parent, { recursive: true })
    const bin = (name: string) => join(import.meta.dirname, '..', 'node_modules/.bin', name)
    try {
      expect(cli(parent, 'init', 'tidy-api', '--no-install').status).toBe(0)
      const app = join(parent, 'tidy-api')
      const read = (path: string) => readFile(join(app, path), 'utf8')
      expect(cli(app, 'feature', 'books', '--switch').status).toBe(0)
      expect(cli(app, 'feature', 'reading-lists').status).toBe(0)
      expect(spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' }).status).toBe(0)
      const [index, catalog] = [await read('src/features/index.ts'), await read('src/features/catalog.ts')]
      const removed = cli(app, 'feature', '--remove', 'notes')
      expect(removed.status, removed.stderr).toBe(0)
      expect(removed.stdout).toContain('Removed src/features/notes/ and its lines in src/features/index.ts')
      expect(removed.stdout).toContain('Next: pnpm migrations (it removes notes’s files from migrations/), then pnpm test')
      expect(existsSync(join(app, 'src/features/notes'))).toBe(false)
      expect(await read('src/features/index.ts')).toBe(index.replace("import { feature as notes } from './notes/index.js'\n", '').replace('  notes,\n', ''))
      // A switched feature leaves the catalog too; a kebab name by its camel spelling
      expect(cli(app, 'feature', '--remove', 'books').stdout).toContain('and its switch in src/features/catalog.ts')
      expect(await read('src/features/catalog.ts')).toBe(catalog.replace(/^ {2}'books': .*\n/m, ''))
      expect(cli(app, 'feature', '--remove', 'reading-lists').status).toBe(0)
      expect(await read('src/features/index.ts')).not.toMatch(/notes|books|readingLists/)
      // Twice: nothing to remove, said so
      const again = cli(app, 'feature', '--remove', 'notes')
      expect([again.status, again.stderr]).toEqual([1, 'kit: no feature notes here: src/features/notes/ is gone and src/features/index.ts lists no ./notes/index.js\n'])
      expect(cli(app, 'feature', '--remove', 'switches').stderr).toContain('switches is the starter’s own feature')
      const pruned = spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' })
      expect(pruned.stdout).toMatch(/Removed \S+_notes_1\.sql/)
      expect((await readdir(join(app, 'migrations'))).filter((file) => /notes|books|reading-lists/.test(file))).toEqual([])
      for (const project of ['tsconfig.json', 'test/workers/tsconfig.json']) {
        const typecheck = spawnSync(bin('tsc'), ['--noEmit', '-p', project], { cwd: app, encoding: 'utf8' })
        expect(typecheck.status, `${project}: ${typecheck.stdout}`).toBe(0)
      }
      const tests = spawnSync(bin('vitest'), ['run', '--root', '.', '--project', 'node'], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
      expect(tests.status, tests.stdout + tests.stderr).toBe(0)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('nests a feature under another with feature --under: listed and made under its parent, 404 for an unknown one, tools that take it', async () => {
    const parent = join(import.meta.dirname, '.generated', `run-under-${process.pid}`)
    await rm(parent, { recursive: true, force: true })
    await mkdir(parent, { recursive: true })
    const bin = (name: string) => join(import.meta.dirname, '..', 'node_modules/.bin', name)
    try {
      expect(cli(parent, 'init', 'nest-api', '--bare', '--no-install').status).toBe(0)
      const app = join(parent, 'nest-api')
      const read = (path: string) => readFile(join(app, path), 'utf8')
      expect(cli(app, 'feature', 'reading-lists', '--fields', 'title:string').status).toBe(0)
      expect(cli(app, 'feature', 'pies', '--under', 'books').stderr).toContain('--under books: no src/features/books/ made by `kit feature`')
      expect(cli(app, 'feature', 'pies', '--under', 'pies').stderr).toContain('--under names another feature')
      expect(existsSync(join(app, 'src/features/pies'))).toBe(false)
      const made = cli(app, 'feature', 'books', '--under', 'reading-lists', '--fields', 'title:string status:enum(to-read|done)')
      expect(made.status, made.stderr).toBe(0)
      expect(made.stdout).toContain('under reading-lists: GET and POST /api/reading-lists/{readingList}/books, each book with its readingListId')
      expect(await read('src/features/books/schema.ts')).toContain('"reading_list_id" text not null references reading_lists(id) on delete cascade, "title" text not null')
      expect(await read('src/features/books/routes.ts')).toContain("path: '/api/reading-lists/{readingList}/books'")
      expect(spawnSync(bin('tsx'), ['scripts/migrations.ts'], { cwd: app, encoding: 'utf8' }).status).toBe(0)
      for (const project of ['tsconfig.json', 'test/workers/tsconfig.json']) {
        const typecheck = spawnSync(bin('tsc'), ['--noEmit', '-p', project], { cwd: app, encoding: 'utf8' })
        expect(typecheck.status, `${project}: ${typecheck.stdout}`).toBe(0)
      }
      const tests = spawnSync(bin('vitest'), ['run', '--root', '.', '--project', 'node', '--reporter', 'verbose'], { cwd: app, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } })
      expect(tests.status, tests.stdout + tests.stderr).toBe(0)
      for (const name of ['answers 404 for a reading list that does not exist', 'makes, lists, changes and deletes a book', 'deletes a reading list’s books with it', 'runs every MCP tool against its route']) expect(tests.stdout, name).toContain(name)
      // Over HTTP and MCP, as an agent uses it
      const { createApp: createNest } = await import(join(app, 'src/app.ts'))
      const { hashApiKey: hashOf, testDb: dbOf } = await import(join(app, 'src/kit/index.ts'))
      const nest = await createNest({ db: await dbOf(), env: { API_KEYS: `tester:${hashOf('nest-key')}` } })
      const headers = { authorization: 'Bearer nest-key', 'content-type': 'application/json' }
      const post = async (path: string, body: object) => nest.request(path, { method: 'POST', headers, body: JSON.stringify(body) })
      const [mine, other] = await Promise.all(['Mine', 'Other'].map(async (title) => ((await (await post('/api/reading-lists', { title })).json()) as { id: string }).id))
      const book = await post(`/api/reading-lists/${mine}/books`, { title: 'Dune', status: 'done' })
      const dune = (await book.json()) as { id: string }
      expect([book.status, dune]).toEqual([201, expect.objectContaining({ title: 'Dune', readingListId: mine })])
      expect((await (await nest.request(`/api/reading-lists/${other}/books`, { headers })).json()).count).toBe(0)
      const unknown = await post('/api/reading-lists/nope/books', { title: 'Lost', status: 'done' })
      expect([unknown.status, (await unknown.json()).detail]).toEqual([404, 'No reading list nope. GET /api/reading-lists lists them.'])
      const listed = await callMcp(nest, 'tools/call', { bearer: 'nest-key', params: { name: 'list_books', arguments: { reading_list: mine } } })
      expect((listed.result?.content as { text: string }[])[0]!.text).toMatch(/^Dune · status done · id /)
      const tool = (await callMcp(nest, 'tools/list', { bearer: 'nest-key' })).result!.tools as { name: string; inputSchema: { required?: string[] } }[]
      expect(tool.find((one) => one.name === 'create_book')!.inputSchema.required).toContain('reading_list')
      // Deleting a reading list deletes its books: no 500 from the foreign key
      expect((await nest.request(`/api/reading-lists/${mine}`, { method: 'DELETE', headers })).status).toBe(204)
      expect((await nest.request(`/api/books/${dune.id}`, { headers })).status).toBe(404)
      expect((await (await nest.request(`/api/reading-lists/${other}`, { headers })).json()).title).toBe('Other')
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('leaves no __placeholder__ in any file init or feature writes, whatever the flags', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-placeholders-'))
    // TanStack Router's own name for the root route, not one of the kit's
    const theirs = new Set(['web/routeTree.gen.ts: __root__'])
    const leftIn = async (app: string) => {
      const files = (await readdir(app, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile() && !/[\\/](node_modules|\.git)([\\/]|$)/.test(entry.parentPath.slice(app.length)))
      const found = await Promise.all(files.map(async (entry) => {
        const path = join(entry.parentPath, entry.name).slice(app.length + 1)
        const named = [path, ...(await readFile(join(entry.parentPath, entry.name), 'utf8')).match(/__[a-z_]+__/g) ?? []]
        return named.flatMap((one) => (/__[a-z_]+__/.test(one) && !theirs.has(`${path}: ${one}`) ? [`${path}: ${one}`] : []))
      }))
      return found.flat()
    }
    try {
      for (const [name, ...flags] of [['both-api'], ['node-api', '--runtime', 'node'], ['workers-api', '--runtime', 'cloudflare'], ['web-app', '--preset', 'app'], ['bare-api', '--bare']]) {
        const made = cli(parent, 'init', name!, ...flags, '--no-install', '--no-git')
        expect(made.status, made.stderr).toBe(0)
        expect(await leftIn(join(parent, name!)), name).toEqual([])
      }
      const app = join(parent, 'both-api')
      for (const args of [
        ['shelves', '--singular', 'shelf', '--fields', 'name:string'],
        ['recipes', '--under', 'shelves', '--fields', 'name:string minutes:int?'],
        ['tasks', '--no-remove', '--switch'],
        ['pages', '--under', 'shelves', '--no-remove', '--switch', '--singular', 'leaf'],
      ]) {
        const made = cli(app, 'feature', ...args)
        expect(made.status, made.stderr).toBe(0)
      }
      expect(await leftIn(app)).toEqual([])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('keeps the starter skills loadable whatever the title holds', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-title-'))
    try {
      const title = 'Say "hi": C:\\apps'
      expect(cli(parent, 'init', 'odd-title', '--title', title, '--bare', '--no-install', '--no-git').status).toBe(0)
      const app = join(parent, 'odd-title')
      const product = await readFile(join(app, 'guide/skills/odd-title/SKILL.md'), 'utf8')
      // Never served, so its boolean metadata.internal (which the server refuses) is left out to read the description
      const developer = (await readFile(join(app, '.agents/skills/odd-title-agent-test/SKILL.md'), 'utf8')).replace('metadata:\n  internal: true\n', '')
      expect(await guideSkillProblems({ files: { 'skills/odd-title/SKILL.md': product, 'skills/odd-title-agent-test/SKILL.md': developer } })).toEqual([])
      const { skills } = await guideSkills({ files: { 'skills/odd-title/SKILL.md': product } })
      expect(skills!.entries[0]!.frontmatter.description).toContain(`Use when a task needs ${title}.`)
      // Outside the quotes the title stays as typed
      expect(product).toContain(`# ${title}\n`)
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  }, 120_000)

  it('gives a feature the pagination part an app lacks, never moving an older kit copy to this version', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-feature-'))
    expect(cli(parent, 'init', 'old-api', '--no-install', '--no-git').status).toBe(0)
    const app = join(parent, 'old-api')
    const lockPath = join(app, 'src/kit/kit.json')
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    const withoutPagination = { ...lock, modules: lock.modules.filter((name: string) => name !== 'pagination'), files: Object.fromEntries(Object.entries(lock.files).filter(([file]) => !file.startsWith('pagination/'))) }
    await rm(join(app, 'src/kit/pagination'), { recursive: true })
    // An app at an older kit: nothing written, and the command that adds the part at its own version
    await writeFile(lockPath, JSON.stringify({ ...withoutPagination, version: '1.30.0' }))
    const older = cli(app, 'feature', 'things')
    expect([older.status, older.stderr]).toEqual([1, expect.stringContaining('`npx @escalay/kit@1.30.0 add pagination --dir src/kit`')])
    expect(existsSync(join(app, 'src/features/things'))).toBe(false)
    expect(JSON.parse(await readFile(lockPath, 'utf8')).version).toBe('1.30.0')
    // At this kit's version, the part is copied in first
    await writeFile(lockPath, JSON.stringify(withoutPagination))
    const current = cli(app, 'feature', 'things')
    expect(current.status, current.stderr).toBe(0)
    expect(current.stdout).toContain('Copied the pagination part into src/kit')
    expect(JSON.parse(await readFile(lockPath, 'utf8')).modules).toContain('pagination')
    await rm(parent, { recursive: true, force: true })
  })

  it('installs a new app and runs its format and migrations, so its gate passes as made', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-init-'))
    const bin = join(parent, 'bin')
    await mkdir(bin)
    const log = join(parent, 'pnpm.log')
    // A stand-in pnpm: logs where and what it ran
    await writeFile(join(bin, 'pnpm'), `#!/bin/sh\n[ "$1" = --version ] && echo 12.3.4 && exit 0\necho "$(basename "$PWD") $*" >> "${log}"\n`, { mode: 0o755 })
    const init = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'init', ...args], { cwd: parent, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    const both = init('ran-api', '--no-git')
    expect(both.status, both.stderr).toBe(0)
    const node = init('box-api', '--runtime', 'node', '--no-git')
    expect(node.status, node.stderr).toBe(0)
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['ran-api install', 'ran-api format', 'ran-api migrations', 'box-api install', 'box-api format'])
    expect(both.stdout).toMatch(/^Next: cd ran-api && pnpm test && pnpm dev$/m)
    // No pnpm: the app is made, and the Next line names every step
    const without = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), 'init', 'plain-api', '--no-git'], { cwd: parent, encoding: 'utf8', env: { ...process.env, PATH: '/nowhere' } })
    expect(without.status, without.stderr).toBe(0)
    expect(without.stdout).toMatch(/^Next: cd plain-api && pnpm install && pnpm format && pnpm migrations && pnpm test && pnpm dev$/m)
    await rm(parent, { recursive: true, force: true })
  })

  it('makes an app with a browser side that typechecks and passes its tests on all three sides', async () => {
    const parent = join(import.meta.dirname, '.generated', `run-app-${process.pid}`)
    await rm(parent, { recursive: true, force: true })
    await mkdir(parent, { recursive: true })
    try {
      const bin = (name: string) => join(import.meta.dirname, '..', 'node_modules/.bin', name)
      const refused = cli(parent, 'init', 'box', '--preset', 'app', '--runtime', 'node')
      expect([refused.status, refused.stderr]).toEqual([1, 'kit: the app preset runs on Cloudflare Workers; leave --runtime out or use --runtime cloudflare\n'])
      const made = cli(parent, 'init', 'desk', '--preset', 'app', '--title', 'Desk', '--no-install')
      expect(made.status, made.stderr).toBe(0)
      expect(made.stdout).toContain('for Cloudflare Workers, with a browser app in web/,')
      const app = join(parent, 'desk')
      const read = (path: string) => readFile(join(app, path), 'utf8')
      for (const path of ['index.html', 'vite.config.ts', 'tsconfig.web.json', 'web/main.tsx', 'web/router.tsx', 'web/routes/__root.tsx', 'web/routes/index.tsx', 'web/routeTree.gen.ts', 'web/styles.css', 'web/app.test.tsx', 'src/worker.ts', 'wrangler.jsonc']) expect(existsSync(join(app, path)), path).toBe(true)
      for (const path of ['src/server.ts', 'Dockerfile', 'container', 'public']) expect(existsSync(join(app, path)), path).toBe(false)
      // The browser starts asking the switches: the client and hooks in web/kit, under the one kit.json
      for (const path of ['web/kit/browser/switches-client.ts', 'web/kit/browser/switches-react.tsx', 'web/lib/features.ts', 'src/features/catalog.ts']) expect(existsSync(join(app, path)), path).toBe(true)
      expect(JSON.parse(await read('src/kit/kit.json'))).toMatchObject({ webDir: '../../web/kit', modules: expect.arrayContaining(['switches', 'switches-client', 'switches-react']) })
      expect(await read('web/routes/__root.tsx')).toContain('<FeaturesProvider client={features}>')
      const manifest = JSON.parse(await read('package.json'))
      expect(manifest.scripts).toMatchObject({ dev: 'vite', build: 'vite build', deploy: expect.stringContaining('vite build && wrangler d1 migrations apply DB --remote && wrangler deploy'), typecheck: expect.stringContaining('tsconfig.web.json'), lint: 'oxlint', format: 'oxfmt' })
      // The versions the kit tests with, so an app starts on a set that is known to work together
      const kitDev = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')).devDependencies
      for (const name of ['react', '@tanstack/react-router', '@tanstack/react-query']) expect(manifest.dependencies[name], name).toBe(kitDev[name])
      for (const name of ['vite', '@cloudflare/vite-plugin', '@vitejs/plugin-react', '@tanstack/router-plugin', 'tailwindcss', 'oxlint', 'oxfmt', 'wrangler']) expect(manifest.devDependencies[name], name).toBe(kitDev[name])
      // The Worker leaves only /app to the built files, and sends people who open the address there
      expect(await read('wrangler.jsonc')).toContain('"assets": { "not_found_handling": "single-page-application", "run_worker_first": ["/*", "!/app/*"] },')
      expect(await read('wrangler.jsonc')).not.toMatch(/account_id": "[0-9a-f]/)
      expect(manifest.scripts.check).toMatch(/scripts\/migrations\.ts --check && vite build$/)
      expect((await read('AGENTS.md')).split('\n').filter((line) => line.startsWith('- `pnpm gate`'))).toEqual(['- `pnpm gate` is everything CI runs: `pnpm check` (types, lint, format, `migrations/` and the build) and `pnpm test`.'])
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
      for (const needed of item.registryDependencies ?? []) expect(needed.startsWith('escalay/api-kit/') ? names.includes(needed.slice('escalay/api-kit/'.length)) : ['button', 'input', 'switch'].includes(needed), `${item.name} → ${needed}`).toBe(true)
    }
    expect(items.filter((item) => item.meta?.root).map((item) => item.name)).toEqual(['npm-release'])
    const block = items.find((item) => item.name === 'vector-search-ui')!
    expect(block.registryDependencies).toEqual(['button', 'input', 'escalay/api-kit/search-react'])
  })

  it('gives every browser file a browser part of its own', async () => {
    const kitDir = join(import.meta.dirname, '..')
    const items: { name: string; files: { path: string }[]; meta?: { web?: boolean } }[] = JSON.parse(await readFile(join(kitDir, 'registry.json'), 'utf8')).items
    const browserFiles = (await readdir(join(kitDir, 'src/browser'))).filter((file) => file !== 'README.md').map((file) => `src/browser/${file}`)
    const partsOf = (path: string) => items.filter((item) => item.meta?.web && item.files.some((file) => file.path === path)).map((item) => item.name)
    // One meta.web item each: the CLI copies it to --web-dir, and `kit add <part>` names it
    expect(browserFiles.filter((path) => partsOf(path).length !== 1).map((path) => `${path}: ${partsOf(path).join(', ') || 'no browser part'}`)).toEqual([])
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

  it('pins create-escalay to its own kit version: pnpm writes `workspace:*` as the exact version, never a range', async () => {
    expect(JSON.parse(await read('packages/create-escalay/package.json')).dependencies).toEqual({ '@escalay/kit': 'workspace:*' })
    // 1.31.0 and older were published with `^`, so the README's pinned example names no version of theirs
    const readme = await read('packages/create-escalay/README.md')
    const pinned = [...readme.matchAll(/create escalay@(\d+)\.(\d+)\.(\d+)/g)].map((match) => match.slice(1).map(Number))
    for (const [major, minor, patch] of pinned) expect(major! * 1e6 + minor! * 1e3 + patch!, 'a version published with a caret range').toBeGreaterThan(1_031_000)
    expect(readme).toContain('after 1.31.0')
  })

  it('names a version wherever it says `npm create escalay`: without one, npx runs whatever create-escalay it cached', async () => {
    const tracked = spawnSync('git', ['ls-files'], { cwd: kitDir, encoding: 'utf8' }).stdout.split('\n')
    // The changelog is history, and the tests name the command as they run it
    const files = tracked.filter((path) => /\.(md|mjs|ts|tsx|json|jsonc|sh|ya?ml|txt)$/.test(path) && path !== 'CHANGELOG.md' && !path.startsWith('test/'))
    const unversioned = (await Promise.all(files.map(async (path) => (await read(path)).split('\n').flatMap((line, at) => (/npm create escalay(?!@)/.test(line) ? [`${path}:${at + 1}: ${line.trim()}`] : []))))).flat()
    expect(unversioned).toEqual([])
    expect(files.length).toBeGreaterThan(100)
  })

  it('answers --help from create-escalay and from every kit command without making anything', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kit-help-'))
    for (const flag of ['--help', '-h']) {
      const created = spawnSync(process.execPath, [join(kitDir, 'packages/create-escalay/index.mjs'), flag], { cwd: parent, encoding: 'utf8' })
      expect([created.status, created.stderr], flag).toEqual([0, ''])
      expect(created.stdout).toMatch(/^Usage: npm create escalay@latest <dir> \[-- options\]$/m)
      expect(created.stdout).toContain('--preset api|app')
    }
    expect(await readdir(parent)).toEqual([])
    const kit = (...args: string[]) => spawnSync(process.execPath, [join(kitDir, 'cli.mjs'), ...args], { cwd: parent, encoding: 'utf8' })
    const add = kit('add', '--help')
    expect([add.status, add.stdout.split('\n')[0]]).toEqual([0, 'kit add core guide mcp testing [--dir src/kit] [--web-dir ../web] [--install]'])
    expect(kit('feature', '-h').stdout).toContain('kit feature <plural-name>')
    expect(await readdir(parent)).toEqual([])
  })
})

describe('the app template’s container', () => {
  const kitDir = join(import.meta.dirname, '..')

  it('copies every top-level folder the app’s src/ imports from', async () => {
    const copied = new Set([...readFileSync(join(kitDir, 'templates/app/Dockerfile'), 'utf8').matchAll(/^COPY (\S+) \1$/gm)].map(([, folder]) => folder))
    // Every template that writes into the app's src/; Workers bundle from `main`, the container runs src/ as it is
    const imported = new Set<string>()
    for (const template of ['app', 'runtime-cloudflare']) {
      const src = join(kitDir, 'templates', template, 'src')
      for (const file of (await readdir(src, { recursive: true })).filter((path) => /\.tsx?$/.test(path))) {
        for (const [, specifier] of readFileSync(join(src, file), 'utf8').matchAll(/\bfrom '(\.{1,2}\/[^']+)'/g)) {
          const [top] = join('src', file, '..', specifier!).split(/[\\/]/)
          if (top !== 'src') imported.add(top!)
        }
      }
    }
    expect(imported).toContain('brand')
    for (const folder of imported) expect(copied, `templates/app/Dockerfile copies ${folder}/`).toContain(folder)
  })
})

describe('the guide under many origins', () => {
  const FILES = { 'llms.txt': '# Apps at {{origin}}, {{counts.apps}} of them\n', 'skills/apps/SKILL.md': '---\nname: apps\ndescription: Use when finding apps at {{origin}}.\n---\n\n# {{counts.apps}} apps\n', 'skills/apps/references/find.md': '# Find one\n' }
  const guided = async ({ publicOrigin }: { publicOrigin?: string } = {}) => {
    const oauth = publicOrigin ? createOAuth({ name: 'Apps', signingKey: await generateOAuthKey(), store: memoryOAuthStore(), owner: async () => null, publicOrigin }) : undefined
    const app = createAgentApi({ title: 'Apps', version: '1.0.0', description: 'Apps.', tags: [], auth: { realm: 'apps', keys: parseApiKeys('') }, ...(oauth ? { oauth } : {}) })
    const state = { apps: 2, varsCalls: 0 }
    serveGuide(app, { files: FILES, vars: () => ((state.varsCalls += 1), { counts: { apps: state.apps } }), full: ['llms.txt'] })
    const specFetches = vi.spyOn(app, 'request')
    const fetchedSpecs = () => specFetches.mock.calls.filter(([path]) => path === '/openapi.json').length
    const from = (host: string, path = '/llms.txt') => app.request(path, { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': host } })
    return { app, state, fetchedSpecs, from }
  }

  it('names the public origin whatever host a caller forwards, when publicOrigin is set', async () => {
    const { from, fetchedSpecs } = await guided({ publicOrigin: 'https://apps.example.test' })
    for (const host of ['elsewhere.example.test', 'other.example.test']) {
      const text = await (await from(host)).text()
      expect(text).toBe('# Apps at https://apps.example.test, 2 of them\n')
    }
    expect(fetchedSpecs()).toBe(1)
  })

  it('keeps the spec for a bounded number of origins when any caller can name one', async () => {
    const { from, fetchedSpecs } = await guided()
    for (let n = 1; n <= 20; n++) expect(await (await from(`host${n}.example.test`)).text()).toContain(`https://host${n}.example.test`)
    expect(fetchedSpecs()).toBe(20)
    await from('host20.example.test')
    expect(fetchedSpecs()).toBe(20)
    // The first origin was let go long ago: its spec is fetched again
    await from('host1.example.test')
    expect(fetchedSpecs()).toBe(21)
  })

  it('renders the skills discovery once per origin, and again when the guide\'s values change', async () => {
    const { from, state } = await guided({ publicOrigin: 'https://apps.example.test' })
    const index = async () => (await from('apps.example.test', '/.well-known/agent-skills/index.json')).json()
    const first = await index()
    const calls = state.varsCalls
    expect(await index()).toEqual(first)
    expect((await from('apps.example.test', '/.well-known/agent-skills/apps.tar.gz')).status).toBe(200)
    // Each request reads the values once, to see whether they changed; nothing is rendered again
    expect(state.varsCalls).toBe(calls + 2)
    state.apps = 3
    const changed = await index()
    expect(changed.skills[0].digest).not.toBe(first.skills[0].digest)
  })

  it('renders the skills discovery every time when the guide\'s values can\'t be compared', async () => {
    const app = createAgentApi({ title: 'Apps', version: '1.0.0', description: 'Apps.', tags: [], auth: { realm: 'apps', keys: parseApiKeys('') } })
    const tally = { apps: 2 }
    // A Map spells out as {} and a BigInt not at all: neither could tell a change
    serveGuide(app, { files: FILES, vars: () => ({ counts: { apps: tally.apps }, seen: new Map([['apps', tally.apps]]), big: 1n }), full: ['llms.txt'] })
    const digestOf = async () => (await (await app.request('/.well-known/agent-skills/index.json')).json()).skills[0].digest
    const first = await digestOf()
    tally.apps = 3
    expect(await digestOf()).not.toBe(first)
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

  it('names each skill the server would skip, and why, in the server’s own words', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const files = {
      'skills/apps/SKILL.md': '---\nname: apps\ndescription: Use when finding apps: by name or by maker.\n---\n\n# Apps\n',
      'skills/maps/SKILL.md': '---\nname: maps\ndescription: "Use when finding places: by name or by street."\n---\n\n# Maps\n',
    }
    expect(await guideSkillProblems({ files })).toEqual(['apps/SKILL.md: SKILL.md frontmatter: line 3: a plain value cannot contain ": "; quote the value (skill skipped)'])
    // The very skill the server leaves out, and only that one
    const { skills } = await guideSkills({ files })
    expect(skills!.entries.map((skill) => skill.frontmatter.name)).toEqual(['maps'])
    expect(await guideSkillProblems({ files: { 'skills/maps/SKILL.md': files['skills/maps/SKILL.md'] } })).toEqual([])
    expect(await guideSkillProblems({ files: new Map([['llms.txt', '# Apps']]) })).toEqual([])
    // Collected, never printed: only guideSkills tells the server log
    expect(warn.mock.calls.filter(([line]) => String(line).includes('apps/SKILL.md'))).toHaveLength(1)
    warn.mockRestore()
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
  const kitDir = join(import.meta.dirname, '..')
  const skillsDir = join(kitDir, 'skills')
  const skillTexts = async () => Object.fromEntries(await Promise.all((await readdir(skillsDir)).sort().map(async (name) => [name, await readFile(join(skillsDir, name, 'SKILL.md'), 'utf8')] as const)))
  /** What the kit's CLI says it has, from its own refusals: its commands, and its presets. */
  const kitSays = (...args: string[]) => spawnSync(process.execPath, [join(kitDir, 'cli.mjs'), ...args], { cwd: tmpdir(), encoding: 'utf8' }).stderr
  const KIT_COMMANDS = kitSays('no-such-command').match(/Commands: (.+)/)![1]!.split(', ')
  const PRESETS = kitSays('init', 'no-such-app', '--preset', 'no-such-preset').match(/--preset is one of (.+)/)![1]!.split(', ')

  it('gives every `npx skills add` it names `-y`: without it the installer stops to ask, which an agent never answers', async () => {
    // Every file the kit ships or writes into an app, the CLI's own output included; the tests and the changelog aside
    const tracked = spawnSync('git', ['ls-files'], { cwd: kitDir, encoding: 'utf8' }).stdout.split('\n')
    const files = tracked.filter((path) => /\.(md|mjs|ts|tsx|json|jsonc|sh|ya?ml|txt)$/.test(path) && path !== 'CHANGELOG.md' && !path.startsWith('test/'))
    expect(files).toEqual(expect.arrayContaining(['cli.mjs', 'templates/app/AGENTS.md', 'src/mcp/README.md']))
    // A command names what it installs; a bare mention (`npx skills add.`) runs nothing
    const commands = (await Promise.all(files.map(async (file) => [...(await readFile(join(kitDir, file), 'utf8')).matchAll(/npx skills add [^\s`'".,)][^`"\n]*/g)].map(([command]) => `${file}: ${command}`)))).flat()
    expect(commands.length).toBeGreaterThan(10)
    // `--list` only lists, so it never asks
    expect(commands.filter((line) => !/ (-y|--list)\b/.test(line))).toEqual([])
  })

  it('each has a name, says when to use it, stays short and names the command that checks its rule', async () => {
    // Every folder in skills/ is a skill: skillTexts reads each one's SKILL.md, so a folder without one fails here
    const skills = await skillTexts()
    expect(Object.keys(skills).length).toBeGreaterThan(0)
    for (const [name, text] of Object.entries(skills)) {
      const [, frontmatter = ''] = text.match(/^---\n([\s\S]*?)\n---\n/) ?? []
      expect(frontmatter, name).toContain(`name: ${name}\n`)
      expect(frontmatter, name).toMatch(/^description: Use when /m)
      const description = frontmatter.match(/^description: (.*)$/m)![1]!
      expect(description.length, name).toBeLessThanOrEqual(1024)
      // A plain YAML scalar: a colon-space or a space-hash inside makes the frontmatter unreadable, and the skill never loads
      expect(description, name).not.toMatch(/: | #/)
      expect(text.split('\n').length, name).toBeLessThanOrEqual(150)
      expect(text, name).toMatch(/`pnpm test|`npx @escalay\/kit doctor`|^pnpm release:check/m)
      // Only commands the CLI has
      for (const [, command] of text.matchAll(/npx @escalay\/kit ([a-z]+)/g)) expect(KIT_COMMANDS, `${name}: ${command}`).toContain(command)
    }
  })

  it('marks the skills for this repository internal, so `npx skills add escalay/api-kit -y` gives an app only its own', async () => {
    const skills = await skillTexts()
    // The skills CLI skips a skill whose frontmatter has metadata.internal, unless it is named with --skill
    const internal = Object.entries(skills).filter(([, text]) => /^metadata:\n {2}internal: true$/m.test(text.split('\n---\n')[0]!)).map(([name]) => name)
    const forThisRepository = Object.entries(skills).filter(([, text]) => text.includes('in the escalay/api-kit repository itself')).map(([name]) => name)
    expect(forThisRepository).toEqual(['api-kit-part'])
    expect(internal).toEqual(forThisRepository)
    expect(await readFile(join(kitDir, 'README.md'), 'utf8')).toContain('`npx skills add escalay/api-kit --skill api-kit-part -y`')
  })

  it('are each listed in the README\'s skills table and in AGENTS.md', async () => {
    const [readme, agents] = await Promise.all(['README.md', 'AGENTS.md'].map((file) => readFile(join(kitDir, file), 'utf8')))
    const agentsRow = agents!.split('\n').find((line) => line.startsWith('| `skills/` |'))!
    for (const name of await readdir(skillsDir)) {
      expect(readme, name).toContain(`| [\`${name}\`](skills/${name}/SKILL.md) |`)
      expect(agentsRow, name).toContain(`\`${name}\``)
    }
  })

  it('name every part between them', async () => {
    const texts = Object.values(await skillTexts())
    const parts: { name: string; meta?: { root?: boolean } }[] = JSON.parse(await readFile(join(kitDir, 'registry.json'), 'utf8')).items
    const unnamed = parts.filter((part) => !part.meta?.root && !texts.some((text) => text.includes(`\`${part.name}\``))).map((part) => part.name)
    expect(unnamed).toEqual([])
  })

  it('says `--wire` first wherever a part --wire wires says how to wire it', async () => {
    const items: { name: string; meta?: { wiring?: { code?: string; wire?: object } } }[] = JSON.parse(await readFile(join(kitDir, 'registry.json'), 'utf8')).items
    const wired = items.filter(({ meta }) => meta?.wiring?.wire)
    expect(wired.map(({ name }) => name).sort()).toEqual(['boards', 'people', 'setup', 'sharing'])
    for (const { name, meta } of wired) {
      const readme = await readFile(join(kitDir, 'src', name, 'README.md'), 'utf8')
      const heading = meta!.wiring!.code ? `## ${meta!.wiring!.code}\n` : '### In an app made by `kit init`\n'
      const section = readme.slice(readme.indexOf(heading))
      expect(section.slice(0, section.indexOf('```')), name).toMatch(new RegExp(`kit add [^\`]*\\b${name}\\b[^\`]*--wire`))
    }
  })

  it('api-kit-part names every meta.wiring field the registry uses', async () => {
    const skill = (await skillTexts())['api-kit-part']!
    const wired: { meta?: { wiring?: Record<string, unknown> & { settings?: Record<string, string>[]; cron?: Record<string, string> } } }[] = JSON.parse(await readFile(join(kitDir, 'registry.json'), 'utf8')).items
    type Wire = { over?: Record<string, string>; features?: Record<string, string>[]; edits?: Record<string, unknown>[] }
    const wireFields = (wire?: Wire) => (wire ? [...Object.keys(wire), ...Object.keys(wire.over ?? {}), ...(wire.features ?? []).flatMap(Object.keys), ...(wire.edits ?? []).flatMap(Object.keys)] : [])
    const fields = new Set(wired.flatMap(({ meta }) => (meta?.wiring ? [...Object.keys(meta.wiring), ...(meta.wiring.settings ?? []).flatMap(Object.keys), ...Object.keys(meta.wiring.cron ?? {}), ...wireFields(meta.wiring.wire as Wire | undefined)] : [])))
    expect(fields.size).toBeGreaterThan(0)
    expect([...fields].filter((field) => !skill.includes(`\`${field}\``))).toEqual([])
  })

  it('api-kit-build wires the sharing part as its README does, and api-kit-review checks the threats its tests hold', async () => {
    const skills = await skillTexts()
    const wiring = await readFile(join(kitDir, 'src/sharing/README.md'), 'utf8')
    for (const fact of ['SHARING_SECRET', 'SHARING_OPEN_PATHS', 'sharing.relay', 'sharing.neverKept', 'sharing.sweep()', 'sharing.forget(', 'sharingSignInPaths(sharing)', 'publicOrigin', "address: { header: 'cf-connecting-ip' }", 'mountA2A']) {
      expect(skills['api-kit-build'], fact).toContain(fact)
      if (fact !== 'mountA2A' && !fact.startsWith('address')) expect(wiring, fact).toContain(fact)
    }
    const review = skills['api-kit-review']!
    const signIns = review.slice(review.indexOf('## 5. Who may sign in'), review.indexOf('## 6.'))
    for (const row of ['Typed codes', 'Known return', 'Owner’s one click', 'Withdrawn', 'Shown once', 'Never through A2A', 'Agent invites']) expect(signIns, row).toContain(`| ${row} |`)
    // Rows a review would fail for: what the part does not build
    expect(signIns).not.toMatch(/Ask to join|remembered invite/)
  })

  it('api-kit-cli names every command of the kit\'s CLI and every preset', async () => {
    const text = (await skillTexts())['api-kit-cli']!
    expect(KIT_COMMANDS).toEqual(expect.arrayContaining(['init', 'repo', 'button', 'brand', 'license']))
    for (const command of KIT_COMMANDS.filter((command) => command !== 'help')) expect(text, command).toContain(`\`kit ${command}`)
    expect(PRESETS).toEqual(expect.arrayContaining(['api', 'app', 'selfhosted']))
    for (const preset of PRESETS) expect(text, preset).toContain(`\`--preset ${preset}\``)
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

  it('passes keep and skip to idempotency', async () => {
    const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(`tester:${hash}`) }, guards: { keep: (status) => status < 500, skip: ['/join/*'] } })
    let runs = 0
    app.post('/api/v1/missing', (c) => c.json({ run: ++runs }, 404))
    app.post('/join/abc', (c) => c.json({ run: ++runs }, 201))
    const send = (path: string) => app.request(path, { method: 'POST', headers: { ...auth, 'idempotency-key': 'k1', 'content-type': 'application/json' }, body: '{}' })
    await send('/api/v1/missing')
    expect((await send('/api/v1/missing')).headers.get('idempotent-replayed')).toBe('true')
    await send('/join/abc')
    expect((await send('/join/abc')).headers.get('idempotent-replayed')).toBeNull()
    expect(runs).toBe(3)
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

  it('answers the request the mcp README writes by hand, and says what a request without its _meta lacks', async () => {
    const { app } = await sampleApi()
    const readme = readFileSync(join(import.meta.dirname, '..', 'src/mcp/README.md'), 'utf8')
    const curl = readme.match(/```bash\n# By hand[^\n]*\n(curl [\s\S]*?)\ncurl /)![1]!.replaceAll('\\\n', ' ')
    const headers = Object.fromEntries([...curl.matchAll(/-H ['"]([^:]+): ([^'"]+)['"]/g)].map(([, name, value]) => [name!, value!.replace('$KEY', auth.authorization.slice('Bearer '.length))]))
    const body = curl.match(/-d '([^']+)'/)![1]!
    const listed = await (await app.request('/mcp', { method: 'POST', headers, body })).json()
    expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toContain('get_app')
    const bare = await (await app.request('/mcp', { method: 'POST', headers, body: JSON.stringify({ ...JSON.parse(body), params: {} }) })).json()
    expect(bare.error.code).toBe(-32602)
    expect(readme).toContain('a request without it is a `-32602`')
    // Without the header, as a 2025-era server: an event stream here, since the request accepts one
    const { 'mcp-protocol-version': _version, 'mcp-method': _method, ...older } = headers
    const streamed = await (await app.request('/mcp', { method: 'POST', headers: older, body: JSON.stringify({ ...JSON.parse(body), params: {} }) })).text()
    expect(JSON.parse(streamed.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length)).result.tools.length).toBeGreaterThan(0)
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

  it('takes the same requests through the testing part’s callMcp, which sets every header and the _meta', async () => {
    const { app } = await sampleApi()
    const bearer = auth.authorization.slice('Bearer '.length)
    const greeting = await callMcp(app, 'initialize', { bearer, params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'agent', version: '1' } } })
    expect([greeting.status, greeting.result?.protocolVersion]).toEqual([200, '2026-07-28'])
    const listed = await callMcp(app, 'tools/list', { bearer })
    expect((listed.result?.tools as { name: string }[]).map((tool) => tool.name)).toContain('get_app')
    const called = await callMcp(app, 'tools/call', { bearer, params: { name: 'get_app', arguments: { id: 'a2' } } })
    expect(called.result?.content).toEqual([{ type: 'text', text: 'Bravo (a2)' }])
    // A refusal is an answer: its status and text, no result
    const refused = await callMcp(app, 'tools/list')
    expect([refused.status, refused.result]).toEqual([401, null])
    expect(refused.text).toContain('unauthorized')
    // Any path and headers: a space's MCP, a forwarded host
    const proxied = await callMcp(app, 'tools/call', { path: '/mcp', headers: { ...auth, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'apps.example' }, params: { name: 'get_app', arguments: { id: 'a1' } } })
    expect((proxied.result?.structuredContent as { _links: { self: { href: string } } })._links.self.href).toBe('https://apps.example/api/v1/apps/a1')
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

  it('names the OAuth client_id in authInfo, not the display name, and still forwards the request headers', async () => {
    const { app } = await oauthApp(memoryOAuthStore())
    const seen: { clientId?: string; extra?: Record<string, unknown> }[] = []
    const callInProcess = inProcess(app)
    const whoAmI = mcpTool({ name: 'who_am_i', title: 'Who am I', description: 'The caller.', input: z.object({}), call: () => ({ path: '/api/v1/things' }), summarize: (json) => String((json.caller as { client: string }).client) })
    mountMcp(app, { factory: mcpServerFactory({ info: { name: 'sample', version: '1.0.0' }, instructions: 'Sample.', tools: [whoAmI], callApi: (call, auth) => (seen.push({ clientId: auth?.clientId, extra: auth?.extra }), callInProcess(call, auth)) }), allowedHostnames: ['localhost'] })
    const { client_id, tokens } = await signedIn(app, { name: 'Sample' })
    const call = await (await rpc(app, 'tools/call', { name: 'who_am_i', arguments: {} }, { authorization: `Bearer ${tokens.access_token}` })).json()
    // The tool's in-process call reached the route as the same caller: the headers rode along
    expect(call.result.content[0]).toEqual({ type: 'text', text: client_id })
    expect(seen[0]).toMatchObject({ clientId: client_id, extra: { name: 'Sample', grant: expect.any(String), headers: { authorization: `Bearer ${tokens.access_token}` } } })
  })

  it('answers GET with 405 as the spec asks', async () => {
    const { app } = await sampleApi()
    expect((await app.request('/mcp', { headers: auth })).status).toBe(405)
  })

  /** The sample's routes behind two tools, one with an output schema and one without. */
  const twoTools = async (structured?: 'always' | 'withOutput') => {
    const sample = await sampleApi()
    const getApp = sample.tools[0]!
    const listApps = mcpTool({ name: 'list_apps', title: 'List apps', description: 'Every app.', input: z.object({}), call: () => ({ path: '/api/v1/apps' }), summarize: (page) => `${page.count} app(s)` })
    const app = new Hono()
    mountMcp(app, { factory: mcpServerFactory({ info: { name: 'sample', version: '1.0.0' }, instructions: 'Find apps.', tools: [getApp, listApps], callApi: inProcess(sample.app), ...(structured ? { structured } : {}) }), allowedHostnames: ['localhost'] })
    const call = async (name: string, args: Record<string, unknown>) => (await (await rpc(app as never, 'tools/call', { name, arguments: args })).json()).result
    return { app, call }
  }

  it('names the run to poll, and where, when a slow route is still working', async () => {
    const api = new Hono()
    api.post('/api/v1/reports', (c) => c.json({ status: 'running' }, 202, { location: '/api/v1/runs/r1' }))
    api.get('/api/v1/runs/r1', (c) => c.json({ status: 'running' }))
    const report = mcpTool({ name: 'make_report', title: 'Make a report', description: 'A slow report.', input: z.object({}), call: () => ({ method: 'POST', path: '/api/v1/reports' }), summarize: () => 'done' })
    const app = new Hono()
    mountMcp(app, { factory: mcpServerFactory({ info: { name: 'sample', version: '1.0.0' }, instructions: 'Reports.', tools: [report], callApi: inProcess(api), waitMs: 0 }), allowedHostnames: ['localhost'] })
    const result = (await (await rpc(app as never, 'tools/call', { name: 'make_report', arguments: {} })).json()).result
    expect(result.content[0].text).toBe('Still working: run r1. GET /api/v1/runs/r1 until its status is done (the run is also in _meta["api-kit/pending"]), then call make_report again with the same arguments (it answers at once when done).')
    expect(result._meta['api-kit/pending']).toEqual({ run: 'r1', location: '/api/v1/runs/r1' })
  })

  it('by default every JSON answer carries structuredContent', async () => {
    for (const { call } of [await twoTools(), await twoTools('always')]) {
      expect((await call('get_app', { id: 'a2' })).structuredContent).toMatchObject({ id: 'a2', name: 'Bravo' })
      const listed = await call('list_apps', {})
      expect(listed.content[0]).toEqual({ type: 'text', text: '1 app(s)' })
      expect(listed.structuredContent).toMatchObject({ count: 1, _embedded: { apps: [{ id: 'a1' }] } })
    }
  })

  it('with structured withOutput, a tool without an output schema answers text only, and one with it answers both', async () => {
    const { app, call } = await twoTools('withOutput')
    const listed = await call('list_apps', {})
    expect(listed.content).toEqual([{ type: 'text', text: '1 app(s)' }])
    expect(listed).not.toHaveProperty('structuredContent')
    const one = await call('get_app', { id: 'a2' })
    expect(one.content[0]).toEqual({ type: 'text', text: 'Bravo (a2)' })
    expect(one.structuredContent).toMatchObject({ id: 'a2', name: 'Bravo' })
    // Listings are unchanged: the schema is still declared where a tool has one
    const { tools } = (await (await rpc(app as never, 'tools/list')).json()).result
    expect(tools.find((tool: { name: string }) => tool.name === 'get_app').outputSchema).toMatchObject({ type: 'object' })
    expect(tools.find((tool: { name: string }) => tool.name === 'list_apps')).not.toHaveProperty('outputSchema')
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
