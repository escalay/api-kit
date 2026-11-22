import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { createAgentApi, mintApiKey, parseApiKeys, serveGuide } from '../src/index.js'
import { inProcess, inToolset, mcpServerFactory, mcpTool, mountMcp, toolsetSizes, toolsHashOf, type McpTool } from '../src/mcp/index.js'
import { checkToolsets, chooseToolsets, requestedToolsets, toolBytes, toolsetsOf } from '../src/mcp/toolsets.js'

const { key, hash } = mintApiKey('test')
const auth = { authorization: `Bearer ${key}` }
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }

const tool = (name: string, path: string, more: Partial<McpTool> = {}) =>
  mcpTool({ name, title: name, description: `Calls ${path}.`, input: z.object({ id: z.string().describe('An id.').optional() }), call: () => ({ path }), summarize: (json) => JSON.stringify(json), cli: { name: `${name.replace(/_/g, ' ')}`, examples: [] }, ...more })

/** Four tools: two in core (one untagged, one also in notes), one in browse, one in notes. */
const TOOLS = [
  tool('get_app', '/api/v1/apps/a1'),
  ...inToolset('browse', [tool('list_apps', '/api/v1/apps')]),
  tool('add_note', '/api/v1/notes', { toolset: 'notes' }),
  ...inToolset('notes', [tool('who_am_i', '/api/v1/me', { toolset: ['core', 'notes'] })]),
]

const sampleApi = async (tools: McpTool[] = TOOLS) => {
  const dir = await mkdtemp(join(tmpdir(), 'toolsets-'))
  await mkdir(join(dir, 'agents'))
  await writeFile(join(dir, 'agents/mcp.md'), '# MCP\n\n{{mcp.toolsets}}\n')
  const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(`tester:${hash}`) } })
  for (const path of ['/api/v1/apps/a1', '/api/v1/apps', '/api/v1/notes', '/api/v1/me']) app.get(path, (c) => c.json({ path }))
  serveGuide(app, { dir, vars: () => ({}), full: ['agents/*'] })
  const factory = mcpServerFactory({ info: { name: 'sample', version: '1.0.0', title: 'Sample' }, instructions: 'Find apps.', tools, callApi: inProcess(app) })
  mountMcp(app, { factory, allowedHostnames: ['localhost'] })
  const rpc = async (path: string, method: string, params: Record<string, unknown> = {}) =>
    (
      await app.request(path, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
      })
    ).json()
  const listed = async (path: string) => (await rpc(path, 'tools/list')).result.tools as { name: string; _meta: Record<string, unknown> }[]
  return { app, factory, rpc, listed }
}

describe('toolsets', () => {
  it('puts an untagged tool in core, a feature’s tools in its set, and keeps a tool’s own sets', () => {
    expect(TOOLS.map((one) => [one.name, toolsetsOf(one)])).toEqual([
      ['get_app', ['core']],
      ['list_apps', ['browse']],
      ['add_note', ['notes']],
      ['who_am_i', ['core', 'notes']],
    ])
    expect(() => checkToolsets([{ name: 'odd', toolset: 'all' }])).toThrow('tool odd: toolset "all"')
    expect(() => checkToolsets([{ name: 'odd', toolset: 'Flows' }])).toThrow('toolset "Flows"')
    expect(() => mcpServerFactory({ info: { name: 's', version: '1' }, instructions: '', tools: [tool('odd', '/x', { toolset: 'a b' })], callApi: async () => new Response() })).toThrow('toolset "a b"')
  })

  it('reads the selection from the tools query, comma-separated or repeated, and drops names that don’t exist', () => {
    expect(requestedToolsets('https://x.example/mcp')).toEqual([])
    expect(requestedToolsets('https://x.example/mcp?tools=Core,%20notes&tools=browse,,core')).toEqual(['core', 'notes', 'browse'])
    expect(chooseToolsets(['notes', 'core'], ['core', 'notes'])).toEqual({ sets: ['core', 'notes'], unknown: [] })
    expect(chooseToolsets(['core', 'nope'], ['core'])).toEqual({ sets: ['core'], unknown: ['nope'] })
    expect(chooseToolsets(['nope'], ['core'])).toEqual({ sets: null, unknown: ['nope'] })
    expect(chooseToolsets(['core', 'all'], ['core'])).toEqual({ sets: null, unknown: [] })
  })

  it('measures what a model reads of each tool and each set, core first, heaviest tool first', () => {
    const sizes = toolsetSizes(TOOLS)
    const one = JSON.stringify({ name: 'get_app', description: 'Calls /api/v1/apps/a1.', inputSchema: z.toJSONSchema(TOOLS[0]!.input, { io: 'input' }) })
    expect(toolBytes(TOOLS[0]!)).toBe(Buffer.byteLength(one))
    expect(sizes.sets.map((set) => [set.name, set.tools])).toEqual([
      ['core', ['get_app', 'who_am_i']],
      ['browse', ['list_apps']],
      ['notes', ['add_note', 'who_am_i']],
    ])
    expect(sizes.sets[0]!.bytes).toBe(toolBytes(TOOLS[0]!) + toolBytes(TOOLS[3]!))
    expect(sizes.all).toEqual({ tools: 4, bytes: TOOLS.reduce((sum, one) => sum + toolBytes(one), 0) })
    expect(sizes.tools.map((one) => one.bytes)).toEqual(sizes.tools.map((one) => one.bytes).sort((a, b) => b - a))
    expect(toolsetSizes(TOOLS)).toBe(sizes)
  })

  it('lists every tool on a plain /mcp, and only the selected sets with ?tools=', async () => {
    const { listed } = await sampleApi()
    const names = async (path: string) => (await listed(path)).map((one) => one.name)
    expect(await names('/mcp')).toEqual(['get_app', 'list_apps', 'add_note', 'who_am_i'])
    expect(await names('/mcp?tools=all')).toEqual(['get_app', 'list_apps', 'add_note', 'who_am_i'])
    expect(await names('/mcp?tools=core')).toEqual(['get_app', 'who_am_i'])
    expect(await names('/mcp?tools=notes,core')).toEqual(['get_app', 'add_note', 'who_am_i'])
    expect(await names('/mcp?tools=browse&tools=notes')).toEqual(['list_apps', 'add_note', 'who_am_i'])
    // Each tool names its sets
    expect((await listed('/mcp?tools=core'))[1]!._meta['api-kit/toolsets']).toEqual(['core', 'notes'])
  })

  it('ignores unknown sets and says so; with none left it lists every tool', async () => {
    const { rpc, listed } = await sampleApi()
    expect((await listed('/mcp?tools=core,nope')).map((one) => one.name)).toEqual(['get_app', 'who_am_i'])
    const partly = (await rpc('/mcp?tools=core,nope', 'server/discover')).result.instructions
    expect(partly).toContain('Unknown toolsets ignored: nope. Toolsets: this connection lists core (2 of 4 tools)')
    expect(await listed('/mcp?tools=nope')).toHaveLength(4)
    expect((await rpc('/mcp?tools=nope', 'server/discover')).result.instructions).toContain('Unknown toolsets ignored: nope. Toolsets: this connection lists every tool (4,')
  })

  it('says in its instructions which sets exist, how big each is, and how to connect with more', async () => {
    const { rpc } = await sampleApi()
    const text = (await rpc('/mcp?tools=core', 'server/discover')).result.instructions as string
    expect(text).toMatch(/^Find apps\.\n\nToolsets: this connection lists core \(2 of 4 tools\); a tool outside them can't be called on it\. Sets: core \(2 tools, ~\d+ KB\), browse \(1 tool, ~\d+ KB\), notes \(2 tools, ~\d+ KB\)\. Connect to \/mcp\?tools=core for what most jobs need/)
    expect((await rpc('/mcp', 'server/discover')).result.instructions).toContain('Toolsets: this connection lists every tool (4, ~')
    // The same words for an agent that opens with initialize
    expect((await rpc('/mcp?tools=core', 'initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'a', version: '1' } })).result.instructions).toContain('lists core (2 of 4 tools)')
  })

  it('keeps one tools array and one hash per selection, and the plain list’s hash as it was', async () => {
    const { factory, listed } = await sampleApi()
    const core = factory.select('http://localhost/mcp?tools=core')
    expect(factory.select('http://localhost/mcp?tools=core,nope').tools).toBe(core.tools)
    expect(factory.select('http://localhost/mcp?tools=notes,core').tools).toBe(factory.select('http://localhost/mcp?tools=core,notes').tools)
    expect(factory.select('http://localhost/mcp').tools).toBe(TOOLS)
    expect(factory.select('http://localhost/mcp').hash).toBe(toolsHashOf(TOOLS))
    const hashOf = async (path: string) => (await listed(path))[0]!._meta['api-kit/tools-hash']
    expect(await hashOf('/mcp?tools=core')).toBe(core.hash)
    expect(await hashOf('/mcp?tools=core')).toBe(await hashOf('/mcp?tools=core'))
    expect(await hashOf('/mcp?tools=core')).not.toBe(await hashOf('/mcp'))
    expect(await hashOf('/mcp')).toBe(toolsHashOf(TOOLS))
  })

  it('answers a call to a tool outside the selection as a failed call that says how to reach it', async () => {
    const { rpc } = await sampleApi()
    const called = (await rpc('/mcp?tools=core', 'tools/call', { name: 'get_app', arguments: {} })).result
    expect(called.content[0].text).toBe('{"path":"/api/v1/apps/a1"}')
    const refused = (await rpc('/mcp?tools=core', 'tools/call', { name: 'add_note', arguments: {} })).result
    expect(refused).toMatchObject({ isError: true, content: [{ type: 'text', text: "404 not_found Not found: add_note is in the notes toolset, which this connection didn't select (it lists core). Reconnect to /mcp?tools=core,notes, or to /mcp for every tool." }] })
    expect(refused._meta['api-kit/problem']).toMatchObject({ status: 404, code: 'not_found' })
    // The envelope the SDK gives any failed call on 2026-07-28
    expect(Object.keys(refused).sort()).toEqual(['_meta', 'content', 'isError', 'resultType'])
    expect(refused).toMatchObject({ resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'sample' } } })
    expect(refused._meta['api-kit/tools-hash']).toBe(called._meta['api-kit/tools-hash'])
    // On a plain /mcp it runs
    expect((await rpc('/mcp', 'tools/call', { name: 'add_note', arguments: {} })).result.isError).toBeUndefined()
    // A name no set has is the SDK's own answer
    expect((await rpc('/mcp?tools=core', 'tools/call', { name: 'nothing', arguments: {} })).error).toMatchObject({ code: -32602, message: expect.stringContaining('Tool nothing not found') })
  })

  it('lists the sets in the Server Card and the guide', async () => {
    const { app } = await sampleApi()
    const card = await (await app.request('/mcp/server-card')).json()
    expect(card._meta['api-kit/toolsets']).toEqual([
      { name: 'core', tools: 2, bytes: expect.any(Number), url: 'http://localhost/mcp?tools=core' },
      { name: 'browse', tools: 1, bytes: expect.any(Number), url: 'http://localhost/mcp?tools=browse' },
      { name: 'notes', tools: 2, bytes: expect.any(Number), url: 'http://localhost/mcp?tools=notes' },
    ])
    const guide = await (await app.request('/agents/mcp.md', { headers: auth })).text()
    expect(guide).toMatch(/- \*\*`core`\*\* — 2 tools, ~\d+ KB: `http:\/\/localhost\/mcp\?tools=core` — get_app, who_am_i\n/)
    expect(guide).toContain('- **every tool** — 4 tools: `http://localhost/mcp` (or `?tools=all`)')
  })

  it('changes nothing for a server whose tools are all in core', async () => {
    const plain = TOOLS.map((one) => ({ ...one, toolset: undefined }))
    const { app, factory, rpc, listed } = await sampleApi(plain)
    expect((await rpc('/mcp?tools=browse', 'server/discover')).result.instructions).toBe('Find apps.')
    expect(await listed('/mcp?tools=browse')).toHaveLength(4)
    expect((await listed('/mcp'))[0]!._meta).not.toHaveProperty('api-kit/toolsets')
    expect(factory.toolsets()).toEqual([])
    expect(await (await app.request('/mcp/server-card')).json()).not.toHaveProperty('_meta')
    expect(await (await app.request('/agents/mcp.md', { headers: auth })).text()).toContain('One set: all 4 tools at `http://localhost/mcp`.')
  })
})
