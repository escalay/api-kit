/**
 * A browser app on the API's own origin, with a public front page in front of it:
 *   /              `landing.html`: what the service is and how agents connect (no data), so scanners and agents find
 *                  the discovery files; `Accept: text/markdown` still gets the agent guide (the kit answers it first)
 *   /app, /app/*   the app: a file of that name when there is one, else `index.html`, so deep links open the app
 *   moved paths    the app's addresses from before it moved under /app, and `/?query` deep links, redirect there
 * Files at the top of `dir` (the landing's script and styles, a plain viewer's `app.js`) are served as they are.
 * Single sign-on gates only `/app` (the only paths Access covers, with the OAuth approval pages); the app's data calls carry its cookie, so the browser never
 * holds an API key. `frontDoorOpen` lists what the API's auth must leave open: the page files, never data.
 *
 * The pages' own scripts and stylesheets are linked with `?v=<content hash>`, so a CDN or browser that keeps static
 * files for hours (Cloudflare's browser TTL overrides `no-cache`) still loads the new ones after a deploy. Hashed build
 * output (`immutable`) keeps its plain name: its chunks import each other by that name, and a second URL for the same
 * module would load it twice (two React Query clients, two routers).
 *
 * Call `serveFrontDoor` last, after every API route: anything they didn't answer is a page.
 *
 * @example
 * const web = { dir: join(APP_DIR, 'public'), moved: ['/notes'] }
 * const app = createAgentApi({ …, home: false, auth: { …, open: frontDoorOpen(web) } })
 * serveFrontDoor(app, web)
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import type { Hono } from 'hono'

export type FrontDoorConfig = {
  /** The built app: `index.html`, optionally `landing.html`, and its files. */
  dir: string
  /** Where the app lives (default `/app`). */
  base?: string
  /** Addresses the app answered before it moved under `base`, redirected there with their path and query. */
  moved?: string[]
  /** Hashed build output that never changes under its name (default `/assets/`). */
  immutable?: string
  /**
   * Private (with the API's `private`): no front page, `/` goes to the app (behind the sign-in), the app's files need
   * the same credentials as the API and are never kept in a shared cache, and every page says `noindex`.
   */
  private?: boolean
}

const topFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((name) => name !== 'index.html' && statSync(join(dir, name)).isFile()) : [])

/**
 * The paths the API's auth leaves open for the front door: `/`, the files at the top of `dir`, the immutable build
 * output and the old addresses (they only redirect). `/app` itself stays behind the sign-in.
 *
 * @example
 * auth: { realm: 'notes', keys, access, open: frontDoorOpen({ dir, moved: ['/notes'] }) }
 */
export const frontDoorOpen = ({ dir, moved = [], immutable = '/assets/', private: hidden = false }: FrontDoorConfig) =>
  hidden ? ['/', ...moved.map((prefix) => `${prefix}*`)] : ['/', `${immutable}*`, ...topFiles(dir).map((name) => `/${name}`), ...moved.map((prefix) => `${prefix}*`)]

/**
 * A page with its local `.js` and `.css` links versioned by content: `src="app.js"` → `src="app.js?v=1a2b3c4d"`. Files
 * under `immutable` are left as they are (their names are hashes already).
 *
 * @example
 * versionAssets('<script src="app.js"></script>', dir) // '<script src="app.js?v=…"></script>'
 */
export const versionAssets = (html: string, dir: string, immutable = '/assets/') =>
  html.replace(/\b(src|href)="(\/?)([\w./-]+\.(?:js|css))"/g, (match, attribute: string, slash: string, file: string) => {
    const path = join(dir, file)
    if (file.includes('..') || `/${file}`.startsWith(immutable) || !existsSync(path)) return match
    return `${attribute}="${slash}${file}?v=${createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8)}"`
  })

/** Serves the front page, the app under `base` and the redirects; false when `dir` has no `index.html`. @example serveFrontDoor(app, { dir }) */
export const serveFrontDoor = (app: Hono<any, any, any>, { dir, base = '/app', moved = [], immutable = '/assets/', private: hidden = false }: FrontDoorConfig) => {
  const index = join(dir, 'index.html')
  if (!existsSync(index)) return false
  const noindex = (page: string) => (hidden && !page.includes('name="robots"') ? page.replace(/<head>/i, '<head><meta name="robots" content="noindex, nofollow">') : page)
  const html = noindex(versionAssets(readFileSync(index, 'utf8'), dir, immutable))
  const landing = !hidden && existsSync(join(dir, 'landing.html')) ? versionAssets(readFileSync(join(dir, 'landing.html'), 'utf8'), dir, immutable) : null

  app.use(`${immutable}*`, async (c, next) => {
    await next()
    if (c.res.ok) c.res.headers.set('cache-control', `${hidden ? 'private' : 'public'}, max-age=31536000, immutable`)
  })
  app.get('/', (c) => {
    // `/?item=…` was a deep link into the app before it moved
    const search = new URL(c.req.url).search
    if (search || !landing) return c.redirect(`${base}${search}`, search ? 301 : 302)
    return c.html(landing, 200, { 'cache-control': 'no-cache' })
  })
  // A plain viewer refers to its files relatively, so `/app/app.js` is `/app.js`; `/app` itself is the page below
  const appFiles = serveStatic({ root: dir, rewriteRequestPath: (path) => path.slice(base.length), onFound: (_path, c) => c.header('cache-control', 'no-cache') })
  app.use(`${base}/*`, (c, next) => (c.req.path === base || c.req.path === `${base}/` ? next() : appFiles(c, next)))
  app.use('*', serveStatic({ root: dir, onFound: (path, c) => { if (!path.includes(immutable)) c.header('cache-control', 'no-cache') } }))
  app.get('*', (c, next) => {
    const path = c.req.path
    if (path === base || path.startsWith(`${base}/`)) return c.html(html, 200, { 'cache-control': 'no-cache' })
    if (moved.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return c.redirect(`${base}${path}${new URL(c.req.url).search}`, 301)
    return next()
  })
  return true
}
