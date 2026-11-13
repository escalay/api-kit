/** The board routes as MCP tools, so an agent can keep what it finds for the owner. */
import { z } from '@hono/zod-openapi'
import { mcpTool, type McpTool } from '../mcp/index.js'

type BoardJson = { id: string; name: string; items: number; description?: string | null; _embedded?: { items: { ref: string; note: string | null; item: unknown }[] } }

/**
 * The MCP tools for the same routes, so an agent can keep what it finds for the owner: list, make, open, save to and
 * take off boards (and suggestions, when the app has them).
 *
 * @example
 * boardTools({ noun: 'recipes', label: (recipe) => `${recipe.title} (${recipe.year})`, suggestions: true })
 */
export const boardTools = ({ path = '/api/boards', noun, label, suggestions = false }: { path?: string; noun: string; label: (item: any) => string; suggestions?: boolean }): McpTool[] => {
  const line = (board: BoardJson) => `${board.name} · ${board.items} ${noun} · id ${board.id}`
  const tools: McpTool[] = [
    mcpTool({
      name: 'list_boards',
      title: 'The owner’s boards',
      description: `Every board (a named collection of ${noun} for a project) with how much is on it; give \`item\` to see which boards hold one.`,
      input: z.object({ item: z.string().optional().describe('Only boards holding this ref.') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      cli: { name: 'board list', examples: [{ run: 'board list', about: 'Every board' }] },
      call: ({ item }) => ({ path, query: item ? { item } : {} }),
      summarize: (json: { _embedded: { boards: BoardJson[] } }) => json._embedded.boards.map(line).join('\n') || 'No boards yet. create_board makes one.',
    }),
    mcpTool({
      name: 'create_board',
      title: 'Make a board',
      description: `A new, empty board to collect ${noun} for a project. Returns its id.`,
      input: z.object({ name: z.string().min(1).describe('A short name.'), description: z.string().optional().describe('What it is for.') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      cli: { name: 'board create', examples: [{ run: 'board create --name "Spring launch"', about: 'A board for a project' }] },
      call: (body) => ({ method: 'POST', path, body }),
      summarize: (json: BoardJson) => `Made ${line(json)}`,
    }),
    mcpTool({
      name: 'get_board',
      title: 'Open a board',
      description: `A board and the ${noun} on it, newest first, with their notes.`,
      input: z.object({ id: z.string().describe('The board’s id.') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      cli: { name: 'board view', examples: [{ run: 'board view brd_a1b2', about: 'A board and what is on it' }] },
      call: ({ id }) => ({ path: `${path}/${encodeURIComponent(id)}` }),
      summarize: (json: BoardJson) => [line(json), ...(json._embedded?.items ?? []).map((entry) => `- ${entry.item ? label(entry.item) : `${entry.ref} (no longer in the catalog)`}${entry.note ? ` — ${entry.note}` : ''}`)].join('\n'),
    }),
    mcpTool({
      name: 'save_to_board',
      title: 'Save to a board',
      description: `Puts one of the ${noun} on a board, with an optional note on why; saving it again only changes the note.`,
      input: z.object({ id: z.string().describe('The board’s id.'), ref: z.string().describe('The item’s ref, from a search result (e.g. its id).'), note: z.string().optional().describe('Why it belongs here.') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      cli: { name: 'board save', examples: [{ run: 'board save brd_a1b2 item_1 --note "for the menu"', about: 'Keep an item on a board, with why' }] },
      call: ({ id, ref, note }) => ({ method: 'PUT', path: `${path}/${encodeURIComponent(id)}/items/${encodeURIComponent(ref)}`, body: note ? { note } : {} }),
      summarize: (json: BoardJson) => `Saved. ${line(json)}`,
    }),
    mcpTool({
      name: 'remove_from_board',
      title: 'Take off a board',
      description: `Takes one of the ${noun} off a board.`,
      input: z.object({ id: z.string().describe('The board’s id.'), ref: z.string().describe('The item’s ref.') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      cli: { name: 'board remove', examples: [{ run: 'board remove brd_a1b2 item_1 --yes', about: 'Take an item off a board' }] },
      call: ({ id, ref }) => ({ method: 'DELETE', path: `${path}/${encodeURIComponent(id)}/items/${encodeURIComponent(ref)}` }),
      summarize: () => 'Removed.',
    }),
  ]
  if (suggestions)
    tools.push(
      mcpTool({
        name: 'board_suggestions',
        title: 'More like a board',
        description: `${noun[0]!.toUpperCase()}${noun.slice(1)} like the ones on a board, best first, leaving out what is already on it.`,
        input: z.object({ id: z.string().describe('The board’s id.'), limit: z.number().int().min(1).max(100).optional().describe('At most this many.') }),
        cli: { name: 'board suggestions', examples: [{ run: 'board suggestions brd_a1b2 --limit 5', about: 'Five more like the board' }] },
        annotations: { readOnlyHint: true, openWorldHint: false },
        call: ({ id, limit }) => ({ path: `${path}/${encodeURIComponent(id)}/suggestions`, query: limit ? { limit } : {} }),
        summarize: (json: { _embedded: { items: unknown[] } }) => json._embedded.items.map((item) => `- ${label(item)}`).join('\n') || 'Nothing yet: add a few items first.',
      }),
    )
  return tools
}
