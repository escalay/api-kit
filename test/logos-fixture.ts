/**
 * A small logo catalog behind the kit with vector search: 200 noise rows, foxes that stand out by look along axis 0,
 * a bird by meaning along axis 3, and an embedder that puts "fox" and every picture on axis 0 and "bird" on axis 3.
 */
import { z } from '@hono/zod-openapi'
import sharp from 'sharp'
import { createAgentApi, hashApiKey, LinksSchema, parseApiKeys } from '../src/index.js'
import { registerVectorSearch } from '../src/vector-search/index.js'
import { DIMENSIONS, encodeVector, vectorSpace, type Embedder } from '../src/vectors/index.js'

export const KEY = 'agent-key'
export const auth = { authorization: `Bearer ${KEY}` }

/** A unit vector along `axis`, leaning `lean` into the next one. */
export const along = (axis: number, lean = 0) => {
  const vector = new Float32Array(DIMENSIONS)
  vector[axis] = 1
  vector[(axis + 1) % DIMENSIONS] = lean
  const length = Math.hypot(...vector)
  return vector.map((value) => value / length)
}
const spaceOf = (rows: [string, Float32Array][]) => vectorSpace(new Map(rows.map(([key, vector]) => [key, { key, hash: 'h', vector: encodeVector(vector) }])))

// 200 logos of noise; foxes stand out along axis 0 by look, birds along axis 3 by meaning
const noise = (offset: number): [string, Float32Array][] => Array.from({ length: 200 }, (_, n) => [`logo:n${n}`, along(10 + offset + n)])
export const LOGOS: Record<string, { client: string; decade: string }> = { 'logo:fox': { client: 'Fox Films', decade: '1970s' }, 'logo:fox2': { client: 'Red Fox', decade: '1980s' }, 'logo:bird': { client: 'Bird Air', decade: '1970s' } }
export const look = spaceOf([...noise(0), ['logo:fox', along(0)], ['logo:fox2', along(0, 0.5)], ['logo:bird', along(2)]])
export const meaning = spaceOf([...noise(300), ['logo:fox', along(5)], ['logo:bird', along(3)]])

/** An embedder whose words and pictures land on fixed axes: "fox" → 0, "bird" → 3, anything else → 700; any picture → 0. */
export const fakeEmbedder = (): Embedder => ({
  documents: async () => ({ vectors: [], tokens: 0, cost: 0 }),
  images: async () => ({ vectors: [], tokens: 0, cost: 0 }),
  query: async (query) => along(query.includes('fox') ? 0 : query.includes('bird') ? 3 : 700),
  image: async () => along(0),
})

export const sampleApi = ({ embedder = fakeEmbedder() as Embedder | null, spaces = { look, meaning } as Record<string, ReturnType<typeof spaceOf>>, fetchImpl = fetch, minZ = undefined as Record<string, number> | undefined, keyOf = ((slug: string) => `logo:${slug}`) as ((id: string) => string) | null } = {}) => {
  const app = createAgentApi({ title: 'Logos', version: '1.0.0', description: 'Logos.', tags: [{ name: 'Search', description: 'Find logos.' }], auth: { realm: 'logos', keys: parseApiKeys(`agent:${hashApiKey(KEY)}`) } })
  const LogoCard = z.object({ id: z.string(), client: z.string(), _links: LinksSchema }).openapi('LogoCard', { description: 'A logo.' })
  registerVectorSearch(app, {
    path: '/api/search',
    similarPath: '/api/logos/{slug}/similar',
    name: 'Logo',
    noun: 'logos',
    tag: 'Search',
    item: LogoCard,
    spaces: () => spaces,
    embedder: () => embedder ?? undefined,
    itemOf: (key, origin) => (LOGOS[key] ? { id: key, client: LOGOS[key].client, _links: { self: { href: `${origin}/api/logos/${key.slice(5)}` } } } : undefined),
    keyOf: keyOf ?? undefined,
    filters: { shape: { decade: z.string().optional().openapi({ description: 'Only this decade, e.g. 1970s.' }) }, keep: ({ decade }) => (decade ? (key) => LOGOS[key]?.decade === decade : undefined) },
    imageHosts: ['assets.example.com'],
    fetchImpl,
    minZ,
  })
  return app
}

export const png = () => sharp({ create: { width: 64, height: 64, channels: 3, background: '#e44' } }).png().toBuffer()
