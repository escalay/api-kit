/** The owner's sharing routes as MCP tools: for the owner's own MCP only, never through A2A. */
import { z } from '@hono/zod-openapi'
import { mcpTool, type McpTool } from '../mcp/index.js'
import { LIFETIMES, SCOPES } from './schema.js'

type InviteCard = { id: string; label: string; scope: string; lifetime: string; state: string; redeemBy: string }
type SharingCard = { space: string; title: string; askToJoin: string; askToJoinOffered: boolean; openInvites: number }

const ON_WORD = 'Use it only when the user asks.'
const inviteLine = (invite: InviteCard) => `${invite.label} · ${invite.state} · ${invite.scope}, ${invite.lifetime} · redeem by ${invite.redeemBy} · id ${invite.id}`
const sharingLine = (json: SharingCard) =>
  `${json.title} (${json.space}): asking to join ${json.askToJoinOffered ? json.askToJoin : 'not offered by this app'}; ${json.openInvites} open invite${json.openInvites === 1 ? '' : 's'}.`

/**
 * The MCP tools for the owner's sharing routes: a space's sharing, the Ask to join switch, and invites made, listed
 * and revoked. Each acts only on the user's word; `create_invite` returns the message to send and never sends it. Give
 * them to the owner's MCP only, never to `mountA2A`: a delegating agent must not mint invites.
 *
 * @example
 * mcpServerFactory({ tools: [...FEATURE_TOOLS, ...sharingTools({ noun: 'shelf' })], … })
 */
export const sharingTools = ({ path = '/api/spaces', noun = 'space' }: { path?: string; noun?: string } = {}): McpTool[] => {
  const space = z.string().describe(`The ${noun}’s name, as in its address (\`soups\`).`)
  const at = (name: string) => `${path}/${encodeURIComponent(name)}`
  return [
    mcpTool({
      name: 'get_sharing',
      title: `How a ${noun} is shared`,
      description: `Whether people may ask to join a ${noun}, and how many invites are open. ${ON_WORD}`,
      input: z.object({ space }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      cli: { name: 'sharing view', examples: [{ run: 'sharing view soups', about: `How the ${noun} soups is shared` }] },
      call: ({ space }) => ({ path: `${at(space)}/sharing` }),
      summarize: (json: SharingCard) => sharingLine(json),
    }),
    mcpTool({
      name: 'set_ask_to_join',
      title: 'Switch asking to join',
      description: `Lets people ask to join a ${noun} (the owner then approves or refuses each), or stops it, refusing everyone waiting. ${ON_WORD}`,
      input: z.object({ space, askToJoin: z.boolean().describe('true lets people ask; false refuses everyone waiting.') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      cli: { name: 'sharing edit', examples: [{ run: 'sharing edit soups --ask-to-join', about: 'Let people ask to join soups' }, { run: 'sharing edit soups --no-ask-to-join', about: 'Stop asking, refusing everyone waiting' }] },
      call: ({ space, askToJoin }) => ({ method: 'PATCH', path: `${at(space)}/sharing`, body: { askToJoin } }),
      summarize: (json: SharingCard) => sharingLine(json),
    }),
    mcpTool({
      name: 'create_invite',
      title: `Invite someone to a ${noun}`,
      description: `Makes a single-use invite to one ${noun} for one person, used within a day: a link and a code, shown only now, and a message with both for the user to send. This tool never sends it. ${ON_WORD}`,
      input: z.object({
        space,
        label: z.string().describe('Who it is for, as the user will recognise them (`Sam`).'),
        scope: z.enum(SCOPES).optional().describe('`read` (the default) or `write` to make changes too.'),
        lifetime: z.enum(LIFETIMES).optional().describe('How long the access lasts once used: `7d`, `30d` (the default) or `until_revoked`, which an agent’s own token may not give.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      cli: { name: 'invite create', examples: [{ run: 'invite create soups --label Sam', about: 'Invite Sam to soups, read only for 30 days' }] },
      call: ({ space, ...body }) => ({ method: 'POST', path: `${at(space)}/invites`, body }),
      summarize: (json: InviteCard & { message: string }) => `Made invite ${json.id} for ${json.label} (${json.scope}, ${json.lifetime}). Its link and code are shown only now: give the user this message to send.\n\n${json.message}`,
    }),
    mcpTool({
      name: 'list_invites',
      title: `A ${noun}’s invites`,
      description: `The invites to a ${noun}, newest first, each open, redeemed, revoked or expired. Never their links or codes. ${ON_WORD}`,
      input: z.object({ space, limit: z.number().int().min(1).max(100).optional().describe('At most this many (default 50).'), cursor: z.string().optional().describe('Where to continue, from the last answer.') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      cli: { name: 'invite list', examples: [{ run: 'invite list soups', about: 'Every invite to soups' }] },
      call: ({ space, limit, cursor }) => ({ path: `${at(space)}/invites`, query: { limit, cursor } }),
      summarize: (json: { _embedded: { invites: InviteCard[] } }) => json._embedded.invites.map(inviteLine).join('\n') || 'No invites yet. create_invite makes one.',
    }),
    mcpTool({
      name: 'revoke_invite',
      title: 'Revoke an invite',
      description: `Revokes an invite no one has used: its link and code stop working at once. ${ON_WORD}`,
      input: z.object({ space, id: z.string().describe('The invite’s id (`inv_…`), from list_invites.') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      cli: { name: 'invite revoke', examples: [{ run: 'invite revoke soups inv_a1b2 --yes', about: 'Revoke an invite to soups' }] },
      call: ({ space, id }) => ({ method: 'DELETE', path: `${at(space)}/invites/${encodeURIComponent(id)}` }),
      summarize: (_json: unknown, { id }) => `Revoked invite ${id}.`,
    }),
  ]
}
