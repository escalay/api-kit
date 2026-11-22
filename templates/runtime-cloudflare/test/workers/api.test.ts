import { exports } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { BRAND_ASSETS } from '../../src/brand.gen.js'
import { TEST_KEY } from './key.js'

const headers = { authorization: `Bearer ${TEST_KEY}`, 'content-type': 'application/json' }

// worker.ts in workerd over D1, brought up by migrations/: what a deploy runs
describe('__title__ on Workers', () => {
  it('starts and serves the standard routes and the guide', async () => {
    for (const path of ['/api/health', '/openapi.json', '/llms.txt', '/.well-known/api-catalog', '/icon.svg', '/site.webmanifest']) expect((await exports.default.fetch(`https://api.test${path}`, { headers })).status, path).toBe(200)
  })

  it('serves the brand from src/brand.gen.ts, the PNGs once `npx @escalay/kit brand` has rendered them', async () => {
    const favicon = await exports.default.fetch('https://api.test/favicon.ico')
    expect(favicon.headers.get('content-type') === 'image/x-icon').toBe('png' in BRAND_ASSETS)
    const card = (await (await exports.default.fetch('https://api.test/mcp/server-card')).json()) as { icons: { src: string }[] }
    expect(card.icons.map((icon) => icon.src)).toContain('https://api.test/icon.svg')
    expect(card.icons.some((icon) => icon.src === 'https://api.test/icon-192.png')).toBe('png' in BRAND_ASSETS)
  })

  it('answers every feature list route with a key, and refuses without one', async () => {
    const doc = (await (await exports.default.fetch('https://api.test/openapi.json', { headers })).json()) as { paths: Record<string, { get?: unknown }> }
    const lists = Object.keys(doc.paths).filter((path) => path.startsWith('/api/') && path !== '/api/health' && !path.includes('{') && doc.paths[path]!.get)
    expect(lists.length).toBeGreaterThan(0)
    for (const path of lists) {
      expect((await exports.default.fetch(`https://api.test${path}`, { headers })).status, path).toBe(200)
      expect((await exports.default.fetch(`https://api.test${path}`)).status, path).toBe(401)
    }
  })

  it('serves MCP: lists the tools and calls one through its route', async () => {
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }
    const rpc = (method: string, params: Record<string, unknown> = {}) =>
      exports.default.fetch('https://api.test/mcp', {
        method: 'POST',
        headers: { ...headers, accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
      })
    const list = (await (await rpc('tools/list')).json()) as { result: { tools: { name: string; inputSchema: { required?: string[] } }[] } }
    expect(list.result.tools.length).toBeGreaterThan(0)
    const tool = list.result.tools.find((candidate) => !candidate.inputSchema.required?.length)!
    const called = (await (await rpc('tools/call', { name: tool.name, arguments: {} })).json()) as { result: { isError?: boolean } }
    expect(called.result.isError ?? false, tool.name).toBe(false)
  })
})
