/** The team routes as MCP tools. Signing in with a passkey is a browser's job, so those routes have no tools. */
import { z } from '@hono/zod-openapi'
import { mcpTool, type McpTool } from '../mcp/index.js'

type Person = { id: string; email: string; role: string; lastSeenAt: string | null }
type Team = { people: Person[]; domains: { domain: string }[] }
const line = (person: Person) => `${person.email} · ${person.role} · id ${person.id} · last seen ${person.lastSeenAt ?? 'never'}`
const summary = (team: Team) => [...team.people.map(line), ...team.domains.map(({ domain }) => `anyone @${domain} · member`)].join('\n') || 'Nobody yet.'

/**
 * The MCP tools for the team: list it, add a person or a domain, change a role, remove someone.
 *
 * @example
 * mcpServerFactory({ tools: [...featureTools, ...teamTools()], … })
 */
export const teamTools = ({ path = '/api/team' }: { path?: string } = {}): McpTool[] => {
  const id = z.string().describe('The person’s id (`prs_…`), from list_team.')
  return [
    mcpTool({
      name: 'list_team',
      title: 'The team',
      description: 'Everyone who may sign in to this deployment, with their role, and the email domains let in as members.',
      input: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: () => ({ path }),
      summarize: summary,
    }),
    mcpTool({
      name: 'add_to_team',
      title: 'Add someone to the team',
      description: 'Lets a person (email, role member unless given) or a whole email domain sign in through Cloudflare Access. Owner or a deployment key only.',
      input: z.object({
        email: z.string().optional().describe('A person to let in.'),
        domain: z.string().optional().describe('Or a whole email domain, as members.'),
        role: z.enum(['owner', 'member']).optional(),
      }),
      annotations: { openWorldHint: false },
      call: (body) => ({ method: 'POST', path, body }),
      summarize: (team: Team) => `The team now:\n${summary(team)}`,
    }),
    mcpTool({
      name: 'change_team_role',
      title: 'Change someone’s role',
      description: 'Makes a member an owner or the other way round; the last owner stays an owner.',
      input: z.object({ id, role: z.enum(['owner', 'member']) }),
      annotations: { openWorldHint: false },
      call: ({ id, role }) => ({ method: 'PATCH', path: `${path}/people/${id}`, body: { role } }),
      summarize: (person: Person) => `Now: ${line(person)}`,
    }),
    mcpTool({
      name: 'remove_from_team',
      title: 'Remove someone from the team',
      description: 'Signs them out everywhere and deletes their passkeys. The last owner cannot be removed.',
      input: z.object({ id }),
      annotations: { destructiveHint: true, openWorldHint: false },
      call: ({ id }) => ({ method: 'DELETE', path: `${path}/people/${id}` }),
      summarize: (_json: unknown, { id }) => `Removed ${id} from the team.`,
    }),
  ]
}
