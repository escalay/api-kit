/**
 * A stateless MCP 2026-07-28 client over HTTP: every request is one POST to `<url>/mcp` with the protocol's `_meta`
 * envelope, the `Mcp-Method` header and, for a call or a read, `Mcp-Name`. Failures become `CliError`s with the exit
 * code they stand for.
 */
import type { Problem } from './job.js'

export const PROTOCOL = '2026-07-28'
export const PROBLEM_META = 'api-kit/problem'
export const PENDING_META = 'api-kit/pending'
/** The kit's hash of the server's tool list, on each listed tool and every call's result. */
export const TOOLS_HASH_META = 'api-kit/tools-hash'

/** The exit codes, stable for scripts and agents. */
export const EXIT = { ok: 0, usage: 1, signIn: 2, notFound: 3, refused: 4, server: 5, timeout: 6, interrupted: 130 } as const

/** The exit code an HTTP status stands for. */
export const exitFor = (status: number) => {
  if (status === 400) return EXIT.usage
  if (status === 401 || status === 403) return EXIT.signIn
  if (status === 404 || status === 410) return EXIT.notFound
  if (status === 408 || status === 504) return EXIT.timeout
  if (status >= 500 || status === 0) return EXIT.server
  return status >= 400 ? EXIT.refused : EXIT.ok
}

/** A failure with its exit code, and the problem behind it when there is one. */
export class CliError extends Error {
  readonly exitCode: number
  readonly problem?: Problem
  constructor(message: string, exitCode: number, problem?: Problem) {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.problem = problem
  }
}

/** A problem as one line: `404 not_found Not found: No such app.` (as the kit's tools write it). */
export const problemLine = (problem: Problem) => `${problem.status} ${problem.code ?? ''} ${problem.title}: ${problem.detail ?? ''}`.replace(/\s+/g, ' ').replace(/:\s*$/, '').trim()

export type ToolResult = { content?: { type: string; text?: string; uri?: string; name?: string; title?: string }[]; structuredContent?: unknown; isError?: boolean; _meta?: Record<string, any> }
type Rpc = { result?: any; error?: { code: number; message: string; data?: unknown } }

/** The JSON-RPC answer in a body that is JSON or a server-sent event stream. */
const answerOf = (type: string, text: string): Rpc => {
  if (!type.includes('event-stream')) return JSON.parse(text) as Rpc
  const events = text.split(/\n\n/).map((event) => event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')).filter(Boolean)
  const found = events.map((data) => JSON.parse(data) as Rpc & { id?: unknown }).find((message) => message.id !== undefined)
  if (!found) throw new CliError('The server sent no answer in its event stream.', EXIT.server)
  return found
}

export type McpClientOptions = {
  url: string
  /** The bearer to send; called again after `refresh` says it found a new one. */
  bearer: () => Promise<string | undefined>
  /** On a 401: try to get a new bearer; true to retry once. */
  refresh?: () => Promise<boolean>
  fetch: typeof fetch
  signIn: string
}

export const mcpClient = ({ url, bearer, refresh, fetch: send, signIn }: McpClientOptions) => {
  const endpoint = `${url.replace(/\/+$/, '')}/mcp`

  const post = async (method: string, params: Record<string, unknown>, signal: AbortSignal | undefined, retried = false): Promise<any> => {
    const token = await bearer()
    let response: Response
    try {
      response = await send(endpoint, {
        method: 'POST',
        signal,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': PROTOCOL,
          'mcp-method': method,
          ...(method === 'tools/call' ? { 'mcp-name': String(params.name) } : {}),
          ...(method === 'resources/read' ? { 'mcp-name': String(params.uri) } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientCapabilities': {} } } }),
      })
    } catch (error) {
      if (signal?.aborted) throw signal.reason instanceof CliError ? signal.reason : new CliError('Stopped.', EXIT.interrupted)
      throw new CliError(`Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`, EXIT.server)
    }
    if ((response.status === 401 || response.status === 403) && !retried && refresh && (await refresh())) return post(method, params, signal, true)
    const text = await response.text()
    if (response.status === 401 || response.status === 403) throw new CliError(`${response.status === 401 ? 'Not signed in' : 'Not allowed'} at ${url}: ${signIn}`, EXIT.signIn, { title: 'Not signed in', status: response.status })
    if (response.status === 404) throw new CliError(`No MCP server at ${endpoint} (404): check the address`, EXIT.server)
    if (!response.ok) {
      const problem = (() => {
        try {
          return JSON.parse(text) as Problem
        } catch {
          return undefined
        }
      })()
      throw new CliError(problem?.title ? problemLine({ ...problem, status: response.status }) : `${endpoint} answered ${response.status}`, exitFor(response.status), problem ? { ...problem, status: response.status } : undefined)
    }
    const answer = answerOf(response.headers.get('content-type') ?? '', text)
    if (answer.error) {
      // A route's failure inside a read comes back as `404 not_found …` in the message
      const status = Number(answer.error.message.match(/^(\d{3}) /)?.[1] ?? 0)
      if (status) throw new CliError(answer.error.message, exitFor(status), { title: answer.error.message, status })
      throw new CliError(answer.error.message, answer.error.code === -32602 ? EXIT.usage : EXIT.server)
    }
    return answer.result
  }

  return {
    discover: (signal?: AbortSignal) => post('server/discover', {}, signal) as Promise<{ serverInfo?: { name: string; version: string } }>,
    listTools: (signal?: AbortSignal) => post('tools/list', {}, signal) as Promise<{ tools: any[]; ttlMs?: number; _meta?: Record<string, any> }>,
    listTemplates: (signal?: AbortSignal) => post('resources/templates/list', {}, signal) as Promise<{ resourceTemplates: any[]; ttlMs?: number }>,
    callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => post('tools/call', { name, arguments: args }, signal) as Promise<ToolResult>,
    readResource: (uri: string, signal?: AbortSignal) => post('resources/read', { uri }, signal) as Promise<{ contents: { uri: string; mimeType?: string; text?: string; blob?: string }[] }>,
  }
}

export type McpClient = ReturnType<typeof mcpClient>

/** A failed tool result's problem: the kit's `_meta`, else read from its text (`404 not_found …`). */
export const problemOfResult = (result: ToolResult): Problem => {
  const meta = result._meta?.[PROBLEM_META] as Problem | undefined
  if (meta) return meta
  const text = (result.content ?? []).map((part) => part.text ?? '').join('\n')
  const status = Number(text.match(/^(\d{3}) /)?.[1] ?? 0)
  // The SDK's own refusal of bad arguments, before the tool runs
  if (!status && /^Input validation error/i.test(text)) return { title: 'Invalid arguments', detail: text, status: 400 }
  return { title: text || 'The tool failed', status: status || 500 }
}
