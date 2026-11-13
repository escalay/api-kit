/**
 * The commands the CLI offers, from the packaged snapshot (`commands.json`) or a deployment's live MCP listings. The
 * same rules as the kit's `cliSnapshot`, so both give the same commands: a tool's `_meta["api-kit/cli"]` names it,
 * its input schema gives the flags (path parameters are positional too), and a tool without a name gets the route rule's.
 */
import type { Job } from './job.js'

export type FlagType = 'string' | 'number' | 'integer' | 'boolean' | 'object'
export type Flag = { name: string; key: string; type: FlagType; description: string; required: boolean; multiple: boolean; enum?: string[]; default?: unknown }
export type Example = { run: string; about: string }
export type Command = {
  name: string
  tool?: string
  resource?: string
  uriTemplate?: string
  job?: string
  summary: string
  description: string
  positional: string[]
  flags: Flag[]
  examples: Example[]
  readOnly: boolean
  destructive: boolean
}
export type Snapshot = { app: string; version: string; commands: Command[] }

type JsonSchema = { type?: string | string[]; description?: string; enum?: unknown[]; default?: unknown; items?: JsonSchema; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; properties?: Record<string, JsonSchema>; required?: string[] }
export type ListedTool = { name: string; title?: string; description?: string; inputSchema?: JsonSchema; annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean }; _meta?: Record<string, any> }
export type ListedTemplate = { name: string; uriTemplate: string; title?: string; description?: string; _meta?: Record<string, any> }

export const CLI_META = 'api-kit/cli'
export const ROUTE_META = 'api-kit/route'

export const kebab = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase()

const singularOf = (word: string) => {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (/[^su]s$/.test(word)) return word.slice(0, -1)
  return word
}
const isParam = (segment: string) => /^\{[^}]+\}$/.test(segment)
const VERB_OF_WORD: Record<string, string> = { get: 'view', update: 'edit', change: 'edit', remove: 'delete' }

/** The route rule, for a tool that names no command (the kit's `fallbackCliName`). */
export const fallbackName = (route: string | undefined, toolName: string) => {
  const [method = 'GET', path = ''] = (route ?? '').split(' ')
  const segments = path.split('/').filter((segment) => segment && segment !== 'api' && !/^v\d+$/.test(segment))
  const words = segments.map((segment, index) => (isParam(segment) ? -1 : index)).filter((index) => index >= 0)
  const last = words.at(-1) ?? -1
  if (route && last >= 0) {
    const word = kebab(segments[last]!)
    const before = words.length > 1 ? segments[words.at(-2)!] : undefined
    if (last === segments.length - 1 && isParam(segments[last - 1] ?? '') && before && !word.endsWith('s')) return `${singularOf(kebab(before))} ${word}`
    const verb = method === 'GET' ? (last === segments.length - 1 ? 'list' : 'view') : method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'edit'
    return `${singularOf(word)} ${verb}`
  }
  const [first = toolName, ...rest] = toolName.split('_')
  return `${singularOf(kebab(rest.join('_'))) || 'tool'} ${VERB_OF_WORD[first] ?? kebab(first)}`
}

const typeOf = (schema: JsonSchema): { type: FlagType; multiple: boolean; enum?: string[] } => {
  const variants = (schema.anyOf ?? schema.oneOf ?? []).filter((variant) => variant.type !== 'null')
  if (variants.length) {
    const array = variants.find((variant) => variant.type === 'array')
    return array ? { ...typeOf(array.items ?? {}), multiple: true } : typeOf(variants[0]!)
  }
  const type = Array.isArray(schema.type) ? schema.type.find((one) => one !== 'null') : schema.type
  if (type === 'array') return { ...typeOf(schema.items ?? {}), multiple: true }
  const values = schema.enum?.filter((value): value is string => typeof value === 'string')
  if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') return { type, multiple: false, ...(values?.length ? { enum: values } : {}) }
  return { type: values?.length ? 'string' : 'object', multiple: false, ...(values?.length ? { enum: values } : {}) }
}

/** An input schema's properties as flags (the kit's `flagsOf`). */
export const flagsOf = (schema: JsonSchema = {}): Flag[] =>
  Object.entries(schema.properties ?? {}).map(([key, property]) => ({
    name: kebab(key),
    key,
    ...typeOf(property),
    description: property.description ?? '',
    required: (schema.required ?? []).includes(key) && property.default === undefined,
    ...(property.default === undefined ? {} : { default: property.default }),
  }))

/** The variables of an RFC 6570 template: path ones (positional) and query ones (`{?a,b}`, flags). */
export const templateVariables = (template: string) => {
  const path: string[] = []
  const query: string[] = []
  for (const [, operator = '', names = ''] of template.matchAll(/\{([+#./;?&]?)([^}]+)\}/g))
    for (const name of names.split(',').map((one) => one.replace(/\*$|:\d+$/, ''))) (operator === '?' || operator === '&' ? query : path).push(name)
  return { path, query }
}

/** A URI from a template: path variables encoded in place, query variables that have a value as `?a=…&b=…`. */
export const expandTemplate = (template: string, values: Record<string, unknown>) =>
  template.replace(/\{([+#./;?&]?)([^}]+)\}/g, (_, operator: string, names: string) => {
    const pairs = names.split(',').flatMap((name) => (values[name] === undefined ? [] : [[name, String(values[name])] as const]))
    if (operator === '?' || operator === '&') return pairs.length ? `${operator}${pairs.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('&')}` : ''
    return pairs.map(([, value]) => (operator === '+' ? encodeURI(value) : encodeURIComponent(value))).join(',')
  })

const toolCommand = (tool: ListedTool): Command => {
  const meta = tool._meta?.[CLI_META] as { name?: string; positional?: string[]; examples?: Example[] } | undefined
  const route = tool._meta?.[ROUTE_META] as string | undefined
  const keys = Object.keys(tool.inputSchema?.properties ?? {})
  const positional = meta?.positional ?? [...(route ?? '').matchAll(/\{([^}]+)\}/g)].map(([, param]) => param!).filter((param) => keys.includes(param))
  const readOnly = tool.annotations?.readOnlyHint ?? false
  return {
    name: meta?.name ?? fallbackName(route, tool.name),
    tool: tool.name,
    summary: tool.title ?? tool.annotations?.title ?? tool.name,
    description: tool.description ?? '',
    positional,
    flags: flagsOf(tool.inputSchema),
    examples: meta?.examples ?? [],
    readOnly,
    // As MCP defines the hints: a tool that writes is destructive unless it says otherwise
    destructive: !readOnly && (tool.annotations?.destructiveHint ?? true),
  }
}

const resourceCommand = (template: ListedTemplate): Command => {
  const meta = template._meta?.[CLI_META] as { name?: string; positional?: string[]; examples?: Example[] } | undefined
  const { path, query } = templateVariables(template.uriTemplate)
  const [thing = template.name] = template.uriTemplate.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')
  const noun = singularOf(kebab(thing.replace(/\{.*$/, '') || template.name))
  return {
    name: meta?.name ?? `${noun} ${kebab(template.name) === noun ? 'view' : kebab(template.name)}`,
    resource: template.name,
    uriTemplate: template.uriTemplate,
    summary: template.title ?? template.name,
    description: template.description ?? '',
    positional: meta?.positional ?? path,
    flags: [...path.map((key) => ({ key, required: true })), ...query.map((key) => ({ key, required: false }))].map(({ key, required }) => ({ name: kebab(key), key, type: 'string' as const, description: '', required, multiple: false })),
    examples: meta?.examples ?? [],
    readOnly: true,
    destructive: false,
  }
}

/** A job as a command: its arguments are its flags, `positional` ones bare too. */
export const jobCommand = (job: Job): Command => ({
  name: job.name,
  job: job.name,
  summary: job.summary,
  description: job.description ?? job.summary,
  positional: Object.entries(job.args).filter(([, arg]) => arg.positional).map(([key]) => key),
  flags: Object.entries(job.args).map(([key, arg]) => ({ name: kebab(key), key, type: arg.type, description: arg.description, required: Boolean(arg.required), multiple: Boolean(arg.multiple), ...(arg.default === undefined ? {} : { default: arg.default }) })),
  examples: job.examples,
  readOnly: false,
  destructive: Boolean(job.destructive),
})

/**
 * The commands a deployment offers, from its `tools/list` and `resources/templates/list`, sorted by name. Templates a
 * protocol extension serves (`io.modelcontextprotocol/skills`, named with a slash) are the extension's, not commands.
 */
export const commandsFromListing = (tools: ListedTool[], templates: ListedTemplate[]) =>
  [...tools.map(toolCommand), ...templates.filter((template) => template._meta?.[CLI_META] || !template.name.includes('/')).map(resourceCommand)].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

/**
 * `--json id,name`: those top-level fields of an object, of each item of an array, and of each item of a HAL list
 * (`_embedded.<name>`) unless the fields are the list's own.
 */
export const selectFields = (value: unknown, fields: string[] | undefined): unknown => {
  if (!fields?.length || value === null || typeof value !== 'object') return value
  const pick = (item: unknown) => (item && typeof item === 'object' ? Object.fromEntries(fields.filter((field) => field in item).map((field) => [field, (item as Record<string, unknown>)[field]])) : item)
  if (Array.isArray(value)) return value.map(pick)
  const embedded = (value as { _embedded?: Record<string, unknown> })._embedded
  const list = embedded && Object.values(embedded).find(Array.isArray)
  if (list && !fields.some((field) => field in value)) return list.map(pick)
  return pick(value)
}
