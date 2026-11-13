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
  /** The tool's route, `GET /api/addresses/{id}`, so text naming it can name the command. */
  route?: string
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
    ...(route ? { route } : {}),
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
  // `senderWritten` names the fields a stranger wrote: it stays with them, chosen or not
  const kept = [...fields, ...(fields.includes(SENDER_WRITTEN) ? [] : [SENDER_WRITTEN])]
  const pick = (item: unknown) => (item && typeof item === 'object' ? Object.fromEntries(kept.filter((field) => field in item).map((field) => [field, (item as Record<string, unknown>)[field]])) : item)
  if (Array.isArray(value)) return value.map(pick)
  const list = listOf(value)
  if (list && !fields.some((field) => field in value)) return list.map(pick)
  return pick(value)
}

/** The field the kit's apps use to name the fields a stranger wrote. */
export const SENDER_WRITTEN = 'senderWritten'

const listOf = (value: object) => {
  const embedded = (value as { _embedded?: Record<string, unknown> })._embedded
  return embedded ? (Object.values(embedded).find(Array.isArray) as unknown[] | undefined) : undefined
}

/**
 * The fields `--json a,b` asks for that the answer doesn't have, and the ones it has: the top-level keys of the
 * first item (of an array or a HAL list), or of the object. Nothing to say about an empty list.
 */
export const missingFields = (value: unknown, fields: string[] | undefined) => {
  if (!fields?.length || value === null || typeof value !== 'object') return { missing: [], keys: [] }
  const list = Array.isArray(value) ? value : listOf(value)
  const own = Array.isArray(value) ? [] : Object.keys(value)
  const sample = list && !fields.some((field) => own.includes(field)) ? list[0] : value
  if (!sample || typeof sample !== 'object') return { missing: [], keys: [] }
  const keys = Object.keys(sample)
  return { missing: fields.filter((field) => !keys.includes(field) && !own.includes(field)), keys }
}

/**
 * JSON as lines a person reads: `key: value` for a flat object, a list of words joined, nested values indented under
 * their key. `_links` is left out (the commands are what to follow) and `senderWritten` is said once, above.
 *
 * @example
 * readableOf({ subject: 'Hi', to: ['a@x.example', 'b@x.example'], from: { name: 'Ana' } })
 * // → 'subject: Hi\nto: a@x.example, b@x.example\nfrom:\n  name: Ana'
 */
export const readableOf = (value: unknown, indent = ''): string => {
  const flat = (one: unknown) => one === null || typeof one !== 'object'
  if (flat(value)) return `${indent}${value === null || value === undefined ? '—' : String(value)}`
  if (Array.isArray(value)) {
    if (!value.length) return `${indent}—`
    if (value.every(flat)) return `${indent}${value.map((one) => (one === null ? '—' : String(one))).join(', ')}`
    return value.map((one) => readableOf(one, `${indent}  `).replace(new RegExp(`^${indent}  `), `${indent}- `)).join('\n')
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== '_links' && key !== SENDER_WRITTEN)
    .map(([key, one]) => {
      if (typeof one === 'string' && one.includes('\n')) return `${indent}${key}:\n${one.split('\n').map((line) => `${indent}  ${line}`).join('\n')}`
      if (flat(one) || (Array.isArray(one) && one.every(flat))) return `${indent}${key}: ${readableOf(one)}`
      return `${indent}${key}:\n${readableOf(one, `${indent}  `)}`
    })
    .join('\n')
}

/** Reads text written for MCP clients as the CLI says it; the text itself when there is nothing to change. */
export type CliWords = (text: string, command?: Command) => string

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A route or URI template as a pattern whose groups are its path variables; `{?query}` parts are left out. */
const patternOf = (template: string) => new RegExp(`^${template.replace(/\{[?&][^}]*\}/g, '').split(/(\{[^}]+\})/).map((part) => (/^\{[^}]+\}$/.test(part) ? '([^/?#]+)' : escapeRegExp(part))).join('')}$`)

/** A command line for a matched route or URI: each captured value given, a `{placeholder}` shown as `<positional>`. */
const commandLine = (app: string, command: Command, values: string[]) =>
  [app, command.name, ...command.positional.map((key, index) => {
    const value = values[index]
    return value === undefined || /^\{[^}]+\}$/.test(value) ? `<${key}>` : value
  })].join(' ')

/** In backticks; a backtick the text had on one side only stays where it was. */
const quoted = (open: string, close: string, line: string) => (open && !close ? `${open}${line}` : close && !open ? `${line}${close}` : `\`${line}\``)

/**
 * Text written for MCP clients, as the command line says it. Conservative: only what exactly matches a command
 *   - a tool's MCP name (a whole word; one without an underscore only in backticks) → `` `mailroom address create` ``
 *   - a route (`GET /api/addresses`, `{id}` matching any value) → the command whose tool calls it
 *   - a resource URI (`mailroom://messages/{id}/headers`) → `` `mailroom mail headers <id>` ``
 *   - a backticked argument (`` `addressId` ``) of the command shown or of a command named above → `` `--address-id` ``,
 *     and `` `read: false` `` → `` `--no-read` `` (`` `--read` `` for true, `` `--key value` `` otherwise)
 * For help, summaries and error lines only; `--json` and `commands --json` stay as the server wrote them.
 *
 * @example
 * cliWordsOf(commands, 'mailroom')('The address’s id, from create_address.') // → 'The address’s id, from `mailroom address create`.'
 */
export const cliWordsOf = (commands: Command[], app: string): CliWords => {
  const byTool = new Map(commands.filter((command) => command.tool).map((command) => [command.tool!, command]))
  const routes = commands.flatMap((command) => (command.route ? [{ command, method: command.route.split(' ')[0]!, pattern: patternOf(command.route.split(' ')[1] ?? '') }] : []))
  const uris = commands.flatMap((command) => (command.uriTemplate ? [{ command, pattern: patternOf(command.uriTemplate) }] : []))
  if (!byTool.size && !uris.length) return (text) => text
  return (text, command) => {
    if (!text) return text
    const named = command ? [command] : []
    const said = text
      // Resource URIs, with the words "the resource" before them, which the command now says
      .replace(/(?:\b(?:the )?resource )?(`?)\b([a-z][a-z0-9+.-]*:\/\/[^\s`'")<>]+?)(`?)([.,;:]?)(?=[\s'")<>]|$)/g, (match, open: string, uri: string, close: string, stop: string) => {
        for (const { command: found, pattern } of uris) {
          const values = uri.split('?')[0]!.match(pattern)
          if (!values) continue
          named.push(found)
          return `${quoted(open, close, commandLine(app, found, values.slice(1)))}${stop}`
        }
        return match
      })
      .replace(/(`?)\b(GET|POST|PUT|PATCH|DELETE) (\/[^\s`'")<>?]*)(\?[^\s`'")<>]*)?(`?)/g, (match, open: string, method: string, path: string, _query: string, close: string) => {
        const bare = path.replace(/[.,;:]+$/, '')
        const found = routes.find((route) => route.method === method && route.pattern.test(bare))
        if (!found) return match
        named.push(found.command)
        return `${quoted(open, close, commandLine(app, found.command, bare.match(found.pattern)!.slice(1)))}${path.slice(bare.length)}`
      })
      .replace(/(`?)\b([a-z][a-z0-9]*(?:_[a-z0-9]+)*)\b(`?)/g, (match, open: string, word: string, close: string) => {
        const found = byTool.get(word)
        if (!found || (!word.includes('_') && !(open && close))) return match
        named.push(found)
        return quoted(open, close, `${app} ${found.name}`)
      })
    const flags = new Map(named.flatMap((one) => one.flags.map((flag) => [flag.key, flag] as const)))
    return said.replace(/`([A-Za-z_][A-Za-z0-9_]*)(?::\s*([^`]+))?`/g, (match, key: string, value: string | undefined) => {
      const flag = flags.get(key)
      if (!flag || byTool.has(key)) return match
      if (value === undefined) return `\`--${flag.name}\``
      const given = value.trim().replace(/^(["'])(.*)\1$/, '$2')
      if (flag.type === 'boolean' && (given === 'true' || given === 'false')) return given === 'true' || flag.name.startsWith('no-') ? `\`--${flag.name}\`` : `\`--no-${flag.name}\``
      return `\`--${flag.name} ${given}\``
    })
  }
}
