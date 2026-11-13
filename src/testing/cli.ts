/**
 * The app's command line, checked and written down:
 *   cliSnapshot   every command (tools, resources, jobs) as `commands.json`, which the CLI package carries so help works
 *                 before sign-in; `scripts/openapi.ts` writes it and a test fails while the file is behind
 *   cliGaps       what keeps the commands from being usable: a missing or badly formed name, a duplicate, a name that
 *                 shadows a job or a built-in, a plural noun, an argument without a description, a tool without an
 *                 example, an example that names a flag the command doesn't have
 *
 * @example
 * expect(cliGaps({ tools: TOOLS, resources: RESOURCES, jobs })).toEqual([])
 * expect(readFileSync('sdk/cli/commands.json', 'utf8')).toBe(`${JSON.stringify(cliSnapshot({ app: 'mailroom', version: VERSION, tools: TOOLS, resources: RESOURCES, jobs }), null, 2)}\n`)
 */
import { z } from '@hono/zod-openapi'
import { CLI_AUTH_VERBS, CLI_BUILT_INS, CLI_GLOBAL_FLAGS, CLI_RESOURCE_FLAGS, cliOf, hintsOf, resourceCli, templateVariables, type CliExample, type CliSpec, type CliTool } from '../core/cli.js'

type JsonSchema = { type?: string | string[]; description?: string; enum?: unknown[]; default?: unknown; items?: JsonSchema; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; properties?: Record<string, JsonSchema>; required?: string[] }

export type CliFlagType = 'string' | 'number' | 'integer' | 'boolean' | 'object'
/** One argument: `name` is the `--flag`, `key` the input property it fills. */
export type CliFlag = { name: string; key: string; type: CliFlagType; description: string; required: boolean; multiple: boolean; enum?: string[]; default?: unknown }
/** One command of the snapshot: a tool's, a resource's (`uriTemplate`) or a job's. */
export type CliSnapshotCommand = {
  name: string
  tool?: string
  resource?: string
  uriTemplate?: string
  job?: string
  summary: string
  description: string
  positional: string[]
  flags: CliFlag[]
  examples: CliExample[]
  readOnly: boolean
  destructive: boolean
}
export type CliSnapshot = { app: string; version: string; commands: CliSnapshotCommand[] }

type SnapshotTool = CliTool & { title: string; description: string; input: z.ZodObject; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }
type SnapshotResource = { name: string; title: string; description: string; uriTemplate: string; cli?: CliSpec }
/** What the snapshot and the audit need of a job (`defineJob` in the CLI makes one). */
export type CliJobLike = {
  name: string
  summary: string
  description?: string
  args: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean; positional?: boolean; multiple?: boolean; default?: unknown }>
  examples: CliExample[]
  destructive?: boolean
}

const kebab = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase()

/** The one type a property is given as on the command line; arrays are repeated flags of their items' type. */
const typeOf = (schema: JsonSchema): { type: CliFlagType; multiple: boolean; enum?: string[] } => {
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

/**
 * An input schema's properties as flags, positional ones included (they also work as `--flag`).
 *
 * @example
 * flagsOf({ type: 'object', properties: { tag: { type: 'array', items: { type: 'string' }, description: 'A tag.' } } })
 * // → [{ name: 'tag', key: 'tag', type: 'string', description: 'A tag.', required: false, multiple: true }]
 */
export const flagsOf = (schema: JsonSchema): CliFlag[] =>
  Object.entries(schema.properties ?? {}).map(([key, property]) => ({
    name: kebab(key),
    key,
    ...typeOf(property),
    description: property.description ?? '',
    required: (schema.required ?? []).includes(key) && property.default === undefined,
    ...(property.default === undefined ? {} : { default: property.default }),
  }))

const toolCommand = (tool: SnapshotTool): CliSnapshotCommand => {
  const cli = cliOf(tool)
  const annotations = hintsOf(tool)
  return {
    name: cli.name,
    tool: tool.name,
    summary: tool.title,
    description: tool.description,
    positional: cli.positional,
    flags: flagsOf(z.toJSONSchema(tool.input, { io: 'input' }) as JsonSchema),
    examples: cli.examples,
    readOnly: annotations.readOnlyHint,
    destructive: annotations.destructiveHint,
  }
}

const resourceCommand = (resource: SnapshotResource): CliSnapshotCommand => {
  const cli = resourceCli(resource)
  const { path, query } = templateVariables(resource.uriTemplate)
  return {
    name: cli.name,
    resource: resource.name,
    uriTemplate: resource.uriTemplate,
    summary: resource.title,
    description: resource.description,
    positional: cli.positional,
    flags: [...path.map((key) => ({ key, required: true })), ...query.map((key) => ({ key, required: false }))].map(({ key, required }) => ({ name: kebab(key), key, type: 'string' as const, description: '', required, multiple: false })),
    examples: cli.examples,
    readOnly: true,
    destructive: false,
  }
}

const jobCommand = (job: CliJobLike): CliSnapshotCommand => ({
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
 * Every command as the CLI package carries it (`sdk/cli/commands.json`): jobs first, then tools and resources by name.
 * Pure, so a test can compare it with the file byte for byte.
 *
 * @example
 * writeFileSync('sdk/cli/commands.json', `${JSON.stringify(cliSnapshot({ app: 'mailroom', version: VERSION, tools: TOOLS, resources: RESOURCES, jobs }), null, 2)}\n`)
 */
export const cliSnapshot = ({ app = '', version = '', tools, resources = [], jobs = [] }: { app?: string; version?: string; tools: SnapshotTool[]; resources?: SnapshotResource[]; jobs?: CliJobLike[] }): CliSnapshot => ({
  app,
  version,
  // Jobs in the app's own order (the first is the one people meet first); the rest by name
  commands: [...jobs.map(jobCommand), ...[...tools.map(toolCommand), ...resources.map(resourceCommand)].sort(byName)],
})

/** Nouns that end in s and are singular. */
const SINGULAR = new Set(['access', 'address', 'alias', 'analytics', 'bus', 'canvas', 'class', 'news', 'process', 'progress', 'settings', 'status', 'series', 'stats', 'success', 'telemetry'])
const looksPlural = (noun: string, allowed: Set<string>) => {
  const word = noun.split('-').at(-1) ?? noun
  return !allowed.has(word) && !allowed.has(noun) && /[^su]s$/.test(word) && !/(ics|ss|us|is)$/.test(word)
}

const GLOBAL_FLAGS = new Set(Object.keys(CLI_GLOBAL_FLAGS))

const FIELDS = /^[A-Za-z_$][\w$.-]*(,[A-Za-z_$][\w$.-]*)*$/
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/** An example's words, quotes kept together as the shell would. */
const wordsOf = (run: string) => [...run.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]!)

/** What is wrong with one example of a command: a run that names another command, a flag it lacks, too many words. */
const exampleGaps = (command: CliSnapshotCommand, where: string) =>
  command.examples.flatMap(({ run, about }) => {
    if (!about) return [`${where}: the example "${run}" says nothing about what it does`]
    const words = wordsOf(run)
    const named = command.name.split(' ')
    if (named.some((word, index) => words[index] !== word)) return [`${where}: the example "${run}" doesn't start with "${command.name}"`]
    const flags = new Map(command.flags.map((flag) => [flag.name, flag]))
    // The engine's own flags, with whether each takes a value: every command's, and a resource's --out
    const own: Record<string, boolean> = { ...CLI_GLOBAL_FLAGS, ...(command.resource ? CLI_RESOURCE_FLAGS : {}) }
    const gaps: string[] = []
    let bare = 0
    for (let index = named.length; index < words.length; index++) {
      const word = words[index]!
      if (word === '-y' || word === '-h') continue
      if (!word.startsWith('--')) {
        bare++
        continue
      }
      const name = word.slice(2).split('=')[0]!
      // As the CLI reads it: the next word is --json's fields once every bare argument is given
      if (name === 'json') {
        if (!word.includes('=') && FIELDS.test(words[index + 1] ?? '') && bare >= command.positional.length) index++
        continue
      }
      const flag = flags.get(name) ?? (name.startsWith('no-') && flags.get(name.slice(3))?.type === 'boolean' ? flags.get(name.slice(3)) : undefined)
      if (!flag && !(name in own)) gaps.push(`${where}: the example "${run}" uses --${name}, which it doesn't take`)
      // A flag's value is the next word, except for booleans and flags written with =
      const takesValue = flag ? flag.type !== 'boolean' : Boolean(own[name])
      if (takesValue && !word.includes('=')) index++
    }
    if (bare > command.positional.length) gaps.push(`${where}: the example "${run}" gives ${bare} bare arguments, and it takes ${command.positional.length}`)
    return gaps
  })

/**
 * What keeps the app's commands from being usable, one line each; `[]` when every tool and resource names its
 * command, names are unique and shadow no job or built-in, nouns are singular, every argument is described and every
 * tool and job has an example that matches it. `singular` adds nouns that end in s and are singular.
 *
 * @example
 * expect(cliGaps({ tools: TOOLS, resources: RESOURCES, jobs })).toEqual([])
 */
export const cliGaps = ({ tools, resources = [], jobs = [] }: { tools: SnapshotTool[]; resources?: SnapshotResource[]; jobs?: CliJobLike[] }, { singular = [] }: { singular?: string[] } = {}) => {
  const gaps: string[] = []
  const allowed = new Set([...SINGULAR, ...singular])
  const builtIns = new Set<string>(CLI_BUILT_INS)
  const jobNames = new Set(jobs.map((job) => job.name))
  const owners = new Map<string, string>()
  const claim = (name: string, where: string) => {
    if (owners.has(name)) gaps.push(`${where}: "${name}" is also the name of ${owners.get(name)}`)
    else owners.set(name, where)
  }
  const entries = [
    ...tools.map((tool) => ({ where: `tool ${tool.name}`, named: cliOf(tool).named, command: toolCommand(tool), needsExample: true })),
    ...resources.map((resource) => ({ where: `resource ${resource.name}`, named: resourceCli(resource).named, command: resourceCommand(resource), needsExample: false })),
  ]
  for (const { where, named, command, needsExample } of entries) {
    if (!named) gaps.push(`${where}: no cli name (the route rule would call it "${command.name}"); add cli: '<noun> <verb>'`)
    if (!/^[a-z][a-z0-9-]* [a-z][a-z0-9-]*$/.test(command.name)) {
      gaps.push(`${where}: "${command.name}" is not "<noun> <verb>" in lowercase kebab-case`)
      continue
    }
    claim(command.name, where)
    const [noun = ''] = command.name.split(' ')
    if (builtIns.has(noun)) gaps.push(`${where}: the noun "${noun}" is a built-in command`)
    if (noun === 'auth' && (CLI_AUTH_VERBS as readonly string[]).includes(command.name.split(' ')[1]!)) gaps.push(`${where}: "${command.name}" is a built-in command`)
    if (jobNames.has(noun)) gaps.push(`${where}: the noun "${noun}" is the job ${noun}`)
    if (looksPlural(noun, allowed)) gaps.push(`${where}: the noun "${noun}" looks plural; nouns are singular (or pass it in singular)`)
    for (const flag of command.flags) if (!command.resource && !flag.description) gaps.push(`${where}: the argument ${flag.key} has no description`)
    for (const flag of command.flags) if (GLOBAL_FLAGS.has(flag.name) && flag.name !== 'timeout') gaps.push(`${where}: the argument ${flag.key} is --${flag.name}, a flag every command already has; rename it`)
    if (needsExample && !command.examples.length) gaps.push(`${where}: no example; add cli: { name, examples: [{ run, about }] }`)
    gaps.push(...exampleGaps(command, where))
  }
  for (const job of jobs) {
    const where = `job ${job.name}`
    if (!/^[a-z][a-z0-9-]*$/.test(job.name)) gaps.push(`${where}: a job is one lowercase kebab-case word`)
    if (builtIns.has(job.name) || job.name === 'auth') gaps.push(`${where}: "${job.name}" is a built-in command`)
    claim(job.name, where)
    for (const [key, arg] of Object.entries(job.args)) if (!arg.description) gaps.push(`${where}: the argument ${key} has no description`)
    for (const flag of jobCommand(job).flags) if (GLOBAL_FLAGS.has(flag.name) && flag.name !== 'timeout') gaps.push(`${where}: the argument ${flag.key} is --${flag.name}, a flag every command already has; rename it`)
    if (!job.examples.length) gaps.push(`${where}: no example`)
    gaps.push(...exampleGaps(jobCommand(job), where))
  }
  return gaps
}
