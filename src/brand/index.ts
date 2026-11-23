/**
 * One brand for every surface: the app owns `brand/brand.ts` (`defineBrand`) and `brand/icon.svg` (and optionally
 * `icon-dark.svg`); `kit brand` renders the PNGs at build time into `src/brand.gen.ts`, committed, so nothing rasterises
 * at runtime and Workers serve the same bytes. `createAgentApi({ brand: createBrand(BRAND, BRAND_ASSETS) })` then
 * serves `/favicon.ico`, `/icon.svg`, `/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png`, `/og.png` and
 * `/site.webmanifest`, and MCP's serverInfo, the Server Card, OpenAPI's `x-logo`, the A2A card, the guide's
 * `{{brand.*}}` and the pages' head tags all read it.
 *
 * @example
 * import BRAND from '../brand/brand.js'
 * import { BRAND_ASSETS } from './brand.gen.js'
 * const app = createAgentApi({ …, brand: createBrand(BRAND, BRAND_ASSETS) })
 */
import type { Context, Hono } from 'hono'
import type { AgentBrand, ServerIcon } from '../core/discovery.js'

export type Brand = {
  /** The programmatic name, as MCP's `serverInfo.name` (`cookbook`). */
  name: string
  /** What people read (`Cookbook`). */
  title: string
  /** One sentence, at most 100 characters (the Server Card's limit). */
  description: string
  websiteUrl?: string
  organization?: { name: string; url?: string }
  termsUrl?: string
  privacyUrl?: string
  /** `#rrggbb`: the theme colour and the OG card's bar. */
  accent: string
  /** `#rrggbb` behind the icon where one must be opaque (OG card, apple-touch icon, OpenAPI logo); white by default. */
  background?: string
}

type Base64 = string
/** What `kit brand` writes into `src/brand.gen.ts`: base64 PNGs by size, the SVG texts, and the hash of the inputs. */
export type BrandAssets = {
  inputsHash: string
  svg: string
  svgDark?: string
  png?: Record<16 | 32 | 48 | 96 | 180 | 192 | 512, Base64>
  pngDark?: Record<192 | 512, Base64>
  og?: Base64
}

const HEX = /^#[0-9a-f]{6}$/i
const httpsOf = (field: string, value: string | undefined) => {
  if (value === undefined) return
  let url: URL | null = null
  try {
    url = new URL(value)
  } catch {}
  if (url?.protocol !== 'https:') throw new Error(`brand: ${field} must be an absolute https URL, not ${JSON.stringify(value)}`)
}

/**
 * The app's brand, checked where it is written: non-empty names, a description of 1–100 characters, `#rrggbb` colours,
 * absolute https URLs.
 *
 * @example
 * export default defineBrand({ name: 'cookbook', title: 'Cookbook', description: 'Recipes and menus for agents.', accent: '#2563eb' })
 */
export const defineBrand = <T extends Brand>(brand: T): T => {
  for (const field of ['name', 'title', 'description'] as const) if (typeof brand[field] !== 'string' || !brand[field].trim()) throw new Error(`brand: ${field} must not be empty`)
  if (brand.description.length > 100) throw new Error(`brand: description is ${brand.description.length} characters; the Server Card takes at most 100`)
  if (!HEX.test(brand.accent)) throw new Error(`brand: accent must be #rrggbb, not ${JSON.stringify(brand.accent)}`)
  if (brand.background !== undefined && !HEX.test(brand.background)) throw new Error(`brand: background must be #rrggbb, not ${JSON.stringify(brand.background)}`)
  httpsOf('websiteUrl', brand.websiteUrl)
  httpsOf('termsUrl', brand.termsUrl)
  httpsOf('privacyUrl', brand.privacyUrl)
  httpsOf('organization.url', brand.organization?.url)
  if (brand.organization && !brand.organization.name?.trim()) throw new Error('brand: organization.name must not be empty')
  return brand
}

/** Base64 to bytes the same way on Node and Workers. */
const bytesOf = (text: Base64) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))

/**
 * An ICO file holding the PNGs as they are (Vista and later read PNG entries), each entry sized from its PNG header.
 *
 * @example
 * icoOf([png16, png32, png48]) // → bytes for /favicon.ico
 */
export const icoOf = (pngs: Uint8Array[]) => {
  const header = 6 + pngs.length * 16
  const out = new Uint8Array(header + pngs.reduce((sum, png) => sum + png.length, 0))
  const view = new DataView(out.buffer)
  view.setUint16(2, 1, true)
  view.setUint16(4, pngs.length, true)
  let offset = header
  pngs.forEach((png, index) => {
    const at = 6 + index * 16
    const size = (byte: number) => new DataView(png.buffer, png.byteOffset).getUint32(byte)
    // 0 means 256 or more
    out[at] = size(16) >= 256 ? 0 : size(16)
    out[at + 1] = size(20) >= 256 ? 0 : size(20)
    view.setUint16(at + 4, 1, true)
    view.setUint16(at + 6, 32, true)
    view.setUint32(at + 8, png.length, true)
    view.setUint32(at + 12, offset, true)
    out.set(png, offset)
    offset += png.length
  })
  return out
}

/**
 * The ordered MCP icons: the 96 px PNG inline (the only kind Claude shows, and VS Code takes it too), then this
 * origin's 192 and 512 PNGs, the SVG last; dark variants as extra entries with `theme: 'dark'` (one inline icon only,
 * to keep serverInfo small). `inline: false` leaves the data icon out; no origin leaves only it.
 *
 * @example
 * brandIcons('https://cookbook.example.com', BRAND_ASSETS)[0] // { src: 'data:image/png;base64,…', mimeType: 'image/png', sizes: ['96x96'] }
 */
export const brandIcons = (origin: string | null, assets: BrandAssets, { inline = true }: { inline?: boolean } = {}): ServerIcon[] => {
  const themed = (theme: 'light' | 'dark') => (assets.svgDark || assets.pngDark ? { theme } : {})
  const png = (path: string, size: number, theme: 'light' | 'dark') => ({ src: `${origin}${path}`, mimeType: 'image/png', sizes: [`${size}x${size}`], ...themed(theme) })
  const icons: ServerIcon[] = []
  if (inline && assets.png) icons.push({ src: `data:image/png;base64,${assets.png[96]}`, mimeType: 'image/png', sizes: ['96x96'], ...themed('light') })
  if (origin === null) return icons
  if (assets.png) icons.push(png('/icon-192.png', 192, 'light'), png('/icon-512.png', 512, 'light'))
  if (assets.pngDark) icons.push(png('/icon-dark-192.png', 192, 'dark'), png('/icon-dark-512.png', 512, 'dark'))
  icons.push({ src: `${origin}/icon.svg`, mimeType: 'image/svg+xml', sizes: ['any'], ...themed('light') })
  if (assets.svgDark) icons.push({ src: `${origin}/icon-dark.svg`, mimeType: 'image/svg+xml', sizes: ['any'], ...themed('dark') })
  return icons
}

const attribute = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The head tags for a page: favicon, SVG icon, apple-touch icon, manifest, theme colour, Open Graph and Twitter card,
 * each only when its file is served.
 *
 * @example
 * html.replace('<head>', `<head>${headTags(BRAND, BRAND_ASSETS, 'https://cookbook.example.com')}`)
 */
export const headTags = (brand: Brand, assets: BrandAssets, origin: string) =>
  [
    ...(assets.png ? ['<link rel="icon" href="/favicon.ico" sizes="32x32">'] : []),
    '<link rel="icon" href="/icon.svg" type="image/svg+xml">',
    ...(assets.png ? ['<link rel="apple-touch-icon" href="/apple-touch-icon.png">'] : []),
    '<link rel="manifest" href="/site.webmanifest">',
    `<meta name="theme-color" content="${attribute(brand.accent)}">`,
    `<meta property="og:title" content="${attribute(brand.title)}">`,
    `<meta property="og:description" content="${attribute(brand.description)}">`,
    ...(assets.og ? [`<meta property="og:image" content="${attribute(origin)}/og.png">`, '<meta name="twitter:card" content="summary_large_image">'] : ['<meta name="twitter:card" content="summary">']),
  ].join('')

/** `/site.webmanifest`: the name, colours and the icons served. @example webManifest(BRAND, BRAND_ASSETS).icons */
export const webManifest = (brand: Brand, assets: BrandAssets) => ({
  name: brand.title,
  short_name: brand.title,
  description: brand.description,
  start_url: '/',
  display: 'standalone',
  theme_color: brand.accent,
  background_color: brand.background ?? '#ffffff',
  icons: [
    ...(assets.png ? [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] : []),
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
  ],
})

/** Bumped when what the routes send changes for the same assets, so an old ETag never confirms it. */
const FORMAT = 1
const CACHE = 'public, max-age=604800'
/** An SVG opened on its own is a document: no script, no fetch, its own origin. */
const SVG_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox"

/** 16 hex characters of the bytes served (two FNV-1a passes with different bases): a new render under the same inputs gets a new ETag. */
const fingerprintOf = (body: Uint8Array | string) => {
  const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body
  let [high, low] = [0x811c9dc5, 0x01000193 ^ 0x9e3779b9]
  for (const byte of bytes) {
    high = Math.imul(high ^ byte, 0x01000193)
    low = Math.imul(low ^ byte, 0x01000193)
  }
  return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0')
}

/**
 * The brand as `createAgentApi({ brand })` takes it: the files it serves and what the other parts read. Decoded on the
 * first request, never at global scope.
 *
 * @example
 * createAgentApi({ …, brand: createBrand(BRAND, BRAND_ASSETS) })
 */
export const createBrand = (brand: Brand, assets: BrandAssets): AgentBrand => {
  const png = (size: keyof NonNullable<BrandAssets['png']>) => () => bytesOf(assets.png![size])
  const dark = (size: keyof NonNullable<BrandAssets['pngDark']>) => () => bytesOf(assets.pngDark![size])
  const files: Record<string, { type: string; body: () => Uint8Array | string }> = {
    '/icon.svg': { type: 'image/svg+xml', body: () => assets.svg },
    '/site.webmanifest': { type: 'application/manifest+json', body: () => JSON.stringify(webManifest(brand, assets)) },
    ...(assets.svgDark ? { '/icon-dark.svg': { type: 'image/svg+xml', body: () => assets.svgDark! } } : {}),
    ...(assets.png
      ? {
          '/favicon.ico': { type: 'image/x-icon', body: () => icoOf([png(16)(), png(32)(), png(48)()]) },
          '/icon-192.png': { type: 'image/png', body: png(192) },
          '/icon-512.png': { type: 'image/png', body: png(512) },
          '/apple-touch-icon.png': { type: 'image/png', body: png(180) },
        }
      : {}),
    ...(assets.pngDark ? { '/icon-dark-192.png': { type: 'image/png', body: dark(192) }, '/icon-dark-512.png': { type: 'image/png', body: dark(512) } } : {}),
    ...(assets.og ? { '/og.png': { type: 'image/png', body: () => bytesOf(assets.og!) } } : {}),
  }
  const made = new Map<string, { body: Uint8Array | string; etag: string }>()
  const send = (c: Context, path: string, prepared: Headers, resourcePolicy: string) => {
    const file = files[path]!
    if (!made.has(path)) {
      const body = file.body()
      made.set(path, { body, etag: `"${fingerprintOf(body)}-${FORMAT}"` })
    }
    const { body, etag } = made.get(path)!
    const headers = new Headers(prepared)
    for (const [name, value] of Object.entries({ 'content-type': file.type, 'cache-control': CACHE, etag, 'access-control-allow-origin': '*', 'cross-origin-resource-policy': resourcePolicy })) headers.set(name, value)
    if (file.type === 'image/svg+xml') headers.set('content-security-policy', SVG_POLICY)
    // RFC 9110: If-None-Match compares weakly (W/ dropped), and * matches any
    const fresh = c.req.header('if-none-match')?.split(',').some((value) => ['*', etag].includes(value.trim().replace(/^W\//, '')))
    return new Response(fresh ? null : (body as BodyInit), { status: fresh ? 304 : 200, headers })
  }
  return {
    name: brand.name,
    title: brand.title,
    description: brand.description,
    ...(brand.websiteUrl ? { websiteUrl: brand.websiteUrl } : {}),
    ...(brand.termsUrl ? { termsUrl: brand.termsUrl } : {}),
    background: brand.background ?? '#ffffff',
    accent: brand.accent,
    logo: assets.png ? '/icon-512.png' : '/icon.svg',
    paths: Object.keys(files),
    icons: (origin, options) => brandIcons(origin, assets, options),
    headTags: (origin) => headTags(brand, assets, origin),
    mount: (app: Hono<any, any, any>, options = {}) => {
      // Other sites show the icons and OG card in an <img>; a private app's files stay on its own site
      const resourcePolicy = options.private ? 'same-site' : 'cross-origin'
      for (const path of Object.keys(files))
        app.get(path, async (c, next) => {
          // After the app's own routes and files: only a path nothing else answered gets the brand's
          await next()
          if (c.res.status !== 404) return
          // Keep what middleware set before answering (the request id, security headers), not what describes the 404
          const prepared = new Headers(c.res.headers)
          for (const name of ['content-type', 'content-length', 'content-language', 'content-encoding']) prepared.delete(name)
          // Cleared first, or Hono copies the 404's headers over the file's
          c.res = undefined as never
          c.res = send(c, path, prepared, resourcePolicy)
        })
    },
  }
}
