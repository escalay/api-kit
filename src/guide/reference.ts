/**
 * The parts of the agent guide that must never drift from the code, written from the code: every operation from the
 * OpenAPI document, every MCP tool with the route it calls, every playbook in the skill folder, and how to get
 * unstuck. Guide templates place them with `{{api.endpoints}}`, `{{api.tag.<slug>}}`, `{{api.unblock}}`,
 * `{{api.operations}}`, `{{mcp.tools}}`, `{{mcp.count}}`, `{{mcp.resources}}` and `{{skills.<name>.playbooks}}`; `serveGuide` fills them.
 *
 * @example
 * endpointsMarkdown(doc)             // ### Search … - `GET /api/v1/search/recipes?q=…` — Recipes for a description. …
 * toolRoute(tool, doc)               // { method: 'GET', path: '/api/v1/search/recipes', operationId: 'searchRecipes' }
 */
import { cliOf, resourceCli, toolCli } from '../core/cli.js'
import type { ResourceLike, ToolLike } from '../core/discovery.js'

type Schema = { type?: string | string[]; enum?: unknown[]; default?: unknown; example?: unknown; description?: string; items?: Schema; minimum?: number; maximum?: number; anyOf?: Schema[]; $ref?: string; properties?: Record<string, Schema>; additionalProperties?: unknown }
type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: Schema }
type Operation = { operationId?: string; summary?: string; description?: string; tags?: string[]; parameters?: Parameter[]; requestBody?: { content?: Record<string, { schema?: unknown }> }; responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>; security?: unknown[] }
export type OpenApiDoc = { tags?: { name: string; description?: string }[]; paths?: Record<string, Record<string, Operation>>; components?: { schemas?: Record<string, Schema & { properties?: Record<string, Schema>; required?: string[] }> } }

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const
const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** The first sentence: what an index line needs, the rest is one call away. */
export const firstSentence = (text = '') => (text.replace(/\s+/g, ' ').trim().match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text.trim())

const typeOf = (schema: Schema = {}): string => {
  if (schema.enum) return schema.enum.map(String).join('|')
  // `one | one[]` is a repeatable parameter: say it once
  const single = schema.anyOf?.find((one) => one.type !== 'array')
  const many = schema.anyOf?.find((one) => one.type === 'array')
  if (single && many && schema.anyOf!.length === 2 && typeOf(single) === typeOf(many.items)) return `${typeOf(single)} (repeatable)`
  if (schema.anyOf) return [...new Set(schema.anyOf.map(typeOf))].join('|')
  if (schema.type === 'array') return `${typeOf(schema.items)}[]`
  return Array.isArray(schema.type) ? schema.type.join('|') : (schema.type ?? 'any')
}

/** `q*` (required), `by=meaning|look (meaning)`: a parameter as an agent scans it. */
const paramLine = (parameter: Parameter) => {
  const schema = parameter.schema ?? {}
  const shape = schema.enum || schema.anyOf?.some((one) => one.enum) ? `=${typeOf(schema)}` : ''
  const fallback = schema.default !== undefined ? ` (default ${JSON.stringify(schema.default)})` : ''
  return `\`${parameter.name}${parameter.required ? '*' : ''}${shape}\`${fallback}`
}

/** A call with the documented examples filled in, so the line itself is a working request. */
const exampleCall = (method: string, path: string, operation: Operation) => {
  const params = operation.parameters ?? []
  const filled = path.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const example = params.find((parameter) => parameter.in === 'path' && parameter.name === name)?.example ?? params.find((parameter) => parameter.name === name)?.schema?.example
    return example === undefined ? whole : String(example)
  })
  const query = params
    .filter((parameter) => parameter.in === 'query' && (parameter.required || parameter.example !== undefined) && parameter.name !== 'cursor')
    .slice(0, 3)
    .flatMap((parameter) => {
      const example = parameter.example ?? parameter.schema?.example
      return example === undefined ? [] : [`${parameter.name}=${Array.isArray(example) ? example[0] : example}`]
    })
  return `${method.toUpperCase()} ${filled}${query.length ? `?${query.join('&')}` : ''}`
}

const operationsOf = (doc: OpenApiDoc) =>
  Object.entries(doc.paths ?? {}).flatMap(([path, item]) => METHODS.flatMap((method) => (item[method] ? [{ method, path, operation: item[method]! }] : [])))

/** `{ "$ref": "#/components/schemas/Page" }` → the named schema and its name. */
const resolve = (doc: OpenApiDoc, schema: Schema | undefined): { name?: string; schema?: Schema } => {
  const name = schema?.$ref?.split('/').pop()
  return name ? { name, schema: doc.components?.schemas?.[name] } : { schema }
}

/** `Page { count, _links, _embedded.apps[] }`: the success body's top-level fields, where lists sit, by name. */
export const returnsOf = (doc: OpenApiDoc, operation: Operation) => {
  const success = Object.entries(operation.responses ?? {}).find(([status]) => /^20[01]$/.test(status))?.[1]
  const content = success?.content ? Object.values(success.content)[0] : undefined
  const { name, schema } = resolve(doc, content?.schema)
  if (!schema?.properties) return name ? `\`${name}\`` : ''
  const fields = Object.entries(schema.properties).flatMap(([key, value]) => {
    if (key !== '_embedded') return [key]
    const embedded = resolve(doc, value).schema?.properties ?? {}
    return Object.keys(embedded).map((inner) => `_embedded.${inner}[]`)
  })
  const accepted = operation.responses?.['202'] ? ' (or `202` with a run)' : ''
  return `${name ? `\`${name}\` ` : ''}{ ${fields.join(', ')} }${accepted}`
}

/** One line per operation: the call (with real example values), what it is for, its parameters (`*` = required), what it returns. */
export const operationLine = ({ method, path, operation }: { method: string; path: string; operation: Operation }, doc: OpenApiDoc = {}) => {
  const query = (operation.parameters ?? []).filter((parameter) => parameter.in === 'query' && parameter.name !== 'cursor')
  const body = operation.requestBody?.content ? Object.keys(operation.requestBody.content).map((type) => type.split(';')[0]).join(' or ') : ''
  const open = Array.isArray(operation.security) && operation.security.length === 0 ? ' No key needed.' : ''
  return [
    `- \`${exampleCall(method, path, operation)}\` — ${firstSentence(operation.description ?? operation.summary)}${open}`,
    query.length ? `Query: ${query.map(paramLine).join(', ')}.` : '',
    body ? `Body: ${body}.` : '',
    returnsOf(doc, operation) ? `Returns ${returnsOf(doc, operation)}.` : '',
    operation.operationId ? `Spec: \`${operation.operationId}\`.` : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** Every operation, grouped under its tag in the document's tag order; `tags` narrows to some of them. */
export const endpointsMarkdown = (doc: OpenApiDoc, { tags }: { tags?: string[] } = {}) => {
  const operations = operationsOf(doc)
  const order = (doc.tags ?? []).map((tag) => tag.name).filter((name) => !tags || tags.includes(name))
  return order
    .map((name) => {
      const lines = operations.filter(({ operation }) => (operation.tags ?? [])[0] === name).map((entry) => operationLine(entry, doc))
      if (!lines.length) return ''
      const description = doc.tags?.find((tag) => tag.name === name)?.description
      return `### ${name}\n\n${description ? `${description}\n\n` : ''}${lines.join('\n')}`
    })
    .filter(Boolean)
    .join('\n\n')
}

/** Each tag's section on its own, for a template that interleaves prose: `{{api.tag.search}}`. */
export const endpointsByTag = (doc: OpenApiDoc) =>
  Object.fromEntries((doc.tags ?? []).map((tag) => [slugOf(tag.name), endpointsMarkdown(doc, { tags: [tag.name] })]))

// ---- MCP tools ----

/** Runs a tool's `call` with placeholder arguments (`{name}`) to see the route it hits, then finds that operation. */
export const toolRoute = (tool: ToolLike, doc: OpenApiDoc) => {
  const placeholders = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `{${key}}` : undefined) })
  let call: { method?: string; path: string }
  try {
    call = tool.call(placeholders as never)
  } catch {
    return null
  }
  const method = (call.method ?? 'GET').toLowerCase()
  const path = call.path.split('?')[0]!
  for (const [template, item] of Object.entries(doc.paths ?? {})) {
    if (!item[method]) continue
    const pattern = new RegExp(`^${template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[^}]+\\?\}/g, '[^/]+')}$`)
    if (pattern.test(path)) return { method: method.toUpperCase(), path: template, operationId: item[method]!.operationId }
  }
  return null
}

/** One line per tool: its name, the route it runs, when to use it (its own description, which also states the cost). */
export const toolsMarkdown = (tools: ToolLike[], doc: OpenApiDoc) =>
  tools
    .map((tool) => {
      const route = toolRoute(tool, doc)
      return `- **\`${tool.name}\`** → \`${route ? `${route.method} ${route.path}` : 'no route found'}\` — ${tool.description.replace(/\s+/g, ' ').trim()}`
    })
    .join('\n')

/** A command as the CLI snapshot (`commands.json`) holds it: enough to list it. */
export type CliCommandLike = { name: string; positional: string[]; summary: string; tool?: string; uriTemplate?: string; job?: string }
/** What the CLI needs of a job to list it. */
export type CliJobLine = { name: string; summary: string; args: Record<string, { positional?: boolean }> }

/**
 * One line per command of the app's CLI, jobs first: the command with its positional arguments, what it does, and the
 * MCP tool (or resource, or "job") behind it. From the tools, resources and jobs, or from the snapshot's `commands`.
 * Without the bin's name, which the guide writes around it.
 *
 * @example
 * cliMarkdown({ commands: snapshot.commands }) // → '- `signup` — Make an address and wait for its code (job)\n- `mail wait <address>` — …'
 */
export const cliMarkdown = ({ tools = [], resources = [], jobs = [], commands }: { tools?: ToolLike[]; resources?: ResourceLike[]; jobs?: CliJobLine[]; commands?: CliCommandLike[] }) => {
  const listed: CliCommandLike[] = commands ?? [
    ...jobs.map((job) => ({ name: job.name, job: job.name, summary: job.summary, positional: Object.entries(job.args).filter(([, arg]) => arg.positional).map(([key]) => key) })),
    ...tools.map((tool) => ({ ...(tool.input ? cliOf(tool as ToolLike & { input: { shape: Record<string, unknown> } }) : toolCli({ name: tool.name, cli: tool.cli, keys: [] })), summary: tool.title ?? firstSentence(tool.description), tool: tool.name })),
    ...resources.flatMap((resource) => (resource.name ? [{ ...resourceCli({ name: resource.name, uriTemplate: resource.uriTemplate, cli: resource.cli }), summary: resource.title, uriTemplate: resource.uriTemplate }] : [])),
  ]
  const order = (a: CliCommandLike, b: CliCommandLike) => (a.job && !b.job ? -1 : b.job && !a.job ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  return [...listed]
    .sort(order)
    .map((command) => `- \`${command.name}${command.positional.map((key) => ` <${key}>`).join('')}\` — ${command.summary} (${command.job ? 'job' : `\`${command.tool ?? command.uriTemplate}\``})`)
    .join('\n')
}

/** One line per MCP resource: its URI template and what attaching it gives. */
export const resourcesMarkdown = (resources: ResourceLike[]) => resources.map((resource) => `- \`${resource.uriTemplate}\` — ${resource.title}: ${resource.description.replace(/\s+/g, ' ').trim()}`).join('\n')

// ---- Skills ----

/** A playbook's title (its `# heading`) and its first paragraph (what it is for). */
export const playbookSummary = (markdown: string) => ({
  title: markdown.match(/^# (.+)$/m)?.[1]?.trim() ?? '',
  purpose: markdown.replace(/^---[\s\S]*?---/, '').split(/\n\s*\n/).map((part) => part.trim()).find((part) => part && !part.startsWith('#'))?.replace(/\s+/g, ' ') ?? '',
})

/** `- [Plan a week](/skills/cookbook/references/plan-a-week.md): …` for every playbook of one skill. */
export const playbooksMarkdown = (files: Map<string, string>, skill: string) =>
  [...files.entries()]
    .filter(([path]) => path.startsWith(`skills/${skill}/references/`) && path.endsWith('.md'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, text]) => {
      const { title, purpose } = playbookSummary(text)
      return `- [${title || path}](/${path}): ${firstSentence(purpose)}`
    })
    .join('\n')

// ---- Getting unstuck ----

/** The same five ways out for every kit API: the spec, the errors, the root, runs, the problem catalogue. */
export const unblockMarkdown = (origin: string) => {
  const search = `curl -s ${origin}/openapi.json | jq -r '.paths | to_entries[] | .key as $p | .value | to_entries[] | "\\(.key|ascii_upcase) \\($p) — \\(.value.summary)"' | grep -i <word>`
  return [
    '1. **Look the call up in the spec.** `GET /openapi.json` (with your key on a private service) has every operation with its parameters, examples and',
    `   response schema. Find one by words: \`${search}\`.`,
    '   What a field means: the call\'s line in `/agents/endpoints.md` names its schema after "Returns"; read it with',
    `   \`curl -s ${origin}/openapi.json | jq '.components.schemas.<Name>'\` (every field is described there).`,
    '2. **Read the error.** Every error is `application/problem+json` with a `code`, a `detail` that says what to change,',
    '   and `errors[]` naming the field. A `400` for an unknown query parameter lists the ones the operation takes.',
    '   `GET /problems/{code}` explains a code.',
    '3. **Start over from the root.** `GET /api` links every list, search and workflow; resources link their neighbours',
    '   in `_links`, so follow links instead of building URLs. Where an answer keeps its list (`_embedded.<name>`, or a',
    '   top-level `items` with `total`) is on each operation\'s `Returns` line in the endpoints page.',
    '4. **A `202` is not an error.** It started a run: poll `Location` until `status` is `done`, then repeat the call',
    '   (or read `_links.result`).',
    '5. **Still stuck?** Say exactly which call failed and its `detail`; never guess an id, a field or a number.',
  ].join('\n')
}

/** Everything generated, keyed the way guide templates name it. */
export const generatedVars = ({ origin, doc, tools, resources, commands, files }: { origin: string; doc: OpenApiDoc; tools?: ToolLike[]; resources?: ResourceLike[]; commands?: CliCommandLike[]; files: Map<string, string> }) => {
  const skills = [...new Set([...files.keys()].flatMap((path) => path.match(/^skills\/([^/]+)\/SKILL\.md$/)?.[1] ?? []))]
  return {
    api: { endpoints: endpointsMarkdown(doc), tag: endpointsByTag(doc), unblock: unblockMarkdown(origin), operations: operationsOf(doc).length },
    mcp: { tools: tools ? toolsMarkdown(tools, doc) : '', count: tools?.length ?? 0, resources: resources?.length ? resourcesMarkdown(resources) : 'None.' },
    skills: Object.fromEntries(skills.map((name) => [name, { playbooks: playbooksMarkdown(files, name) }])),
    cli: { commands: commands || tools ? cliMarkdown({ tools, resources, commands }) : '' },
  }
}

/** Template names the kit fills itself; `guideGaps` doesn't ask the app for them. */
export const GENERATED_ROOTS = ['origin', 'api', 'mcp', 'skills', 'cli'] as const
