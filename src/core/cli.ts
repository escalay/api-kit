/**
 * A tool's or resource's command on the app's command line (`<app> <noun> <verb>`): its name, the positional
 * arguments (the route's or URI template's path parameters, in order) and its examples. `mcp` publishes it in
 * `tools/list` as `_meta["api-kit/cli"]`; `testing` writes the CLI snapshot and audits the names from it.
 *
 * @example
 * toolCli({ name: 'get_app', cli: { name: 'app view', examples: [{ run: 'app view a1', about: 'One app' }] }, route: 'GET /api/v1/apps/{id}', keys: ['id'] })
 * // → { name: 'app view', positional: ['id'], examples: [{ run: 'app view a1', about: 'One app' }], named: true }
 */

/** One example of a command: the command line without the bin, and what it does. */
export type CliExample = { run: string; about: string }

/**
 * What a tool or resource says about its command: `'mail wait'`, or the name with examples, and (rarely) its
 * positional arguments when the path doesn't show them.
 */
export type CliSpec = string | { name: string; examples?: CliExample[]; positional?: string[] }

/** A command as published: `named` is false when the name came from the route rule, not from the tool. */
export type CliCommand = { name: string; positional: string[]; examples: CliExample[]; named: boolean }

/** Where a tool's command is published in its MCP listing. */
export const CLI_META = 'api-kit/cli'
/** Where a failed tool call carries its problem (RFC 9457, with `status`). */
export const PROBLEM_META = 'api-kit/problem'
/** Where a tool call that is still working names its run. */
export const PENDING_META = 'api-kit/pending'
/**
 * Where each listed tool, and every call's result, carries a short hash of the whole listing (tools and resources:
 * names, words, schemas, `_meta`), so a client that cached the list can tell it changed with the next answer.
 */
export const TOOLS_HASH_META = 'api-kit/tools-hash'

/** Commands every app's CLI has, which no tool, resource or job may be named after (or use as a noun). */
export const CLI_BUILT_INS = ['help', 'commands', 'api', 'tool', 'doctor', 'completion', 'version'] as const
/**
 * The flags every command takes, and whether each takes a value (`--json` takes fields only sometimes: see the CLI's
 * rule). The CLI engine keeps the same table in `sdk/cli/engine/args.ts`; a kit test keeps the two equal.
 */
export const CLI_GLOBAL_FLAGS: Readonly<Record<string, boolean>> = { json: false, yes: false, 'dry-run': false, input: true, timeout: true, profile: true, help: false }
/** Flags a resource's command takes besides its template variables: `--out <file>` saves a file part. */
export const CLI_RESOURCE_FLAGS: Readonly<Record<string, boolean>> = { out: true }

/**
 * The built-in `auth` verbs. `auth` is shared: an app's tool may fill a free verb (`who_am_i` is `auth status`, which
 * the CLI shows with the profile it used).
 */
export const CLI_AUTH_VERBS = ['login', 'logout', 'token', 'switch'] as const

const kebab = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[_\s]+/g, '-').toLowerCase()

/**
 * A noun's singular form by the usual English endings (`addresses` → `address`, `replies` → `reply`, `keys` → `key`).
 *
 * @example
 * singularOf('webhooks') // → 'webhook'
 */
export const singularOf = (word: string) => {
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (/(ss|x|ch|sh)es$/.test(word)) return word.slice(0, -2)
  if (/[^su]s$/.test(word)) return word.slice(0, -1)
  return word
}

const isParam = (segment: string) => /^\{[^}]+\}$/.test(segment)
const VERB_OF_WORD: Record<string, string> = { get: 'view', update: 'edit', change: 'edit', remove: 'delete' }

/**
 * The fallback name for a tool that names no command: from its route (`GET /api/addresses/{id}` → `address view`,
 * `POST /api/messages/{id}/reply` → `message reply`), else from its MCP name (`search_recipes` → `recipe search`).
 *
 * @example
 * fallbackCliName('DELETE /api/v1/keys/{id}', 'delete_key') // → 'key delete'
 */
export const fallbackCliName = (route: string | undefined, toolName: string) => {
  const [method = 'GET', path = ''] = (route ?? '').split(' ')
  const segments = path.split('/').filter((segment) => segment && segment !== 'api' && !/^v\d+$/.test(segment))
  const words = segments.map((segment, index) => (isParam(segment) ? -1 : index)).filter((index) => index >= 0)
  const last = words.at(-1) ?? -1
  if (route && last >= 0) {
    const word = kebab(segments[last]!)
    const before = words.length > 1 ? segments[words.at(-2)!] : undefined
    // A singular word after an id is an action on that thing (`/messages/{id}/reply`), not a collection
    if (last === segments.length - 1 && isParam(segments[last - 1] ?? '') && before && !word.endsWith('s')) return `${singularOf(kebab(before))} ${word}`
    const verb = method === 'GET' ? (last === segments.length - 1 ? 'list' : 'view') : method === 'POST' ? 'create' : method === 'DELETE' ? 'delete' : 'edit'
    return `${singularOf(word)} ${verb}`
  }
  const [first = toolName, ...rest] = toolName.split('_')
  return `${singularOf(kebab(rest.join('_'))) || 'tool'} ${VERB_OF_WORD[first] ?? kebab(first)}`
}

/** What the CLI needs of an MCP tool (`McpTool` has it). */
export type CliTool = { name: string; route?: string; cli?: CliSpec; input: { shape: Record<string, unknown> }; call: (args: never) => { method?: string; path: string } }

/**
 * A tool's route as `METHOD /path/{param}`: its own `route`, or `call` run with each argument as its `{name}`. Undefined
 * when neither works (a call that reads its arguments' values).
 *
 * @example
 * routeOf(mcpTool({ name: 'get_recipe', input: z.object({ id: z.string() }), call: ({ id }) => ({ path: `/api/v1/recipes/${id}` }), … }))
 * // → 'GET /api/v1/recipes/{id}'
 */
export const routeOf = (tool: Pick<CliTool, 'route' | 'input' | 'call'>): string | undefined => {
  if (tool.route) return tool.route
  try {
    const placeholders = Object.fromEntries(Object.keys(tool.input.shape).map((key) => [key, `{${key}}`]))
    const call = tool.call(placeholders as never)
    return `${call.method ?? 'GET'} ${decodeURIComponent(call.path)}`
  } catch {
    return undefined
  }
}

/**
 * A tool's MCP hints with the kit's defaults: read-only when its route is a `GET` (or can't be read from its call)
 * and it says nothing else (a tool that says it is destructive is never read-only), not destructive, idempotent,
 * closed-world.
 *
 * @example
 * hintsOf(deleteNote) // → { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
 */
export const hintsOf = (tool: Pick<CliTool, 'route' | 'input' | 'call'> & { annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean } }) => {
  // A route the call doesn't show (built from its arguments' values) keeps the old default: read-only
  const reads = (routeOf(tool) ?? 'GET ').startsWith('GET ') && !tool.annotations?.destructiveHint
  return { readOnlyHint: reads, destructiveHint: false, idempotentHint: true, openWorldHint: false, ...tool.annotations }
}

const specOf = (cli: CliSpec | undefined) => (typeof cli === 'string' ? { name: cli, examples: [], positional: undefined } : cli ? { name: cli.name, examples: cli.examples ?? [], positional: cli.positional } : undefined)

/**
 * A tool's command: its own `cli`, or the fallback name; the route's path parameters that are input keys, in order.
 *
 * @example
 * toolCli({ name: 'save_to_board', route: 'PUT /api/boards/{id}/items/{ref}', keys: ['id', 'ref', 'note'] }).positional // → ['id', 'ref']
 */
export const toolCli = ({ name, cli, route, keys, inPath }: { name: string; cli?: CliSpec; route?: string; keys: string[]; inPath?: string[] }): CliCommand => {
  const spec = specOf(cli)
  const params = inPath ?? [...(route ?? '').matchAll(/\{([^}]+)\}/g)].map(([, param]) => param!).filter((param) => keys.includes(param))
  return { name: spec?.name ?? fallbackCliName(route, name), positional: spec?.positional ?? [...new Set(params)], examples: spec?.examples ?? [], named: Boolean(spec) }
}

/**
 * The input keys a tool's call puts in its path, in path order: `call` run with each key as `{key}`. Undefined when
 * the call can't run on placeholders, so the caller falls back to the route's `{names}`. A tool's own `route` may name
 * its placeholders differently (`{id}` for the input `address`), which is why the call decides.
 *
 * @example
 * pathKeysOf(waitForMessage) // → ['address'] (route says `/api/addresses/{id}/messages/next`)
 */
export const pathKeysOf = (tool: Pick<CliTool, 'input' | 'call'>): string[] | undefined => {
  const keys = Object.keys(tool.input.shape)
  try {
    const path = decodeURIComponent(tool.call(Object.fromEntries(keys.map((key) => [key, `{${key}}`])) as never).path)
    return keys.filter((key) => path.includes(`{${key}}`)).sort((a, b) => path.indexOf(`{${a}}`) - path.indexOf(`{${b}}`))
  } catch {
    return undefined
  }
}

/**
 * A tool's command line: its `cli` name (or the route rule's), its positional arguments (the route's path parameters,
 * in order) and its examples, as `tools/list` publishes them in `_meta["api-kit/cli"]`.
 *
 * @example
 * cliOf(getApp) // → { name: 'app view', positional: ['id'], examples: [{ run: 'app view a1', about: 'One app' }], named: true }
 */
export const cliOf = (tool: CliTool): CliCommand => toolCli({ name: tool.name, cli: tool.cli, route: routeOf(tool), keys: Object.keys(tool.input.shape), inPath: pathKeysOf(tool) })

/**
 * The variables of an RFC 6570 URI template: `path` ones (`{id}`) are positional, `query` ones (`{?format,part}`) are flags.
 *
 * @example
 * templateVariables('mail://messages/{id}/body{?format}') // → { path: ['id'], query: ['format'] }
 */
export const templateVariables = (template: string) => {
  const path: string[] = []
  const query: string[] = []
  for (const [, operator = '', names = ''] of template.matchAll(/\{([+#./;?&]?)([^}]+)\}/g))
    for (const name of names.split(',').map((one) => one.replace(/\*$|:\d+$/, ''))) (operator === '?' || operator === '&' ? query : path).push(name)
  return { path, query }
}

/**
 * A resource's command: its own `cli`, or `<thing> <name>` from its URI template (`sample://apps/{id}` named `logo` →
 * `app logo`); the template's path variables are positional.
 *
 * @example
 * resourceCli({ name: 'mail_headers', uriTemplate: 'mail://messages/{id}/headers', cli: 'mail headers' }) // → { name: 'mail headers', positional: ['id'], … }
 */
export const resourceCli = ({ name, uriTemplate, cli }: { name: string; uriTemplate: string; cli?: CliSpec }): CliCommand => {
  const spec = specOf(cli)
  const [thing = name] = uriTemplate.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')
  const noun = singularOf(kebab(thing.replace(/\{.*$/, '') || name))
  const verb = kebab(name) === noun ? 'view' : kebab(name)
  return { name: spec?.name ?? `${noun} ${verb}`, positional: spec?.positional ?? templateVariables(uriTemplate).path, examples: spec?.examples ?? [], named: Boolean(spec) }
}
