/**
 * Two guards for calls that change something or cost money, both keyed by the caller:
 *   idempotency   `Idempotency-Key` on POST and PATCH (IETF httpapi-idempotency-key): a retry with the same key and
 *                 body gets the stored answer (`Idempotent-Replayed: true`), the same key with another body is a 422,
 *                 one still in flight a 409. Kept 24 hours, and only what `keep` passes (by default a success, never
 *                 a refusal or a server error, which changed nothing). Never on `/oauth/*` and `/agent/identity*`,
 *                 whose answers hold tokens, nor on the paths an app adds to `skip`.
 *   rateLimit     at most `limit` calls per `windowSeconds` per caller on the routes it guards, with the draft
 *                 `RateLimit-Policy` / `RateLimit` headers (IETF httpapi-ratelimit-headers) and a 429 problem with
 *                 `Retry-After` past it: a looping agent can't drain a paid budget.
 * Both keep their state in a `GuardStore`: `memoryGuardStore()` (the default) is right for one Node process; on
 * Workers, where every isolate has its own memory, pass `dbGuardStore(db)` (`db`) so all of them share it.
 * A caller with no credentials is counted by address, read from the one source the app names (`AddressTrust`).
 *
 * @example
 * const guards = await dbGuardStore(db)
 * const app = createAgentApi({ …, guards: { store: guards } })                   // idempotency, wired for you
 * app.use('/api/v1/products/:id/gaps', rateLimit({ policy: 'paid', limit: 120, windowSeconds: 3600, store: guards }))
 */
import { createHash } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { matches, OAUTH_OPEN_PATHS } from './auth.js'
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

/**
 * Where the caller's address comes from, set once with `createAgentApi({ address })` (or per `rateLimit`):
 *   'headers'                  today's read, as sent: `cf-connecting-ip`, else the whole `x-forwarded-for` (default)
 *   { header, hops = 1 }       the value `hops` from the right of a header a proxy writes or appends to
 *   'socket'                   the connection on Node (`@hono/node-server`); 'local' where there is none (Workers)
 * A named source is never mixed with another; a port is dropped, and a global IPv6 address counts by its /64.
 * @example
 * createAgentApi({ …, address: { header: 'cf-connecting-ip' } })                 // behind Cloudflare
 * createAgentApi({ …, address: { header: 'x-forwarded-for', hops: 1 } })         // behind one proxy that appends
 * createAgentApi({ …, address: 'socket' })                                         // nothing in front, on Node
 */
export type AddressTrust = 'headers' | 'socket' | { header: string; hops?: number }

type Connection = { incoming?: { socket?: { remoteAddress?: string } } }

/** The eight 16-bit groups of an IPv6 address (an IPv4 tail as two), or undefined when it is not one. */
const groupsOf = (address: string) => {
  const halves = address.split('::')
  if (halves.length > 2) return undefined
  const groupsIn = (half: string) =>
    (half ? half.split(':') : []).flatMap((part) => {
      const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(part)?.slice(1).map(Number)
      if (ipv4) return ipv4.some((octet) => octet > 255) ? [NaN] : [ipv4[0]! * 256 + ipv4[1]!, ipv4[2]! * 256 + ipv4[3]!]
      return /^[0-9a-f]{1,4}$/.test(part) ? [parseInt(part, 16)] : [NaN]
    })
  const [left, right = []] = halves.map(groupsIn) as [number[], number[]?]
  const groups = halves.length === 2 ? [...left, ...Array<number>(Math.max(0, 8 - left.length - right.length)).fill(0), ...right] : left
  return groups.length === 8 && groups.every((group) => group >= 0) ? groups : undefined
}

/**
 * What the guards count an address as: an IPv4 one as it is (a port dropped); one IPv6 carries (mapped, NAT64) as that
 * IPv4 address; a global IPv6 one (2000::/3) by its /64 (`2001:db8:1:2::/64`); any other IPv6 one (loopback,
 * link-local, unique local) whole.
 */
const prefixOf = (value: string) => {
  const unported = /^\[([^\]]+)\](?::\d+)?$/.exec(value)?.[1] ?? /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(value)?.[1] ?? value
  const bare = unported.replace(/%.*$/, '').toLowerCase()
  if (!bare.includes(':')) return bare
  const groups = groupsOf(bare)
  if (!groups) return bare
  const hex = groups.map((group) => group.toString(16))
  const zero = (from: number, to: number) => groups.slice(from, to).every((group) => group === 0)
  const mapped = zero(0, 5) && groups[5] === 0xffff
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && zero(2, 6)
  if (mapped || nat64) return [groups[6]! >> 8, groups[6]! & 255, groups[7]! >> 8, groups[7]! & 255].join('.')
  if ((groups[0]! & 0xe000) === 0x2000) return `${hex.slice(0, 4).join(':')}::/64`
  // One spelling per address: the first run of two or more zero groups as `::`
  return hex.join(':').replace(/(^|:)0(:0)+(:|$)/, '::')
}

/**
 * The caller's address from `trust`, else the source `createAgentApi({ address })` set on the request, else today's
 * read; 'local' when the named source has none.
 * @example
 * app.post('/api/claim', async (c) => { await guards.count(`claim ip:${addressOf(c)}`, 3_600_000, Date.now()); … })
 */
export const addressOf = (c: Context, trust?: AddressTrust): string => {
  const source = trust ?? (c.get('kit:address' as never) as AddressTrust | undefined) ?? 'headers'
  if (source === 'headers') return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local'
  if (source === 'socket') {
    // @hono/node-server hands the connection over as the env (some dev servers under `server`); no import needed
    const env = c.env as (Connection & { server?: Connection }) | undefined
    const address = (env?.server ?? env)?.incoming?.socket?.remoteAddress
    return address ? prefixOf(address) : 'local'
  }
  const values = (c.req.header(source.header) ?? '').split(',').map((value) => value.trim())
  const hops = source.hops ?? 1
  // Fewer values than hops: the request did not come the way the app said, so nothing in it is read
  const value = values.length >= hops ? values[values.length - hops] : undefined
  return value ? prefixOf(value) : 'local'
}

/** Who the guards count: an OAuth agent by its client and grant (never the name it gave itself), else name or email, else the address. */
const callerOf = (c: Context, trust?: AddressTrust) => {
  const caller = c.get('caller' as never) as { kind: string; name?: string; email?: string; client?: string; grant?: string } | undefined
  if (caller?.kind === 'agent' && caller.client) return `agent:${caller.client}/${caller.grant ?? '-'}`
  return caller ? `${caller.kind}:${caller.name ?? caller.email}` : `ip:${addressOf(c, trust)}`
}

/** Which answers are kept to replay: a success. A refusal changed nothing, so a retry after its cause is fixed runs again. */
const keepSuccess = (status: number) => status < 400

/** Paths whose answers are never kept: the OAuth endpoints answer with tokens and codes. */
const NEVER_KEPT = [...OAUTH_OPEN_PATHS, '/agent/identity*']

/** `idempotency`'s options; `createAgentApi({ guards })` passes `store`, `keep` and `skip`. */
export type IdempotencyOptions = {
  ttlMs?: number
  lockMs?: number
  store?: GuardStore
  /** Which statuses are kept to replay (default: below 400). `(status) => status < 500` keeps refusals too, as the kit once did; one that passes a 5xx keeps server errors as well. */
  keep?: (status: number) => boolean
  /** More paths never kept, beside `/oauth/*` and `/agent/identity*`: an app's own open routes that answer a secret (a redirect holding a code). */
  skip?: string[]
}

/**
 * Replays a retried POST or PATCH from its first answer (the rules are at the top of this file).
 *
 * @example
 * app.use('*', idempotency({ store: await dbGuardStore(db), skip: ['/join/*'] }))   // createAgentApi does this for you
 */
export const idempotency = ({ ttlMs = 24 * 60 * 60 * 1000, lockMs = 60_000, store = memoryGuardStore(), keep = keepSuccess, skip = [] }: IdempotencyOptions = {}): MiddlewareHandler =>
  async (c, next) => {
    const key = c.req.header('idempotency-key')
    if (!key || (c.req.method !== 'POST' && c.req.method !== 'PATCH')) return next()
    if ([...NEVER_KEPT, ...skip].some((pattern) => matches(c.req.path, pattern))) return next()
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
    // What isn't kept (a refusal, a server error) frees the key: a retry with it runs again
    if (!keep(c.res.status)) return void (await store.release(id))
    const body = Buffer.from(await c.res.clone().arrayBuffer()).toString('base64')
    await store.save(id, { bodyHash, status: c.res.status, headers: [...c.res.headers.entries()], body }, now + ttlMs)
  }

/**
 * `address` overrides the app's source for this limit. `key` replaces the caller in the bucket id (count per pack, per
 * grant, per anything); null lets the call through uncounted.
 * @example
 * rateLimit({ policy: 'pack', limit: 60, windowSeconds: 600, store, key: (c) => `pack:${c.req.path.split('/')[2]}` })
 */
export type RateLimitOptions = { policy: string; limit: number; windowSeconds: number; store?: GuardStore; address?: AddressTrust; key?: (c: Context) => string | null }

export const rateLimit = ({ policy, limit, windowSeconds, store = memoryGuardStore(), address, key }: RateLimitOptions): MiddlewareHandler =>
  async (c, next) => {
    const who = key ? key(c) : callerOf(c, address)
    if (who === null) return next()
    const now = Date.now()
    const window = await store.count(`${policy} ${who}`, windowSeconds * 1000, now)
    const reset = Math.max(1, Math.ceil((window.start + windowSeconds * 1000 - now) / 1000))
    const headers = { 'ratelimit-policy': `"${policy}";q=${limit};w=${windowSeconds}`, ratelimit: `"${policy}";r=${Math.max(0, limit - window.used)};t=${reset}` }
    if (window.used > limit) return problemResponse(c, 'too_many_requests', { detail: `More than ${limit} calls to ${policy} routes in ${windowSeconds / 60} minutes. Try again in ${reset} seconds; answers already computed are cached, so repeating one is not needed.`, headers: { ...headers, 'retry-after': String(reset) } })
    await next()
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value)
  }
