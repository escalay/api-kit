/**
 * Two guards for calls that change something or cost money, both keyed by the caller:
 *   idempotency   `Idempotency-Key` on POST and PATCH (IETF httpapi-idempotency-key): a retry with the same key and
 *                 body gets the stored answer (`Idempotent-Replayed: true`), the same key with another body is a 422,
 *                 one still in flight a 409. Kept 24 hours.
 *   rateLimit     at most `limit` calls per `windowSeconds` per caller on the routes it guards, with the draft
 *                 `RateLimit-Policy` / `RateLimit` headers (IETF httpapi-ratelimit-headers) and a 429 problem with
 *                 `Retry-After` past it: a looping agent can't drain a paid budget.
 * Both keep their state in a `GuardStore`: `memoryGuardStore()` (the default) is right for one Node process; on
 * Workers, where every isolate has its own memory, pass `dbGuardStore(db)` (`db`) so all of them share it.
 *
 * @example
 * const guards = await dbGuardStore(db)
 * const app = createAgentApi({ …, guards: { store: guards } })                   // idempotency, wired for you
 * app.use('/api/v1/products/:id/gaps', rateLimit({ policy: 'paid', limit: 120, windowSeconds: 3600, store: guards }))
 */
import { createHash } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { problemResponse } from './problem.js'

/** A stored answer to replay: the body is base64, so a store can keep it as JSON. */
export type StoredAnswer = { bodyHash: string; status: number; headers: [string, string][]; body: string }

/** Where the guards keep their state. Each method is atomic, so concurrent requests can't both pass a check. */
export type GuardStore = {
  /** Counts one call against `id`; a window that started `windowMs` ago or earlier starts over. */
  count: (id: string, windowMs: number, now: number) => Promise<{ start: number; used: number }>
  /**
   * Claims an idempotency key for `lockMs`: null when this request now holds it, `'running'` when another request
   * does, or the answer saved for it.
   */
  claim: (id: string, lockMs: number, now: number) => Promise<StoredAnswer | 'running' | null>
  /** Saves the answer for a key this request holds, kept until `expiresAt` (epoch ms). */
  save: (id: string, answer: StoredAnswer, expiresAt: number) => Promise<void>
  /** Lets go of a key this request holds without an answer (a server error), so a retry can run. */
  release: (id: string) => Promise<void>
}

/** The guards' state in this process's memory: one Node instance. Old entries go once there are `maxEntries`. */
export const memoryGuardStore = ({ maxEntries = 2000 }: { maxEntries?: number } = {}): GuardStore => {
  const windows = new Map<string, { start: number; used: number }>()
  const keys = new Map<string, { answer: StoredAnswer | null; expiresAt: number }>()
  const prune = (now: number) => {
    for (const [id, entry] of keys) if (entry.expiresAt <= now || keys.size > maxEntries) keys.delete(id)
  }
  return {
    count: async (id, windowMs, now) => {
      const current = windows.get(id)
      const window = current && now - current.start < windowMs ? current : { start: now, used: 0 }
      window.used++
      windows.set(id, window)
      if (windows.size > maxEntries) for (const [old, entry] of windows) if (now - entry.start >= windowMs) windows.delete(old)
      return { ...window }
    },
    claim: async (id, lockMs, now) => {
      prune(now)
      const entry = keys.get(id)
      if (entry) return entry.answer ?? 'running'
      keys.set(id, { answer: null, expiresAt: now + lockMs })
      return null
    },
    save: async (id, answer, expiresAt) => void keys.set(id, { answer, expiresAt }),
    release: async (id) => {
      if (keys.get(id)?.answer === null) keys.delete(id)
    },
  }
}

const callerOf = (c: Context) => {
  const caller = c.get('caller' as never) as { kind: string; name?: string; email?: string } | undefined
  return caller ? `${caller.kind}:${caller.name ?? caller.email}` : `ip:${c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local'}`
}

export const idempotency = ({ ttlMs = 24 * 60 * 60 * 1000, lockMs = 60_000, store = memoryGuardStore() }: { ttlMs?: number; lockMs?: number; store?: GuardStore } = {}): MiddlewareHandler =>
  async (c, next) => {
    const key = c.req.header('idempotency-key')
    if (!key || (c.req.method !== 'POST' && c.req.method !== 'PATCH')) return next()
    if (key.length > 255) return problemResponse(c, 'bad_request', { detail: 'Idempotency-Key is at most 255 characters.', errors: [{ in: 'header', path: 'Idempotency-Key', message: 'too long' }] })
    const id = `${callerOf(c)} ${c.req.method} ${c.req.path} ${key}`
    const bodyHash = createHash('sha256').update(new Uint8Array(await c.req.raw.clone().arrayBuffer())).digest('hex')
    const now = Date.now()
    const hit = await store.claim(id, lockMs, now)
    if (hit === 'running') return problemResponse(c, 'conflict', { detail: 'A request with this Idempotency-Key is still running. Retry when it has answered.' })
    if (hit) {
      if (hit.bodyHash !== bodyHash) return problemResponse(c, 'unprocessable', { detail: 'This Idempotency-Key was used with a different body. Use a new key for a new request.' })
      return new Response(Buffer.from(hit.body, 'base64'), { status: hit.status, headers: [...hit.headers, ['idempotent-replayed', 'true']] })
    }
    try {
      await next()
    } catch (error) {
      await store.release(id)
      throw error
    }
    // Server errors aren't kept: a retry with the same key should be able to succeed
    if (c.res.status >= 500) return void (await store.release(id))
    const body = Buffer.from(await c.res.clone().arrayBuffer()).toString('base64')
    await store.save(id, { bodyHash, status: c.res.status, headers: [...c.res.headers.entries()], body }, now + ttlMs)
  }

export const rateLimit = ({ policy, limit, windowSeconds, store = memoryGuardStore() }: { policy: string; limit: number; windowSeconds: number; store?: GuardStore }): MiddlewareHandler =>
  async (c, next) => {
    const now = Date.now()
    const window = await store.count(`${policy} ${callerOf(c)}`, windowSeconds * 1000, now)
    const reset = Math.max(1, Math.ceil((window.start + windowSeconds * 1000 - now) / 1000))
    const headers = { 'ratelimit-policy': `"${policy}";q=${limit};w=${windowSeconds}`, ratelimit: `"${policy}";r=${Math.max(0, limit - window.used)};t=${reset}` }
    if (window.used > limit) return problemResponse(c, 'too_many_requests', { detail: `More than ${limit} calls to ${policy} routes in ${windowSeconds / 60} minutes. Try again in ${reset} seconds; answers already computed are cached, so repeating one is not needed.`, headers: { ...headers, 'retry-after': String(reset) } })
    await next()
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value)
  }
