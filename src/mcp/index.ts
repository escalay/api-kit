/**
 * An MCP server (spec 2026-07-28, stateless Streamable HTTP; 2025-era clients served by the SDK's fallback) whose tools
 * are thin calls to the app's own HTTP routes, so the API and MCP can never disagree: same validation, same auth,
 * same problem details. A tool answers with a short text an agent reads first, the route's JSON as
 * `structuredContent` (matching `outputSchema` when given; see `structured` on `mcpServerFactory`), and
 * `resource_link`s for images. The skills folder is
 * served through the Skills extension (SEP-2640) and each playbook also as a prompt.
 *
 * @example
 * const tools = [mcpTool({ name: 'search_recipes', title: 'Search recipes', description: '…', input: z.object({ q: z.string() }),
 *   call: ({ q }) => ({ path: '/api/v1/search/recipes', query: { q } }), summarize: (page) => … })]
 * mountMcp(app, { factory: mcpServerFactory({ info, instructions, tools, callApi: inProcess(app) }), allowedHostnames: ['cookbook.example.com'] })
 * // a stdio client on a laptop: the same tools over HTTP with its own key (serveStdio is the SDK's:
 * // import { serveStdio } from '@modelcontextprotocol/server/stdio')
 * serveStdio(mcpServerFactory({ info, instructions, tools, callApi: overHttp(origin, process.env.COOKBOOK_API_KEY!) }))
 */
import { createMcpHandler, McpServer, originValidationResponse, ResourceTemplate, SUPPORTED_PROTOCOL_VERSIONS, UriTemplate, type AuthInfo, type CallToolResult, type McpRequestContext, type McpServerFactory } from '@modelcontextprotocol/server'
import type { SkillCatalog } from '@modelcontextprotocol/server/ext/skills'
import { createHash } from 'node:crypto'
import { z } from '@hono/zod-openapi'
import type { Context, Hono } from 'hono'
import { CLI_META, cliOf, hintsOf, PENDING_META, PROBLEM_META, TOOLS_HASH_META, resourceCli, routeOf, templateVariables, type CallAt, type CliSpec } from '../core/cli.js'
import { attachSkills, instructionsWithSkills } from './skills.js'
import { MODERN_PROTOCOL_VERSION, mountedOf, publicOriginOf, recordMounted, sendPublic, serverCard, SERVER_CARD_TYPE, WELL_KNOWN, type AgentBrand, type ServerIcon } from '../core/discovery.js'
import { neverKeep } from '../core/guards.js'
import { originOf, originOfRequest, pathWith } from '../core/hal.js'

type Query = Record<string, string | number | boolean | string[] | null | undefined>
export type ApiCall = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; query?: Query; body?: unknown }
export type CallApi = (call: ApiCall, auth: AuthInfo | undefined) => Promise<Response>

export type ToolAnnotations = { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }
export type ResourceLinkOut = { uri: string; name: string; title?: string; description?: string; mimeType?: string }

export type McpTool<Input extends z.ZodObject = z.ZodObject> = {
  /** `snake_case`, 1–64 characters of `a-z0-9_`. */
  name: string
  title: string
  /** When to use it and what comes back — the model chooses tools by this. */
  description: string
  input: Input
  /** The route's 200 schema, when its shape is fixed: the JSON (sent as `structuredContent`) must match it. */
  output?: z.ZodTypeAny
  annotations?: ToolAnnotations
  /** `at.params`: the mount path's parameters (`/s/:space/mcp` → `{ space }`), decoded; encode each one put in a path. */
  call: (args: z.infer<Input>, at?: CallAt) => ApiCall
  /** The text an agent reads first: a few lines per result with ids and the links to follow. */
  summarize: (json: any, args: z.infer<Input>) => string
  /** Images or files worth attaching as `resource_link` blocks (at most a handful). */
  links?: (json: any) => ResourceLinkOut[]
  /** The route it calls, `GET /api/v1/recipes/{id}`, when `routeOf` can't read it from `call` (a path built in steps). */
  route?: string
  /** Its command, noun then verb (`'mail wait'`), with examples run without the bin (`'mail wait adr_1 --timeout 30'`). */
  cli?: CliSpec
}

/** Where a tool's route is published in its MCP listing, so a gateway can tell which tool a guide's route means. */
export const ROUTE_META = 'api-kit/route'

/** Keeps the input type when building a list of tools. */
export const mcpTool = <Input extends z.ZodObject>(tool: McpTool<Input>) => tool as unknown as McpTool

/**
 * A resource a client can attach (a recipe with its picture, a menu's courses): a URI template and the API calls whose
 * answers make it up — JSON as text, anything else (images) as a blob. Read through the routes with the caller's
 * credentials, like tools.
 */
export type McpResource = {
  name: string
  title: string
  description: string
  /** RFC 6570, e.g. `cookbook://recipes/{id}`. */
  uriTemplate: string
  /** The calls whose answers make up the resource, in order; an `optional` one (an image) is left out when it fails. */
  read: (variables: Record<string, string>, at?: CallAt) => (ApiCall & { optional?: boolean })[]
  /** Its command, noun then verb (`'mail headers'`); the template's path variables are its positional arguments. */
  cli?: CliSpec
}

/** Keeps a resource's shape checked when building the list. */
export const mcpResource = (resource: McpResource) => resource

export type McpPrompt = { name: string; title: string; description: string; arguments?: z.ZodObject; text: (args: Record<string, string>) => string }

export type McpServerInfo = { name: string; version: string; title?: string; description?: string; websiteUrl?: string; icons?: ServerIcon[] }

/**
 * The server's identity with the brand's title, description, website and icons where `info` leaves them out, for the
 * origin it is served at. `inline: false` leaves the data icon out (what rides on every answer); no brand, `info` as it is.
 *
 * @example
 * serverInfoOf({ name: 'cookbook', version: '1.0.0' }, brand, 'https://cookbook.example.com').icons?.[0].src // 'data:image/png;base64,…'
 */
export const serverInfoOf = (info: McpServerInfo, brand: AgentBrand | undefined, origin: string | null, { inline = true }: { inline?: boolean } = {}): McpServerInfo => {
  if (!brand) return info
  const websiteUrl = info.websiteUrl ?? brand.websiteUrl
  const icons = info.icons ?? brand.icons(origin, { inline })
  return { ...info, title: info.title ?? brand.title, description: info.description ?? brand.description, ...(websiteUrl ? { websiteUrl } : {}), ...(icons.length ? { icons } : {}) }
}

const HOUR = 3_600_000

/** A problem+json body (or anything else) as one line an agent can act on. */
export const problemText = (json: any, status: number) =>
  json && typeof json === 'object' && 'title' in json ? `${json.status ?? status} ${json.code ?? ''} ${json.title}: ${json.detail ?? ''}`.replace(/\s+/g, ' ').trim() : `HTTP ${status}`

/**
 * An answer's body as an RFC 9457 problem that always has its `status`, also when the body was not a problem.
 *
 * @example
 * problemOf(null, 502) // → { type: 'about:blank', title: 'HTTP 502', status: 502 }
 */
export const problemOf = (json: any, status: number): Record<string, unknown> & { status: number } =>
  json && typeof json === 'object' && 'title' in json ? { ...json, status: typeof json.status === 'number' ? json.status : status } : { type: 'about:blank', title: `HTTP ${status}`, status }

/** How a slow call stands: its answer, or (`pending`, the run's id, and `location`, its path) a run still working. */
export type Waited = { response: Response; pending: string | null; location: string | null }

const POLL_MS = 3000

/** A call's answer, or the run it started when it answered 202 with a `Location`. */
const waitedOf = (response: Response): Waited => {
  const location = response.headers.get('location')
  return response.status === 202 && location ? { response, pending: location.split('/').pop()!, location } : { response, pending: null, location: null }
}

/** A path for `callApi` from a link's absolute `href`. */
const pathOf = (href: string) => {
  const url = new URL(href, 'http://localhost')
  return url.pathname + url.search
}

/**
 * The caller's auth for one JSON-RPC call: its Idempotency-Key gets the call's id, so the calls of one batch never
 * share a key, and a retried call (the same id) runs its route once.
 */
const perCallAuth = (auth: AuthInfo | undefined, id: string | number): AuthInfo | undefined => {
  const headers = (auth?.extra?.headers ?? {}) as Record<string, string>
  const key = headers['idempotency-key']
  return key && auth ? { ...auth, extra: { ...auth.extra, headers: { ...headers, 'idempotency-key': `${key}:${id}` } } } : auth
}

/** The caller's auth without its Idempotency-Key: a call made again after its run is done wants the result, not the 202 kept for that key. */
const freshCallOf = (auth: AuthInfo | undefined): AuthInfo | undefined => {
  const { 'idempotency-key': _key, ...headers } = (auth?.extra?.headers ?? {}) as Record<string, string>
  return auth && { ...auth, extra: { ...auth.extra, headers } }
}

/**
 * Polls a slow call's run (its `Location`) until `waitMs` has passed, looking at least once. Done: the answer is the
 * run's `_links.result` when it names one, else the call made once more (a slow route caches its answer: the
 * standard's 202 rule); a call that answers 202 again started another run, which is pending in turn. Failed: the
 * run's answer. It never makes the call again while the run works, so a call with side effects isn't repeated.
 *
 * @example
 * const { response, location } = await pollRun(callApi, tool.call(args), stored.location, auth, 0)
 */
export const pollRun = async (callApi: CallApi, call: ApiCall, location: string, auth: AuthInfo | undefined, waitMs: number): Promise<Waited> => {
  const until = Date.now() + waitMs
  for (;;) {
    const run = await callApi({ path: location }, auth)
    const { status, _links } = ((await run.clone().json().catch(() => null)) ?? {}) as { status?: string; _links?: { result?: { href?: string } } }
    if (status === 'done') {
      const result = _links?.result?.href
      return waitedOf(await callApi(result ? { path: pathOf(result) } : call, freshCallOf(auth)))
    }
    if (status === 'failed') return { response: run, pending: null, location: null }
    if (Date.now() >= until) return { response: run, pending: location.split('/').pop()!, location }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}

/**
 * Makes a call; a slow route answers 202 with a run in `Location`, which `pollRun` polls (up to `waitMs`), so a client
 * sees one answer. Past the wait it says which run to check, and where.
 *
 * @example
 * const { response, pending, location } = await callWaiting(callApi, tool.call(args), auth, 60_000)
 */
export const callWaiting = async (callApi: CallApi, call: ApiCall, auth: AuthInfo | undefined, waitMs: number): Promise<Waited> => {
  const answered = waitedOf(await callApi(call, auth))
  return answered.location ? pollRun(callApi, call, answered.location, auth, waitMs) : answered
}

/**
 * A URI template whose query variables (`{?format}`) may be left out or given in part: the SDK's own match needs every
 * one, so `mail://messages/m1/body` would find no resource.
 */
const lenientTemplate = (template: string) => {
  const strict = new UriTemplate(template)
  const bare = template.replace(/\{[?&][^}]*\}/g, '')
  if (bare === template) return strict
  const plain = new UriTemplate(bare)
  const { query } = templateVariables(template)
  return Object.assign(strict, {
    match: (uri: string) => {
      const exact = UriTemplate.prototype.match.call(strict, uri)
      if (exact) return exact
      const [path = '', search = ''] = uri.split('?')
      const found = plain.match(path)
      return found && { ...found, ...Object.fromEntries([...new URLSearchParams(search)].filter(([name]) => query.includes(name))) }
    },
  })
}

/** A resource's command as `resources/templates/list` publishes it. */
const resourceMeta = (resource: McpResource) => {
  const { name, positional, examples } = resourceCli(resource)
  return { name, positional, examples }
}

/** The mount path's parameters `mountMcp` put in `authInfo`; none over stdio. */
const callAtOf = (auth: AuthInfo | undefined): CallAt => ({ params: (auth?.extra?.params ?? {}) as Record<string, string> })

const hashes = new WeakMap<McpTool[], string>()
/**
 * A short hash of what `tools/list` and `resources/templates/list` say: each tool's name, words, schemas, hints and
 * `_meta`, each resource's. Made once per tool list, on the first request (never at global scope, for Workers).
 *
 * @example
 * toolsHashOf(TOOLS, RESOURCES) // → '3f9a0c1e2b7d4a58'
 */
export const toolsHashOf = (tools: McpTool[], resources: McpResource[] = []) => {
  const known = hashes.get(tools)
  if (known) return known
  const listing = {
    tools: tools.map((tool) => ({ name: tool.name, title: tool.title, description: tool.description, input: z.toJSONSchema(tool.input, { io: 'input' }), output: tool.output ? z.toJSONSchema(tool.output, { io: 'output', unrepresentable: 'any' }) : null, hints: hintsOf(tool), route: routeOf(tool) ?? null, cli: cliOf(tool) })),
    resources: resources.map((resource) => ({ name: resource.name, title: resource.title, description: resource.description, uriTemplate: resource.uriTemplate, cli: resourceCli(resource) })),
  }
  const hash = createHash('sha256').update(JSON.stringify(listing)).digest('hex').slice(0, 16)
  hashes.set(tools, hash)
  return hash
}

/** A factory that also carries its server info and tools, so `mountMcp` can publish the card and the guide can list the tools. */
export type AgentMcpFactory = McpServerFactory & { info: McpServerInfo; tools: McpTool[]; resources: McpResource[]; instructions?: string; prompts?: McpPrompt[]; brand?: AgentBrand }

/**
 * The MCP server over the tools. `toolsTtlMs`: how long clients may cache `tools/list` (default an hour); shorter when
 * the tools change without a deploy. `structured`: when a tool's JSON answer rides as `structuredContent`: `'always'`
 * (the default; the app's CLI reads it for `--json`), or `'withOutput'`, only for a tool with an `output` schema, for
 * clients that show `structuredContent` instead of the text. `brand`: the server's title, description, website and icons
 * (`mountMcp` passes the app's own, from `createAgentApi({ brand })`, so give it here only for a stdio server).
 *
 * @example
 * mcpServerFactory({ info, instructions, tools, callApi: inProcess(app), structured: 'withOutput' })
 */
export const mcpServerFactory = ({ info, instructions, tools, resources = [], prompts = [], skills, callApi, waitMs = 60_000, toolsTtlMs = HOUR, structured = 'always', brand: ownBrand }: { info: McpServerInfo; instructions: string; tools: McpTool[]; resources?: McpResource[]; prompts?: McpPrompt[]; skills?: SkillCatalog; callApi: CallApi; waitMs?: number; toolsTtlMs?: number; structured?: 'always' | 'withOutput'; brand?: AgentBrand }): AgentMcpFactory => Object.assign((ctx?: McpRequestContext & { brand?: AgentBrand }) => {
  // Lists only change with a deploy: let clients cache them for an hour
  const cached = { ttlMs: HOUR, cacheScope: 'private' as const }
  // 2026-07-28 stamps serverInfo on every answer: the inline icon (kilobytes) rides only on discover; 2025's initialize takes it whole
  const brand = ctx?.brand ?? ownBrand
  // No request (stdio): this server is the connection's only identity, so it takes the whole of it
  const whole = ctx?.era !== 'modern' || !ctx.requestInfo || ctx.requestInfo.headers.get('mcp-method') === 'server/discover'
  const identity = serverInfoOf(info, brand, ctx?.requestInfo ? originOfRequest(ctx.requestInfo) : null, { inline: whole })
  const server = new McpServer(identity, { instructions: instructionsWithSkills(instructions, skills), cacheHints: { 'server/discover': cached, 'tools/list': { ...cached, ttlMs: toolsTtlMs }, 'prompts/list': cached, 'resources/list': cached, 'resources/templates/list': cached } })
  // Clients that cache the list learn from any answer that it changed
  const listed = { [TOOLS_HASH_META]: toolsHashOf(tools, resources) }
  for (const tool of tools) {
    const route = routeOf(tool)
    const cli = cliOf(tool)
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, ...(tool.output ? { outputSchema: tool.output } : {}), annotations: { title: tool.title, ...hintsOf(tool) }, _meta: { ...(route ? { [ROUTE_META]: route } : {}), [CLI_META]: { name: cli.name, positional: cli.positional, examples: cli.examples }, ...listed } },
      async (args: Record<string, unknown>, ctx): Promise<CallToolResult> => {
        const { response, pending, location } = await callWaiting(callApi, tool.call(args as never, callAtOf(ctx.http?.authInfo)), perCallAuth(ctx.http?.authInfo, ctx.mcpReq.id), waitMs)
        const json = await response.json().catch(() => null)
        if (pending) {
          const text = `Still working: run ${pending}. GET ${location} until its status is done (the run is also in _meta["${PENDING_META}"]), then call ${tool.name} again with the same arguments (it answers at once when done).`
          return { content: [{ type: 'text', text }], _meta: { [PENDING_META]: { run: pending, location }, ...listed } }
        }
        if (!response.ok) return { isError: true, content: [{ type: 'text', text: problemText(json, response.status) }], _meta: { [PROBLEM_META]: problemOf(json, response.status), ...listed } }
        return {
          content: [{ type: 'text', text: tool.summarize(json, args as never) }, ...(tool.links?.(json) ?? []).map((link) => ({ type: 'resource_link' as const, ...link }))],
          ...(json && typeof json === 'object' && (structured === 'always' || tool.output) ? { structuredContent: json } : {}),
          _meta: listed,
        }
      },
    )
  }
  for (const prompt of prompts) {
    server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description, ...(prompt.arguments ? { argsSchema: prompt.arguments } : {}) } as never, ((args: Record<string, string> = {}) => ({
      description: prompt.description,
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: prompt.text(args) } }],
    })) as never)
  }
  for (const resource of resources) {
    server.registerResource(
      resource.name,
      new ResourceTemplate(lenientTemplate(resource.uriTemplate), { list: undefined }),
      { title: resource.title, description: resource.description, cacheHint: cached, _meta: { [CLI_META]: resourceMeta(resource) } },
      async (uri, variables, ctx) => {
        const auth = ctx.http?.authInfo
        const values = Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, Array.isArray(value) ? value[0]! : String(value)]))
        const parts = await Promise.all(
          resource.read(values, callAtOf(auth)).map(async ({ optional, ...call }) => {
            const response = await callApi(call, auth)
            if (!response.ok && optional) return null
            if (!response.ok) throw new Error(problemText(await response.json().catch(() => null), response.status))
            const type = response.headers.get('content-type') ?? 'application/octet-stream'
            return /json|text|markdown/.test(type)
              ? { uri: uri.href, mimeType: type.split(';')[0]!, text: await response.text() }
              : { uri: uri.href, mimeType: type.split(';')[0]!, blob: Buffer.from(await response.arrayBuffer()).toString('base64') }
          }),
        )
        return { contents: parts.filter((part) => part !== null) }
      },
    )
  }
  if (skills) attachSkills(server, skills)
  return server
}, { info, tools, resources, instructions: instructionsWithSkills(instructions, skills), prompts, ...(ownBrand ? { brand: ownBrand } : {}) })

/**
 * The tools and resources `mountMcp` serves on an app, as they were given: for the CLI snapshot and `cliGaps`.
 *
 * @example
 * const { tools, resources } = mountedMcp(await createApp({ db: await testDb(), env: {} }))
 * expect(cliGaps({ tools, resources, jobs })).toEqual([])
 */
export const mountedMcp = (app: object) => {
  const mcp = mountedOf(app).mcp
  return { tools: (mcp?.tools ?? []) as unknown as McpTool[], resources: (mcp?.resources ?? []) as unknown as McpResource[] }
}

/** The caller's headers a tool's route gets: who is calling, and the Idempotency-Key, so a retried call runs once. */
export const FORWARDED = ['authorization', 'cf-access-jwt-assertion', 'idempotency-key'] as const

/** Tools run the app's routes in-process with the caller's own credentials: no network hop, same auth decision. */
export const inProcess = (app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }): CallApi => async (call, auth) => {
  const forwarded = (auth?.extra?.headers ?? {}) as Record<string, string>
  return app.request(pathWith(call.path, call.query), {
    method: call.method ?? 'GET',
    headers: { accept: 'application/json', ...(call.body === undefined ? {} : { 'content-type': 'application/json' }), ...forwarded },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  })
}

/** For a local stdio server: the same tools against the remote API with the client's own key. */
export const overHttp = (origin: string, key: string, fetchImpl: typeof fetch = fetch): CallApi => (call) =>
  fetchImpl(origin + pathWith(call.path, call.query), {
    method: call.method ?? 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${key}`, ...(call.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
  })

/**
 * 2026-07-28 has no `initialize` (`server/discover` replaced it), so the SDK answers -32601, which reads to an agent as
 * a broken server. Agents still open with it out of habit: answer with what `server/discover` would, and say so.
 */
const modernInitialize = async (c: Context, factory: AgentMcpFactory, brand: AgentBrand | undefined) => {
  if (c.req.method !== 'POST' || c.req.header('mcp-protocol-version') !== MODERN_PROTOCOL_VERSION) return null
  const message = (await c.req.raw.clone().json().catch(() => null)) as { jsonrpc?: string; id?: string | number; method?: string } | null
  if (message?.method !== 'initialize' || message.id === undefined) return null
  const result = {
    protocolVersion: MODERN_PROTOCOL_VERSION,
    // As the server itself declares them: an app may announce changes on a listen stream (`handler.notify`)
    capabilities: { tools: { listChanged: true }, ...(factory.prompts?.length ? { prompts: { listChanged: true } } : {}), ...(factory.resources.length ? { resources: { listChanged: true } } : {}) },
    serverInfo: serverInfoOf(factory.info, brand, originOf(c)),
    instructions: `${factory.instructions ?? ''}\n\nThis server speaks MCP ${MODERN_PROTOCOL_VERSION}, which is stateless: no initialize or session is needed. Call tools/list or any method directly with the MCP-Protocol-Version and Mcp-Method headers (server/discover returns this same information).`.trim(),
  }
  return c.json({ jsonrpc: '2.0', id: message.id, result })
}

const SERVER_CARD_SUFFIX = '/server-card'

/**
 * Serves MCP at `path` (POST; GET and DELETE answer 405 as the spec asks). Authentication has already run (the app's
 * `authenticate` guards this path like any other); the caller's credentials ride along in `authInfo` so tools reuse
 * them. Browsers' Origin is checked against `allowedHostnames`. A path with parameters (`/s/:space/mcp`) serves one
 * MCP per value: each tool's call gets them as `at.params`, and the guide, catalogs and the well-known card keep
 * describing the mount without parameters.
 *
 * @example
 * mountMcp(app, { factory: mcpServerFactory({ info, instructions, tools, callApi: inProcess(app) }), allowedHostnames })
 * mountMcp(app, { path: '/s/:space/mcp', factory: mcpServerFactory({ info, instructions, tools: shelfTools, callApi: inProcess(app) }), allowedHostnames })
 */
export const mountMcp = (app: Hono<any, any, any>, { path = '/mcp', factory, allowedHostnames }: { path?: string; factory: AgentMcpFactory; allowedHostnames: string[] }) => {
  // The app's brand (`createAgentApi({ brand })`) unless the factory was given its own
  const brandOf = () => factory.brand ?? mountedOf(app).brand
  const handler = createMcpHandler((ctx) => factory({ ...ctx, brand: brandOf() } as McpRequestContext), { responseMode: 'auto' })
  // The Server Card (SEP-2127): at its reserved place beside the endpoint, and where domain scanners look
  const card = (origin: string, endpoint = path) => serverCard(origin, endpoint, serverInfoOf(factory.info, brandOf(), origin), [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS])
  const sendCard = (c: Context, endpoint?: string) => sendPublic(c, JSON.stringify(card(publicOriginOf(app, c), endpoint), null, 2), SERVER_CARD_TYPE)
  const hasParameters = path.includes('/:')
  if (hasParameters) {
    // One MCP per value: its card names the endpoint as asked (`/s/soups/mcp`), still encoded
    app.get(path + SERVER_CARD_SUFFIX, (c: Context) => sendCard(c, new URL(c.req.url).pathname.slice(0, -SERVER_CARD_SUFFIX.length)))
  } else {
    recordMounted(app, { mcp: { path, card, tools: factory.tools, resources: factory.resources } })
    for (const at of [path + SERVER_CARD_SUFFIX, WELL_KNOWN.serverCard]) app.get(at, (c: Context) => sendCard(c))
  }
  app.all(path, async (c: Context) => {
    // A tool's route keeps its own answer under the same Idempotency-Key; this one, holding it, is never kept
    neverKeep(c)
    const rejected = originValidationResponse(c.req.raw, allowedHostnames)
    if (rejected) return rejected
    const greeting = await modernInitialize(c, factory, brandOf())
    if (greeting) return greeting
    const caller = c.get('caller' as never) as { kind: string; name?: string; email?: string; client?: string; grant?: string } | undefined
    const authInfo: AuthInfo = {
      token: (c.req.header('authorization') ?? '').replace(/^bearer\s+/i, ''),
      // An OAuth agent by its client_id: the name is the one it gave itself, for display
      clientId: caller?.client ?? caller?.name ?? caller?.email ?? 'anonymous',
      scopes: [],
      // A static key never expires; the SDK treats a missing expiry as expired
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      // Tools call the routes in-process: pass the caller's credentials, and the public origin so links stay absolute
      extra: {
        ...(caller?.grant ? { grant: caller.grant } : {}),
        ...(caller?.name ? { name: caller.name } : {}),
        // The mount path's parameters, read from the route: nothing a client sends can set them
        params: c.req.param() as Record<string, string>,
        headers: {
          ...Object.fromEntries(FORWARDED.flatMap((name) => (c.req.header(name) ? [[name, c.req.header(name)!]] : []))),
          'x-forwarded-proto': new URL(originOf(c)).protocol.replace(':', ''),
          'x-forwarded-host': new URL(originOf(c)).host,
        },
      },
    }
    return handler.fetch(c.req.raw, { authInfo })
  })
  return handler
}

export { guideSkillProblems, guideSkills } from './skills.js'
export { CLI_META, cliOf, PENDING_META, PROBLEM_META, routeOf, TOOLS_HASH_META, type CallAt, type CliExample, type CliSpec } from '../core/cli.js'
