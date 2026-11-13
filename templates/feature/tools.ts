/** The __labels__ routes as MCP tools: thin calls an agent makes with the owner's credentials. */
import { z } from '@hono/zod-openapi'
import { mcpTool, type McpTool } from '../../kit/mcp/index.js'
import { PATH } from './routes.js'

type Card = { id: string; title: string; body: string | null; updatedAt: string }
const line = (row: Card) => `${row.title} · id ${row.id} · changed ${row.updatedAt.slice(0, 10)}`
const id = z.string().describe('The __label__’s id, from list___snake__.')

export const __camel__Tools: McpTool[] = [
  mcpTool({
    name: 'list___snake__', title: '__Pascal__', description: 'Every __label__, the newest changed first, with its id. Start here.',
    input: z.object({ limit: z.number().int().min(1).max(100).optional().describe('At most this many (default 50).') }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    cli: { name: '__kebab_singular__ list', examples: [{ run: '__kebab_singular__ list --limit 10', about: 'The ten newest' }] },
    call: (args) => ({ path: PATH, query: args }),
    summarize: (json: { _embedded: { __camel__: Card[] } }) => json._embedded.__camel__.map(line).join('\n') || 'None yet.',
  }),
  mcpTool({
    name: 'get___snake_singular__', title: 'One __label__', description: 'A __label__ with its full text.',
    input: z.object({ id }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    cli: { name: '__kebab_singular__ view', examples: [{ run: '__kebab_singular__ view <id>', about: 'One, with its full text' }] },
    call: ({ id }) => ({ path: `${PATH}/${encodeURIComponent(id)}` }),
    summarize: (row: Card) => `${line(row)}\n\n${row.body ?? '(no text)'}`,
  }),
  mcpTool({
    name: 'create___snake_singular__', title: 'Make a __label__', description: 'Makes a __label__ with a title and, optionally, its text.',
    input: z.object({ title: z.string().min(1).max(200).describe('A short title.'), body: z.string().max(10_000).optional().describe('Its text.') }),
    annotations: { openWorldHint: false },
    cli: { name: '__kebab_singular__ create', examples: [{ run: '__kebab_singular__ create --title "First one" --body "Some text"', about: 'Make one with its text' }] },
    call: (body) => ({ method: 'POST', path: PATH, body }),
    summarize: (row: Card) => `Made: ${line(row)}`,
  }),
  mcpTool({
    name: 'update___snake_singular__', title: 'Change a __label__', description: 'Changes a __label__’s title, its text, or both.',
    input: z.object({ id, title: z.string().min(1).max(200).optional().describe('A new title.'), body: z.string().max(10_000).optional().describe('New text.') }),
    annotations: { idempotentHint: true, openWorldHint: false },
    cli: { name: '__kebab_singular__ edit', examples: [{ run: '__kebab_singular__ edit <id> --title "A better title"', about: 'Change its title' }] },
    call: ({ id, ...change }) => ({ method: 'PATCH', path: `${PATH}/${encodeURIComponent(id)}`, body: change }),
    summarize: (row: Card) => `Changed: ${line(row)}`,
  }),
  mcpTool({
    name: 'delete___snake_singular__', title: 'Delete a __label__', description: 'Deletes a __label__ for good. Ask the owner first.',
    input: z.object({ id }),
    annotations: { destructiveHint: true, openWorldHint: false },
    cli: { name: '__kebab_singular__ delete', examples: [{ run: '__kebab_singular__ delete <id> --yes', about: 'Delete it for good' }] },
    call: ({ id }) => ({ method: 'DELETE', path: `${PATH}/${encodeURIComponent(id)}` }),
    summarize: () => 'Deleted.',
  }),
]
