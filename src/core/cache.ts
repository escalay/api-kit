/**
 * Caching for read-mostly data. An API over a snapshot changes only when the snapshot or the code serving it does, so
 * a GET's ETag is the snapshot version, this process's start and the URL: a client that sends it back in
 * `If-None-Match` gets `304 Not Modified` without the route running, and a deploy never leaves it on an old answer. `Cache-Control` says how long each kind of response may be kept; errors are never stored.
 *
 * @example
 * app.use('/api/*', snapshotEtag(() => store.version, { skip: (path) => path.startsWith('/api/v1/boards') }))
 * app.use('*', cacheControl({ '/media/': CACHE.media, '/api/': CACHE.api }))
 */
import { createHash, randomUUID } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

export const CACHE = {
  /** Revalidate every time (cheap with ETags), keep out of shared caches. */
  api: 'private, no-cache',
  /** Images and videos never change under the same URL. */
  media: 'private, max-age=86400, immutable',
  /** Guides and the OpenAPI document. */
  docs: 'private, max-age=300',
  error: 'no-store',
} as const

/**
 * Changes on every start, so answers a code change altered are never confirmed from before it. Made on first use:
 * Workers refuse random values at global scope.
 */
let started: string | undefined
const startId = () => (started ??= randomUUID())

/**
 * `boot` names the deploy instead of the process: on Workers pass the version id (`env.CF_VERSION_METADATA.id`), so
 * every isolate of one deploy agrees on the ETag and a new deploy still changes it.
 */
export const snapshotEtag = (versionOf: () => string | undefined, { skip = () => false, boot }: { skip?: (path: string) => boolean; boot?: string } = {}): MiddlewareHandler =>
  async (c, next) => {
    const version = versionOf()
    if ((c.req.method !== 'GET' && c.req.method !== 'HEAD') || !version || skip(c.req.path)) return next()
    const tag = `W/"${createHash('sha256').update(`${version}|${boot ?? startId()}|${c.req.url}|${c.req.header('accept') ?? ''}`).digest('base64url').slice(0, 27)}"`
    const sent = c.req.header('if-none-match')?.split(',').map((value) => value.trim())
    if (sent?.includes(tag) || sent?.includes('*')) return c.body(null, 304, { etag: tag })
    await next()
    if (c.res.status === 200 && !c.res.headers.has('etag')) c.res.headers.set('etag', tag)
  }

/** The first matching path prefix sets `Cache-Control` on success; any error is `no-store`. */
export const cacheControl = (byPrefix: Record<string, string>): MiddlewareHandler => async (c, next) => {
  await next()
  if (c.res.status >= 400) c.res.headers.set('cache-control', CACHE.error)
  else if (!c.res.headers.has('cache-control')) {
    const match = Object.entries(byPrefix).find(([prefix]) => c.req.path.startsWith(prefix))
    if (match) c.res.headers.set('cache-control', match[1])
  }
}
