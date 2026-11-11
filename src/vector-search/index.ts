/**
 * Search by words, by picture and by likeness over an app's vectors (`vectors.ts`), as three documented routes and the
 * MCP tools that call them:
 *   GET  {path}?q=…            items for a description; `by` look, meaning or both (one query embedding, cached)
 *   POST {path}                items that look like a picture: a multipart `image` file or JSON `{ "image": … }`
 *   GET  {similarPath}         items like one item, by look or meaning (free: no embedding)
 * Words and pictures keep only the rows that stand out from the whole catalog (`standouts`), so a query that matches
 * nothing answers nothing; `both` merges the two spaces on how far each row stands out, not on raw cosine. Likeness
 * always answers (`nearest`). Results are HAL: `_embedded.results[]` of `{ score, z, space, item }`.
 *
 * The app supplies its item schema and cards, its filters (declared on every route, so unknown ones stay a 400) and,
 * for agents, which hosts a picture may be fetched from: a data URL always works, an `https` URL only on `imageHosts`.
 *
 * @example
 * registerVectorSearch(app, { path: '/api/search', similarPath: '/api/recipes/{slug}/similar', name: 'Recipe', noun: 'recipes', tag: 'Search', item: RecipeCardSchema,
 *   spaces: () => vectors, embedder: () => embedder, itemOf: (key, origin) => cardOf(key, origin), keyOf: (slug) => `recipe:${slug}` })
 * mcpServerFactory({ tools: [...vectorSearchTools({ path: '/api/search', similarPath: '/api/recipes/{slug}/similar', noun: 'recipes', label: (recipe) => recipe.title }), …], … })
 */
import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi'
import { rateLimit } from '../core/guards.js'
import { HAL_JSON, linksOf, LinksSchema, originOf, pathWith } from '../core/hal.js'
import { mcpTool, type McpTool } from '../mcp/index.js'
import { problemResponses, ProblemError } from '../core/problem.js'
import { imageDataUrl, nearest, SpendCapError, standouts, vectorOf, type Embedder, type VectorSpace } from '../vectors/index.js'

export type SearchSpace = 'look' | 'meaning'
type By = SearchSpace | 'both'
type Filters = Record<string, unknown>
type Result = { score: number; z: number | null; space: SearchSpace; item: unknown }

export type VectorSearchConfig = {
  /** GET searches by words, POST by picture. */
  path: string
  /** One path parameter, the item's id: `/api/recipes/{slug}/similar`. */
  similarPath?: string
  /** Singular, for OpenAPI component and operation names: `Recipe`. */
  name: string
  /** Plural, for descriptions: `recipes`. */
  noun: string
  tag: string
  /** The OpenAPI schema of one result's `item`. */
  item: z.ZodTypeAny
  /** The vectors searched now; a space not built yet is left out. */
  spaces: () => Partial<Record<SearchSpace, VectorSpace>>
  /** Undefined without a key: words and pictures answer 503, likeness still works. */
  embedder: () => Embedder | undefined
  /** The card for a vector's key, or undefined when it left the catalog (the row is skipped). */
  itemOf: (key: string, origin: string) => unknown
  /** The similar route's id → its vector key (default: the id itself). */
  keyOf?: (id: string) => string
  /** Query parameters every route accepts, and the keys they keep (undefined keeps all). */
  filters?: { shape: z.ZodRawShape; keep: (filters: Filters) => ((key: string) => boolean) | undefined }
  /** Caps results per group (an author, a collection) so one group doesn't fill the page. */
  groupOf?: (key: string) => string
  perGroup?: number
  /**
   * How far a row must stand out (measured on the app's own catalog; see `standouts`): per space for words, and
   * `picture` for a picture, which always has look-alikes and so takes a lower bar (default 2.5).
   */
  minZ?: Partial<Record<SearchSpace | 'picture', number>>
  /** Per space: a raw-similarity floor on top of `minZ`, for a corpus all about one subject (see `standouts`). */
  minScore?: Partial<Record<SearchSpace, number>>
  /** Hosts a JSON `image` URL may come from (exact hostnames); data URLs always work. */
  imageHosts?: string[]
  /** Calls per caller per hour on the paid routes (words and pictures). */
  hourlyLimit?: number
  /** False for a catalog with no pictures: no picture route, no picture tool. */
  pictures?: boolean
  /** The example query in the spec and the guide: something this catalog answers well. */
  example?: string
  /** The spaces this catalog has at all (default both): a text-only catalog offers `['meaning']`, so `by=look` isn't advertised. */
  offers?: SearchSpace[]
  fetchImpl?: typeof fetch
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMAGE = 8 * 1024 * 1024

/** A picture a request sent, as the data URL a look vector is made from: a multipart file, a data URL, or an https URL on the allowlist. */
/** The API's own origin, and a fetch that runs a path in-process with the caller's credentials. */
type Own = { origin: string; fetch: (path: string) => Promise<Response> }

const pictureOf = async (given: unknown, imageHosts: string[], fetchImpl: typeof fetch, own?: Own) => {
  if (given instanceof File) {
    if (!IMAGE_TYPES.includes(given.type)) throw new ProblemError('unsupported_media_type', { detail: `The image is ${given.type || 'untyped'}: send PNG, JPEG, WebP or GIF.` })
    if (given.size > MAX_IMAGE) throw new ProblemError('payload_too_large', { detail: 'The image is over 8 MB: send a smaller one.' })
    return imageDataUrl(new Uint8Array(await given.arrayBuffer()))
  }
  if (typeof given !== 'string') throw new ProblemError('bad_request', { detail: 'Send the picture: a multipart `image` file, or JSON `{ "image": "data:image/png;base64,…" }`.', errors: [{ in: 'body', path: 'image', message: 'required' }] })
  if (given.startsWith('data:image/')) return imageDataUrl(Buffer.from(given.slice(given.indexOf(',') + 1), 'base64')).catch(() => {
    throw new ProblemError('bad_request', { detail: 'The data URL is not an image this API can read (PNG, JPEG, WebP, GIF).', errors: [{ in: 'body', path: 'image', message: 'unreadable image' }] })
  })
  const url = URL.canParse(given) ? new URL(given) : null
  // An image link this API handed out is read in-process, with the caller's own access
  const ours = !!url && !!own && url.host === new URL(own.origin).host
  if (!ours && (url?.protocol !== 'https:' || !imageHosts.includes(url.hostname)))
    throw new ProblemError('bad_request', {
      detail: `A picture by URL must be one of this API's own image links${imageHosts.length ? ` or https on ${imageHosts.join(', ')}` : ''}. Otherwise send a data URL or upload the file.`,
      errors: [{ in: 'body', path: 'image', message: 'host not allowed' }],
    })
  const response = await (ours ? own!.fetch(url!.pathname + url!.search) : fetchImpl(url!, { redirect: 'error' })).catch(() => null)
  const type = response?.headers.get('content-type')?.split(';')[0] ?? ''
  if (!response?.ok || !IMAGE_TYPES.includes(type)) throw new ProblemError('bad_request', { detail: `Could not fetch an image from ${url!.href} (${response ? `${response.status} ${type}` : 'no answer'}).`, errors: [{ in: 'body', path: 'image', message: 'not an image' }] })
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_IMAGE) throw new ProblemError('payload_too_large', { detail: 'The image is over 8 MB.' })
  return imageDataUrl(bytes)
}

/** Embeds with the app's key, turning money and outages into problems an agent can act on. */
const embedding = async (embedder: Embedder | undefined, make: (embedder: Embedder) => Promise<Float32Array>) => {
  if (!embedder) throw new ProblemError('unavailable', { detail: 'Search by words or picture needs this server’s embedding key, which is not set. Similar-by-id and every other route still work.' })
  try {
    return await make(embedder)
  } catch (error) {
    if (error instanceof SpendCapError) throw new ProblemError('spend_cap', { detail: 'The search budget is used up: describing a query or a picture costs money. Similar-by-id and every free route still work.' })
    if (error instanceof ProblemError) throw error
    throw new ProblemError('upstream', { detail: `The embedding service failed (${String((error as Error).message).slice(0, 200)}). Retry in a minute.` })
  }
}

/** Rows that stand out in each asked space, merged on z (a row found in both keeps its better side). */
const PICTURE_MIN_Z = 2.5

/** How many of the nearest rows below the bar an empty answer shows, so an agent can judge for itself. */
const CLOSEST = 3

const rank = (config: VectorSearchConfig, spaces: Partial<Record<SearchSpace, VectorSpace>>, by: By, query: Float32Array, filters: Filters, limit: number, picture = false, loose = false) => {
  const keep = config.filters?.keep(filters)
  // Matches merge on how far they stand out; rows below the bar, on raw similarity
  const measure = (row: { score: number; z: number | null }) => (loose ? row.score : (row.z ?? -Infinity))
  const best = new Map<string, Omit<Result, 'item'> & { key: string }>()
  for (const space of by === 'both' ? (['look', 'meaning'] as const) : [by]) {
    const vectors = spaces[space]
    if (!vectors) continue
    const minZ = picture ? (config.minZ?.picture ?? PICTURE_MIN_Z) : config.minZ?.[space]
    const minScore = picture ? undefined : config.minScore?.[space]
    const pick = { limit: limit * 2, keep, groupOf: config.groupOf, perGroup: config.perGroup }
    // Below the bar there is no meaningful z: the nearest by raw score
    const matches = loose ? nearest(vectors, query, pick).map((match) => ({ ...match, z: null })) : standouts(vectors, query, { ...pick, minZ, minScore })
    for (const match of matches) {
      const held = best.get(match.key)
      if (!held || measure(held) < measure(match)) best.set(match.key, { ...match, space })
    }
  }
  return [...best.values()].sort((a, b) => measure(b) - measure(a)).slice(0, limit)
}

const spacesFor = (config: VectorSearchConfig, by: By) => {
  const spaces = config.spaces()
  const wanted = by === 'both' ? (['look', 'meaning'] as const) : [by]
  if (!wanted.some((space) => spaces[space])) throw new ProblemError('unavailable', { detail: `The ${wanted.join(' and ')} vectors for ${config.noun} are not built yet. Try again later or use the other routes.`, headers: { 'retry-after': '3600' } })
  return spaces
}

/**
 * Registers search by words (GET), by picture (POST) and likeness on the app, rate-limited per caller on the two that
 * cost an embedding. Call it after `createAgentApi`.
 */
export const registerVectorSearch = (app: OpenAPIHono, config: VectorSearchConfig) => {
  const { path, similarPath, name, noun, tag } = config
  const filterShape = config.filters?.shape ?? {}
  const fetchImpl = config.fetchImpl ?? fetch
  const offers = config.offers ?? (['look', 'meaning'] as SearchSpace[])
  const both = offers.length > 1
  const by = (fallback: By, allowed: By[]) => {
    const kept = both ? allowed : ([offers[0]] as By[])
    return z.enum(kept as [By, ...By[]]).default(both ? fallback : offers[0]!).openapi({ description: both ? 'Compare by what it looks like (`look`), what it is about (`meaning`), or both, each match on its better side.' : `Only \`${offers[0]}\` here: this catalog has no other vectors.` })
  }
  const limit = z.coerce.number().int().min(1).max(100).default(24).openapi({ description: 'At most this many results (1–100, default 24).' })
  const ResultsSchema = z
    .object({
      query: z.string().nullable().openapi({ description: 'The words searched for; null for a picture or an item.' }),
      by: z.enum(['look', 'meaning', 'both']),
      count: z.number().int(),
      _links: LinksSchema,
      _embedded: z.object({
        results: z.array(
          z.object({
            score: z.number().openapi({ description: 'Cosine similarity (−1 to 1). Gemini’s scores sit in a narrow band; compare within one answer only.' }),
            z: z.number().nullable().openapi({ description: 'How many standard deviations above the catalog’s mean this row scored; null for likeness.' }),
            space: z.enum(['look', 'meaning']).openapi({ description: 'The space it matched in.' }),
            item: config.item,
          }),
        ),
        closest: z
          .array(z.object({ score: z.number(), z: z.number().nullable(), space: z.enum(['look', 'meaning']), item: config.item }))
          .optional()
          .openapi({ description: `Only when nothing clears the bar: the ${CLOSEST} nearest ${noun} below it, so you can judge whether the catalog has anything close. They are not matches; say so if you use them.` }),
      }),
    })
    .openapi(`${name}SearchResults`, { description: `${noun} that match, best first.` })
  const answer = (origin: string, self: string, query: string | null, chosen: By, results: Result[], closest?: () => Result[]) => ({
    query,
    by: chosen,
    count: results.length,
    _links: linksOf(origin, { self, search: { path: `${path}?q={q}`, templated: true, title: `Search ${noun} by words` } }),
    _embedded: { results, ...(!results.length && closest ? { closest: closest() } : {}) },
  })
  const withItems = (origin: string, rows: { key: string; score: number; z: number | null; space: SearchSpace }[]) =>
    rows.flatMap(({ key, score, z, space }) => {
      const item = config.itemOf(key, origin)
      return item === undefined ? [] : [{ score, z, space, item }]
    })

  if (config.hourlyLimit !== 0) app.use(path, rateLimit({ policy: `${noun}-search`, limit: config.hourlyLimit ?? 600, windowSeconds: 3600 }))
  const ok = (description: string) => ({ 200: { description, content: { [HAL_JSON]: { schema: ResultsSchema } } } })

  app.openapi(
    createRoute({
      method: 'get',
      path,
      operationId: `search${name}s`,
      tags: [tag],
      summary: `${noun[0]!.toUpperCase()}${noun.slice(1)} for a description`,
      description: `${noun} that match words: what they show or are about (\`meaning\`) or what they look like (\`look\`). Only matches that stand out from the whole catalog come back, so an empty answer means nothing fits. Costs one query embedding; repeats are cached.`,
      request: { query: z.object({ q: z.string().min(2).max(500).openapi({ description: 'What you are looking for, in words.', example: config.example ?? 'a fox made of triangles' }), by: by('both', ['both', 'look', 'meaning']), limit, ...filterShape }) },
      responses: { ...ok('Matches, best first.'), ...problemResponses(400, 401, 429, 503) },
    }),
    async (c) => {
      const { q, by: chosen, limit: count, ...filters } = c.req.valid('query') as { q: string; by: By; limit: number } & Filters
      const spaces = spacesFor(config, chosen)
      const query = await embedding(config.embedder(), (embedder) => embedder.query(q))
      const origin = originOf(c)
      const results = withItems(origin, rank(config, spaces, chosen, query, filters, count))
      return c.json(answer(origin, pathWith(path, c.req.query()), q, chosen, results, () => withItems(origin, rank(config, spaces, chosen, query, filters, CLOSEST, false, true))), 200)
    },
  )

  if (config.pictures !== false) app.openapi(
    createRoute({
      method: 'post',
      path,
      operationId: `search${name}sByImage`,
      tags: [tag],
      summary: `${noun[0]!.toUpperCase()}${noun.slice(1)} that look like a picture`,
      description: `${noun} like a picture you send (a sketch, a screenshot, a photo), PNG, JPEG, WebP or GIF up to 8 MB: \`multipart/form-data\` with an \`image\` file (\`curl -F image=@sketch.png\`), or JSON \`{ "image": "data:image/png;base64,…" }\` (or one of this API's own image links${config.imageHosts?.length ? `, or an https URL on ${config.imageHosts.join(', ')}` : ''}). \`by=meaning\` finds ${noun} about what the picture shows instead of ones that look like it. Filters go in the query string. Costs one image embedding (~$0.0001).`,
      request: {
        query: z.object({ by: by('look', ['look', 'meaning', 'both']), limit, ...filterShape }),
        body: {
          // Each content type validates its own body; `required` would run the JSON check on an upload too
          required: false,
          description: 'Required: the picture as a multipart `image` file, or JSON.',
          content: {
            'multipart/form-data': { schema: z.object({ image: z.any().openapi({ type: 'string', format: 'binary', description: 'The picture file.' }) }).openapi(`${name}ImageUpload`, { description: 'A picture file.' }) },
            'application/json': { schema: z.object({ image: z.string().max(11_000_000).openapi({ description: `The picture as a data URL${config.imageHosts?.length ? ' or an https URL on an allowed host' : ''}.`, example: 'data:image/png;base64,iVBORw0KGgo…' }) }).strict().openapi(`${name}ImageQuery`, { description: 'A picture.' }) },
          },
        },
      },
      responses: { ...ok('Lookalikes, best first.'), ...problemResponses(400, 401, 413, 415, 429, 503) },
    }),
    async (c) => {
      const { by: chosen, limit: count, ...filters } = c.req.valid('query') as { by: By; limit: number } & Filters
      const spaces = spacesFor(config, chosen)
      const upload = (c.req.header('content-type') ?? '').startsWith('multipart/form-data')
      const given = upload ? (await c.req.parseBody())['image'] : ((await c.req.json().catch(() => ({}))) as { image?: unknown }).image
      const origin = originOf(c)
      const credentials = Object.fromEntries(['authorization', 'cookie', 'cf-access-jwt-assertion'].flatMap((header) => (c.req.header(header) ? [[header, c.req.header(header)!]] : [])))
      const picture = await pictureOf(given, config.imageHosts ?? [], fetchImpl, { origin, fetch: (own) => Promise.resolve(app.request(own, { headers: credentials })) })
      const query = await embedding(config.embedder(), (embedder) => embedder.image(picture))
      const results = withItems(origin, rank(config, spaces, chosen, query, filters, count, true))
      return c.json(answer(origin, pathWith(path, c.req.query()), null, chosen, results, () => withItems(origin, rank(config, spaces, chosen, query, filters, CLOSEST, true, true))), 200)
    },
  )

  if (!similarPath) return
  const param = similarPath.match(/\{(\w+)\}/)?.[1] ?? 'id'
  app.openapi(
    createRoute({
      method: 'get',
      path: similarPath,
      operationId: `listSimilar${name}s`,
      tags: [tag],
      summary: `${noun[0]!.toUpperCase()}${noun.slice(1)} like one`,
      description: `${noun} like this one: \`look\` finds the same forms and style, \`meaning\` the same subject in any style. Always answers, closest first. Free.`,
      request: { params: z.object({ [param]: z.string().openapi({ description: 'The item’s id, or its board ref (`type:id`).' }) }), query: z.object({ by: z.enum(offers as [SearchSpace, ...SearchSpace[]]).optional().openapi({ description: both ? 'Compare by what it looks like (`look`, the default when look vectors exist) or what it is about (`meaning`).' : `Only \`${offers[0]}\` here.` }), limit, ...filterShape }) },
      responses: { ...ok('Similar items, closest first.'), ...problemResponses(400, 401, 404, 503) },
    }),
    (c) => {
      const id = (c.req.valid('param') as Record<string, string>)[param]!
      const { by: asked, limit: count, ...filters } = c.req.valid('query') as { by?: SearchSpace; limit: number } & Filters
      const chosen = asked ?? (config.spaces().look ? 'look' : 'meaning')
      const vectors = spacesFor(config, chosen)[chosen]!
      // An id may itself hold a colon (`episode:intro`); a board ref adds a type prefix (`recipe:soup`) to a bare id
      const key = [id, id.replace(/^[a-z][\w-]*:/, '')].map((candidate) => config.keyOf?.(candidate) ?? candidate).find((candidate) => vectorOf(vectors, candidate)) ?? id
      const vector = vectorOf(vectors, key)
      if (!vector) throw new ProblemError('not_found', { detail: `No ${chosen} vector for ${id}: it is not in the catalog, or not embedded yet. Find ids through search.` })
      const keep = config.filters?.keep(filters)
      const rows = nearest(vectors, vector, { limit: count, keep: (other) => other !== key && (keep?.(other) ?? true), groupOf: config.groupOf, perGroup: config.perGroup })
      const origin = originOf(c)
      return c.json(answer(origin, pathWith(c.req.path, c.req.query()), null, chosen, withItems(origin, rows.map((row) => ({ ...row, z: null, space: chosen })))), 200)
    },
  )
}

type ToolConfig = Pick<VectorSearchConfig, 'path' | 'similarPath' | 'noun' | 'imageHosts' | 'pictures' | 'offers'> & {
  /** One line naming a result's item, e.g. its title. */
  label: (item: any) => string
  /** The same filters as the routes, as tool arguments. */
  filters?: z.ZodRawShape
  /** Names default to `search_<noun>`, `search_<noun>_by_image`, `similar_<noun>`. */
  names?: Partial<Record<'search' | 'image' | 'similar', string>>
}

const summary = (label: ToolConfig['label']) => (json: { query: string | null; by: string; _embedded: { results: Result[]; closest?: Result[] } }) => {
  const line = (result: Result, n: number) => `${n + 1}. ${label(result.item)} · ${result.space} ${result.score}${result.z === null ? '' : ` (z ${result.z})`} · ${(result.item as { _links?: { self?: { href: string } } })._links?.self?.href ?? ''}`.trim()
  const results = json._embedded.results
  if (!results.length) {
    const closest = json._embedded.closest ?? []
    return [`Nothing stands out${json.query ? ` for "${json.query}"` : ''} by ${json.by}. Try other words, by=both, or fewer filters.`, ...(closest.length ? ['Nearest below the bar (not matches):', ...closest.map(line)] : [])].join('\n')
  }
  return results.map(line).join('\n')
}

/**
 * The MCP tools for the same three routes, so an agent searches by words, by picture and by likeness through the API
 * with its own credentials.
 *
 * @example
 * vectorSearchTools({ path: '/api/search', similarPath: '/api/recipes/{slug}/similar', noun: 'recipes', label: (recipe) => `${recipe.title} (${recipe.year})` })
 */
export const vectorSearchTools = (config: ToolConfig): McpTool[] => {
  const { path, similarPath, noun } = config
  const filters = config.filters ?? {}
  const offers = config.offers ?? (['look', 'meaning'] as SearchSpace[])
  const by = offers.length > 1 ? z.enum(['both', 'look', 'meaning']).optional().describe('look: appearance; meaning: subject; both (default for words).') : z.enum([offers[0]!] as [SearchSpace]).optional().describe(`Only ${offers[0]} here.`)
  const limit = z.number().int().min(1).max(100).optional().describe('At most this many (default 24).')
  const summarize = summary(config.label)
  const tools: McpTool[] = [
    mcpTool({
      name: config.names?.search ?? `search_${noun}`,
      title: `Search ${noun} by words`,
      description: `${noun} that match a description of what they show or look like, best first. Returns only clear matches: an empty answer means nothing fits.`,
      input: z.object({ q: z.string().min(2).describe('What you are looking for, in words.'), by, limit, ...filters }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: (args) => ({ path, query: args as never }),
      summarize,
    }),
    ...(config.pictures === false ? [] : [mcpTool({
      name: config.names?.image ?? `search_${noun}_by_image`,
      title: `Search ${noun} by picture`,
      description: `${noun} that look like a picture: pass it as a data URL (data:image/png;base64,…), or one of this server's own image links${config.imageHosts?.length ? `, or an https URL on ${config.imageHosts.join(', ')}` : ''}. Other URLs are refused. by=meaning finds ${noun} about what the picture shows.`,
      input: z.object({ image: z.string().describe("A data URL, or one of this server's own image links."), by: z.enum(['look', 'meaning', 'both']).optional().describe('look (default), meaning or both.'), limit, ...filters }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      call: ({ image, ...rest }) => ({ method: 'POST', path, query: rest as never, body: { image } }),
      summarize,
    })]),
  ]
  if (similarPath) {
    const param = similarPath.match(/\{(\w+)\}/)?.[1] ?? 'id'
    tools.push(
      mcpTool({
        name: config.names?.similar ?? `similar_${noun}`,
        title: `${noun[0]!.toUpperCase()}${noun.slice(1)} like one`,
        description: `${noun} like one you have the id of: by look (same forms and style) or meaning (same subject). Always answers, closest first.`,
        input: z.object({ [param]: z.string().describe(`The item’s ${param}, from a search result or its link (a board ref like \`type:${param}\` works too).`), by: z.enum(offers as [SearchSpace, ...SearchSpace[]]).optional().describe(offers.length > 1 ? 'look or meaning.' : `Only ${offers[0]} here.`), limit, ...filters }),
        annotations: { readOnlyHint: true, openWorldHint: false },
        call: (args: Record<string, unknown>) => {
          const { [param]: id, ...rest } = args
          // As given: the route tells an id holding a colon from a board ref's type prefix
          return { path: similarPath.replace(/\{\w+\}/, encodeURIComponent(String(id))), query: rest as never }
        },
        summarize,
      }),
    )
  }
  return tools
}
