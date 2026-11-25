/** The __labels__ routes as MCP tools: thin calls an agent makes with the owner's credentials. */
import { z } from '@hono/zod-openapi'
import { mcpTool, type McpTool } from '../../kit/mcp/index.js'
import { PATH } from './routes.js' // feature:flat
import { PATH, pathUnder } from './routes.js' // feature:under

type Card = { id: string; __card_fields__; updatedAt: string }
type Page = { _embedded: { __camel__: Card[] }; _links: { next?: { href: string } } }
// The fields an agent picks by (a state, a short value) on every line, so a list answers "which are done"
const line = (row: Card) => `${row.__first__}__line_fields__ · id ${row.id} · changed ${row.updatedAt.slice(0, 10)}`
const id = z.string().describe('The __label__’s id, from list___snake__.')
const __parent_snake_singular__ = z.string().describe('The __parent_label__’s id, from list___parent_snake__.') // feature:under

export const __camel__Tools: McpTool[] = [
  mcpTool({
    name: 'list___snake__', title: '__Pascal__', description: 'The __labels__, the newest first, a page at a time, each with its id. Start here.',
    input: z.object({
      __parent_snake_singular__, // feature:under
      limit: z.number().int().min(1).max(100).optional().describe('At most this many (default 50).'),
      cursor: z.string().optional().describe('Where the next page starts: the cursor the last page ended with.'),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    cli: { name: '__kebab_singular__ list', examples: [{ run: '__kebab_singular__ list --limit 10', about: 'The ten newest' }] },
    call: (args) => ({ path: PATH, query: args }), // feature:flat
    call: ({ __parent_snake_singular__, ...args }) => ({ path: pathUnder(__parent_snake_singular__), query: args }), // feature:under
    // The cursor is `_links.next`'s, so the agent asks for the next page with it
    summarize: (page: Page) => {
      const cursor = page._links.next && new URL(page._links.next.href).searchParams.get('cursor')
      return [page._embedded.__camel__.map(line).join('\n') || 'None yet.', ...(cursor ? [`More: list___snake__ with cursor ${cursor}`] : [])].join('\n')
    },
  }),
  mcpTool({
    name: 'get___snake_singular__', title: 'One __label__', description: 'A __label__ with all its fields.',
    input: z.object({ id }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    cli: { name: '__kebab_singular__ view', examples: [{ run: '__kebab_singular__ view <id>', about: 'One, with all its fields' }] },
    call: ({ id }) => ({ path: `${PATH}/${encodeURIComponent(id)}` }),
    summarize: (row: Card) => [line(row), __detail_lines__].join('\n'),
  }),
  mcpTool({
    name: 'create___snake_singular__', title: 'Make a __label__', description: 'Makes a __label__.',
    input: z.object({ __tool_create_fields__ }), // feature:flat
    input: z.object({ __parent_snake_singular__, __tool_create_fields__ }), // feature:under
    annotations: { openWorldHint: false },
    cli: { name: '__kebab_singular__ create', examples: [{ run: '__kebab_singular__ create __create_flags__', about: 'Make one' }] },
    call: (body) => ({ method: 'POST', path: PATH, body }), // feature:flat
    call: ({ __parent_snake_singular__, ...body }) => ({ method: 'POST', path: pathUnder(__parent_snake_singular__), body }), // feature:under
    summarize: (row: Card) => `Made: ${line(row)}`,
  }),
  mcpTool({
    name: 'update___snake_singular__', title: 'Change a __label__', description: 'Changes the fields given; the others stay as they are.',
    input: z.object({ id, __tool_update_fields__ }),
    annotations: { idempotentHint: true, openWorldHint: false },
    cli: { name: '__kebab_singular__ edit', examples: [{ run: '__kebab_singular__ edit <id> __edit_flags__', about: 'Change one field' }] },
    call: ({ id, ...change }) => ({ method: 'PATCH', path: `${PATH}/${encodeURIComponent(id)}`, body: change }),
    summarize: (row: Card) => `Changed: ${line(row)}`,
  }),
  mcpTool({ // feature:remove
    name: 'delete___snake_singular__', title: 'Delete a __label__', description: 'Deletes a __label__ for good. Ask the owner first.', // feature:remove
    input: z.object({ id }), // feature:remove
    annotations: { destructiveHint: true, openWorldHint: false }, // feature:remove
    cli: { name: '__kebab_singular__ delete', examples: [{ run: '__kebab_singular__ delete <id> --yes', about: 'Delete it for good' }] }, // feature:remove
    call: ({ id }) => ({ method: 'DELETE', path: `${PATH}/${encodeURIComponent(id)}` }), // feature:remove
    summarize: () => 'Deleted.', // feature:remove
  }), // feature:remove
]
