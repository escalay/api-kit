/**
 * HAL hypermedia (`application/hal+json`): every resource carries `_links` with absolute `href`s and, when the caller
 * asked for neighbours, `_embedded`. An agent chains calls by following links instead of building URLs, so a route can
 * move without breaking anyone who started from `/api`.
 *
 * @example
 * const origin = originOf(c)
 * linksOf(origin, { self: '/api/v1/cooks/123', recipes: { path: '/api/v1/cooks/123/recipes', title: 'Its 12 recipes' } })
 * // { self: { href: 'https://cookbook.example.com/api/v1/cooks/123' }, recipes: { href: '…/recipes', title: 'Its 12 recipes' } }
 * pathWith('/api/v1/search/recipes', { q: 'soup', platform: undefined }) // '/api/v1/search/recipes?q=soup'
 */
import { z } from '@hono/zod-openapi'
import type { Context } from 'hono'

export const HAL_JSON = 'application/hal+json'

export type Link = { href: string; title?: string; templated?: boolean; type?: string }
export type Links = Record<string, Link>
export type LinkTarget = string | { path: string; title?: string; templated?: boolean; type?: string } | null | undefined

/** A bare host and optional port: a name of unreserved characters (RFC 3986), an IPv4 address or a bracketed IPv6 one. */
const BARE_HOST = /^(?:[\w.~-]+|\[[\da-f:.]+\])(?::\d{1,5})?$/i
/** The first item of a forwarded header, which a client can set when proxies append: set `publicOrigin`. */
const firstOf = (value: string | null) => value?.split(',')[0]?.trim()

/**
 * The public origin of a raw request: behind Traefik and Cloudflare the socket is plain http, so it takes the first
 * `X-Forwarded-Proto` when it is `http` or `https` and the first `X-Forwarded-Host` when it is a bare host[:port]. Any
 * other value (a path, query, fragment or user in it) is ignored for the request URL's own, so a forged host never
 * names a path. A caller can still forward any bare host: an app behind a proxy or on more than one host sets
 * `publicOrigin`.
 *
 * @example
 * originOfRequest(new Request('http://10.0.0.2/x', { headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cookbook.example.com' } })) // 'https://cookbook.example.com'
 * originOfRequest(new Request('http://localhost/x', { headers: { 'x-forwarded-host': 'localhost/s/soups' } }))                                // 'http://localhost'
 */
export const originOfRequest = (request: Request) => {
  const url = new URL(request.url)
  const proto = firstOf(request.headers.get('x-forwarded-proto'))?.toLowerCase()
  const scheme = proto === 'http' || proto === 'https' ? proto : url.protocol.slice(0, -1)
  const host = firstOf(request.headers.get('x-forwarded-host'))
  const forwarded = host && BARE_HOST.test(host) && URL.canParse(`${scheme}://${host}`)
  return `${scheme}://${forwarded ? host : url.host}`
}

/**
 * The public origin of the request a handler serves, for absolute links: `originOfRequest(c.req.raw)`.
 *
 * @example
 * linksOf(originOf(c), { self: '/api/v1/cooks/123' })
 */
export const originOf = (c: Context) => originOfRequest(c.req.raw)

/** A path with its query, leaving out empty values; arrays repeat the key (`platform=ios&platform=web`). */
export const pathWith = (path: string, query: Record<string, string | number | boolean | string[] | null | undefined> = {}) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    for (const one of Array.isArray(value) ? value : [value]) params.append(key, String(one))
  }
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

/** Relative paths → absolute links; `null` and `undefined` targets are left out, so optional links just disappear. */
export const linksOf = (origin: string, targets: Record<string, LinkTarget>): Links =>
  Object.fromEntries(
    Object.entries(targets)
      .filter((entry): entry is [string, Exclude<LinkTarget, null | undefined>] => entry[1] != null)
      .map(([rel, target]) => {
        if (typeof target === 'string') return [rel, { href: origin + target }]
        const { path, ...rest } = target
        return [rel, { href: origin + path, ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)) }]
      }),
  )

export const LinkSchema = z
  .object({
    href: z.string().url().openapi({ description: 'Absolute URL to follow.', example: 'https://api.example.com/api/v1/cooks/123' }),
    title: z.string().optional().openapi({ description: 'What is at the other end, in a few words.' }),
    templated: z.boolean().optional().openapi({ description: 'True when `href` is a URI template (RFC 6570) to fill in first.' }),
    type: z.string().optional().openapi({ description: 'Media type of the target when it is not HAL JSON (an image, Markdown).' }),
  })
  .openapi('Link', { description: 'A HAL link.' })

export const LinksSchema = z.record(z.string(), LinkSchema).openapi('Links', {
  description: 'HAL `_links`: relation name → link. `self` is always present; follow links instead of building URLs.',
  example: { self: { href: 'https://api.example.com/api/v1/cooks/123' } },
})
