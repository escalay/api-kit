import { z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { boardRef, boardTools, parseBoardRef, registerBoards } from '../src/boards/index.js'
import { BoardsError, createBoardsClient } from '../src/browser/boards-client.js'
import { createAgentApi, hashApiKey, LinksSchema, parseApiKeys, testDb } from '../src/index.js'
import { inProcess } from '../src/mcp/index.js'
import { lintOpenApi, toolRoutes, toolsRun } from '../src/testing/index.js'

const KEY = 'agent-key'
const LOGOS: Record<string, string> = { fox: 'Fox Films', bird: 'Bird Air', sun: 'Sun Bank' }

const sampleApi = async () => {
  const app = createAgentApi({ title: 'Logos', version: '1.0.0', description: 'Logos.', tags: [{ name: 'Boards', description: 'Collections.' }], auth: { realm: 'logos', keys: parseApiKeys(`agent:${hashApiKey(KEY)}`) } })
  const Card = z.object({ slug: z.string(), client: z.string(), _links: LinksSchema }).openapi('LogoCard', { description: 'A logo.' })
  await registerBoards(app, {
    db: await testDb(),
    item: Card,
    refExample: 'logo:fox',
    itemOf: (ref, origin) => {
      const slug = ref.slice('logo:'.length)
      return LOGOS[slug] ? { slug, client: LOGOS[slug], _links: { self: { href: `${origin}/api/logos/${slug}` } } } : null
    },
    suggestions: (refs, limit, origin) => Object.keys(LOGOS).filter((slug) => !refs.includes(`logo:${slug}`)).slice(0, limit).map((slug) => ({ slug, client: LOGOS[slug], _links: { self: { href: `${origin}/api/logos/${slug}` } } })),
  })
  return app
}
const call = (app: Awaited<ReturnType<typeof sampleApi>>, method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })

describe('board refs', () => {
  it('reads a ref as its type and an id that may hold colons, and turns them back into one', () => {
    expect(parseBoardRef('segment:episode:intro:2')).toEqual({ type: 'segment', id: 'episode:intro:2' })
    expect(parseBoardRef('logo:fox')).toEqual({ type: 'logo', id: 'fox' })
    for (const notARef of ['fox', 'Logo:fox', 'logo:', ':fox', 'logo:has space']) expect(parseBoardRef(notARef), notARef).toBeNull()
    expect(boardRef('section', 'post:first-steps:2-0')).toBe('section:post:first-steps:2-0')
    expect(parseBoardRef(boardRef('section', 'post:first-steps:2-0'))).toEqual({ type: 'section', id: 'post:first-steps:2-0' })
  })
})

describe('boards', () => {
  it('makes a board, saves items with notes, and shows where an item is saved', async () => {
    const app = await sampleApi()
    const made = await call(app, 'POST', '/api/boards', { name: ' Bank identity ', description: 'refs for the brief' })
    expect(made.status).toBe(201)
    const board = await made.json()
    expect(made.headers.get('location')).toBe(`/api/boards/${board.id}`)
    expect(board).toMatchObject({ name: 'Bank identity', description: 'refs for the brief', items: 0 })
    expect((await call(app, 'PUT', `/api/boards/${board.id}/items/logo:fox`, { note: 'the ears' })).status).toBe(201)
    expect((await call(app, 'PUT', `/api/boards/${board.id}/items/logo:fox`)).status).toBe(200)
    expect((await call(app, 'PUT', `/api/boards/${board.id}/items/logo:bird`)).status).toBe(201)
    const full = await (await call(app, 'GET', `/api/boards/${board.id}`)).json()
    expect(full._embedded.items.map((entry: { ref: string; note: string | null }) => [entry.ref, entry.note])).toEqual(expect.arrayContaining([['logo:fox', 'the ears'], ['logo:bird', null]]))
    expect(full._embedded.items[0].item._links.self.href).toMatch(/\/api\/logos\//)
    await call(app, 'POST', '/api/boards', { name: 'Other' })
    const holding = await (await call(app, 'GET', '/api/boards?item=logo:fox')).json()
    expect(holding._embedded.boards.map((one: { name: string }) => one.name)).toEqual(['Bank identity'])
    expect((await (await call(app, 'GET', '/api/boards')).json()).count).toBe(2)
  })

  it('renames, takes items off, suggests more, and deletes', async () => {
    const app = await sampleApi()
    const { id } = await (await call(app, 'POST', '/api/boards', { name: 'Draft' })).json()
    await call(app, 'PUT', `/api/boards/${id}/items/logo:fox`)
    expect((await (await call(app, 'PATCH', `/api/boards/${id}`, { name: 'Final' })).json()).name).toBe('Final')
    expect((await (await call(app, 'GET', `/api/boards/${id}/suggestions`)).json())._embedded.items.map((item: { slug: string }) => item.slug)).toEqual(['bird', 'sun'])
    expect((await call(app, 'DELETE', `/api/boards/${id}/items/logo:fox`)).status).toBe(204)
    expect((await (await call(app, 'GET', `/api/boards/${id}`)).json()).items).toBe(0)
    expect((await call(app, 'DELETE', `/api/boards/${id}`)).status).toBe(204)
    expect((await call(app, 'GET', `/api/boards/${id}`)).status).toBe(404)
  })

  it('refuses unknown items and boards, bad refs, and anyone without credentials', async () => {
    const app = await sampleApi()
    const { id } = await (await call(app, 'POST', '/api/boards', { name: 'X' })).json()
    expect((await (await call(app, 'PUT', `/api/boards/${id}/items/logo:nope`)).json()).code).toBe('not_found')
    expect((await call(app, 'PUT', '/api/boards/nope/items/logo:fox')).status).toBe(404)
    expect((await call(app, 'PUT', `/api/boards/${id}/items/no-colon`)).status).toBe(400)
    expect((await call(app, 'POST', '/api/boards', { name: '' })).status).toBe(400)
    expect((await app.request('/api/boards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' })).status).toBe(401)
  })

  it('documents the routes to the standard and gives agents the same as tools', async () => {
    const app = await sampleApi()
    const doc = await (await app.request('/openapi.json')).json()
    expect(lintOpenApi(doc)).toEqual([])
    const tools = boardTools({ noun: 'logos', label: (logo) => logo.client, suggestions: true })
    expect(toolRoutes(tools, doc)).toEqual([])
    const callApi = inProcess(app)
    const auth = { token: KEY, clientId: 'agent', scopes: [], extra: { headers: { authorization: `Bearer ${KEY}` } } }
    const run = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((one) => one.name === name)!
      const response = await callApi(tool.call(tool.input.parse(args) as never), auth)
      return tool.summarize(await response.json().catch(() => null), args as never)
    }
    const made = await run('create_board', { name: 'Birds' })
    const id = made.match(/id ([\w-]+)/)![1]!
    expect(await run('save_to_board', { id, ref: 'logo:bird', note: 'wings' })).toContain('1 logos')
    expect(await run('get_board', { id })).toContain('- Bird Air — wings')
    expect(await run('list_boards', { item: 'logo:bird' })).toContain('Birds')
    expect(await run('board_suggestions', { id })).toBe('- Fox Films\n- Sun Bank')
    expect(await run('remove_from_board', { id, ref: 'logo:bird' })).toBe('Removed.')
  })

  it('runs every board tool with toolsRun, and says what fails', async () => {
    const app = await sampleApi()
    const headers = { authorization: `Bearer ${KEY}` }
    const tools = boardTools({ noun: 'logos', label: (logo) => logo.client, suggestions: true })
    const { id } = (await (await call(app, 'POST', '/api/boards', { name: 'Run' })).json()) as { id: string }
    const args = { list_boards: {}, create_board: { name: 'Made by a tool' }, get_board: { id }, save_to_board: { id, ref: 'logo:bird' }, remove_from_board: { id, ref: 'logo:bird' }, board_suggestions: { id } }
    expect(await toolsRun(tools, app, args, { headers })).toEqual([])
    const { create_board, ...missing } = args
    const throwing = tools.map((tool) => (tool.name === 'list_boards' ? { ...tool, summarize: () => { throw new Error('no boards field') } } : tool))
    expect(await toolsRun(throwing, app, args, { headers })).toEqual(['list_boards: its summary threw on the 200 answer: no boards field'])
    const failures = await toolsRun(tools, app, { ...missing, get_board: { id: 'nope' }, save_to_board: { id }, extra_tool: {} }, { headers })
    expect(failures).toHaveLength(4)
    expect(failures).toEqual(expect.arrayContaining([
      expect.stringMatching(/^get_board: GET \/api\/boards\/nope answered 404: /),
      'create_board: no sample arguments',
      expect.stringMatching(/^save_to_board: its input rejects the sample arguments/),
      "extra_tool: sample arguments for a tool that doesn't exist",
    ]))
  })
  it('lets a page manage boards through the browser client', async () => {
    const app = await sampleApi()
    const client = createBoardsClient<{ client: string }>({ fetchImpl: ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch, headers: { authorization: `Bearer ${KEY}` } })
    const saved = await client.create('Saved')
    expect((await client.save(saved.id, 'logo:sun', 'gold')).items).toBe(1)
    expect((await client.list('logo:sun')).map((board) => board.name)).toEqual(['Saved'])
    expect((await client.get(saved.id)).entries?.[0]).toMatchObject({ ref: 'logo:sun', note: 'gold', item: { client: 'Sun Bank' } })
    expect((await client.suggestions(saved.id, 1)).map((item) => item.client)).toEqual(['Fox Films'])
    await client.unsave(saved.id, 'logo:sun')
    expect((await client.rename(saved.id, { name: 'Kept' })).name).toBe('Kept')
    await client.remove(saved.id)
    const error = await client.get(saved.id).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(BoardsError)
    expect(error).toMatchObject({ status: 404, code: 'not_found' })
  })
})
