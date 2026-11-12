/**
 * One call gives an app the whole standard: an `OpenAPIHono` whose every error is problem+json, every request has an
 * id, the OpenAPI 3.1 document at `/openapi.json` describes auth, tags and the agent guide, Scalar renders it at
 * `/docs`, `/problems/{code}` explains each error, and `/api/health` answers without a key. The app then adds its own
 * routes with `createRoute` and `app.openapi`.
 *
 * @example
 * const app = createAgentApi({
 *   title: 'Cookbook', version: '1.0.0', description: 'What it is and where to start.',
 *   tags: [{ name: 'Catalog', description: 'Cooks, recipes, menus' }],
 *   auth: { realm: 'cookbook', keys: parseApiKeys(process.env.API_KEYS), access: { team: 'example', audience: process.env.ACCESS_AUD ?? '' } },
 *   health: () => ({ snapshot: store.snapshot }),
 * })
 * app.openapi(getAppRoute, (c) => c.json(appOf(c.req.valid('param').id), 200))
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import type { MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { authenticate, OAUTH_OPEN_PATHS, SCOPES, type OAuthServer } from './auth.js'
import { cacheControl, CACHE } from './cache.js'
import { idempotency, type GuardStore } from './guards.js'
import { API_CATALOG_TYPE, apiCatalog, LINK_HEADER, markdownTokens, MARKDOWN_TYPE, poppyJson, robotsTxt, sendPublic, sitemapXml, WELL_KNOWN, wantsMarkdown, type DiscoveryConfig } from './discovery.js'
import { HAL_JSON, originOf } from './hal.js'
import { errorHandler, notFoundHandler, PROBLEMS, problemResponse, problemResponses, validationHook, type ProblemCode } from './problem.js'

export type AgentApiConfig = {
  title: string
  version: string
  /** Markdown for the top of the OpenAPI document and the docs page: what this is, where to start. */
  description: string
  tags: { name: string; description: string }[]
  /** Scalar's sidebar groups (`x-tagGroups`). */
  tagGroups?: { name: string; tags: string[] }[]
  auth: Parameters<typeof authenticate>[0]
  /** Extra fields for `/api/health`, e.g. the snapshot the API serves. */
  health?: () => Record<string, unknown>
  /** Origins allowed to call from a browser; the API's own pages are same-origin and need none. */
  corsOrigins?: string[]
  /** robots.txt: Content Signals and crawling (defaults: private, no, no, no). See `discovery.ts`. */
  discovery?: DiscoveryConfig
  /** `docs` (default): `/` sends people to `/docs` and agents asking for Markdown to the guide. `app`: people go to the browser app at `/app/` instead (and `/app` redirects there). `false`: the app serves `/`. */
  home?: 'docs' | 'app' | false
  /** The service as its own OAuth server (`createOAuth`): mounted here, its tokens accepted beside keys. */
  oauth?: OAuthServer
  /** Where Idempotency-Key answers are kept (default: this process's memory). On Workers: `dbGuardStore(db)`. */
  guards?: { store?: GuardStore }
  /**
   * Private: nothing about the service is readable without credentials. Only `robots.txt`, `/api/health` (status only),
   * the error pages and what an OAuth client needs to ask for access stay open; the guide, docs, spec, discovery files
   * and agent cards need a key, a token or the Access cookie. Every response says `noindex`, and no page points at
   * the guide. Agents still connect: MCP clients through OAuth (the 401 names the resource metadata), others with a key.
   */
  private?: boolean
}

/** What an OAuth client needs before it holds a token, and nothing more (private mode). */
const PRIVATE_OPEN = ['/robots.txt', '/api/health', '/problems/*', '/.well-known/oauth-protected-resource*', '/.well-known/oauth-authorization-server*', '/.well-known/jwks.json']
const PRIVATE_OAUTH_OPEN = ['/oauth/*', '/agent/identity', '/agent/identity/claim']
const NOINDEX = 'noindex, nofollow, noarchive, nosnippet, noimageindex'

export const SECURITY_SCHEME = 'apiKey'

type Parameter = { name?: string; in?: string; required?: boolean; description?: string; example?: unknown; schema?: { description?: string; example?: unknown; type?: string; maxLength?: number } }
type OpenApiDocument = { paths?: Record<string, Record<string, { parameters?: Parameter[] }>> } & Record<string, unknown>

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description: 'Any unique string (a UUID): a retry with the same key and body gets the first answer instead of doing the work twice; the same key with another body is a 422. Kept 24 hours.',
  schema: { type: 'string', maxLength: 255 },
}

/**
 * Copies each parameter's schema description and example up to the parameter, where OpenAPI readers look first, and
 * documents `Idempotency-Key` on every POST and PATCH (the kit honours it on all of them).
 */
export const hoistParameterDocs = (doc: OpenApiDocument) => {
  for (const item of Object.values(doc.paths ?? {}))
    for (const [method, operation] of Object.entries(item)) {
      if (method === 'post' || method === 'patch') operation.parameters = [...(operation.parameters ?? []), IDEMPOTENCY_HEADER as Parameter]
      for (const parameter of operation.parameters ?? []) {
        parameter.description ??= parameter.schema?.description
        if (parameter.example === undefined && parameter.schema?.example !== undefined) parameter.example = parameter.schema.example
      }
    }
  return doc
}

/**
 * A parameter the operation doesn't declare is an error, not a no-op: `?since=` on a route without it would otherwise
 * answer 200 as if it had filtered. The allowed names come from each route's own query schema, read once.
 */
const rejectUnknownQuery = (app: OpenAPIHono): MiddlewareHandler => {
  let routes: { method: string; pattern: RegExp; allowed: Set<string> }[] | null = null
  return async (c, next) => {
    routes ??= app.openAPIRegistry.definitions.flatMap((definition) => {
      if (definition.type !== 'route') return []
      const { method, path, request } = definition.route as { method: string; path: string; request?: { query?: { shape?: Record<string, unknown> } } }
      return [{ method: method.toUpperCase(), pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`), allowed: new Set(Object.keys(request?.query?.shape ?? {})) }]
    })
    const route = routes.find((candidate) => candidate.method === c.req.method && candidate.pattern.test(c.req.path))
    const unknown = route ? Object.keys(c.req.queries()).filter((name) => !route.allowed.has(name)) : []
    if (!unknown.length) return next()
    const allowed = route!.allowed.size ? `Allowed here: ${[...route!.allowed].join(', ')}.` : 'This operation takes no query parameters.'
    return problemResponse(c, 'bad_request', { detail: `Unknown query parameter${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}. ${allowed}`, errors: unknown.map((name) => ({ in: 'query' as const, path: name, message: 'not a parameter of this operation' })) })
  }
}

/** The pages an agent lands on first; each carries the RFC 8288 pointers, as does every 401. */
const LINKED = new Set(['/', '/api', WELL_KNOWN.health, WELL_KNOWN.docs, WELL_KNOWN.guide])
const linkHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  if (LINKED.has(c.req.path) || c.res.status === 401) c.res.headers.append('link', LINK_HEADER)
}

/** `Accept: text/markdown` on `/` or `/docs` gets the agent guide (llms.txt) instead of HTML; browsers still get HTML. */
const markdownForAgents = (app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }): MiddlewareHandler => async (c, next) => {
  if (c.req.method !== 'GET' || (c.req.path !== '/' && c.req.path !== WELL_KNOWN.docs) || !wantsMarkdown(c.req.header('accept'))) {
    await next()
    if (c.req.path === '/' || c.req.path === WELL_KNOWN.docs) c.res.headers.append('vary', 'Accept')
    return
  }
  const guide = await app.request(WELL_KNOWN.guide, { headers: { 'x-forwarded-proto': new URL(originOf(c)).protocol.slice(0, -1), 'x-forwarded-host': new URL(originOf(c)).host } })
  if (!guide.ok) return next()
  const text = await guide.text()
  return c.body(text, 200, { 'content-type': MARKDOWN_TYPE, 'x-markdown-tokens': String(markdownTokens(text)), vary: 'Accept', 'cache-control': CACHE.docs })
}

export const createAgentApi = (config: AgentApiConfig) => {
  const app = new OpenAPIHono({ defaultHook: validationHook as never })
  const home = config.home ?? 'docs'
  // Discovery is public: what exists and how to reach it, never the data
  const discovery = ['/robots.txt', '/sitemap.xml', '/.well-known/*', '*/server-card', ...(home ? ['/'] : []), ...(home === 'app' ? ['/app'] : [])]
  const open = config.private
    ? [...PRIVATE_OPEN, ...(config.oauth ? PRIVATE_OAUTH_OPEN : []), ...(config.auth.open ?? [])]
    : ['/api/health', '/openapi.json', '/docs', '/llms.txt', '/llms-full.txt', '/agents/*', '/skills/*', '/problems/*', ...discovery, ...(config.oauth ? OAUTH_OPEN_PATHS : []), ...(config.auth.open ?? [])]

  app.use('*', requestId({ headerName: 'x-request-id' }))
  app.use('*', secureHeaders({ crossOriginResourcePolicy: false, contentSecurityPolicy: undefined }))
  // Same-site unless a route says otherwise (a sandboxed page's own files must load from its opaque origin)
  app.use('*', async (c, next) => {
    await next()
    if (!c.res.headers.has('cross-origin-resource-policy')) c.res.headers.set('cross-origin-resource-policy', 'same-site')
  })
  if (config.corsOrigins?.length) app.use('*', cors({ origin: config.corsOrigins, exposeHeaders: ['etag', 'link', 'retry-after', 'x-request-id'] }))
  // Before auth, so a 401 also tells an agent where the catalog and docs are
  if (config.private)
    app.use('*', async (c, next) => {
      await next()
      c.res.headers.set('x-robots-tag', NOINDEX)
      // Anything readable only with credentials must never sit in a shared cache (Cloudflare keeps .txt and .js by extension)
      const cache = c.res.headers.get('cache-control')
      if (cache?.includes('public') && c.req.path !== '/robots.txt') c.res.headers.set('cache-control', cache.replace('public', 'private'))
    })
  else {
    app.use('*', linkHeaders)
    app.use('*', markdownForAgents(app))
  }
  app.use('*', authenticate({ relay: ['/mcp', '/a2a'], ...config.auth, open, ...(config.oauth ? { tokens: config.oauth.verify, resourceMetadata: config.oauth.resourceMetadataFor } : {}) }) as MiddlewareHandler)
  app.use('*', cacheControl({ '/openapi.json': CACHE.docs, '/problems/': CACHE.docs, '/api/': CACHE.api }))
  // Resources under /api are HAL; Hono writes plain JSON, so name the media type once here
  app.use('/api/*', async (c, next) => {
    await next()
    if (c.res.status < 300 && c.req.path !== '/api/health' && c.res.headers.get('content-type')?.startsWith('application/json')) c.res.headers.set('content-type', HAL_JSON)
  })
  app.use('*', rejectUnknownQuery(app))
  // After auth: a retried POST is recognised per caller
  app.use('*', idempotency({ store: config.guards?.store }))
  app.onError(errorHandler)
  app.notFound(notFoundHandler)

  app.openAPIRegistry.registerComponent('securitySchemes', SECURITY_SCHEME, {
    type: 'http',
    scheme: 'bearer',
    description: 'An API key per client: `Authorization: Bearer <key>`. People reach the same routes through the single sign-on in front of the site.',
  })
  if (config.oauth) {
    app.openAPIRegistry.registerComponent('securitySchemes', 'oauth', {
      type: 'oauth2',
      description: 'An OAuth token the owner approved: authorization code with PKCE (clients register at `/oauth/register`), or agent registration as `/auth.md` describes.',
      flows: { authorizationCode: { authorizationUrl: '/oauth/authorize', tokenUrl: '/oauth/token', refreshUrl: '/oauth/token', scopes: Object.fromEntries(SCOPES.map((scope) => [scope, scope === 'read' ? 'Read everything' : 'Make changes (boards)'])) } },
    })
    config.oauth.mount(app)
  }

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/health',
      operationId: 'getHealth',
      summary: 'Health check',
      description: 'Answers without a key: `ok` while the service can serve, with the version it runs.',
      tags: ['Meta'],
      security: [],
      responses: {
        200: { description: 'The service is up.', content: { 'application/json': { schema: z.object({ status: z.literal('ok'), version: z.string() }).catchall(z.unknown()).openapi('Health', { description: 'Up, with the version it runs and what it serves.' }) } } },
        ...problemResponses(503),
      },
    }),
    (c) => c.json({ status: 'ok' as const, version: config.version, ...(config.private ? {} : config.health?.()) }, 200),
  )

  app.get('/problems/:code', (c) => {
    const code = c.req.param('code') as ProblemCode
    if (!(code in PROBLEMS)) return problemResponse(c, 'not_found', { detail: `No problem type "${code}". All of them: ${Object.keys(PROBLEMS).join(', ')}.` })
    const problem = PROBLEMS[code]
    return c.json({ code, status: problem.status, title: problem.title, description: problem.description })
  })

  // The generator leaves a parameter's description and example inside its schema; tools and agents read them on the
  // parameter, so lift them there
  app.get('/openapi.json', (c) => {
    const doc = app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: config.title, version: config.version, description: config.description },
      servers: [{ url: originOf(c), description: 'This server' }],
      security: [{ [SECURITY_SCHEME]: [] }, ...(config.oauth ? [{ oauth: [...SCOPES] }] : [])],
      tags: [...config.tags, { name: 'Meta', description: 'Health and errors.' }],
      externalDocs: { url: `${originOf(c)}/llms.txt`, description: 'Agent guide: concepts, every endpoint with examples, trust and limits, and task playbooks.' },
    }) as unknown as OpenApiDocument
    return c.json({ ...hoistParameterDocs(doc), ...(config.tagGroups ? { 'x-tagGroups': [...config.tagGroups, { name: 'Meta', tags: ['Meta'] }] } : {}) })
  })
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: `${config.title} — API`, hideClientButton: false, defaultOpenAllTags: false }))

  app.get(WELL_KNOWN.apiCatalog, (c) => sendPublic(c, JSON.stringify(apiCatalog(originOf(c)), null, 2), API_CATALOG_TYPE))
  app.get('/robots.txt', (c) => sendPublic(c, robotsTxt(config.private ? { private: true } : (config.discovery ?? {}), originOf(c)), 'text/plain; charset=utf-8'))
  const { sitemap, poppy } = config.private ? {} : (config.discovery ?? {})
  if (sitemap?.length) app.get('/sitemap.xml', (c) => sendPublic(c, sitemapXml(originOf(c), sitemap), 'application/xml; charset=utf-8'))
  if (poppy) app.get('/.well-known/poppy.json', (c) => sendPublic(c, JSON.stringify(poppyJson(originOf(c), poppy, Boolean(config.oauth)), null, 2), 'application/json'))
  if (home) app.get('/', (c) => c.redirect(home === 'app' ? '/app/' : '/docs', 302))
  // The app's files are served under /app/, so the bare path is sent there too
  if (home === 'app') app.get('/app', (c) => c.redirect('/app/', 302))

  return app
}

export type AgentApi = ReturnType<typeof createAgentApi>
