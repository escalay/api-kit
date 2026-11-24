import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { createAgentApi, HAL_JSON, memoryGuardStore, mintApiKey, parseApiKeys, problemResponses, serveAiCatalog, serveGuide, showOnce, type GuardStore, type StoredAnswer } from '../src/index.js'
import { inProcess, mcpResource, mcpServerFactory, mcpTool, mountedMcp, mountMcp, routeOf, type CallApi } from '../src/mcp/index.js'
import { cliSnapshot, toolRoutes } from '../src/testing/index.js'

const { key, hash } = mintApiKey('test')
const auth = { authorization: `Bearer ${key}` }
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }

const ShelfSchema = z.object({ shelf: z.string(), recipes: z.array(z.string()) }).openapi('Shelf', { description: 'A shelf and its recipes.' })
const shelfPath = (space: string | undefined) => `/api/shelves/${encodeURIComponent(space ?? '')}/recipes`

/** Reads the space it serves from the mount path: `/s/soups/mcp` lists the soups shelf. */
const listRecipes = mcpTool({
  name: 'list_recipes', title: 'List recipes', description: 'The recipes on this space’s shelf.', input: z.object({}),
  call: (_, at) => ({ path: shelfPath(at?.params.space) }),
  summarize: (json) => `${json.shelf}: ${json.recipes.join(', ')}`,
})
const addRecipe = mcpTool({
  name: 'add_recipe', title: 'Add a recipe', description: 'Adds a recipe to this space’s shelf.', input: z.object({ name: z.string() }),
  call: ({ name }, { params } = { params: {} }) => ({ method: 'POST', path: shelfPath(params.space), body: { name } }),
  summarize: (json) => `${json.shelf}: ${json.recipes.join(', ')}`,
})
/** A tool written before mounts had parameters: one argument. */
const countShelves = mcpTool({
  name: 'count_shelves', title: 'Count shelves', description: 'How many shelves there are.', input: z.object({}),
  call: () => ({ path: '/api/shelves' }),
  summarize: (json) => `${json.count} shelves`,
})
const shelfResource = mcpResource({
  name: 'shelf', title: 'This shelf', description: 'The space’s shelf as JSON.', uriTemplate: 'sample://shelf',
  read: (_, at) => [{ path: shelfPath(at?.params.space) }],
})

/** A shelves API with the owner's `/mcp` and, when `spaces` says where, one MCP per space at `/s/:space/mcp`. */
const shelvesApi = ({ spaces = 'none', seen = [] }: { spaces?: 'none' | 'before' | 'after'; seen?: string[] } = {}) => {
  const app = createAgentApi({ title: 'Shelves', version: '1.0.0', description: 'Shelves of recipes.', tags: [{ name: 'Shelves', description: 'The shelves.' }], auth: { realm: 'shelves', keys: parseApiKeys(`tester:${hash}`) }, health: () => ({}) })
  const shelves = new Map<string, string[]>([['soups', ['Leek soup']], ['bakes', ['Rye bread']], ['soups/x', ['Odd soup']], ['.soups', ['Dot soup']], ['soups..x', ['Dots soup']]])
  const recipesRoute = (method: 'get' | 'post') =>
    createRoute({
      method, path: '/api/shelves/{shelf}/recipes', operationId: `${method}Recipes`, summary: 'Recipes', description: 'A shelf’s recipes.', tags: ['Shelves'],
      request: { params: z.object({ shelf: z.string().openapi({ description: 'The shelf.' }) }), ...(method === 'post' ? { body: { content: { 'application/json': { schema: z.object({ name: z.string() }) } } } } : {}) },
      responses: { 200: { description: 'The shelf.', content: { [HAL_JSON]: { schema: ShelfSchema } } }, ...problemResponses(401, 404) },
    })
  const answer = (shelf: string) => ({ shelf, recipes: shelves.get(shelf) ?? [] })
  app.openapi(recipesRoute('get'), (c) => c.json(answer(c.req.valid('param').shelf), 200))
  app.openapi(recipesRoute('post'), async (c) => {
    const { shelf } = c.req.valid('param')
    shelves.set(shelf, [...(shelves.get(shelf) ?? []), (await c.req.json()).name])
    return c.json(answer(shelf), 200)
  })
  app.get('/api/shelves', (c) => c.json({ count: shelves.size }))
  serveGuide(app, { files: { 'llms.txt': '# Shelves\n\n{{mcp.count}} tools:\n\n{{mcp.tools}}\n\n{{mcp.resources}}\n' }, vars: () => ({}), full: ['llms.txt'] })
  const callApi: CallApi = (call, info) => (seen.push(`${call.method ?? 'GET'} ${call.path}`), inProcess(app)(call, info))
  const info = { name: 'shelves', version: '1.0.0', title: 'Shelves' }
  const mountSpaces = () => mountMcp(app, { path: '/s/:space/mcp', factory: mcpServerFactory({ info, instructions: 'One shelf.', tools: [listRecipes, addRecipe, countShelves], resources: [shelfResource], callApi }), allowedHostnames: ['localhost'] })
  if (spaces === 'before') mountSpaces()
  mountMcp(app, { factory: mcpServerFactory({ info, instructions: 'Every shelf.', tools: [countShelves], callApi }), allowedHostnames: ['localhost'] })
  if (spaces === 'after') mountSpaces()
  serveAiCatalog(app, { host: 'Shelves', apiTitle: 'Shelves', queries: { api: ['list a shelf'] } })
  return app
}

type App = ReturnType<typeof shelvesApi>
const rpc = (app: App, at: string, method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = auth) =>
  app.request(at, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : method === 'resources/read' ? { 'mcp-name': String(params.uri) } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { _meta: meta, ...params } }),
  })
const callTool = async (app: App, at: string, name: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => (await (await rpc(app, at, 'tools/call', { name, arguments: args, ...extra })).json()).result

describe('a mount path’s parameters', () => {
  it('a tool at /s/:space/mcp calls its own space’s route', async () => {
    const seen: string[] = []
    const app = shelvesApi({ spaces: 'after', seen })
    expect((await callTool(app, '/s/soups/mcp', 'list_recipes')).content[0].text).toBe('soups: Leek soup')
    expect((await callTool(app, '/s/bakes/mcp', 'list_recipes')).content[0].text).toBe('bakes: Rye bread')
    expect((await callTool(app, '/s/bakes/mcp', 'add_recipe', { name: 'Scones' })).content[0].text).toBe('bakes: Rye bread, Scones')
    expect(seen).toEqual(['GET /api/shelves/soups/recipes', 'GET /api/shelves/bakes/recipes', 'POST /api/shelves/bakes/recipes'])
  })

  it('a resource at /s/:space/mcp reads its own space’s route', async () => {
    const app = shelvesApi({ spaces: 'after' })
    const read = await (await rpc(app, '/s/bakes/mcp', 'resources/read', { uri: 'sample://shelf' })).json()
    expect(JSON.parse(read.result.contents[0].text)).toEqual({ shelf: 'bakes', recipes: ['Rye bread'] })
  })

  it('a tool without a second argument works as before, on either mount', async () => {
    const app = shelvesApi({ spaces: 'after' })
    expect((await callTool(app, '/mcp', 'count_shelves')).content[0].text).toBe('5 shelves')
    expect((await callTool(app, '/s/soups/mcp', 'count_shelves')).content[0].text).toBe('5 shelves')
  })

  it('a tool hears the mount’s parameters, and none at a mount without them', async () => {
    const heard: unknown[] = []
    const app = shelvesApi()
    const listening = mcpTool({ ...countShelves, name: 'listen', call: (_, at) => ({ path: '/api/shelves', query: { at: JSON.stringify(at) } }) })
    // Only the calls that reach the API: listing a tool also runs its call, with placeholders
    const callApi: CallApi = (call, info) => (heard.push(JSON.parse(String(call.query?.at ?? null))), inProcess(app)(call, info))
    const factory = () => mcpServerFactory({ info: { name: 'listen', version: '1.0.0' }, instructions: 'Listens.', tools: [listening], callApi })
    mountMcp(app, { path: '/plain/mcp', factory: factory(), allowedHostnames: ['localhost'] })
    mountMcp(app, { path: '/s/:space/b/:board/mcp', factory: factory(), allowedHostnames: ['localhost'] })
    await callTool(app, '/plain/mcp', 'listen')
    await callTool(app, '/s/soups/b/b_1/mcp', 'listen')
    expect(heard).toEqual([{ params: {} }, { params: { space: 'soups', board: 'b_1' } }])
  })

  it('a parameter with %2F, .. or %2e reaches the tool decoded and is encoded back in the path', async () => {
    const seen: string[] = []
    const app = shelvesApi({ spaces: 'after', seen })
    expect((await callTool(app, '/s/soups%2Fx/mcp', 'list_recipes')).content[0].text).toBe('soups/x: Odd soup')
    expect((await callTool(app, '/s/%2esoups/mcp', 'list_recipes')).content[0].text).toBe('.soups: Dot soup')
    expect((await callTool(app, '/s/soups..x/mcp', 'list_recipes')).content[0].text).toBe('soups..x: Dots soup')
    expect(seen).toEqual(['GET /api/shelves/soups%2Fx/recipes', 'GET /api/shelves/.soups/recipes', 'GET /api/shelves/soups..x/recipes'])
    // A dot segment is resolved before routing: it reaches the owner's /mcp, never a space named `..`
    for (const at of ['/s/../mcp', '/s/%2e%2e/mcp', '/s/%2E%2E/mcp', '/s/.%2e/mcp']) {
      const list = await (await rpc(app, at, 'tools/list')).json()
      expect(list.result.tools.map((tool: { name: string }) => tool.name), at).toEqual(['count_shelves'])
    }
    expect((await rpc(app, '/s/%2e/mcp', 'tools/list')).status).toBe(404)
  })

  it('a name arrives as the route read it: decoded, its case kept, its dot segments resolved', async () => {
    const seen: string[] = []
    const app = shelvesApi({ spaces: 'after', seen })
    for (const at of ['/s/%73oups/mcp', '/s/Soups/mcp', '/s/soups/../bakes/mcp']) await callTool(app, at, 'list_recipes')
    expect(seen).toEqual(['GET /api/shelves/soups/recipes', 'GET /api/shelves/Soups/recipes', 'GET /api/shelves/bakes/recipes'])
    expect((await rpc(app, '/s/soups/mcp/', 'tools/list')).status).toBe(404)
  })

  it('a dot segment sent raw over a socket reaches /mcp too', async () => {
    const app = shelvesApi({ spaces: 'before' })
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
    await new Promise((resolve) => server.once('listening', resolve))
    // node:http sends the path as written; fetch would resolve it before sending
    const toolsAt = (path: string) =>
      new Promise<string[]>((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } })
        const headers = { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }
        const sent = request({ host: '127.0.0.1', port: (server.address() as AddressInfo).port, path, method: 'POST', headers }, (answer) => {
          let text = ''
          answer.on('data', (chunk) => (text += chunk))
          answer.on('end', () => resolve(JSON.parse(text).result.tools.map((tool: { name: string }) => tool.name)))
        })
        sent.on('error', reject)
        sent.end(body)
      })
    try {
      for (const path of ['/s/../mcp', '/s/%2e%2e/mcp', '/s/.%2e/mcp']) expect(await toolsAt(path), path).toEqual(['count_shelves'])
      expect(await toolsAt('/s/soups/mcp')).toEqual(['list_recipes', 'add_recipe', 'count_shelves'])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })

  it('a client can’t set the parameters: arguments, _meta and the query string are ignored', async () => {
    const seen: string[] = []
    const app = shelvesApi({ spaces: 'after', seen })
    await callTool(app, '/s/soups/mcp', 'list_recipes', { params: { space: 'bakes' }, space: 'bakes' }, { _meta: { ...meta, params: { space: 'bakes' } } })
    await callTool(app, '/s/soups/mcp?space=bakes&params=bakes', 'list_recipes')
    expect(seen).toEqual(['GET /api/shelves/soups/recipes', 'GET /api/shelves/soups/recipes'])
  })

  it('needs credentials at a space like every other route', async () => {
    const app = shelvesApi({ spaces: 'before' })
    expect((await rpc(app, '/s/soups/mcp', 'tools/list', {}, {})).status).toBe(401)
    expect((await rpc(app, '/s/soups/mcp', 'tools/call', { name: 'list_recipes', arguments: {} }, { authorization: 'Bearer wrong' })).status).toBe(401)
  })

  it('reads a space tool’s route with its parameters as placeholders, so a write is not read-only', async () => {
    expect(routeOf(listRecipes)).toBe('GET /api/shelves/{space}/recipes')
    expect(routeOf(addRecipe)).toBe('POST /api/shelves/{space}/recipes')
    const app = shelvesApi({ spaces: 'after' })
    const { tools } = (await (await rpc(app, '/s/soups/mcp', 'tools/list')).json()).result
    const add = tools.find((tool: { name: string }) => tool.name === 'add_recipe')
    expect(add.annotations.readOnlyHint).toBe(false)
    expect(add._meta['api-kit/route']).toBe('POST /api/shelves/{space}/recipes')
    expect(add._meta['api-kit/cli'].positional).toEqual([])
    // The guide's check finds the operation each one reaches
    expect(toolRoutes([listRecipes, addRecipe], await (await app.request('/openapi.json', { headers: auth })).json())).toEqual([])
  })

  it.each(['before', 'after'] as const)('the guide, catalogs and cliSnapshot are unchanged by a mount with parameters (mounted %s /mcp)', async (spaces) => {
    const plain = shelvesApi()
    const both = shelvesApi({ spaces })
    expect(mountedMcp(both)).toEqual(mountedMcp(plain))
    expect(cliSnapshot(mountedMcp(both))).toEqual(cliSnapshot(mountedMcp(plain)))
    for (const path of ['/llms.txt', '/.well-known/mcp/server-card.json', '/mcp/server-card', '/.well-known/ai-catalog.json']) {
      const [before, after] = await Promise.all([plain, both].map(async (app) => (await app.request(path, { headers: auth })).text()))
      expect(after, path).toBe(before)
    }
    expect(await (await plain.request('/llms.txt', { headers: auth })).text()).toContain('`count_shelves`')
  })

  it('a space’s MCP never keeps a shown-once answer, and its route gets the per-call Idempotency-Key', async () => {
    const store = memoryGuardStore()
    // Every answer the guard keeps, as it handed it to the store
    const kept: StoredAnswer[] = []
    const recording: GuardStore = { ...store, save: (id, answer, expiresAt) => (kept.push(answer), store.save(id, answer, expiresAt)) }
    const app = createAgentApi({ title: 'Shelves', version: '1.0.0', description: 'Shelves of recipes.', tags: [], auth: { realm: 'shelves', keys: parseApiKeys(`tester:${hash}`) }, guards: { store: recording } })
    const heard: string[] = []
    app.post('/api/shelves/:shelf/keys', (c) => {
      heard.push(`${c.req.param('shelf')} ${c.req.header('idempotency-key')}`)
      showOnce(c, `Made a key for ${c.req.param('shelf')}; it is never shown again.`)
      return c.json({ key: `sk_shelf_${heard.length}` }, 201)
    })
    const makeKey = mcpTool({
      name: 'make_key', title: 'Make a key', description: 'Makes a key for this space’s shelf.', input: z.object({}),
      call: (_, at) => ({ method: 'POST', path: `/api/shelves/${encodeURIComponent(at?.params.space ?? '')}/keys`, body: {} }),
      summarize: (json) => json.key,
    })
    mountMcp(app, { path: '/s/:space/mcp', factory: mcpServerFactory({ info: { name: 'shelves', version: '1.0.0' }, instructions: 'One shelf.', tools: [makeKey], callApi: inProcess(app) }), allowedHostnames: ['localhost'] })
    const call = async () =>
      (await app.request('/s/soups/mcp', {
        method: 'POST',
        headers: { ...auth, 'idempotency-key': 'k1', 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'make_key' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'make_key', arguments: {}, _meta: meta } }),
      })).text()
    expect(await call()).toContain('sk_shelf_1')
    const again = await call()
    expect(again).not.toContain('sk_shelf_1')
    expect(again).toContain('Made a key for soups')
    // The route ran once, for its space, under the caller's key with the call's JSON-RPC id
    expect(heard).toEqual(['soups k1:7'])
    // Only the route's marker is kept: the space's MCP answer, which showed the key, never is
    expect(kept).toEqual([{ version: 2, bodyHash: expect.any(String), shownOnce: expect.stringContaining('Made a key for soups') }])
  })

  it('serves each space’s Server Card naming that space’s endpoint', async () => {
    const app = shelvesApi({ spaces: 'before' })
    expect((await (await app.request('/s/soups/mcp/server-card')).json()).remotes[0].url).toBe('http://localhost/s/soups/mcp')
    expect((await (await app.request('/s/soups%2Fx/mcp/server-card')).json()).remotes[0].url).toBe('http://localhost/s/soups%2Fx/mcp')
    expect((await (await app.request('/.well-known/mcp/server-card.json')).json()).remotes[0].url).toBe('http://localhost/mcp')
  })
})
