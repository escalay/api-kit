import { describe, expect, it } from 'vitest'
import { z } from '@hono/zod-openapi'
import { mountA2A } from '../src/a2a/index.js'
import { createAgentApi, createOAuth, generateOAuthKey, hashApiKey, memoryOAuthStore, parseApiKeys } from '../src/index.js'
import { inProcess, mcpTool } from '../src/mcp/index.js'

const ORIGIN = 'http://localhost'
const KEY = 'agent-key'
const OTHER = 'other-key'

const sampleApi = async ({ slow = false } = {}) => {
  const store = memoryOAuthStore()
  const oauth = createOAuth({ name: 'Sample', signingKey: await generateOAuthKey(), store, owner: async () => null })
  const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(`agent:${hashApiKey(KEY)},other:${hashApiKey(OTHER)}`) }, oauth })
  let runs = 0
  app.get('/api/v1/ideas', (c) => {
    runs += 1
    if (slow && runs === 1) return c.json({ status: 'running' }, 202, { location: '/api/v1/runs/r1' })
    return c.json({ query: c.req.query('q'), products: [{ name: 'Splitwise' }] })
  })
  app.get('/api/v1/runs/r1', (c) => c.json({ status: 'running' }))
  app.get('/api/v1/broken', (c) => c.json({ status: 404, code: 'not_found', title: 'Not found', detail: 'No such idea.' }, 404))
  const tools = [
    mcpTool({ name: 'explore_idea', title: 'Who already does an idea', description: 'Products for an idea.', input: z.object({ idea: z.string().min(2), limit: z.number().int().default(8) }), call: ({ idea, limit }) => ({ path: '/api/v1/ideas', query: { q: idea, limit } }), summarize: (json) => `"${json.query}": ${json.products.map((product: { name: string }) => product.name).join(', ')}` }),
    mcpTool({ name: 'broken', title: 'Broken', description: 'Always 404.', input: z.object({ q: z.string() }), call: () => ({ path: '/api/v1/broken' }), summarize: () => '' }),
  ]
  mountA2A(app, { info: { name: 'Sample', description: 'Two tools.', version: '1.0.0' }, skills: [{ tool: tools[0]!, text: 'idea', tags: ['research'], examples: ['split a bill'] }, { tool: tools[1]!, text: 'q', tags: ['test'] }], callApi: inProcess(app), store, oauth: true, waitMs: 0 })
  return { app, store }
}

const rpc = (method: string, params: unknown, { key = KEY, version = '1.0' as string | null } = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(version ? { 'a2a-version': version } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
})
const send = (text: string, extra: Record<string, unknown> = {}) => ({ message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text }] }, ...extra })

describe('A2A', () => {
  it('publishes an Agent Card with its JSON-RPC interface, skills and both ways in', async () => {
    const { app } = await sampleApi()
    const card = await (await app.request('/.well-known/agent-card.json')).json()
    expect(card).toMatchObject({
      name: 'Sample', version: '1.0.0', documentationUrl: `${ORIGIN}/llms.txt`,
      supportedInterfaces: [{ url: `${ORIGIN}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
      securitySchemes: { oauth: { oauth2SecurityScheme: { flows: { authorizationCode: { tokenUrl: `${ORIGIN}/oauth/token`, pkceRequired: true } } } }, apiKey: { httpAuthSecurityScheme: { scheme: 'Bearer' } } },
      defaultInputModes: ['text/plain', 'application/json'],
      skills: [{ id: 'explore_idea', name: 'Who already does an idea', tags: ['research'], examples: ['split a bill'] }, { id: 'broken' }],
    })
  })

  it('answers a message with a completed task carrying the summary and the JSON', async () => {
    const { app } = await sampleApi()
    expect((await app.request('/a2a', { method: 'POST', body: '{}' })).status).toBe(401)
    const body = await (await app.request('/a2a', rpc('SendMessage', send('split a bill with friends')))).json()
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 1, result: { task: { status: { state: 'TASK_STATE_COMPLETED' }, metadata: { skill: 'explore_idea' } } } })
    const task = body.result.task
    expect(task.artifacts[0].parts).toEqual([{ text: '"split a bill with friends": Splitwise', mediaType: 'text/plain' }, { data: { query: 'split a bill with friends', products: [{ name: 'Splitwise' }] }, mediaType: 'application/json' }])
    expect(task.history[0]).toMatchObject({ role: 'ROLE_USER', taskId: task.id, contextId: task.contextId })
    const again = await (await app.request('/a2a', rpc('GetTask', { id: task.id, historyLength: 0 }))).json()
    expect(again.result).toMatchObject({ id: task.id, status: { state: 'TASK_STATE_COMPLETED' } })
    expect(again.result.history).toBeUndefined()
    expect((await (await app.request('/a2a', rpc('GetTask', { id: task.id }, { key: OTHER }))).json()).error.code).toBe(-32001)
    const list = await (await app.request('/a2a', rpc('ListTasks', { contextId: task.contextId }))).json()
    expect(list.result).toMatchObject({ totalSize: 1, nextPageToken: '', tasks: [{ id: task.id }] })
    expect((await (await app.request('/a2a', rpc('CancelTask', { id: task.id }))).json()).error.code).toBe(-32002)
  })

  it('takes a skill and arguments from metadata and a data part, and reports bad ones as invalid params', async () => {
    const { app } = await sampleApi()
    const message = { messageId: 'm2', role: 'ROLE_USER', parts: [{ data: { idea: 'book a table', limit: 3 } }] }
    expect((await (await app.request('/a2a', rpc('SendMessage', { message, metadata: { skill: 'explore_idea' } }))).json()).result.task.artifacts[0].parts[1].data.query).toBe('book a table')
    expect((await (await app.request('/a2a', rpc('SendMessage', send('x')))).json()).error).toMatchObject({ code: -32602, data: [{ reason: 'INVALID_PARAMETERS' }] })
    expect((await (await app.request('/a2a', rpc('SendMessage', send('hello', { metadata: { skill: 'nope' } })))).json()).error.code).toBe(-32602)
    const failed = await (await app.request('/a2a', rpc('SendMessage', send('hello', { metadata: { skill: 'broken' } })))).json()
    expect(failed.result.task.status).toMatchObject({ state: 'TASK_STATE_FAILED', message: { role: 'ROLE_AGENT', parts: [{ text: '404 not_found Not found: No such idea.' }] } })
  })

  it('keeps a task for a day, in the epoch seconds the store takes', async () => {
    const { app, store } = await sampleApi()
    const task = (await (await app.request('/a2a', rpc('SendMessage', send('split a bill')))).json()).result.task
    expect(await store.get('a2a-task', task.id)).not.toBeNull()
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 86_400_000 + 1_000
      expect(await store.get('a2a-task', task.id)).toBeNull()
    } finally {
      Date.now = realNow
    }
  })

  it('leaves a slow call working and finishes it on GetTask', async () => {
    const { app } = await sampleApi({ slow: true })
    const task = (await (await app.request('/a2a', rpc('SendMessage', send('split a bill')))).json()).result.task
    expect(task.status.state).toBe('TASK_STATE_WORKING')
    expect((await (await app.request('/a2a', rpc('GetTask', { id: task.id }))).json()).result.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('speaks JSON-RPC errors for versions, methods and what it does not do', async () => {
    const { app } = await sampleApi()
    const code = async (init: RequestInit) => (await (await app.request('/a2a', init)).json()).error.code
    expect(await code(rpc('SendMessage', send('split a bill'), { version: null }))).toBe(-32009)
    expect(await code(rpc('SendStreamingMessage', send('split a bill')))).toBe(-32004)
    expect(await code(rpc('GetExtendedAgentCard', {}))).toBe(-32004)
    expect(await code(rpc('CreateTaskPushNotificationConfig', {}))).toBe(-32003)
    expect(await code(rpc('Nope', {}))).toBe(-32601)
    expect(await code({ ...rpc('SendMessage', {}), body: 'not json' })).toBe(-32700)
    expect(await code({ ...rpc('SendMessage', {}), body: '[]' })).toBe(-32600)
  })

})
