/**
 * Checks that keep an API agent-ready as it grows, run in each app's tests:
 *   lintOpenApi     every operation is findable and self-explaining: a unique camelCase `operationId`, a summary and a
 *                   description, declared tags, described parameters, a typed 2xx body, errors as problem+json, and
 *                   every named schema described
 *   guideRoutes     every `GET /api/…` the agent guide mentions is a real operation, so the docs fail the build before
 *                   they go stale
 *   guideGaps       placeholders a guide uses that neither the app nor the kit's generated parts fill
 *   toolRoutes      MCP tools whose call doesn't land on a documented operation
 *   toolsRun        MCP tools that fail when run: each called in-process with sample arguments, as an agent would
 *
 * @example
 * const doc = await (await app.request('/openapi.json')).json()
 * expect(lintOpenApi(doc)).toEqual([])
 * expect(guideRoutes(guideFiles(AGENTS_DIR), doc)).toEqual([])
 */
import { fillTemplate } from '../guide/guide.js'
import type { ResourceLike, ToolLike } from '../core/discovery.js'
import { pathWith } from '../core/hal.js'
import { PROBLEM_JSON } from '../core/problem.js'
import { generatedVars, toolRoute, type OpenApiDoc } from '../guide/reference.js'

type Operation = {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: { name: string; in: string; description?: string; $ref?: string }[]
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>
  requestBody?: unknown
  security?: unknown[]
}
type Document = { tags?: { name: string }[]; paths?: Record<string, Record<string, Operation>>; components?: { schemas?: Record<string, { description?: string }> } }

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const

export const lintOpenApi = (doc: Document) => {
  const issues: string[] = []
  const declared = new Set((doc.tags ?? []).map((tag) => tag.name))
  const ids = new Map<string, string>()
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of METHODS) {
      const operation = item[method]
      if (!operation) continue
      const at = `${method.toUpperCase()} ${path}`
      if (!operation.operationId) issues.push(`${at}: no operationId`)
      else if (!/^[a-z][a-zA-Z0-9]*$/.test(operation.operationId)) issues.push(`${at}: operationId "${operation.operationId}" is not camelCase`)
      else if (ids.has(operation.operationId)) issues.push(`${at}: operationId "${operation.operationId}" also used by ${ids.get(operation.operationId)}`)
      else ids.set(operation.operationId, at)
      if (!operation.summary) issues.push(`${at}: no summary`)
      else if (operation.summary.length > 80) issues.push(`${at}: summary over 80 characters`)
      if (!operation.description || operation.description.length < 20) issues.push(`${at}: no description an agent can choose by`)
      if (!operation.tags?.length) issues.push(`${at}: no tag`)
      for (const tag of operation.tags ?? []) if (!declared.has(tag)) issues.push(`${at}: tag "${tag}" is not declared`)
      for (const parameter of operation.parameters ?? []) if (!parameter.$ref && !parameter.description) issues.push(`${at}: parameter ${parameter.in}.${parameter.name} has no description`)
      const statuses = Object.keys(operation.responses ?? {})
      const success = statuses.filter((status) => /^2\d\d$/.test(status))
      if (!success.length) issues.push(`${at}: no 2xx response`)
      for (const status of success) if (status !== '204' && status !== '202' && !operation.responses![status]!.content) issues.push(`${at}: ${status} has no body schema`)
      for (const status of statuses.filter((status) => /^[45]\d\d$/.test(status))) if (!operation.responses![status]!.content?.[PROBLEM_JSON]) issues.push(`${at}: ${status} is not problem+json`)
      // Anything that takes input or needs a key can fail on the caller's side, and says how
      const canFail = (operation.parameters?.length ?? 0) > 0 || operation.requestBody !== undefined || !(Array.isArray(operation.security) && operation.security.length === 0)
      if (canFail && !statuses.some((status) => status.startsWith('4'))) issues.push(`${at}: documents no 4xx error`)
    }
  }
  for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) if (!schema.description) issues.push(`schema ${name}: no description`)
  return issues
}

/** `GET /api/v1/cooks/{id}/recipes?…` and `POST /api/v1/compare` in the guide → those not in the OpenAPI paths. */
export const guideRoutes = (files: Map<string, string>, doc: Document, prefix = '/api/') => {
  const operations = Object.entries(doc.paths ?? {}).flatMap(([path, item]) => METHODS.filter((method) => item[method]).map((method) => ({ method: method.toUpperCase(), pattern: new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`) })))
  const missing = new Set<string>()
  for (const [file, text] of files) {
    for (const match of text.matchAll(new RegExp(`\\b(GET|POST|PUT|PATCH|DELETE) (${prefix.replace(/\//g, '\\/')}[^\\s\`?)|]*)`, 'g'))) {
      const [, method, raw] = match
      const path = raw!.replace(/[.,;:]+$/, '').replace(/\{[^}]+\}/g, 'x').replace(/<[^>]+>/g, 'x')
      if (!operations.some((operation) => operation.method === method && operation.pattern.test(path))) missing.add(`${file}: ${method} ${raw}`)
    }
  }
  return [...missing]
}

/**
 * Placeholders a guide uses that nothing fills: not `vars`, and not the kit's generated parts when `doc` (and `tools`)
 * are given, so a typo like `{{api.endpoint}}` is caught too.
 */
export const guideGaps = (files: Map<string, string>, vars: Record<string, unknown>, { doc, tools, resources }: { doc?: OpenApiDoc; tools?: ToolLike[]; resources?: ResourceLike[] } = {}) => {
  const generated = doc ? generatedVars({ origin: 'https://example.test', doc, tools, resources, files }) : {}
  const skipped = doc ? [] : ['api.', 'mcp.', 'skills.']
  return [...files].flatMap(([file, text]) =>
    fillTemplate(text, { origin: 'https://example.test', ...generated, ...vars })
      .missing.filter((name) => !skipped.some((root) => name.startsWith(root)))
      .map((name) => `${file}: {{${name}}}`),
  )
}

/** Tools whose `call` reaches no operation in the OpenAPI document (a renamed route, a typo in a path). */
export const toolRoutes = (tools: ToolLike[], doc: OpenApiDoc) => tools.filter((tool) => !toolRoute(tool, doc)).map((tool) => tool.name)

type RunnableTool = {
  name: string
  input: { parse: (args: unknown) => unknown }
  call: (args: never) => { method?: string; path: string; query?: Record<string, unknown>; body?: unknown }
  summarize: (body: never, args: never) => string
}
type RequestableApp = { request: (path: string, init?: RequestInit) => Response | Promise<Response> }

/**
 * Runs every tool against the app, in order, the way an agent would: its sample arguments through its input schema, its
 * call to the route, its summary of the answer. Returns what failed, `[]` when every tool works: a tool with no
 * sample arguments, arguments its schema rejects, a call that doesn't answer 2xx, or a summary that is empty or shows
 * `undefined` / `[object Object]`. `toolRoutes` only checks that a call names a route; this catches a call that names
 * the right route and still fails (a mangled id, a wrong query parameter).
 *
 * @example
 * const board = await (await app.request('/api/boards', { method: 'POST', headers, body: '{"name":"Test"}' })).json()
 * expect(await toolsRun(TOOLS, app, { search_notes: { q: 'soup' }, get_board: { id: board.id } }, { headers })).toEqual([])
 */
export const toolsRun = async (tools: RunnableTool[], app: RequestableApp, args: Record<string, Record<string, unknown>>, { headers = {} }: { headers?: Record<string, string> } = {}) => {
  const failures: string[] = []
  for (const tool of tools) {
    if (!args[tool.name]) {
      failures.push(`${tool.name}: no sample arguments`)
      continue
    }
    const parsed = (() => {
      try {
        return { ok: true as const, value: tool.input.parse(args[tool.name]) }
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    })()
    if (!parsed.ok) {
      failures.push(`${tool.name}: its input rejects the sample arguments: ${parsed.error.slice(0, 200)}`)
      continue
    }
    const { method = 'GET', path, query, body } = tool.call(parsed.value as never)
    const response = await app.request(pathWith(path, query as Parameters<typeof pathWith>[1]), { method, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) {
      failures.push(`${tool.name}: ${method} ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`)
      continue
    }
    const json = response.status === 204 ? {} : await response.json().catch(() => null)
    const summary = (() => {
      try {
        return { ok: true as const, text: tool.summarize(json as never, parsed.value as never) }
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : String(error) }
      }
    })()
    if (!summary.ok) {
      failures.push(`${tool.name}: its summary threw on the ${response.status} answer${response.status === 202 ? ' (still working: give the route a finished run, or summarize a 202)' : ''}: ${summary.error.slice(0, 200)}`)
      continue
    }
    const text = summary.text
    if (!text.trim()) failures.push(`${tool.name}: an empty summary`)
    else if (/\bundefined\b|\[object Object\]/.test(text)) failures.push(`${tool.name}: its summary shows ${/\[object Object\]/.test(text) ? '[object Object]' : 'undefined'}: ${text.slice(0, 200)}`)
  }
  for (const name of Object.keys(args)) if (!tools.some((tool) => tool.name === name)) failures.push(`${name}: sample arguments for a tool that doesn't exist`)
  return failures
}

export { softAuthenticator } from './authenticator.js'
