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

// Behind Traefik and Cloudflare the socket is plain http: trust the forwarded proto and host for absolute URLs
export const originOf = (c: Context) => {
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
  return `${proto ?? url.protocol.replace(':', '')}://${c.req.header('x-forwarded-host') ?? url.host}`
}

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
