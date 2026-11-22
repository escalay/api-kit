/**
 * A small cookbook API with every surface a brand shows on: the OpenAPI document and docs page, the guide, MCP (both
 * protocol eras) with its Server Card, the A2A card, the AI Catalog and a front door. `test/brand.test.ts` reads each
 * one with and without a brand; `surfacesOf` is what the no-brand golden file pins.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { z } from '@hono/zod-openapi'
import { mountA2A } from '../src/a2a/index.js'
import { createAgentApi, frontDoorOpen, hashApiKey, parseApiKeys, serveAiCatalog, serveFrontDoor, serveGuide } from '../src/index.js'
import { inProcess, mcpServerFactory, mcpTool, mountMcp } from '../src/mcp/index.js'

export const KEY = 'cookbook-key'
export const AUTH = { authorization: `Bearer ${KEY}` }

/** A PNG of one colour, made by hand: real bytes at a real size, without a renderer. */
export const pngOf = (width: number, height = width, [r, g, b, a] = [37, 99, 235, 255]) => {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r!, g!, b!, a!]).flat())])
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', new Uint8Array())]))
}
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2563eb"/></svg>'
/** What `kit brand` writes into src/brand.gen.ts, with hand-made PNGs. */
export const ASSETS = {
  inputsHash: 'ab'.repeat(32),
  svg: SVG,
  svgDark: SVG.replace('#2563eb', '#93c5fd'),
  png: { 16: base64(pngOf(16)), 32: base64(pngOf(32)), 48: base64(pngOf(48)), 96: base64(pngOf(96)), 180: base64(pngOf(180)), 192: base64(pngOf(192)), 512: base64(pngOf(512)) },
  pngDark: { 192: base64(pngOf(192)), 512: base64(pngOf(512)) },
  og: base64(pngOf(1200, 630)),
}

export const cookbookApi = async ({ frontDoor = {}, llms = '# Cookbook\n\n> Recipes at {{origin}}.\n', ...extra }: { frontDoor?: Record<string, string>; llms?: string } & Partial<Parameters<typeof createAgentApi>[0]> = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'brand-web-'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><head><title>Cookbook</title></head><body>the app</body></html>')
  await writeFile(join(dir, 'landing.html'), '<!doctype html><html><head><title>Cookbook</title></head><body>the front page</body></html>')
  for (const [name, text] of Object.entries(frontDoor)) await writeFile(join(dir, name), text)
  const web = { dir }
  const app = createAgentApi({
    title: 'Cookbook',
    version: '1.0.0',
    description: 'Recipes and menus.',
    tags: [{ name: 'Recipes', description: 'The recipes.' }],
    home: false,
    auth: { realm: 'cookbook', keys: parseApiKeys(`tester:${hashApiKey(KEY)}`), open: frontDoorOpen(web) },
    ...extra,
  })
  app.get('/api/v1/recipes', (c) => c.json({ recipes: [{ id: 'r1', name: 'Soup' }] }))
  serveGuide(app, { files: { 'llms.txt': llms }, vars: () => ({}), full: ['llms.txt'] })
  const tools = [mcpTool({ name: 'list_recipes', title: 'List recipes', description: 'Every recipe.', input: z.object({}), call: () => ({ path: '/api/v1/recipes' }), summarize: (json) => json.recipes.map((one: { name: string }) => one.name).join(', ') })]
  mountMcp(app, { factory: mcpServerFactory({ info: { name: 'cookbook', version: '1.0.0', title: 'Cookbook' }, instructions: 'Find recipes.', tools, callApi: inProcess(app) }), allowedHostnames: ['localhost', 'gw.example.com'] })
  mountA2A(app, { info: { name: 'Cookbook', description: 'Recipes.', version: '1.0.0' }, skills: [{ tool: tools[0]!, text: 'q', tags: ['recipes'] }], callApi: inProcess(app) })
  serveAiCatalog(app, { host: 'Cookbook', apiTitle: 'Cookbook', queries: { api: ['find a soup recipe'] } })
  serveFrontDoor(app, web)
  return app
}

type App = Awaited<ReturnType<typeof cookbookApi>>
const PROXIED = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'gw.example.com' }
const MODERN = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }

/** One JSON-RPC call to /mcp: the 2026 era with its envelope, or a 2025 client's stateless `initialize`. */
export const mcpCall = async (app: App, method: string, params: Record<string, unknown> = {}, era: 'modern' | 'legacy' = 'modern') => {
  const response = await app.request('/mcp', {
    method: 'POST',
    headers: { ...AUTH, ...PROXIED, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(era === 'modern' ? { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}) } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: era === 'modern' ? { ...params, _meta: MODERN } : params }),
  })
  const text = await response.text()
  // The SDK may answer as an event stream: the message is its data line
  return JSON.parse(text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))!.slice(6))
}

const LEGACY_INITIALIZE = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }

/** Every surface a brand changes, as served through a proxy at gw.example.com (request ids left out). */
export const surfacesOf = async (app: App) => {
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await app.request(path, { headers: { ...PROXIED, ...headers } })
    return { status: response.status, type: response.headers.get('content-type'), body: response.status === 200 ? await response.text() : null }
  }
  return {
    openapi: await get('/openapi.json', AUTH),
    docs: await get('/docs'),
    llms: await get('/llms.txt'),
    serverCard: await get('/mcp/server-card'),
    aiCatalog: await get('/.well-known/ai-catalog.json'),
    agentCard: await get('/.well-known/agent-card.json'),
    landing: await get('/'),
    page: await get('/app', AUTH),
    favicon: (await get('/favicon.ico')).status,
    icon: (await get('/icon.svg')).status,
    manifest: (await get('/site.webmanifest')).status,
    discover: await mcpCall(app, 'server/discover'),
    greeting: await mcpCall(app, 'initialize', LEGACY_INITIALIZE),
    toolsList: await mcpCall(app, 'tools/list'),
    toolsCall: await mcpCall(app, 'tools/call', { name: 'list_recipes', arguments: {} }),
    legacyInitialize: await mcpCall(app, 'initialize', LEGACY_INITIALIZE, 'legacy'),
  }
}
