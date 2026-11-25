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
 *   cliGaps         commands the app's CLI can't offer well: unnamed, duplicated, shadowing, plural, undescribed, no example
 *   cliSnapshot     every command as the CLI package carries it (`commands.json`)
 *   approveSignIn   an OAuth approval as a browser makes it (ticket cookie, same-origin), on the kit's consent page or
 *                   an app's own form
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
import { brandVars, generatedVars, toolRoute, type CliCommandLike, type OpenApiDoc } from '../guide/reference.js'

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
 * are given, so a typo like `{{api.endpoint}}` is caught too. `brand`: the app's (`defineBrand`), for `{{brand.*}}`.
 */
export const guideGaps = (files: Map<string, string>, vars: Record<string, unknown>, { doc, tools, resources, commands, brand }: { doc?: OpenApiDoc; tools?: ToolLike[]; resources?: ResourceLike[]; commands?: CliCommandLike[]; brand?: { name: string; title: string; description: string } } = {}) => {
  const generated = doc ? generatedVars({ origin: 'https://example.test', doc, tools, resources, commands, files }) : {}
  const skipped = doc ? [] : ['api.', 'mcp.', 'skills.', 'cli.']
  return [...files].flatMap(([file, text]) =>
    fillTemplate(text, { origin: 'https://example.test', ...generated, ...(brand ? { brand: brandVars(brand) } : {}), ...vars })
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

/** A form an app's sign-in page holds: `fields` are what the person types, posted with the form's hidden inputs. */
type AppForm = { action: string; fields?: Record<string, string> }
type PageForm = { method: string; action: string; hidden: Record<string, string> }

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
/** The character a numeric reference names; U+FFFD, as in a browser, for zero, a surrogate or one past U+10FFFF. */
const characterOf = (reference: string) => {
  const codePoint = /^#x/i.test(reference) ? Number.parseInt(reference.slice(2), 16) : Number(reference.slice(1))
  const named = codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
  return named ? String.fromCodePoint(codePoint) : '�'
}
/** An attribute value as a browser reads it: named and numeric character references decoded. */
const decoded = (text: string) =>
  text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) =>
    entity.startsWith('#') ? characterOf(entity) : ENTITIES[entity.toLowerCase()]!,
  )
/** A tag's attributes, names lower-cased, quoted or bare values decoded. */
const attributesOf = (tag: string): Record<string, string> =>
  Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)].map(([, name, ...values]) => [name!.toLowerCase(), decoded(values.find((value) => value !== undefined) ?? '')]))
/** Every form on a page: its method (lower-cased, `get` when none), its action as written, its hidden inputs. */
const formsOf = (html: string): PageForm[] =>
  [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(([, tag = '', body = '']) => {
    const { method = 'get', action = '' } = attributesOf(tag)
    const inputs = [...body.matchAll(/<input\b([^>]*)>/gi)].map(([, input = '']) => attributesOf(input))
    const hidden = inputs.filter((input) => input.type?.toLowerCase() === 'hidden' && input.name)
    return { method: method.toLowerCase(), action, hidden: Object.fromEntries(hidden.map((input) => [input.name!, input.value ?? ''])) }
  })

/** The one form on an app's page that posts to `form.action`, and what it sends; throws, naming the page's forms, on none or several. */
const appFormIn = (html: string, form: AppForm) => {
  const forms = formsOf(html)
  const matching = forms.filter((one) => one.method === 'post' && one.action === form.action)
  const seen = forms.map((one) => `${one.method} ${one.action}`).join(', ') || 'none'
  if (!matching.length) throw new Error(`approveSignIn: no form posts to ${form.action} (the page’s forms: ${seen})`)
  if (matching.length > 1) throw new Error(`approveSignIn: ${matching.length} forms post to ${form.action}, so which one is ambiguous (the page’s forms: ${seen})`)
  return { action: form.action, fields: { ...matching[0]!.hidden, ...form.fields } }
}

/** The kit's consent form and the owner's answer; throws when the page is not one. */
const consentFormIn = (status: number, html: string, decision: 'allow' | 'deny') => {
  const ticket = /name="ticket" value="([^"]+)"/.exec(html)?.[1]
  if (!ticket) throw new Error(`approveSignIn: /oauth/authorize answered ${status} with no consent form: ${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`)
  return { action: '/oauth/authorize', fields: { ticket, decision } }
}

/**
 * Approves a sign-in the way a browser does: opens `/oauth/authorize`, keeps the ticket cookie it sets, and posts a
 * form on that page same-origin with it. Without `form`, the kit's own consent page and the owner's `decision`. With
 * `form`, an app's own page (`approve`): the one `<form method="post">` whose `action` is `form.action` (a path on the
 * app), its hidden inputs and `fields`; it throws, naming the page's forms, when none or more than one matches.
 * Returns the answer, a 302 to the client's redirect with `code` (or `error=access_denied`), or the app's own answer.
 * `headers` go on both requests: whatever signs the owner in, a forwarded host. A hand-made approval POST without the
 * cookie and a same-origin header is refused.
 *
 * @example
 * const answer = await approveSignIn(app, { response_type: 'code', client_id, redirect_uri, code_challenge, code_challenge_method: 'S256' }, { headers: { 'x-test-owner': 'owner@example.test' } })
 * const code = new URL(answer.headers.get('location')!).searchParams.get('code')
 * // An app's own page: the invite code typed into its join form
 * const joined = await approveSignIn(app, query, { form: { action: '/sharing/join', fields: { code: 'BDKM-QXTW' } } })
 */
export const approveSignIn = async (
  app: RequestableApp,
  query: URLSearchParams | Record<string, string> | string,
  { headers = {}, decision = 'allow', form }: { headers?: Record<string, string>; decision?: 'allow' | 'deny'; form?: AppForm } = {},
) => {
  // Same-origin, as the browser's POST is: never a URL, nor `//host`, which names another origin
  if (form && !/^\/(?!\/)/.test(form.action)) throw new Error(`approveSignIn: form.action must be a path on the app (/join), not ${form.action}`)
  const page = await app.request(`/oauth/authorize?${new URLSearchParams(query)}`, { headers })
  const html = await page.text()
  const { action, fields } = form ? appFormIn(html, form) : consentFormIn(page.status, html, decision)
  const cookies = page.headers.getSetCookie().map((line) => line.split(';')[0]!)
  const cookie = [headers.cookie, ...cookies].filter(Boolean).join('; ')
  return app.request(action, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(fields).toString(),
  })
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const asForm = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() })
const asJson = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** What `connectAgent` returns: the approval's answer, its page's text when it was no redirect with a code, and the tokens. */
export type AgentConnection = {
  page: Response
  html: string
  tokens: { access_token: string; token_type: string; scope: string; expires_in?: number; refresh_token?: string } | null
}

/**
 * Connects a third-party agent to `address` (the app's `/mcp`, or a space's) the way an MCP client does: a call with no
 * token, the 401's `resource_metadata`, that document's `resource`, a registration at `/oauth/register` (RFC 7591, a
 * public client), `/oauth/authorize` with PKCE (S256) for that resource, then the code exchanged at `/oauth/token`.
 * `approve` stands for the person in the browser: it gets the authorize query and returns the answer to their click,
 * usually `approveSignIn` (the kit's page or the app's own `form`). `tokens` is null when that answer is no redirect
 * with a code (a refusal, a page asking again: `page` and `html` say which); a failed step throws, naming it. Web
 * Crypto only, so it runs in workerd too.
 *
 * @example
 * // A friend's agent joins a shelf with the invite's code, typed on the sharing part's page
 * const { tokens } = await connectAgent(app, { address: 'https://shelves.example/s/soups/mcp', approve: (query) => approveSignIn(app, query, { form: { action: '/sharing/join', fields: { code } } }) })
 * await app.request('/s/soups/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens!.access_token}` }, body })
 */
export const connectAgent = async (
  app: RequestableApp,
  { address, approve, redirect = 'http://127.0.0.1:33418/callback', scope = 'read write', name = 'Sample Agent' }: { address: string; approve: (query: URLSearchParams) => Promise<Response>; redirect?: string; scope?: string; name?: string },
): Promise<AgentConnection> => {
  const refused = await app.request(new URL(address).pathname, asJson({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(refused.headers.get('www-authenticate') ?? '')?.[1]
  if (refused.status !== 401 || !metadataUrl) throw new Error(`connectAgent: ${address} answered ${refused.status} without a resource_metadata challenge`)
  const { resource } = (await (await app.request(new URL(metadataUrl).pathname)).json()) as { resource: string }
  const registered = await app.request('/oauth/register', asJson({ client_name: name, redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' }))
  if (registered.status !== 201) throw new Error(`connectAgent: /oauth/register answered ${registered.status}: ${await registered.text()}`)
  const { client_id } = (await registered.json()) as { client_id: string }
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
  const query = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: redirect, scope, resource, code_challenge: challenge, code_challenge_method: 'S256' })
  const page = await approve(query)
  const location = page.headers.get('location')
  const code = page.status === 302 && location ? new URL(location).searchParams.get('code') : null
  if (!code) return { page, html: await page.text(), tokens: null }
  const answer = await app.request('/oauth/token', asForm({ grant_type: 'authorization_code', code, client_id, code_verifier: verifier, redirect_uri: redirect }))
  if (answer.status !== 200) throw new Error(`connectAgent: /oauth/token answered ${answer.status}: ${await answer.text()}`)
  return { page, html: '', tokens: (await answer.json()) as NonNullable<AgentConnection['tokens']> }
}

export { softAuthenticator } from './authenticator.js'
export { cliGaps, cliSnapshot, flagsOf, type CliFlag, type CliJobLike, type CliSnapshot, type CliSnapshotCommand } from './cli.js'
