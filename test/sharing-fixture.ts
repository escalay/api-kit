/**
 * A recipe box whose shelves are spaces, wired with the sharing part as its README's Wire it says: each shelf's own MCP
 * at `/box/{space}/mcp` (`resourcePath`), whose tools read the shelf from the mount and call
 * `/api/shelves/{shelf}/recipes` in-process; the owner's MCP at `/mcp` with the sharing tools; and two apps it knows,
 * Client A by its https callback and Sample App by its custom scheme. The owner is whoever sends `x-test-owner`.
 */
import { createRoute, z } from '@hono/zod-openapi'
import { createAgentApi, createOAuth, generateOAuthKey, HAL_JSON, hashApiKey, LinksSchema, linksOf, memoryGuardStore, memoryOAuthStore, parseApiKeys, ProblemError, problemResponses, testDb } from '../src/index.js'
import { inProcess, mcpServerFactory, mcpTool, mountMcp } from '../src/mcp/index.js'
import { createSharing, registerSharing, sharingTools, SHARING_OPEN_PATHS, SHARING_TAG, type Space } from '../src/sharing/index.js'

export const ORIGIN = 'http://localhost'
export const OWNER = 'owner@example.test'
/** A key from API_KEYS that may share (`fixedKeys`), and one that may not. */
export const OWNER_KEY = 'owner-key'
export const READER_KEY = 'reader-key'
export const CLIENT_A = 'https://client-a.example.test/callback'
export const SAMPLE_APP = 'sample-app:/callback'
const SECRET = 'a sharing secret of thirty-two bytes or more, for tests only'

/** A shelf's MCP address. */
export const shelfAddress = (shelf: string) => `${ORIGIN}/box/${shelf}/mcp`

const ShelfSchema = z.object({ shelf: z.string(), recipes: z.array(z.string()), _links: LinksSchema }).openapi('Shelf', { description: 'A shelf and its recipes.' })
const recipesRoute = (method: 'get' | 'post') =>
  createRoute({
    method,
    path: '/api/shelves/{shelf}/recipes',
    operationId: method === 'get' ? 'listRecipes' : 'addRecipe',
    summary: method === 'get' ? 'List a shelf’s recipes' : 'Add a recipe to a shelf',
    description: method === 'get' ? 'The recipes on one shelf, by its name.' : 'Adds a recipe to one shelf, by its name.',
    tags: ['Shelves'],
    request: {
      params: z.object({ shelf: z.string().openapi({ description: 'The shelf’s name (`soups`).' }) }),
      ...(method === 'post' ? { body: { content: { 'application/json': { schema: z.object({ name: z.string() }) } } } } : {}),
    },
    responses: { 200: { description: 'The shelf.', content: { [HAL_JSON]: { schema: ShelfSchema } } }, ...problemResponses(401, 403, 404) },
  })

/** A shelf's tools at its own MCP: the shelf is the mount's `space`, never an argument. */
const recipesAt = (shelf: string | undefined) => `/api/shelves/${encodeURIComponent(shelf ?? '')}/recipes`
type ShelfJson = { shelf: string; recipes: string[] }
const shelfLine = (json: ShelfJson) => `${json.shelf}: ${json.recipes.join(', ')}`
const shelfTools = [
  mcpTool({ name: 'list_recipes', title: 'List recipes', description: 'The recipes on this shelf.', input: z.object({}), call: (_, at) => ({ path: recipesAt(at?.params.space) }), summarize: shelfLine }),
  mcpTool({ name: 'add_recipe', title: 'Add a recipe', description: 'Adds a recipe to this shelf.', input: z.object({ name: z.string() }), call: ({ name }, at) => ({ method: 'POST', path: recipesAt(at?.params.space), body: { name } }), summarize: shelfLine }),
]

/** The recipe box: Soups and Bakes, each with a recipe, served as the README wires the part. */
export const recipeBox = async () => {
  const db = await testDb()
  const shelves: Space[] = [{ id: 'sp_soups', name: 'soups', title: 'Soups' }, { id: 'sp_bakes', name: 'bakes', title: 'Bakes' }]
  const recipes = new Map([['soups', ['Leek soup']], ['bakes', ['Rye bread']]])
  const spaces = { byName: async (name: string) => shelves.find((shelf) => shelf.name === name) ?? null, byId: async (id: string) => shelves.find((shelf) => shelf.id === id) ?? null }
  const owner = async (c: { req: { header: (name: string) => string | undefined } }) => c.req.header('x-test-owner') ?? null
  const keys = parseApiKeys(`owner:${hashApiKey(OWNER_KEY)},reader:${hashApiKey(READER_KEY)}`)

  const sharing = await createSharing({
    db,
    secret: SECRET,
    spaces,
    spaceOfPath: (path) => /^\/api\/shelves\/([^/]+)(\/|$)/.exec(path)?.[1] ?? null,
    owner,
    fixedKeys: ['owner'],
    knownReturns: [{ name: 'Client A', callback: CLIENT_A }, { name: 'Sample App', callback: SAMPLE_APP }],
    resourcePath: '/box/{space}/mcp',
  })
  const oauth = createOAuth({ name: 'Sample', signingKey: await generateOAuthKey(), store: memoryOAuthStore(), owner, publicOrigin: ORIGIN, limits: { store: memoryGuardStore() }, ...sharing.oauth })
  const app = createAgentApi({
    title: 'Recipe box',
    version: '1.0.0',
    description: 'Shelves of recipes, each shared on its own.',
    tags: [{ name: 'Shelves', description: 'The shelves and their recipes.' }, SHARING_TAG],
    auth: { realm: 'recipe-box', keys, open: [...SHARING_OPEN_PATHS], relay: ['/mcp', sharing.relay] },
    guards: { store: memoryGuardStore(), skip: sharing.neverKept },
    oauth,
  })
  const shelfOf = (name: string) => {
    if (!recipes.has(name)) throw new ProblemError('not_found', { detail: `No shelf ${name} here.` })
    return { shelf: name, recipes: recipes.get(name)!, _links: linksOf(ORIGIN, { self: recipesAt(name) }) }
  }
  app.openapi(recipesRoute('get'), (c) => c.json(shelfOf(c.req.valid('param').shelf), 200))
  app.openapi(recipesRoute('post'), async (c) => {
    const { shelf } = c.req.valid('param')
    const { name } = (await c.req.json()) as { name: string }
    shelfOf(shelf).recipes.push(name)
    return c.json(shelfOf(shelf), 200)
  })
  await registerSharing(app, sharing, { oauth })
  const info = { name: 'recipe-box', version: '1.0.0', title: 'Recipe box' }
  mountMcp(app, { factory: mcpServerFactory({ info, instructions: 'The owner’s recipe box and who it is shared with.', tools: sharingTools({ noun: 'shelf' }), callApi: inProcess(app) }), allowedHostnames: ['localhost'] })
  mountMcp(app, { path: sharing.mcpPath, factory: mcpServerFactory({ info, instructions: 'One shelf of recipes.', tools: shelfTools, callApi: inProcess(app) }), allowedHostnames: ['localhost'] })
  return { app, oauth, sharing, shelves, recipes }
}

export type RecipeBox = Awaited<ReturnType<typeof recipeBox>>
