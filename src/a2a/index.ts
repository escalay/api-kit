/**
 * A2A (Agent2Agent, spec 1.0) over the app's MCP tools: the Agent Card at `/.well-known/agent-card.json` and a JSON-RPC
 * endpoint (`SendMessage`, `GetTask`, `ListTasks`, `CancelTask`). Each skill is one tool: a message's text fills the
 * tool's main argument (a `data` part may give all of them), the tool runs its route in-process with the caller's own
 * credentials, and the answer comes back as a Task whose artifact holds the tool's summary (text) and the route's JSON
 * (data). A slow route (202 + run) leaves the task working; `GetTask` asks again. Tasks live in the store for a day and
 * only their caller sees them. No streaming, push notifications or extended card: the card says so.
 *
 * @example
 * mountA2A(app, {
 *   info: { name: 'Cookbook', description: 'Recipes and menus…', version: '1.0.0' },
 *   skills: [{ tool: exploreIdea, text: 'idea', tags: ['research'], examples: ['split a bill with friends'] }],
 *   callApi: inProcess(app), store: state.oauth, oauth: true,
 * })
 */
import { randomUUID } from 'node:crypto'
import type { AuthInfo } from '@modelcontextprotocol/server'
import type { Context, Hono } from 'hono'
import { sendPublic, WELL_KNOWN } from '../core/discovery.js'
import { originOf } from '../core/hal.js'
import { callWaiting, FORWARDED, problemText, type CallApi, type McpTool } from '../mcp/index.js'
import { memoryStore, type KeyValueStore } from '../core/kv.js'

export const A2A_VERSION = '1.0'

/** One A2A skill: an MCP tool, the argument a plain-text message fills, and how registries should file it. */
export type A2ASkill = {
  tool: McpTool
  /** The tool's argument that a message's text fills, e.g. `idea` or `purpose`. */
  text: string
  tags: string[]
  examples?: string[]
}

/** Any key-value store with expiry (`kv.ts`); the OAuth store fits (tasks are kept under the kind `a2a-task`). */
export type A2ATaskStore = KeyValueStore

export type A2AConfig = {
  path?: string
  info: { name: string; description: string; version: string; organization?: string }
  /** The first is used when a message names none (`metadata.skill`). */
  skills: A2ASkill[]
  callApi: CallApi
  store?: A2ATaskStore
  /** Advertise the app's OAuth server (`oauth.ts`) beside API keys. */
  oauth?: boolean
  /** How long `SendMessage` waits for a slow route before answering with a working task. */
  waitMs?: number
}

type Part = { text?: string; data?: unknown; url?: string; raw?: string; mediaType?: string; filename?: string; metadata?: Record<string, unknown> }
type Message = { messageId: string; role: string; parts: Part[]; contextId?: string; taskId?: string; metadata?: Record<string, unknown> }
type TaskState = 'TASK_STATE_WORKING' | 'TASK_STATE_COMPLETED' | 'TASK_STATE_FAILED' | 'TASK_STATE_CANCELED' | 'TASK_STATE_AUTH_REQUIRED'
type Task = { id: string; contextId: string; status: { state: TaskState; message?: Message; timestamp: string }; artifacts?: unknown[]; history?: Message[]; metadata: Record<string, unknown> }
type Stored = { owner: string; task: Task; skill: string; args: Record<string, unknown>; created: number }

const TERMINAL = new Set<TaskState>(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'])
const DAY = 86_400_000
const KIND = 'a2a-task'
const INDEX = 'a2a-tasks'

/** JSON-RPC and A2A error codes (spec §5.4, §9.5). */
const ERRORS = {
  parse: [-32700, 'Invalid JSON payload'],
  request: [-32600, 'Request payload validation error'],
  method: [-32601, 'Method not found'],
  params: [-32602, 'Invalid parameters'],
  taskNotFound: [-32001, 'Task not found', 'TASK_NOT_FOUND'],
  notCancelable: [-32002, 'Task cannot be canceled', 'TASK_NOT_CANCELABLE'],
  noPush: [-32003, 'Push notifications are not supported', 'PUSH_NOTIFICATION_NOT_SUPPORTED'],
  unsupported: [-32004, 'This operation is not supported', 'UNSUPPORTED_OPERATION'],
  version: [-32009, 'This A2A version is not supported', 'VERSION_NOT_SUPPORTED'],
} as const

class RpcError extends Error {
  constructor(readonly error: (typeof ERRORS)[keyof typeof ERRORS], readonly detail: string) {
    super(detail)
  }
}

const rpcError = (id: unknown, [code, message, reason]: readonly [number, string, string?], detail: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message, data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: reason ?? message.toUpperCase().replace(/\W+/g, '_'), domain: 'a2a-protocol.org', metadata: { detail } }] },
})

const agentMessage = (text: string, task: Pick<Task, 'id' | 'contextId'>): Message => ({ messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text }], taskId: task.id, contextId: task.contextId })

/** The Agent Card (spec §4.4.1) for this origin. */
export const agentCard = (origin: string, { path = '/a2a', info, skills, oauth }: A2AConfig) => ({
  name: info.name,
  description: info.description,
  supportedInterfaces: [{ url: origin + path, protocolBinding: 'JSONRPC', protocolVersion: A2A_VERSION }],
  provider: { organization: info.organization ?? info.name, url: origin },
  version: info.version,
  documentationUrl: origin + WELL_KNOWN.guide,
  capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
  securitySchemes: {
    ...(oauth
      ? {
          oauth: {
            oauth2SecurityScheme: {
              description: 'The owner approves each agent: register at /oauth/register (or follow /auth.md), then the authorization code flow with PKCE.',
              flows: { authorizationCode: { authorizationUrl: `${origin}/oauth/authorize`, tokenUrl: `${origin}/oauth/token`, refreshUrl: `${origin}/oauth/token`, scopes: { read: 'Look things up.', write: 'Change saved state.' }, pkceRequired: true } },
              oauth2MetadataUrl: `${origin}/.well-known/oauth-authorization-server`,
            },
          },
        }
      : {}),
    apiKey: { httpAuthSecurityScheme: { description: 'An API key from the owner, as a bearer token.', scheme: 'Bearer' } },
  },
  securityRequirements: [...(oauth ? [{ schemes: { oauth: { list: ['read'] } } }] : []), { schemes: { apiKey: { list: [] } } }],
  defaultInputModes: ['text/plain', 'application/json'],
  defaultOutputModes: ['text/plain', 'application/json'],
  skills: skills.map(({ tool, tags, examples }) => ({ id: tool.name, name: tool.title, description: tool.description, tags, ...(examples ? { examples } : {}) })),
})

/** Serves the Agent Card and the JSON-RPC endpoint. Mount after `createAgentApi`, whose `authenticate` guards `path`. */
export const mountA2A = (app: Hono<any, any, any>, config: A2AConfig) => {
  const { path = '/a2a', skills, callApi, store = memoryStore(), waitMs = 60_000 } = config
  // Each Worker isolate has its own memory: a task made in one is missing in the next
  if (!config.store && globalThis.navigator?.userAgent === 'Cloudflare-Workers') console.warn('mountA2A: tasks are kept in memory; on Workers pass a store in the database (dbOAuthStore(db) fits)')
  const byId = new Map(skills.map((skill) => [skill.tool.name, skill]))

  app.get(WELL_KNOWN.agentCard, (c: Context) => sendPublic(c, JSON.stringify(agentCard(originOf(c), config), null, 2), 'application/json'))

  const ownerOf = (c: Context) => {
    const caller = c.get('caller' as never) as { kind: string; name?: string; email?: string } | undefined
    return `${caller?.kind ?? 'anonymous'}:${caller?.name ?? caller?.email ?? ''}`
  }
  const authOf = (c: Context): AuthInfo => ({
    token: '',
    clientId: ownerOf(c),
    scopes: [],
    extra: {
      headers: {
        ...Object.fromEntries(FORWARDED.flatMap((name) => (c.req.header(name) ? [[name, c.req.header(name)!]] : []))),
        'x-forwarded-proto': new URL(originOf(c)).protocol.replace(':', ''),
        'x-forwarded-host': new URL(originOf(c)).host,
      },
    },
  })

  const save = async (owner: string, stored: Stored) => {
    // The store takes epoch seconds
    await store.put(KIND, stored.task.id, stored as never, Math.floor((stored.created + DAY) / 1000))
    const index = ((await store.get(INDEX, owner))?.ids as string[] | undefined) ?? []
    if (!index.includes(stored.task.id)) await store.put(INDEX, owner, { ids: [stored.task.id, ...index].slice(0, 500) }, Math.floor((Date.now() + DAY) / 1000))
  }
  const load = async (owner: string, id: unknown) => {
    const stored = typeof id === 'string' ? ((await store.get(KIND, id)) as Stored | null) : null
    if (!stored || stored.owner !== owner) throw new RpcError(ERRORS.taskNotFound, `No task ${String(id)} for this caller (tasks are kept for a day).`)
    return stored
  }
  const shown = (stored: Stored, historyLength?: number) => {
    const { history = [], ...task } = stored.task
    return historyLength === 0 ? task : { ...task, history: historyLength ? history.slice(-historyLength) : history }
  }

  /** Runs (or asks again for) the task's tool call and records the outcome on the task. */
  const run = async (c: Context, stored: Stored, wait: number) => {
    const skill = byId.get(stored.skill)!
    const { response, pending } = await callWaiting(callApi, skill.tool.call(stored.args as never), authOf(c), wait)
    const json = await response.json().catch(() => null)
    const at = new Date().toISOString()
    const task = stored.task
    if (pending) task.status = { state: 'TASK_STATE_WORKING', message: agentMessage(`Still working (run ${pending}). Ask again with GetTask.`, task), timestamp: at }
    else if (response.ok) {
      task.status = { state: 'TASK_STATE_COMPLETED', timestamp: at }
      task.artifacts = [{ artifactId: randomUUID(), name: skill.tool.title, parts: [{ text: skill.tool.summarize(json, stored.args as never), mediaType: 'text/plain' }, { data: json, mediaType: 'application/json' }] }]
    } else {
      const state = response.status === 401 || response.status === 403 ? 'TASK_STATE_AUTH_REQUIRED' : 'TASK_STATE_FAILED'
      task.status = { state, message: agentMessage(problemText(json, response.status), task), timestamp: at }
    }
    if (task.status.message) task.history = [...(task.history ?? []), task.status.message]
    await save(stored.owner, stored)
    return stored
  }

  const argsOf = (skill: A2ASkill, message: Message) => {
    const data = message.parts.find((part) => part.data && typeof part.data === 'object' && !Array.isArray(part.data))?.data as Record<string, unknown> | undefined
    const text = message.parts.flatMap((part) => (typeof part.text === 'string' ? [part.text] : [])).join('\n').trim()
    const args = { ...(text ? { [skill.text]: text } : {}), ...data }
    const parsed = skill.tool.input.safeParse(args)
    if (!parsed.success) throw new RpcError(ERRORS.params, `${skill.tool.name}: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || skill.text}: ${issue.message}`).join('; ')}`)
    return parsed.data as Record<string, unknown>
  }

  const methods: Record<string, (c: Context, params: any) => Promise<unknown>> = {
    SendMessage: async (c, params) => {
      const message = params?.message as Message | undefined
      if (!message || typeof message.messageId !== 'string' || message.role !== 'ROLE_USER' || !Array.isArray(message.parts) || !message.parts.length)
        throw new RpcError(ERRORS.params, 'params.message needs messageId, role ROLE_USER and at least one part.')
      const owner = ownerOf(c)
      if (message.taskId) {
        const stored = await load(owner, message.taskId)
        if (TERMINAL.has(stored.task.status.state)) throw new RpcError(ERRORS.unsupported, `Task ${stored.task.id} is finished; send a new message without taskId.`)
        return { task: shown(await run(c, stored, 0), params?.configuration?.historyLength) }
      }
      const name = (params?.metadata?.skill ?? message.metadata?.skill ?? skills[0]?.tool.name) as string
      const skill = byId.get(name)
      if (!skill) throw new RpcError(ERRORS.params, `Unknown skill ${name}. Skills: ${[...byId.keys()].join(', ')}.`)
      const args = argsOf(skill, message)
      const task: Task = { id: randomUUID(), contextId: message.contextId ?? randomUUID(), status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() }, metadata: { skill: name } }
      task.history = [{ ...message, taskId: task.id, contextId: task.contextId }]
      const stored = await run(c, { owner, task, skill: name, args, created: Date.now() }, params?.configuration?.returnImmediately ? 0 : waitMs)
      return { task: shown(stored, params?.configuration?.historyLength) }
    },
    GetTask: async (c, params) => {
      const stored = await load(ownerOf(c), params?.id)
      return shown(stored.task.status.state === 'TASK_STATE_WORKING' ? await run(c, stored, 0) : stored, params?.historyLength)
    },
    ListTasks: async (c, params) => {
      const owner = ownerOf(c)
      const ids = ((await store.get(INDEX, owner))?.ids as string[] | undefined) ?? []
      const all = (await Promise.all(ids.map((id) => store.get(KIND, id) as Promise<Stored | null>))).filter((stored): stored is Stored => !!stored && stored.owner === owner)
      const matching = all.filter((stored) => (!params?.contextId || stored.task.contextId === params.contextId) && (!params?.status || stored.task.status.state === params.status))
      const pageSize = Math.min(Math.max(Number(params?.pageSize) || 50, 1), 100)
      const start = Number(params?.pageToken) || 0
      const page = matching.slice(start, start + pageSize)
      return {
        tasks: page.map((stored) => {
          const task = shown(stored, params?.historyLength ?? 0) as Task
          return params?.includeArtifacts ? task : { ...task, artifacts: undefined }
        }),
        nextPageToken: start + pageSize < matching.length ? String(start + pageSize) : '',
        pageSize,
        totalSize: matching.length,
      }
    },
    CancelTask: async (c, params) => {
      const stored = await load(ownerOf(c), params?.id)
      if (TERMINAL.has(stored.task.status.state)) throw new RpcError(ERRORS.notCancelable, `Task ${stored.task.id} already ended (${stored.task.status.state}).`)
      stored.task.status = { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() }
      await save(stored.owner, stored)
      return shown(stored)
    },
  }
  const unsupported = ['SendStreamingMessage', 'SubscribeToTask', 'GetExtendedAgentCard']
  const push = ['CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs', 'DeleteTaskPushNotificationConfig']

  app.post(path, async (c: Context) => {
    const reply = (body: unknown) => c.json(body as never, 200)
    const body = await c.req.json().catch(() => undefined)
    if (body === undefined) return reply(rpcError(null, ERRORS.parse, 'The body is not JSON.'))
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string')
      return reply(rpcError(body?.id, ERRORS.request, 'Send one JSON-RPC 2.0 request: {"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{…}}.'))
    // An absent version means 0.3 (spec §3.2.6); this endpoint speaks 1.0
    const version = c.req.header('a2a-version') ?? c.req.query('A2A-Version') ?? '0.3'
    if (version.split('.').slice(0, 2).join('.') !== A2A_VERSION) return reply(rpcError(body.id, ERRORS.version, `Send the header A2A-Version: ${A2A_VERSION}.`))
    if (unsupported.includes(body.method)) return reply(rpcError(body.id, ERRORS.unsupported, `${body.method}: this agent answers SendMessage and GetTask only (no streaming, no extended card).`))
    if (push.includes(body.method)) return reply(rpcError(body.id, ERRORS.noPush, 'Poll with GetTask instead.'))
    const method = methods[body.method]
    if (!method) return reply(rpcError(body.id, ERRORS.method, `Methods: ${Object.keys(methods).join(', ')}.`))
    try {
      return reply({ jsonrpc: '2.0', id: body.id ?? null, result: await method(c, body.params) })
    } catch (error) {
      if (error instanceof RpcError) return reply(rpcError(body.id, error.error, error.detail))
      throw error
    }
  })
}
