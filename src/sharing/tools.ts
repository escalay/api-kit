/** The owner's sharing routes as MCP tools: for the owner's own MCP only, never through A2A. */
import { z } from '@hono/zod-openapi'
import { mcpTool, type McpTool } from '../mcp/index.js'
import { LIFETIMES, SCOPES } from './schema.js'

type InviteCard = { id: string; label: string; scope: string; lifetime: string; state: string; redeemBy: string }
type MemberCard = { id: string; label: string; appName: string; returnsTo: string; scope: string; lifetime: string; state: string }
type SharingCard = { space: string; title: string; openInvites: number }
type Paged = { _links: { next?: { href: string } | null } }
type InvitePage = Paged & { _embedded: { invites: InviteCard[] } }
type MemberPage = Paged & { _embedded: { members: MemberCard[] } }

const ON_WORD = 'Use it only when the user asks.'
const inviteLine = (invite: InviteCard) => `${invite.label} · ${invite.state} · ${invite.scope}, ${invite.lifetime} · redeem by ${invite.redeemBy} · id ${invite.id}`
const memberLine = (member: MemberCard) => `${member.label} · ${member.state === 'active' ? 'active' : 'signed out'} · ${member.scope}, ${member.lifetime} · ${member.appName} (returns to ${member.returnsTo}) · id ${member.id}`
/** The line that says a page has more after it, with the cursor that continues; none on the last page. */
const moreLine = (page: Paged, noun: string, tool: string) => {
  const cursor = page._links.next ? new URL(page._links.next.href).searchParams.get('cursor') : null
  return cursor ? [`More ${noun}: call ${tool} again with cursor ${cursor}`] : []
}
/** A page of invites as the agent reads it: a line each, then whether more follow. */
const invitesText = (page: InvitePage) => {
  const lines = page._embedded.invites.map(inviteLine)
  return lines.length ? [...lines, ...moreLine(page, 'invites', 'list_invites')].join('\n') : 'No invites yet. create_invite makes one.'
}
/** A page of members as the agent reads it: a line each, then whether more follow. */
const membersText = (page: MemberPage) => {
  const lines = page._embedded.members.map(memberLine)
  return lines.length ? [...lines, ...moreLine(page, 'members', 'list_members')].join('\n') : 'No members yet: no one has joined.'
}
const sharingLine = (json: SharingCard) =>
  `${json.title} (${json.space}): ${json.openInvites} open invite${json.openInvites === 1 ? '' : 's'}.`

/**
 * The MCP tools for the owner's sharing routes: a space's sharing, invites made, listed and revoked, and members
 * listed, removed and invited again. Each acts only on the user's word; `create_invite` and
 * `invite_again` return the message to send and never send it. Give them to the owner's MCP only, never to
 * `mountA2A`: a delegating agent must not mint invites.
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
      description: `How many invites to a ${noun} are open. ${ON_WORD}`,
      input: z.object({ space }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      cli: { name: 'sharing view', examples: [{ run: 'sharing view soups', about: `How the ${noun} soups is shared` }] },
      call: ({ space }) => ({ path: `${at(space)}/sharing` }),
      summarize: (json: SharingCard) => sharingLine(json),
    }),
    mcpTool({
      name: 'create_invite',
      title: `Invite someone to a ${noun}`,
      description: `Makes a single-use invite to one ${noun} for one person, used within a day: a code, shown only now, and a message with the code and the ${noun}’s address for the user to send. This tool never sends it. ${ON_WORD}`,
      input: z.object({
        space,
        label: z.string().describe('Who it is for, as the user will recognise them (`Sam`).'),
        scope: z.enum(SCOPES).optional().describe('`read` (the default) or `write` to make changes too.'),
        lifetime: z.enum(LIFETIMES).optional().describe('How long the access lasts once used: `7d`, `30d` (the default) or `until_revoked`, which an agent’s own token may not give.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      cli: { name: 'invite create', examples: [{ run: 'invite create soups --label Sam', about: 'Invite Sam to soups, read only for 30 days' }] },
      call: ({ space, ...body }) => ({ method: 'POST', path: `${at(space)}/invites`, body }),
      summarize: (json: InviteCard & { message: string }) => `Made invite ${json.id} for ${json.label} (${json.scope}, ${json.lifetime}). Its code is shown only now: give the user this message to send.\n\n${json.message}`,
    }),
    mcpTool({
      name: 'list_invites',
      title: `A ${noun}’s invites`,
      description: `The invites to a ${noun}, newest first, each open, redeemed, revoked or expired, a page at a time: the answer ends with the cursor for the next page while there is more. Never their codes. ${ON_WORD}`,
      input: z.object({ space, limit: z.number().int().min(1).max(100).optional().describe('At most this many (default 50).'), cursor: z.string().optional().describe('Where to continue, from the last answer.') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      cli: { name: 'invite list', examples: [{ run: 'invite list soups', about: 'Every invite to soups' }] },
      call: ({ space, limit, cursor }) => ({ path: `${at(space)}/invites`, query: { limit, cursor } }),
      summarize: (page: InvitePage) => invitesText(page),
    }),
    mcpTool({
      name: 'revoke_invite',
      title: 'Revoke an invite',
      description: `Revokes an invite no one has used: its code stops working at once. ${ON_WORD}`,
      input: z.object({ space, id: z.string().describe('The invite’s id (`inv_…`), from list_invites.') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      cli: { name: 'invite revoke', examples: [{ run: 'invite revoke soups inv_a1b2 --yes', about: 'Revoke an invite to soups' }] },
      call: ({ space, id }) => ({ method: 'DELETE', path: `${at(space)}/invites/${encodeURIComponent(id)}` }),
      summarize: (_json: unknown, { id }) => `Revoked invite ${id}.`,
    }),
    mcpTool({
      name: 'list_members',
      title: `A ${noun}’s members`,
      description: `The apps signed in to a ${noun}, newest first, each active or signed out (invite_again gives a signed-out one a fresh invite), a page at a time: the answer ends with the cursor for the next page while there is more. ${ON_WORD}`,
      input: z.object({ space, limit: z.number().int().min(1).max(100).optional().describe('At most this many (default 50).'), cursor: z.string().optional().describe('Where to continue, from the last answer.') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      cli: { name: 'member list', examples: [{ run: 'member list soups', about: 'Everyone signed in to soups' }] },
      call: ({ space, limit, cursor }) => ({ path: `${at(space)}/members`, query: { limit, cursor } }),
      summarize: (page: MemberPage) => membersText(page),
    }),
    mcpTool({
      name: 'invite_again',
      title: 'Invite a member again',
      description: `A fresh invite for a member who lost their sign-in, with the same label, access and lifetime: shown only now, with a message for the user to send. This tool never sends it. Once it is used, the old sign-in ends. ${ON_WORD}`,
      input: z.object({ space, id: z.string().describe('The member’s id (`mem_…`), from list_members.') }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      cli: { name: 'member reinvite', examples: [{ run: 'member reinvite soups mem_a1b2', about: 'A fresh invite for a member of soups' }] },
      call: ({ space, id }) => ({ method: 'POST', path: `${at(space)}/members/${encodeURIComponent(id)}/invite-again` }),
      summarize: (json: InviteCard & { message: string }) => `Made invite ${json.id} for ${json.label} (${json.scope}, ${json.lifetime}), replacing their old sign-in once used. Its code is shown only now: give the user this message to send.\n\n${json.message}`,
    }),
    mcpTool({
      name: 'remove_member',
      title: 'Remove a member',
      description: `Ends a member’s sign-in at once, takes it off the list, and ends its invites, Invite again ones too. To let them back, make a new invite. ${ON_WORD}`,
      input: z.object({ space, id: z.string().describe('The member’s id (`mem_…`), from list_members.') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      cli: { name: 'member remove', examples: [{ run: 'member remove soups mem_a1b2 --yes', about: 'Remove a member of soups' }] },
      call: ({ space, id }) => ({ method: 'DELETE', path: `${at(space)}/members/${encodeURIComponent(id)}` }),
      summarize: (_json: unknown, { id }) => `Removed member ${id}: its sign-in has ended.`,
    }),
  ]
}
