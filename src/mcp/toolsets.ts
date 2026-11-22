/**
 * Toolsets: named groups of a server's tools, so an agent loads only the tools its job needs. Every tool's name,
 * description and input schema sit in the model's context for the whole session; a client picks sets with the
 * `tools` query on the same endpoint (`/mcp?tools=core,flows`), and a plain `/mcp` still lists every tool.
 *
 * A tool belongs to the sets in its `toolset` (one name or several); a tool without one is in `core`, the set most
 * agents need. `all` selects every tool and is never a tool's set. Names a server doesn't have are ignored and named
 * in its instructions; when none is left the connection lists every tool.
 *
 * @example
 * const tools = [...coreTools, ...inToolset('flows', flowTools)]
 * toolsetSizes(tools).sets // → [{ name: 'core', tools: ['create_address', …], bytes: 27_912 }, { name: 'flows', … }]
 */
import { z } from '@hono/zod-openapi'
import type { ToolsetSummary } from '../core/discovery.js'

/** The set a tool without `toolset` is in: what most agents need. */
export const CORE_TOOLSET = 'core'
/** Selects every tool (`/mcp?tools=all`), the same as no `tools` query; no tool may name it as its set. */
export const ALL_TOOLSETS = 'all'
/** A toolset's name: lowercase, a letter first, then letters, digits and `-`, at most 32 characters. */
export const TOOLSET_NAME = /^[a-z][a-z0-9-]{0,31}$/

/** What toolsets need of a tool: the kit's `McpTool` fits. */
type Tool = { name: string; description: string; input: z.ZodObject; toolset?: string | readonly string[] }

/**
 * The sets a tool is in, `core` when it names none.
 *
 * @example
 * toolsetsOf({ toolset: ['core', 'flows'] }) // → ['core', 'flows']
 * toolsetsOf({}) // → ['core']
 */
export const toolsetsOf = (tool: { toolset?: string | readonly string[] }): string[] =>
  tool.toolset === undefined ? [CORE_TOOLSET] : typeof tool.toolset === 'string' ? [tool.toolset] : [...new Set(tool.toolset)]

/**
 * A feature's tools put in a set (or several). A tool that names its own `toolset` keeps it, so one tool of a
 * feature can stay in `core` while the rest move out.
 *
 * @example
 * inToolset('admin', keyTools().map((tool) => (tool.name === 'who_am_i' ? { ...tool, toolset: 'core' } : tool)))
 */
export const inToolset = <T extends { toolset?: string | readonly string[] }>(toolset: string | readonly string[], tools: readonly T[]): T[] =>
  tools.map((tool) => (tool.toolset === undefined ? { ...tool, toolset } : tool))

/**
 * Throws on a set name that can't be selected: not lowercase, too long, or `all`. `mcpServerFactory` calls it.
 *
 * @example
 * checkToolsets([{ name: 'odd', toolset: 'All' }]) // throws: tool odd: toolset "All" …
 */
export const checkToolsets = (tools: readonly { name: string; toolset?: string | readonly string[] }[]) => {
  for (const tool of tools)
    for (const name of toolsetsOf(tool))
      if (name === ALL_TOOLSETS || !TOOLSET_NAME.test(name)) throw new Error(`tool ${tool.name}: toolset "${name}" must match ${TOOLSET_NAME} and not be "${ALL_TOOLSETS}"`)
}

const bytesOf = (text: string) => new TextEncoder().encode(text).length

/**
 * What a model reads of a tool, in bytes: its name, description and input schema as JSON (about 4 bytes a token).
 *
 * @example
 * toolBytes(getNote) // → 412
 */
export const toolBytes = (tool: Tool) => bytesOf(JSON.stringify({ name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.input, { io: 'input' }) }))

export type ToolSize = { name: string; toolsets: string[]; bytes: number }
export type ToolsetSizes = {
  /** Every tool together: what a plain `/mcp` lists. */
  all: { tools: number; bytes: number }
  /** `core` first, then the others by name; a tool in two sets counts in both. */
  sets: ToolsetSummary[]
  /** Each tool, heaviest first. */
  tools: ToolSize[]
}

const sized = new WeakMap<readonly Tool[], ToolsetSizes>()
/**
 * Each toolset's tools and size, and each tool's size: to keep `core` lean (a test can hold it under a budget) and to
 * find the tools whose descriptions or schemas cost the most. Made once per tools array.
 *
 * @example
 * const { sets } = toolsetSizes(TOOLS)
 * expect(sets.find((set) => set.name === 'core')!.bytes).toBeLessThan(30_000)
 */
export const toolsetSizes = (tools: readonly Tool[]): ToolsetSizes => {
  const known = sized.get(tools)
  if (known) return known
  const each = tools.map((tool) => ({ name: tool.name, toolsets: toolsetsOf(tool), bytes: toolBytes(tool) }))
  const names = [...new Set(each.flatMap((tool) => tool.toolsets))].sort((a, b) => (a === CORE_TOOLSET ? -1 : b === CORE_TOOLSET ? 1 : a.localeCompare(b)))
  const sizes: ToolsetSizes = {
    all: { tools: each.length, bytes: each.reduce((sum, tool) => sum + tool.bytes, 0) },
    sets: names.map((name) => {
      const inside = each.filter((tool) => tool.toolsets.includes(name))
      return { name, tools: inside.map((tool) => tool.name), bytes: inside.reduce((sum, tool) => sum + tool.bytes, 0) }
    }),
    tools: [...each].sort((a, b) => b.bytes - a.bytes),
  }
  sized.set(tools, sizes)
  return sizes
}

const toolCount = (count: number) => `${count} tool${count === 1 ? '' : 's'}`

/** `27912` → `~28 KB`. */
export const kilobytes = (bytes: number) => `~${Math.max(1, Math.round(bytes / 1000))} KB`

/**
 * The set names a request asks for: the `tools` query, comma-separated or repeated, trimmed and lowercased; `[]`
 * when it asks for none.
 *
 * @example
 * requestedToolsets('https://mail.example/mcp?tools=core,Flows') // → ['core', 'flows']
 */
export const requestedToolsets = (url: string | undefined): string[] =>
  url ? [...new Set(new URL(url).searchParams.getAll('tools').flatMap((value) => value.split(',')).map((name) => name.trim().toLowerCase()).filter(Boolean))] : []

/** What a connection lists: the selected sets (`null` for every tool), and the names it asked for that don't exist. */
export type ToolsetChoice = { sets: string[] | null; unknown: string[] }

/**
 * Which sets a request selects among the ones that exist. Unknown names are dropped (and returned, for the
 * instructions); none left, or `all` among them, selects every tool.
 *
 * @example
 * chooseToolsets(['flows', 'flwos'], ['core', 'flows']) // → { sets: ['flows'], unknown: ['flwos'] }
 */
export const chooseToolsets = (requested: string[], existing: string[]): ToolsetChoice => {
  const unknown = requested.filter((name) => name !== ALL_TOOLSETS && !existing.includes(name))
  const sets = requested.filter((name) => existing.includes(name)).sort()
  return { sets: requested.includes(ALL_TOOLSETS) || !sets.length ? null : sets, unknown }
}

/**
 * The paragraph a server's instructions end with when it has toolsets: what this connection lists, every set with
 * its size, how to connect with others, and that a tool outside the selection can't be called here.
 *
 * @example
 * toolsetsText(toolsetSizes(TOOLS), { sets: ['core'], unknown: [] }, '/mcp')
 * // → 'Toolsets: this connection lists core (23 of 122 tools). Sets: core (23 tools, ~28 KB), flows (…). …'
 */
export const toolsetsText = (sizes: ToolsetSizes, choice: ToolsetChoice, path: string) => {
  const listed = choice.sets ? sizes.sets.filter((set) => choice.sets!.includes(set.name)) : sizes.sets
  const count = new Set(listed.flatMap((set) => set.tools)).size
  const sets = sizes.sets.map((set) => `${set.name} (${toolCount(set.tools.length)}, ${kilobytes(set.bytes)})`).join(', ')
  return [
    ...(choice.unknown.length ? [`Unknown toolsets ignored: ${choice.unknown.join(', ')}.`] : []),
    choice.sets
      ? `Toolsets: this connection lists ${choice.sets.join(', ')} (${count} of ${sizes.all.tools} tools); a tool outside them can't be called on it.`
      : `Toolsets: this connection lists every tool (${sizes.all.tools}, ${kilobytes(sizes.all.bytes)}).`,
    `Sets: ${sets}.`,
    `Connect to ${path}?tools=${CORE_TOOLSET} for what most jobs need and add sets by name (${path}?tools=${sizes.sets.slice(0, 2).map((set) => set.name).join(',')}); ${path} lists every tool.`,
  ].join(' ')
}
