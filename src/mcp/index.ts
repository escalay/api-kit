/**
 * An MCP server (spec 2026-07-28, stateless Streamable HTTP; 2025-era clients served by the SDK's fallback) whose tools
 * are thin calls to the app's own HTTP routes, so the API and MCP can never disagree: same validation, same auth,
 * same problem details. A tool answers with a short text an agent reads first, the route's JSON as
 * `structuredContent` (matching `outputSchema` when given), and `resource_link`s for images. The skills folder is
 * served through the Skills extension (SEP-2640) and each playbook also as a prompt.
 *
 * @example
 * const tools = [mcpTool({ name: 'search_recipes', title: 'Search recipes', description: '…', input: z.object({ q: z.string() }),
 *   call: ({ q }) => ({ path: '/api/v1/search/recipes', query: { q } }), summarize: (page) => … })]
 * mountMcp(app, { factory: mcpServerFactory({ info, instructions, tools, callApi: inProcess(app) }), allowedHostnames: ['cookbook.example.com'] })
 * // a stdio client on a laptop: the same tools over HTTP with its own key
 * serveStdio(mcpServerFactory({ info, instructions, tools, callApi: overHttp(origin, process.env.COOKBOOK_API_KEY!) }))
 */
import { createMcpHandler, McpServer, originValidationResponse, ResourceTemplate, SUPPORTED_PROTOCOL_VERSIONS, UriTemplate, type AuthInfo, type CallToolResult, type McpServerFactory } from '@modelcontextprotocol/server'
import type { SkillCatalog } from '@modelcontextprotocol/server/ext/skills'
import type { z } from '@hono/zod-openapi'
import type { Context, Hono } from 'hono'
import { CLI_META, cliOf, hintsOf, PENDING_META, PROBLEM_META, resourceCli, routeOf, templateVariables, type CliSpec } from '../core/cli.js'
import { MODERN_PROTOCOL_VERSION, mountedOf, recordMounted, sendPublic, serverCard, SERVER_CARD_TYPE, WELL_KNOWN } from '../core/discovery.js'
import { originOf, pathWith } from '../core/hal.js'

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
  /** The route's 200 schema, when its shape is fixed: the JSON (always sent as `structuredContent`) must match it. */
  output?: z.ZodTypeAny
  annotations?: ToolAnnotations
  call: (args: z.infer<Input>) => ApiCall
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
  read: (variables: Record<string, string>) => (ApiCall & { optional?: boolean })[]
  /** Its command, noun then verb (`'mail headers'`); the template's path variables are its positional arguments. */
  cli?: CliSpec
}

/** Keeps a resource's shape checked when building the list. */
export const mcpResource = (resource: McpResource) => resource

export type McpPrompt = { name: string; title: string; description: string; arguments?: z.ZodObject; text: (args: Record<string, string>) => string }

export type McpServerInfo = { name: string; version: string; title?: string; description?: string; websiteUrl?: string; icons?: { src: string; mimeType?: string; sizes?: string[] }[] }

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

/**
 * A slow route answers 202 with a run in `Location`: the tool polls it (up to `waitMs`), then asks again for the
 * cached result, so a client sees one answer. Past the wait it says which run to check.
 */
export const callWaiting = async (callApi: CallApi, call: ApiCall, auth: AuthInfo | undefined, waitMs: number) => {
  let response = await callApi(call, auth)
  const location = response.headers.get('location')
  if (response.status !== 202 || !location) return { response, pending: null }
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const run = (await (await callApi({ path: location }, auth)).json().catch(() => null)) as { status?: string } | null
    if (run?.status === 'done') return { response: await callApi(call, auth), pending: null }
    if (run?.status === 'failed') return { response: await callApi({ path: location }, auth), pending: null }
  }
  response = await callApi({ path: location }, auth)
  return { response, pending: location.split('/').pop()! }
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

/** A factory that also carries its server info and tools, so `mountMcp` can publish the card and the guide can list the tools. */
export type AgentMcpFactory = McpServerFactory & { info: McpServerInfo; tools: McpTool[]; resources: McpResource[]; instructions?: string; prompts?: McpPrompt[] }

/** `toolsTtlMs`: how long clients may cache `tools/list` (default an hour); shorter when the tools change without a deploy. */
export const mcpServerFactory = ({ info, instructions, tools, resources = [], prompts = [], skills, callApi, waitMs = 60_000, toolsTtlMs = HOUR }: { info: McpServerInfo; instructions: string; tools: McpTool[]; resources?: McpResource[]; prompts?: McpPrompt[]; skills?: SkillCatalog; callApi: CallApi; waitMs?: number; toolsTtlMs?: number }): AgentMcpFactory => Object.assign(() => {
  // Lists only change with a deploy: let clients cache them for an hour
  const cached = { ttlMs: HOUR, cacheScope: 'private' as const }
  const server = new McpServer(info, { instructions, cacheHints: { 'server/discover': cached, 'tools/list': { ...cached, ttlMs: toolsTtlMs }, 'prompts/list': cached, 'resources/list': cached, 'resources/templates/list': cached } })
  for (const tool of tools) {
    const route = routeOf(tool)
    const cli = cliOf(tool)
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.input, ...(tool.output ? { outputSchema: tool.output } : {}), annotations: { title: tool.title, ...hintsOf(tool) }, _meta: { ...(route ? { [ROUTE_META]: route } : {}), [CLI_META]: { name: cli.name, positional: cli.positional, examples: cli.examples } } },
      async (args: Record<string, unknown>, ctx): Promise<CallToolResult> => {
        const { response, pending } = await callWaiting(callApi, tool.call(args as never), ctx.http?.authInfo, waitMs)
        const json = await response.json().catch(() => null)
        if (pending) return { content: [{ type: 'text', text: `Still working: run ${pending}. Check it with get_run, then call ${tool.name} again with the same arguments (it answers at once when done).` }], _meta: { [PENDING_META]: { run: pending } } }
        if (!response.ok) return { isError: true, content: [{ type: 'text', text: problemText(json, response.status) }], _meta: { [PROBLEM_META]: problemOf(json, response.status) } }
        return {
          content: [{ type: 'text', text: tool.summarize(json, args as never) }, ...(tool.links?.(json) ?? []).map((link) => ({ type: 'resource_link' as const, ...link }))],
          ...(json && typeof json === 'object' ? { structuredContent: json } : {}),
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
          resource.read(values).map(async ({ optional, ...call }) => {
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
  skills?.attach(server)
  return server
}, { info, tools, resources, instructions, prompts })

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

export const FORWARDED = ['authorization', 'cf-access-jwt-assertion'] as const

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
const modernInitialize = async (c: Context, factory: AgentMcpFactory) => {
  if (c.req.method !== 'POST' || c.req.header('mcp-protocol-version') !== MODERN_PROTOCOL_VERSION) return null
  const message = (await c.req.raw.clone().json().catch(() => null)) as { jsonrpc?: string; id?: string | number; method?: string } | null
  if (message?.method !== 'initialize' || message.id === undefined) return null
  const result = {
    protocolVersion: MODERN_PROTOCOL_VERSION,
    // As the server itself declares them: an app may announce changes on a listen stream (`handler.notify`)
    capabilities: { tools: { listChanged: true }, ...(factory.prompts?.length ? { prompts: { listChanged: true } } : {}), ...(factory.resources.length ? { resources: { listChanged: true } } : {}) },
    serverInfo: factory.info,
    instructions: `${factory.instructions ?? ''}\n\nThis server speaks MCP ${MODERN_PROTOCOL_VERSION}, which is stateless: no initialize or session is needed. Call tools/list or any method directly with the MCP-Protocol-Version and Mcp-Method headers (server/discover returns this same information).`.trim(),
  }
  return c.json({ jsonrpc: '2.0', id: message.id, result })
}

/**
 * Serves MCP at `path` (POST; GET and DELETE answer 405 as the spec asks). Authentication has already run (the app's
 * `authenticate` guards this path like any other); the caller's credentials ride along in `authInfo` so tools reuse
 * them. Browsers' Origin is checked against `allowedHostnames`.
 */
export const mountMcp = (app: Hono<any, any, any>, { path = '/mcp', factory, allowedHostnames }: { path?: string; factory: AgentMcpFactory; allowedHostnames: string[] }) => {
  const handler = createMcpHandler(factory, { responseMode: 'auto' })
  // The Server Card (SEP-2127): at its reserved place beside the endpoint, and where domain scanners look
  const card = (origin: string) => serverCard(origin, path, factory.info, [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS])
  recordMounted(app, { mcp: { path, card, tools: factory.tools, resources: factory.resources } })
  for (const at of [`${path}/server-card`, WELL_KNOWN.serverCard]) app.get(at, (c: Context) => sendPublic(c, JSON.stringify(card(originOf(c)), null, 2), SERVER_CARD_TYPE))
  app.all(path, async (c: Context) => {
    const rejected = originValidationResponse(c.req.raw, allowedHostnames)
    if (rejected) return rejected
    const greeting = await modernInitialize(c, factory)
    if (greeting) return greeting
    const caller = c.get('caller' as never) as { kind: string; name?: string; email?: string } | undefined
    const authInfo: AuthInfo = {
      token: (c.req.header('authorization') ?? '').replace(/^bearer\s+/i, ''),
      clientId: caller?.name ?? caller?.email ?? 'anonymous',
      scopes: [],
      // A static key never expires; the SDK treats a missing expiry as expired
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      // Tools call the routes in-process: pass the caller's credentials, and the public origin so links stay absolute
      extra: {
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

export { guideSkills } from './skills.js'
export { CLI_META, cliOf, PENDING_META, PROBLEM_META, routeOf, type CliExample, type CliSpec } from '../core/cli.js'
