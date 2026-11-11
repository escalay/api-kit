/**
 * How agents find an API before they hold a key: public, read-only metadata the kit serves from what the app already
 * has, so none of it can drift from the real routes.
 *   /.well-known/api-catalog            RFC 9727 linkset: the OpenAPI document, docs, guide and health
 *   Link headers                        RFC 8288 on `/`, `/api`, health, the docs and every 401: the same pointers
 *   /robots.txt                         Content Signals (ai-train, search, ai-input) and whether to crawl at all
 *   Accept: text/markdown               `/` and `/docs` answer with the agent guide (llms.txt) instead of HTML
 *   /.well-known/agent-skills/…         the skills index (Agent Skills Discovery v0.2.0) and one archive per skill
 *   <mcp>/server-card                   the MCP Server Card (SEP-2127), also at /.well-known/mcp/server-card.json
 *   /.well-known/ai-catalog.json        an AI Catalog listing all of the above (ARD)
 *   /sitemap.xml                        the public pages (`discovery.sitemap`), named in robots.txt
 *   /.well-known/poppy.json             Personal Agent Protocol discovery (`discovery.poppy`): the APIs and the issuer
 * `createAgentApi`, `serveGuide` and `mountMcp` wire their parts themselves; an app adds `serveAiCatalog` last. OAuth
 * metadata comes with `oauth.ts` when the app is its own authorization server.
 *
 * @example
 * const app = createAgentApi({ …, discovery: { contentSignal: { aiTrain: false, search: false, aiInput: false } } })
 * serveGuide(app, { dir, vars, full })              // skills index + archives
 * mountMcp(app, { factory, allowedHostnames })      // server card
 * serveAiCatalog(app, { host: 'Cookbook', queries: { api: ['find a quick dinner recipe'], mcp: ['…'] } })
 */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { Context, Hono } from 'hono'
import { originOf } from './hal.js'

/** What a discovery document links to; the kit serves each of these. */
export const WELL_KNOWN = {
  apiCatalog: '/.well-known/api-catalog',
  skillsIndex: '/.well-known/agent-skills/index.json',
  serverCard: '/.well-known/mcp/server-card.json',
  aiCatalog: '/.well-known/ai-catalog.json',
  agentCard: '/.well-known/agent-card.json',
  openapi: '/openapi.json',
  docs: '/docs',
  guide: '/llms.txt',
  health: '/api/health',
} as const

export const OPENAPI_TYPE = 'application/vnd.oai.openapi+json;version=3.1'
export const MARKDOWN_TYPE = 'text/markdown; charset=utf-8'

// ---- Shared response rules ----

const PUBLIC_CACHE = 'public, max-age=3600'
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD',
  'access-control-allow-headers': 'Content-Type, If-None-Match',
  'access-control-expose-headers': 'ETag',
}

export const sha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * A public metadata document: open CORS, an hour of caching, a strong ETag and `304` on `If-None-Match` (what the
 * Server Card and skills specs ask for; harmless for the rest).
 */
export const sendPublic = (c: Context, body: string | Uint8Array, type: string) => {
  const etag = `"${sha256(body).slice(0, 32)}"`
  const headers = { 'content-type': type, 'cache-control': PUBLIC_CACHE, etag, ...CORS }
  const sent = c.req.header('if-none-match')?.split(',').map((value) => value.trim())
  if (sent?.includes(etag) || sent?.includes('*')) return c.body(null, 304, headers)
  return c.body(typeof body === 'string' ? body : (body as Uint8Array<ArrayBuffer>), 200, headers)
}

// ---- RFC 9727 API catalog and RFC 8288 Link headers ----

/** The API catalog for one API rooted at `<origin>/api`: its description, docs and status. */
export const apiCatalog = (origin: string) => ({
  linkset: [
    {
      anchor: `${origin}/api`,
      'service-desc': [{ href: origin + WELL_KNOWN.openapi, type: OPENAPI_TYPE }],
      'service-doc': [
        { href: origin + WELL_KNOWN.docs, type: 'text/html' },
        { href: origin + WELL_KNOWN.guide, type: 'text/markdown' },
      ],
      status: [{ href: origin + WELL_KNOWN.health, type: 'application/json' }],
    },
  ],
})

export const API_CATALOG_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"'

/** The `Link` header value pointing at the catalog and what it lists (relative references, valid per RFC 8288). */
export const LINK_HEADER = [
  `<${WELL_KNOWN.apiCatalog}>; rel="api-catalog"`,
  `<${WELL_KNOWN.openapi}>; rel="service-desc"; type="${OPENAPI_TYPE}"`,
  `<${WELL_KNOWN.docs}>; rel="service-doc"; type="text/html"`,
  `<${WELL_KNOWN.guide}>; rel="describedby"; type="text/markdown"`,
].join(', ')

// ---- robots.txt with Content Signals ----

export type DiscoveryConfig = {
  /**
   * Content Signals (contentsignals.org): may crawlers train on this, index it for search, use it as input to AI
   * answers. Defaults to no, no, no: private by default.
   */
  contentSignal?: { aiTrain?: boolean; search?: boolean; aiInput?: boolean }
  /** Whether crawlers may walk the site at all (`Disallow: /` when false, the default). */
  crawl?: boolean
  /** Public paths for `/sitemap.xml` (and its `Sitemap:` line in robots.txt). */
  sitemap?: string[]
  /** Personal Agent Protocol discovery: the organization's name and what it offers agents, as paths on this origin. */
  poppy?: { name: string; apis?: { type: string; path: string; description: string }[]; protocols?: { type: string; path: string }[]; scopes?: Record<string, { description: string; changes: 'none' | 'reversible' | 'irreversible'; personalData: boolean }> }
}

export const robotsTxt = ({ contentSignal = {}, crawl = false, sitemap, private: hidden }: DiscoveryConfig & { private?: boolean }, origin: string) => {
  const yesNo = (value: boolean | undefined) => (value ? 'yes' : 'no')
  // A private service names nothing: no guide, no catalog, no sitemap
  if (hidden) return ['User-agent: *', 'Content-Signal: ai-train=no, search=no, ai-input=no', 'Disallow: /', ''].join('\n')
  return [
    'User-agent: *',
    `Content-Signal: ai-train=${yesNo(contentSignal.aiTrain)}, search=${yesNo(contentSignal.search)}, ai-input=${yesNo(contentSignal.aiInput)}`,
    crawl ? 'Allow: /' : 'Disallow: /',
    '',
    `# Agents: the guide is ${origin}${WELL_KNOWN.guide}, the catalog ${origin}${WELL_KNOWN.aiCatalog}`,
    `Agentmap: ${origin}${WELL_KNOWN.aiCatalog}`,
    ...(sitemap?.length ? [`Sitemap: ${origin}/sitemap.xml`] : []),
    '',
  ].join('\n')
}

/** The sitemap of public pages (sitemaps.org). */
export const sitemapXml = (origin: string, paths: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((path) => `  <url><loc>${origin}${path.replace(/&/g, '&amp;')}</loc></url>`).join('\n')}\n</urlset>\n`

/** `/.well-known/poppy.json` (Personal Agent Protocol draft 0.3, section 3): this origin is the organization and the issuer. */
export const poppyJson = (origin: string, { name, apis = [], protocols = [], scopes }: NonNullable<DiscoveryConfig['poppy']>, withIssuer: boolean) => ({
  protocol_version: '0.3',
  organization: { name, domain: new URL(origin).hostname },
  ...(withIssuer
    ? {
        auth: {
          issuer: origin,
          ...(scopes
            ? {
                scopes: Object.fromEntries(Object.entries(scopes).map(([scope, one]) => [scope, one.description])),
                scope_hints: Object.fromEntries(Object.entries(scopes).map(([scope, one]) => [scope, { changes: one.changes, personal_data: one.personalData }])),
              }
            : {}),
        },
      }
    : {}),
  ...(protocols.length ? { agent: { protocols: protocols.map((one) => ({ type: one.type, endpoint: `${origin}${one.path}` })) } } : {}),
  ...(apis.length ? { apis: apis.map((one) => ({ type: one.type, url: `${origin}${one.path}`, description: one.description })) } : {}),
  web: {},
})

/** Rough tokens for `x-markdown-tokens`: about four characters each. */
export const markdownTokens = (text: string) => Math.ceil(text.length / 4)

/** True when the client asked for Markdown ahead of HTML (`Accept: text/markdown`). */
export const wantsMarkdown = (accept: string | undefined) => {
  const types = (accept ?? '').split(',').map((part) => part.split(';')[0]!.trim().toLowerCase())
  const markdown = types.indexOf('text/markdown')
  const html = types.indexOf('text/html')
  return markdown >= 0 && (html < 0 || markdown < html)
}

// ---- Skills: index and deterministic archives ----

export const SKILLS_INDEX_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json'

/** `name` and `description` from a SKILL.md's YAML frontmatter (single-line values, as the skills spec writes them). */
export const frontmatterOf = (markdown: string) => {
  const block = markdown.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''
  const field = (key: string) => block.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2')
  return { name: field('name'), description: field('description') }
}

/**
 * A gzipped ustar archive of `files` (path → text) with fixed metadata, so the same files always give the same bytes
 * and the same digest. SKILL.md comes first; the skill's files sit at the root, as the discovery spec asks.
 */
export const tarGz = (files: [string, string][]) => {
  const blocks: Buffer[] = []
  const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0'
  // SKILL.md first, so a reader can stop after it; the rest in a fixed order
  for (const [path, text] of [...files].sort(([a], [b]) => Number(b === 'SKILL.md') - Number(a === 'SKILL.md') || a.localeCompare(b))) {
    if (path.startsWith('/') || path.split('/').includes('..') || Buffer.byteLength(path) > 100) throw new Error(`Unsafe or too long archive path: ${path}`)
    const content = Buffer.from(text, 'utf8')
    const header = Buffer.alloc(512)
    header.write(path, 0, 'utf8')
    header.write(octal(0o644, 8), 100)
    header.write(octal(0, 8), 108)
    header.write(octal(0, 8), 116)
    header.write(octal(content.length, 12), 124)
    header.write(octal(0, 12), 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let sum = 0
    for (const byte of header) sum += byte
    header.write(octal(sum, 7) + ' ', 148)
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return new Uint8Array(gzipSync(Buffer.concat(blocks), { level: 9 }))
}

export type SkillArtifact = { name: string; description: string; type: 'skill-md' | 'archive'; url: string; bytes: Uint8Array | string; mediaType: string }

/** The index entry for each skill, its digest taken over the exact bytes its `url` serves. */
export const skillsIndex = (origin: string, skills: SkillArtifact[]) => ({
  $schema: SKILLS_INDEX_SCHEMA,
  skills: skills.map((skill) => ({ name: skill.name, type: skill.type, description: skill.description, url: origin + skill.url, digest: `sha256:${sha256(skill.bytes)}` })),
})

// ---- MCP Server Card (SEP-2127) ----

export const SERVER_CARD_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json'
export const SERVER_CARD_TYPE = 'application/mcp-server-card+json'
/** The 2026 revision the kit's servers speak; the SDK answers the 2025 ones through its fallback. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28'

export type ServerCardInfo = { name: string; version: string; title?: string; description?: string; websiteUrl?: string }

/** `cookbook.example.com` + `cookbook` → `com.example.cookbook/cookbook`: the reverse-DNS name the card spec asks for. */
export const reverseDnsName = (origin: string, name: string) => `${new URL(origin).hostname.split('.').reverse().join('.')}/${name}`

export const serverCard = (origin: string, path: string, info: ServerCardInfo, protocolVersions: string[]) => ({
  $schema: SERVER_CARD_SCHEMA,
  name: reverseDnsName(origin, info.name),
  version: info.version,
  description: info.description ?? info.title ?? info.name,
  ...(info.title ? { title: info.title } : {}),
  websiteUrl: info.websiteUrl ?? `${origin}${WELL_KNOWN.guide}`,
  remotes: [
    {
      type: 'streamable-http' as const,
      url: origin + path,
      headers: [
        {
          name: 'Authorization',
          description: 'An API key issued per client by the owner.',
          isRequired: true,
          isSecret: true,
          value: 'Bearer {api_key}',
          variables: { api_key: { description: 'Your API key.', isRequired: true, isSecret: true } },
        },
      ],
      supportedProtocolVersions: protocolVersions,
    },
  ],
})

// ---- What an app has mounted, for the catalogs ----

/** What the guide needs of an MCP tool: the kit's `McpTool` fits, so does any tool with a name, a description and a call. */
export type ToolLike = { name: string; description: string; call: (args: never) => { method?: string; path: string } }
/** What the guide needs of an MCP resource: its URI template and what it is. */
export type ResourceLike = { uriTemplate: string; title: string; description: string }

type Mounted = {
  skills?: (origin: string) => SkillArtifact[]
  /** Builds the skill artifacts for an origin (they are rendered per origin and per data snapshot). */
  refreshSkills?: (origin: string, credentials?: Record<string, string>) => Promise<SkillArtifact[]>
  mcp?: { path: string; card: (origin: string) => ReturnType<typeof serverCard>; tools: ToolLike[]; resources?: ResourceLike[] }
}
const mountedByApp = new WeakMap<object, Mounted>()

/** `serveGuide` and `mountMcp` record what they serve so `serveAiCatalog` lists exactly that. */
export const recordMounted = (app: object, part: Mounted) => mountedByApp.set(app, { ...mountedByApp.get(app), ...part })
export const mountedOf = (app: object) => mountedByApp.get(app) ?? {}

// ---- AI Catalog (ARD) ----

export const AI_CATALOG_TYPE = 'application/ai-catalog+json'

export type AiCatalogConfig = {
  /** Who operates this, shown by registries. */
  host: string
  /** The publisher segment of `urn:air` identifiers; defaults to the request's host name. */
  publisher?: string
  /** 2–5 questions per artifact that registries embed to match it to what people ask. */
  queries: { api: string[]; mcp?: string[]; skills?: Record<string, string[]> }
}

export const aiCatalog = (origin: string, config: AiCatalogConfig, mounted: Mounted, apiTitle: string) => {
  const publisher = config.publisher ?? new URL(origin).hostname
  const urn = (namespace: string, name: string) => `urn:air:${publisher}:${namespace}:${name}`
  const card = mounted.mcp?.card(origin)
  return {
    specVersion: '1.0',
    host: { displayName: config.host, identifier: `did:web:${new URL(origin).hostname}`, documentationUrl: origin + WELL_KNOWN.guide },
    entries: [
      { identifier: urn('api', 'openapi'), displayName: apiTitle, type: OPENAPI_TYPE, url: origin + WELL_KNOWN.openapi, representativeQueries: config.queries.api },
      // ARD asks every entry for a displayName; the card's own title, so the two can't drift
      ...(card && mounted.mcp ? [{ identifier: urn('mcp', card.name.split('/').pop()!), displayName: card.title ?? card.name, type: SERVER_CARD_TYPE, url: `${origin}${mounted.mcp.path}/server-card`, representativeQueries: config.queries.mcp ?? config.queries.api }] : []),
      ...(mounted.skills?.(origin) ?? []).map((skill) => ({
        identifier: urn('skill', skill.name),
        displayName: skill.name,
        description: skill.description,
        type: skill.type === 'archive' ? 'application/agent-skills+gzip' : 'application/agent-skills+md',
        url: origin + skill.url,
        digest: `sha256:${sha256(skill.bytes)}`,
        representativeQueries: config.queries.skills?.[skill.name] ?? config.queries.api,
      })),
    ],
  }
}

/** Serves the AI Catalog over whatever the app mounted; call after `serveGuide` and `mountMcp`. */
export const serveAiCatalog = (app: Hono<any, any, any>, config: AiCatalogConfig & { apiTitle: string }) => {
  app.get(WELL_KNOWN.aiCatalog, async (c) => {
    const mounted = mountedOf(app)
    // The caller's own credentials: a private service renders its skills only for them
    await mounted.refreshSkills?.(originOf(c), Object.fromEntries((['authorization', 'cookie', 'cf-access-jwt-assertion'] as const).flatMap((name) => (c.req.header(name) ? [[name, c.req.header(name)!]] : []))))
    return sendPublic(c, JSON.stringify(aiCatalog(originOf(c), config, mounted, config.apiTitle), null, 2), AI_CATALOG_TYPE)
  })
}
