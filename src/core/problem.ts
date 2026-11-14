/**
 * Errors as RFC 9457 problem details (`application/problem+json`). Every error has a stable machine `code` (also the
 * last segment of its `type` URI, which the API serves as a page), a human `title`, the HTTP `status`, and a `detail`
 * that says what to do next. Validation errors list each bad field in `errors`.
 *
 * @example
 * throw new ProblemError(404, 'not_found', { detail: 'No item 42. Search with GET /api/v1/search/recipes.' })
 * createRoute({ …, responses: { 200: …, ...problemResponses(400, 404) } })
 */
import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { originOf } from './hal.js'

export const PROBLEM_JSON = 'application/problem+json'

/** Every problem the API returns, with the status it comes with and what it means. */
export const PROBLEMS = {
  bad_request: { status: 400, title: 'Bad request', description: 'A parameter or the body is invalid. `errors` lists each one with its path; fix them and retry.' },
  unauthorized: { status: 401, title: 'Unauthorized', description: 'No valid API key. Send `Authorization: Bearer <key>`; keys are issued per client.' },
  forbidden: { status: 403, title: 'Forbidden', description: 'The key is valid but may not do this.' },
  feature_disabled: { status: 403, title: 'Feature disabled', description: 'This feature is switched off here. `feature` names it, `blockedBy` the features it needs that are off, and an owner switches it on at `switchOn`.' },
  not_found: { status: 404, title: 'Not found', description: 'Nothing at this path or with this id in the current snapshot. Find ids through search or a list, then follow `_links`.' },
  method_not_allowed: { status: 405, title: 'Method not allowed', description: 'This path exists but not with this method.' },
  conflict: { status: 409, title: 'Conflict', description: 'The change clashes with the current state (a name already taken, a stale If-Match).' },
  gone: { status: 410, title: 'Gone', description: 'This existed in an earlier snapshot and was removed.' },
  payload_too_large: { status: 413, title: 'Payload too large', description: 'The body is over the limit given in `detail`.' },
  unsupported_media_type: { status: 415, title: 'Unsupported media type', description: 'Send the content type the operation lists.' },
  unprocessable: { status: 422, title: 'Unprocessable', description: 'The request is well formed but can\'t be applied as sent, e.g. an Idempotency-Key reused with a different body.' },
  too_many_requests: { status: 429, title: 'Too many requests', description: 'Slow down: wait the seconds in `Retry-After`, then retry.' },
  spend_cap: { status: 429, title: 'Spend cap reached', description: 'This operation costs money and its budget is used up. Free operations still work.' },
  internal: { status: 500, title: 'Internal error', description: 'A bug on our side. Retrying the same request rarely helps; report the `instance`.' },
  upstream: { status: 503, title: 'Upstream failed', description: 'A service this call depends on (a model, storage) failed. Retry after `Retry-After` seconds.' },
  unavailable: { status: 503, title: 'Unavailable', description: 'The data is still loading or being replaced. Retry after `Retry-After` seconds.' },
} as const satisfies Record<string, { status: number; title: string; description: string }>

export type ProblemCode = keyof typeof PROBLEMS

export const ProblemSchema = z
  .object({
    type: z.string().url().openapi({ description: 'URI of the problem type; its last segment is `code`, and it opens a page describing it.', example: 'https://api.example.com/problems/not_found' }),
    code: z.enum(Object.keys(PROBLEMS) as [ProblemCode, ...ProblemCode[]]).openapi({ description: 'Stable machine-readable code. Branch on this, not on `title`.' }),
    title: z.string().openapi({ description: 'Short, human summary of the problem type.', example: 'Not found' }),
    status: z.number().int().openapi({ description: 'The HTTP status, repeated for convenience.', example: 404 }),
    detail: z.string().optional().openapi({ description: 'What went wrong this time and what to do next.', example: 'No item 42.' }),
    instance: z.string().optional().openapi({ description: 'The request id; quote it when reporting a bug.', example: 'req_01J…' }),
    errors: z
      .array(z.object({ in: z.enum(['path', 'query', 'header', 'body']).optional(), path: z.string(), message: z.string() }))
      .optional()
      .openapi({ description: 'For `bad_request`: every invalid field, where it is (`in`) and why.' }),
  })
  .catchall(z.unknown())
  .openapi('Problem', { description: 'An error, as RFC 9457 problem details (`application/problem+json`).' })

export type Problem = z.infer<typeof ProblemSchema>

export class ProblemError extends Error {
  constructor(
    readonly code: ProblemCode,
    readonly options: { detail?: string; errors?: Problem['errors']; headers?: Record<string, string>; extensions?: Record<string, unknown> } = {},
  ) {
    super(options.detail ?? PROBLEMS[code].title)
  }
}

export const problemBody = (c: Context, code: ProblemCode, options: ProblemError['options'] = {}): Problem => ({
  type: `${originOf(c)}/problems/${code}`,
  code,
  title: PROBLEMS[code].title,
  status: PROBLEMS[code].status,
  ...(options.detail ? { detail: options.detail } : {}),
  ...(c.get('requestId' as never) ? { instance: c.get('requestId' as never) as string } : {}),
  ...(options.errors ? { errors: options.errors } : {}),
  ...options.extensions,
})

/** Seconds an `upstream` problem asks the client to wait unless the code passes its own `retry-after`. */
export const UPSTREAM_RETRY_AFTER = 30

export const problemResponse = (c: Context, code: ProblemCode, options: ProblemError['options'] = {}) =>
  c.body(JSON.stringify(problemBody(c, code, options)), PROBLEMS[code].status as ContentfulStatusCode, {
    'content-type': PROBLEM_JSON,
    // 503, never 502: Cloudflare replaces a 502's body with its own page, and the problem is lost
    ...(code === 'upstream' ? { 'retry-after': String(UPSTREAM_RETRY_AFTER) } : {}),
    ...options.headers,
  })

/** Response entries for `createRoute`: `...problemResponses(400, 404)` documents those errors as problem+json. */
export const problemResponses = (...statuses: number[]) =>
  Object.fromEntries(
    statuses.map((status) => {
      const codes = Object.entries(PROBLEMS).filter(([, problem]) => problem.status === status)
      return [status, { description: codes.map(([code, problem]) => `\`${code}\`: ${problem.description}`).join(' '), content: { [PROBLEM_JSON]: { schema: ProblemSchema } } }]
    }),
  )

type Issue = { path: PropertyKey[]; message: string }

/** `defaultHook` for OpenAPIHono: a failed zod validation becomes a 400 problem listing every bad field. */
export const validationHook = (result: { success: boolean; target?: string; error?: { issues: Issue[] } }, c: Context) => {
  if (result.success) return
  const where = ({ param: 'path', query: 'query', header: 'header', json: 'body', form: 'body' } as const)[result.target as 'param'] ?? undefined
  const errors = (result.error?.issues ?? []).map((issue) => ({ ...(where ? { in: where } : {}), path: issue.path.map(String).join('.') || '(root)', message: issue.message }))
  return problemResponse(c, 'bad_request', { detail: `${errors.length} invalid ${errors.length === 1 ? 'field' : 'fields'}: ${errors.map((error) => error.path).join(', ')}.`, errors })
}

/** `app.onError`: problems as themselves, Hono's HTTP errors by status, anything else as a logged 500. */
export const errorHandler = (error: Error, c: Context) => {
  if (error instanceof ProblemError) return problemResponse(c, error.code, error.options)
  if (error instanceof HTTPException) {
    // A bare 503 says the service can't answer now, not that something behind it failed: `upstream` is only ever named
    const code = (error.status === 503 ? 'unavailable' : (Object.entries(PROBLEMS).find(([, problem]) => problem.status === error.status)?.[0] ?? 'internal')) as ProblemCode
    return problemResponse(c, code, { detail: error.message })
  }
  console.error(`${c.req.method} ${c.req.path}`, error)
  return problemResponse(c, 'internal')
}

/** A wrong path says how to find the right one: a trailing slash dropped, the root, the spec. */
export const notFoundHandler = (c: Context) => {
  const path = c.req.path
  const hint = path.length > 1 && path.endsWith('/') ? ` Drop the trailing slash: ${path.slice(0, -1)}.` : ''
  return problemResponse(c, 'not_found', { detail: `No route ${c.req.method} ${path}.${hint} Start from GET /api and follow _links, look the operation up in GET /openapi.json, or read /llms.txt.` })
}
