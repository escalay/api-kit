/**
 * STANDARD §23's last rule, end to end over `test/sharing-fixture.ts`: a recipe box shares its shelves, tested as a
 * browser and an agent use it. The owner approves through `approveSignIn`, an invitee's app through the part's own
 * page (`form`); then a shelf's token is refused at another shelf, a spent invite is refused, a removed member's
 * token is refused, and a shelf that exists and one that does not answer alike.
 */
import { describe, expect, it } from 'vitest'
import { ONLY_ITS_SPACE } from '../src/sharing/index.js'
import { approveSignIn, connectAgent } from '../src/testing/index.js'
import { CLIENT_A, ORIGIN, OWNER, OWNER_KEY, READER_KEY, recipeBox, SAMPLE_APP, shelfAddress, type RecipeBox } from './sharing-fixture.js'

const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
const AS_OWNER = { 'x-test-owner': OWNER }
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

type ToolResult = { isError?: boolean; content: { text: string }[] }

/** Calls an MCP tool at `at` with a bearer, as an agent does: the answer's status and, on a 200, its result. */
const callTool = async (box: RecipeBox, at: string, bearer: string, name: string, args: Record<string, unknown> = {}) => {
  const answer = await box.app.request(at, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: META } }),
  })
  const text = await answer.text()
  return { status: answer.status, text, result: answer.status === 200 ? ((JSON.parse(text) as { result: ToolResult }).result) : null }
}
const toolText = async (...args: Parameters<typeof callTool>) => {
  const { status, text, result } = await callTool(...args)
  expect([status, result?.isError ?? false], text).toEqual([200, false])
  return result!.content[0]!.text
}

/** An app connecting to `address` as an MCP client does, through the testing part's `connectAgent`. */
const connect = async (box: RecipeBox, options: { address: string; redirect: string; approve: (query: URLSearchParams) => Promise<Response> }) => connectAgent(box.app, { ...options, name: 'Sample' })

/** The owner's own agent at `/mcp`, approved on the kit's consent page: a root token. */
const ownerAgent = async (box: RecipeBox) => (await connect(box, { address: `${ORIGIN}/mcp`, redirect: CLIENT_A, approve: (query) => approveSignIn(box.app, query, { headers: AS_OWNER }) })).tokens!.access_token
/** An invite made with the owner's agent through `create_invite`: the message to send, and the address and code it carries. */
const inviteWithAgent = async (box: RecipeBox, owner: string, shelf: string, label: string) => {
  const message = await toolText(box, '/mcp', owner, 'create_invite', { space: shelf, label })
  const address = /https?:\/\/\S+\/mcp\b/.exec(message)?.[0] ?? ''
  return { message, address, code: /[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}/.exec(message)![0] }
}
/** An app joining at `address` with an invite's code typed on the part's page. */
const joinWithCode = (box: RecipeBox, address: string, code: string, redirect = CLIENT_A) =>
  connect(box, { address, redirect, approve: (query) => approveSignIn(box.app, query, { form: { action: '/sharing/join', fields: { code } } }) })

/** The box with the owner's agent, and Sam's app joined at Soups with only what the invite's message says. */
const samAtSoups = async () => {
  const box = await recipeBox()
  const owner = await ownerAgent(box)
  const { message, address, code } = await inviteWithAgent(box, owner, 'soups', 'Sam')
  const sam = (await joinWithCode(box, address, code)).tokens!
  return { box, owner, message, address, code, sam: sam.access_token, scope: sam.scope }
}

describe('a recipe box shares its shelves', () => {
  it('connects as a third-party agent does, and names the step that failed', async () => {
    const box = await recipeBox()
    await expect(connectAgent(box.app, { address: `${ORIGIN}/api/health`, approve: async () => new Response(null) })).rejects.toThrow(/^connectAgent: http:\/\/localhost\/api\/health answered \d+ without a resource_metadata challenge$/)
    // A refusal is an answer, not a failure: no tokens, and the page that said so
    const refused = await connectAgent(box.app, { address: `${ORIGIN}/mcp`, approve: (query) => approveSignIn(box.app, query, { headers: AS_OWNER, decision: 'deny' }) })
    expect([refused.page.status, refused.tokens]).toEqual([302, null])
    expect(new URL(refused.page.headers.get('location')!).searchParams.get('error')).toBe('access_denied')
  })

  it('the owner invites Sam through their own agent, Sam’s app joins with the code, and Sam’s agent reads Soups through its tools', async () => {
    const { box, owner, message, address, sam, scope } = await samAtSoups()
    // The message names the shelf's address and the code, and no page that nothing serves
    expect(address).toBe(shelfAddress('soups'))
    expect(message).not.toContain('/sharing/join/')
    // The app asked for read and write; the invite gives read
    expect(scope).toBe('read')
    expect(await toolText(box, '/box/soups/mcp', sam, 'list_recipes')).toBe('soups: Leek soup')
    const write = await callTool(box, '/box/soups/mcp', sam, 'add_recipe', { name: 'Pea soup' })
    expect([write.status, write.result?.isError]).toEqual([200, true])
    expect(box.recipes.get('soups')).toEqual(['Leek soup'])
    // The owner sees Sam, and the owner's own root token works at every shelf
    expect(await toolText(box, '/mcp', owner, 'list_members', { space: 'soups' })).toMatch(/^Sam · active · read, 30d · Sample \(returns to client-a\.example\.test\)/)
    expect(await toolText(box, '/box/bakes/mcp', owner, 'add_recipe', { name: 'Scones' })).toBe('bakes: Rye bread, Scones')
  })

  it('holds a shelf’s token to its shelf: refused at another shelf, at its routes, the owner’s MCP and the sharing routes', async () => {
    const { box, sam } = await samAtSoups()
    const call = (path: string) => box.app.request(path, { headers: { authorization: `Bearer ${sam}` } })
    expect((await call('/api/shelves/soups/recipes')).status).toBe(200)
    const atBakes = await callTool(box, '/box/bakes/mcp', sam, 'list_recipes')
    expect([atBakes.status, atBakes.text]).toEqual([401, expect.stringContaining(ONLY_ITS_SPACE)])
    for (const path of ['/api/shelves/bakes/recipes', '/api/spaces/soups/invites', '/api/spaces/soups/members']) expect([path, (await call(path)).status]).toEqual([path, 401])
    expect((await callTool(box, '/mcp', sam, 'list_members', { space: 'soups' })).status).toBe(401)
    expect(box.recipes.get('bakes')).toEqual(['Rye bread'])
  })

  it('refuses a spent invite: a second app typing the same code gets the code page again, and nothing', async () => {
    const { box, sam, code } = await samAtSoups()
    const second = await joinWithCode(box, shelfAddress('soups'), code, SAMPLE_APP)
    expect([second.page.status, second.tokens, second.html]).toEqual([400, null, expect.stringContaining('That code is not one of ours')])
    expect(await toolText(box, '/box/soups/mcp', sam, 'list_recipes')).toBe('soups: Leek soup')
  })

  it('refuses a removed member’s token on its next call', async () => {
    const { box, owner, sam } = await samAtSoups()
    expect(await toolText(box, '/box/soups/mcp', sam, 'list_recipes')).toBe('soups: Leek soup')
    const listed = await toolText(box, '/mcp', owner, 'list_members', { space: 'soups' })
    const id = /id (\S+)$/.exec(listed)![1]!
    await toolText(box, '/mcp', owner, 'remove_member', { space: 'soups', id })
    expect((await callTool(box, '/box/soups/mcp', sam, 'list_recipes')).status).toBe(401)
    expect((await box.app.request('/api/shelves/soups/recipes', { headers: { authorization: `Bearer ${sam}` } })).status).toBe(401)
  })

  it('lets the owner approve an app at a shelf with the boxes the page ticks, a grant locked to that shelf and never an owner token', async () => {
    const box = await recipeBox()
    const owner = await ownerAgent(box)
    // At a known return the page's boxes start ticked, so the browser posts them
    const approveTicked = async (query: URLSearchParams) => {
      const page = await (await box.app.request(`/oauth/authorize?${query}`, { headers: AS_OWNER })).text()
      for (const name of ['write', 'untilRevoked']) expect(page).toContain(`name="${name}" value="on" checked>`)
      return approveSignIn(box.app, query, { headers: AS_OWNER, form: { action: '/sharing/owner', fields: { decision: 'approve', write: 'on', untilRevoked: 'on' } } })
    }
    const known = await connect(box, { address: shelfAddress('bakes'), redirect: SAMPLE_APP, approve: approveTicked })
    const token = known.tokens!.access_token
    expect(known.tokens!.scope).toBe('read write')
    expect(await toolText(box, '/box/bakes/mcp', token, 'add_recipe', { name: 'Scones' })).toBe('bakes: Rye bread, Scones')
    expect((await callTool(box, '/box/soups/mcp', token, 'list_recipes')).status).toBe(401)
    expect((await callTool(box, '/mcp', token, 'create_invite', { space: 'bakes', label: 'Ada' })).status).toBe(401)
    expect((await box.app.request('/api/spaces/bakes/invites', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Ada' }) })).status).toBe(401)
    // At a return it does not know, Approve alone gives read for 30 days
    const unknown = await connect(box, { address: shelfAddress('bakes'), redirect: 'https://elsewhere.example.test/cb', approve: (query) => approveSignIn(box.app, query, { headers: AS_OWNER, form: { action: '/sharing/owner', fields: { decision: 'approve' } } }) })
    expect(unknown.tokens!.scope).toBe('read')
    expect((await toolText(box, '/mcp', owner, 'list_members', { space: 'bakes' })).split('\n').map((line) => line.split(' · ').slice(1, 3))).toEqual([
      ['active', 'read, 30d'],
      ['active', 'write, until_revoked'],
    ])
  })

  it('answers alike for a shelf that exists and one that does not, wherever a caller may not see it', async () => {
    const { box, sam } = await samAtSoups()
    const byKey = (key: string, path: string) => box.app.request(path, { headers: { authorization: `Bearer ${key}` } })
    /** A problem without its request id, and the shelf's name in its words made one. */
    const problemOf = async (answer: Response, shelf: string) => {
      const { instance: _instance, ...body } = (await answer.json()) as Record<string, unknown>
      return { status: answer.status, body: JSON.parse(JSON.stringify(body).replaceAll(shelf, 'SHELF')) as unknown }
    }
    // A key that may not share: Soups is hidden from it, Pies does not exist
    expect((await byKey(OWNER_KEY, '/api/spaces/soups/sharing')).status).toBe(200)
    const hidden = await problemOf(await byKey(READER_KEY, '/api/spaces/soups/sharing'), 'soups')
    expect(hidden).toEqual(await problemOf(await byKey(READER_KEY, '/api/spaces/pies/sharing'), 'pies'))
    expect(hidden.status).toBe(404)
    // Sam's token: Bakes is hidden from it, Pies does not exist
    const refusal = async (shelf: string) => problemOf(await box.app.request(`/box/${shelf}/mcp`, { ...json({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), headers: { authorization: `Bearer ${sam}`, 'content-type': 'application/json' } }), shelf)
    const atBakes = await refusal('bakes')
    expect(atBakes).toEqual(await refusal('pies'))
    expect(atBakes).toEqual({ status: 401, body: expect.objectContaining({ detail: ONLY_ITS_SPACE }) })
    // A stranger's app with a wrong code: the page names neither
    const stranger = async (shelf: string) => {
      const { page, html } = await joinWithCode(box, shelfAddress(shelf), 'BDKM-QXTW')
      return [page.status, html.replace(/value="[^"]*"/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')]
    }
    const atSoups = await stranger('soups')
    expect(atSoups).toEqual(await stranger('pies'))
    expect(atSoups).toEqual([400, expect.stringContaining('That code is not one of ours')])
  })
})
