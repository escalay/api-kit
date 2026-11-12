/**
 * The client's core: one request with the key, an `Idempotency-Key` on creates and changes, one retry when the
 * connection fails, problem+json errors as `__Pascal__Error`, and lists paged by cursor. Written once by `kit sdk`;
 * yours from then on. It needs only `fetch`, so it runs in Node 20+, Workers, Deno, Bun and browsers.
 */

/** An RFC 9457 problem, as the API answers every error. */
export type Problem = { type: string; code: string; title: string; status: number; detail?: string; instance?: string }

/** The API answered with a problem. `code` is stable to branch on; `detail` says what to change. */
export class __Pascal__Error extends Error {
  readonly status: number
  /** The problem's code, or `network` when the API could not be reached. */
  readonly code: string
  readonly detail?: string
  readonly problem?: Problem

  constructor(status: number, problem?: Problem, cause?: unknown) {
    super(problem ? `${problem.title}: ${problem.detail ?? problem.code}` : `__Title__ could not be reached (${String(cause)})`, { cause })
    this.name = '__Pascal__Error'
    this.status = status
    this.code = problem?.code ?? 'network'
    this.detail = problem?.detail
    this.problem = problem
  }
}

export type ClientOptions = {
  /** The deployment's address, e.g. `https://api.example.com`. A path after it is kept. */
  baseUrl: string
  /** Sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string
  /** Another `fetch`, e.g. one that adds headers or records calls. */
  fetch?: typeof fetch
}

export type Call = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  query?: Record<string, unknown>
  body?: unknown
  signal?: AbortSignal
}

/** A query string from an object: undefined and null left out, arrays joined with commas. */
export const queryOf = (query: Record<string, unknown> = {}) => {
  const pairs = Object.entries(query).flatMap(([name, value]): [string, string][] => {
    if (value === undefined || value === null) return []
    if (Array.isArray(value)) return [[name, value.join(',')]]
    return [[name, String(value)]]
  })
  return pairs.length ? `?${new URLSearchParams(pairs)}` : ''
}

/** The cursor in a `_links.next` href. The href itself is never followed: it names the origin the server saw. */
export const cursorOf = (links: { next?: { href: string } }) => (links.next ? (new URL(links.next.href).searchParams.get('cursor') ?? undefined) : undefined)

const PAGE = 100

/**
 * createRequest returns `request` (one call, typed by the caller) and `pages` (every item of a list, page after page).
 * Every URL is built from `baseUrl`, never from a link in an answer.
 */
export const createRequest = ({ baseUrl, apiKey, fetch: send = globalThis.fetch.bind(globalThis) }: ClientOptions) => {
  const base = baseUrl.replace(/\/+$/, '')

  const request = async <Json>(path: string, { method = 'GET', query, body, signal }: Call = {}): Promise<Json> => {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (apiKey) headers.authorization = `Bearer ${apiKey}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    // A create or change sent twice with the same key happens once: the one retry below is safe
    if (method === 'POST' || method === 'PATCH') headers['idempotency-key'] = crypto.randomUUID()
    const init: RequestInit = { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal }
    const url = `${base}${path}${queryOf(query)}`
    let response: Response
    try {
      response = await send(url, init)
    } catch (error) {
      if (signal?.aborted) throw error
      try {
        response = await send(url, init)
      } catch (again) {
        throw new __Pascal__Error(0, undefined, again)
      }
    }
    if (response.status === 204) return undefined as Json
    const json = await response.json().catch(() => undefined)
    if (!response.ok) throw new __Pascal__Error(response.status, json as Problem | undefined)
    return json as Json
  }

  /** Every item of a HAL list (`_embedded[name]`), page after page. */
  async function* pages<Item>(path: string, name: string, query: Record<string, unknown> = {}): AsyncGenerator<Item> {
    let cursor: string | undefined
    do {
      const page = await request<{ _links: { next?: { href: string } }; _embedded: Record<string, Item[]> }>(path, { query: { ...query, limit: PAGE, cursor } })
      yield* page._embedded[name] ?? []
      cursor = cursorOf(page._links)
    } while (cursor)
  }

  return { request, pages }
}
