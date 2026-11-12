/** The key routes as MCP tools. */
import { z } from '@hono/zod-openapi'
import { mcpTool, type McpTool } from '../mcp/index.js'

type Card = { id: string; name: string; start: string; createdBy: string; lastUsedAt: string | null }
const line = (row: Card) => `${row.name} · id ${row.id} · starts ${row.start} · made by ${row.createdBy} · last used ${row.lastUsedAt ?? 'never'}`

/**
 * The MCP tools for the key routes: who am I, list, read, make and revoke.
 *
 * @example
 * mcpServerFactory({ tools: [...FEATURE_TOOLS, ...keyTools()], … })
 */
export const keyTools = ({ path = '/api/keys', mePath = '/api/me' }: { path?: string; mePath?: string } = {}): McpTool[] => {
  const id = z.string().describe('The key’s id (`key_…`), from list_keys.')
  return [
    mcpTool({
      name: 'who_am_i',
      title: 'Who am I',
      description: 'Who you are calling as (which key, person or agent) and whether you may make and revoke keys. Use it to check that a key works.',
      input: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: () => ({ path: mePath }),
      summarize: (json: { kind: string; name: string; keyId: string | null; canManageKeys: boolean }) => `Calling as ${json.kind} ${json.name}${json.keyId ? ` (key id ${json.keyId})` : ''}. ${json.canManageKeys ? 'May' : 'May not'} make or revoke keys.`,
    }),
    mcpTool({
      name: 'list_keys',
      title: 'API keys',
      description: 'The API keys made through the API, with when each was last used, and the names of the keys set in the deployment. The keys themselves are never shown again.',
      input: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: () => ({ path }),
      summarize: (json: { fixedKeys: string[]; _embedded: { keys: Card[] } }) => [`Set in the deployment: ${json.fixedKeys.join(', ') || 'none'}`, ...(json._embedded.keys.length ? json._embedded.keys.map(line) : ['No keys made through the API.'])].join('\n'),
    }),
    mcpTool({
      name: 'get_key',
      title: 'One API key',
      description: 'One API key made through the API: name, start, maker, last use. Never the key itself.',
      input: z.object({ id }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: ({ id }) => ({ path: `${path}/${id}` }),
      summarize: (row: Card) => line(row),
    }),
    mcpTool({
      name: 'create_key',
      title: 'Make an API key',
      description: 'Makes an API key for one app, machine or person and returns it once: hand it to its holder, never keep it in a file or a message. Only a key set in the deployment or a signed-in person may make keys.',
      input: z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).describe('Who or what holds it, e.g. `billing-app`: lowercase letters, digits and hyphens.') }),
      annotations: { openWorldHint: false },
      call: (body) => ({ method: 'POST', path, body }),
      summarize: (json: Card & { key: string }) => `Made key ${json.name} (id ${json.id}). The key, shown only now: ${json.key}`,
    }),
    mcpTool({
      name: 'delete_key',
      title: 'Revoke an API key',
      description: 'Revokes an API key at once: its next request is refused. Only a key set in the deployment or a signed-in person may revoke keys.',
      input: z.object({ id }),
      annotations: { destructiveHint: true, openWorldHint: false },
      call: ({ id }) => ({ method: 'DELETE', path: `${path}/${id}` }),
      summarize: (_json: unknown, { id }) => `Revoked key ${id}.`,
    }),
  ]
}
