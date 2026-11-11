import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { appendLedger, centroid, createEmbedder, DIMENSIONS, documentText, embedMissing, embedRequest, encodeVector, hashOf, imageDataUrl, nearest, queryText, readLedger, SpendCapError, standouts, vectorSpace, type Embedded, type EmbeddingInput } from '../src/vectors/index.js'

/** A unit vector along `axis`, leaning `lean` into the next one. */
const along = (axis: number, lean = 0) => {
  const vector = new Float32Array(DIMENSIONS)
  vector[axis] = 1
  vector[(axis + 1) % DIMENSIONS] = lean
  const length = Math.hypot(...vector)
  return vector.map((value) => value / length)
}
const spaceOf = (rows: [string, Float32Array][]) => vectorSpace(new Map(rows.map(([key, vector]) => [key, { key, hash: 'h', vector: encodeVector(vector) }])))
const ledgerFile = async () => join(await mkdtemp(join(tmpdir(), 'ledger-')), 'space.jsonl')

/** An OpenRouter stand-in: answers each input with a vector along its index, and records what it was sent. */
const fakeOpenRouter = (answer: (call: number) => Response | null = () => null) => {
  const bodies: { model: string; dimensions: number; input: unknown[] }[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const override = answer(bodies.length + 1)
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    return override ?? new Response(JSON.stringify({ data: body.input.map((_: unknown, index: number) => ({ index, embedding: Array.from(along(index)) })), usage: { prompt_tokens: 10 * body.input.length, cost: 0.001 } }))
  }) as typeof fetch
  return { fetchImpl, bodies }
}

describe('vectors', () => {
  it('hashes and formats exactly as the ledgers already paid for, so nothing re-embeds', () => {
    // Pinned: a different hash would mark every vector in an existing ledger stale
    expect(hashOf('title: Doctor | text: A consultation.')).toBe('b1f508eca6fefce7')
    expect(hashOf(new Uint8Array([1, 2, 3]))).toBe('37fa1c2e5cef7d4c')
    expect(documentText('Doctor with a patient', ['A consultation.', null, 'Category: Medical', false, 'Tags: doctor, patient'])).toBe('title: Doctor with a patient | text: A consultation.. Category: Medical. Tags: doctor, patient')
    expect(documentText('Doctor', [])).toBe('title: Doctor | text: ')
    expect(queryText('  doctor  ')).toBe('task: search result | query: doctor')
  })

  it('keeps ledgers append-only with the last line per key winning', async () => {
    const file = await ledgerFile()
    await appendLedger(file, [{ key: 'a', hash: '1', vector: encodeVector(along(0)) }])
    await appendLedger(file, [{ key: 'a', hash: '2', vector: encodeVector(along(1)) }, { key: 'b', hash: '1', vector: encodeVector(along(2)) }])
    const ledger = await readLedger(file)
    expect([...ledger.values()].map((line) => `${line.key}${line.hash}`)).toEqual(['a2', 'b1'])
    expect(vectorSpace(ledger).matrix[1]).toBeCloseTo(1)
    expect(vectorSpace(ledger, (key) => key === 'b').keys).toEqual(['b'])
    expect((await readLedger(join(tmpdir(), 'no-such-ledger.jsonl'))).size).toBe(0)
  })

  it('embeds only what is missing or changed, writing each batch as it returns', async () => {
    const file = await ledgerFile()
    const batches: number[] = []
    const embed = async (inputs: EmbeddingInput[]): Promise<Embedded> => {
      batches.push(inputs.length)
      return { vectors: inputs.map((_, n) => along(n)), tokens: inputs.length, cost: 0.01 }
    }
    const items = ['a', 'b', 'c', 'd', 'e'].map((key) => ({ key, content: `title: ${key} | text: ` }))
    expect(await embedMissing({ file, items, embed, batchSize: 2, limit: 3 })).toMatchObject({ embedded: 3, fresh: 0, tokens: 3 })
    expect(await embedMissing({ file, items, embed, batchSize: 2 })).toMatchObject({ embedded: 2, fresh: 3 })
    expect(await embedMissing({ file, items: [...items.slice(1), { key: 'a', content: 'changed' }], embed })).toMatchObject({ embedded: 1, fresh: 4 })
    expect(batches).toEqual([2, 1, 2, 1])
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(6)
  })

  it('starts no batch past the budget and stops on the spend cap, keeping what it paid for', async () => {
    const items = Array.from({ length: 10 }, (_, n) => ({ key: `k${n}`, content: `t${n}` }))
    const cheap = async (inputs: EmbeddingInput[]): Promise<Embedded> => ({ vectors: inputs.map(() => along(0)), tokens: 1, cost: 1 })
    expect(await embedMissing({ file: await ledgerFile(), items, embed: cheap, batchSize: 2, concurrency: 1, budget: 2 })).toMatchObject({ embedded: 4, cost: 2, stopped: 'budget' })

    const file = await ledgerFile()
    let calls = 0
    const capped = async (inputs: EmbeddingInput[]): Promise<Embedded> => {
      if (++calls > 2) throw new SpendCapError('OpenRouter 402: key limit reached')
      return cheap(inputs)
    }
    expect(await embedMissing({ file, items, embed: capped, batchSize: 3, concurrency: 1 })).toMatchObject({ embedded: 6, stopped: 'spend cap' })
    expect((await readLedger(file)).size).toBe(6)
  })

  it('skips an item whose input fails and embeds the rest of its batch', async () => {
    const file = await ledgerFile()
    const embed = async (inputs: EmbeddingInput[]): Promise<Embedded> => ({ vectors: inputs.map(() => along(0)), tokens: inputs.length, cost: 0 })
    const items = [
      { key: 'ok', content: 'title: ok | text: ' },
      { key: 'broken', content: '<svg', input: async () => Promise.reject(new Error('broken: the SVG does not render')) },
      { key: 'bytes', content: new Uint8Array([1]) },
    ]
    const run = await embedMissing({ file, items, embed })
    expect(run).toMatchObject({ embedded: 1, failed: ['broken: the SVG does not render', 'bytes: bytes need an input() that makes the image data URL'] })
    expect([...(await readLedger(file)).keys()]).toEqual(['ok'])
  })

  it('keeps only rows that stand out, so a query matching nothing returns nothing', () => {
    const noise: [string, Float32Array][] = Array.from({ length: 200 }, (_, n) => [`noise-${n}`, along(10 + n)])
    const space = spaceOf([...noise, ['match', along(0)], ['near', along(0, 0.8)]])
    const found = standouts(space, along(0), { limit: 10 })
    expect(found.map((row) => row.key)).toEqual(['match', 'near'])
    expect(found[0]!.z).toBeGreaterThan(found[1]!.z)
    expect(standouts(space, along(700), { limit: 10 })).toEqual([])
    expect(standouts(space, along(0), { limit: 10, keep: (key) => key !== 'match' }).map((row) => row.key)).toEqual(['near'])
    // A score floor drops what stands out but isn't close: 'near' sits at cosine ~0.78
    expect(standouts(space, along(0), { limit: 10, minScore: 0.9 }).map((row) => row.key)).toEqual(['match'])
  })

  it('finds the nearest rows the filter allows, capped per group', () => {
    const space = spaceOf([['far', along(5)], ['a1', along(0)], ['a2', along(0, 0.3)], ['b1', along(0, 0.8)]])
    expect(nearest(space, along(0), { limit: 2 }).map((row) => row.key)).toEqual(['a1', 'a2'])
    expect(nearest(space, along(0), { limit: 2, keep: (key) => key !== 'a1' }).map((row) => row.key)).toEqual(['a2', 'b1'])
    expect(nearest(space, along(0), { limit: 3, groupOf: (key) => key[0]!, perGroup: 1 }).map((row) => row.key)).toEqual(['a1', 'b1', 'far'])
    expect(nearest(space, along(0), { limit: 2, keep: () => false })).toEqual([])
  })

  it('averages rows into one unit vector', () => {
    const style = centroid(spaceOf([['a', along(0)], ['b', along(1)]]), ['a', 'b', 'missing'])
    expect(Math.hypot(...style)).toBeCloseTo(1, 5)
    expect(style[0]).toBeCloseTo(style[1]!, 5)
  })

  it('flattens images onto white at most 384 px', async () => {
    const transparent = await sharp({ create: { width: 800, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer()
    const jpeg = Buffer.from((await imageDataUrl(transparent)).split(',')[1]!, 'base64')
    const { width, height } = await sharp(jpeg).metadata()
    expect([width, height]).toEqual([384, 192])
    expect((await sharp(jpeg).stats()).dominant).toEqual({ r: 248, g: 248, b: 248 })
  })

  it('sends texts 100 and images 32 per request, retries a rate limit and reports the spend cap', async () => {
    const { fetchImpl, bodies } = fakeOpenRouter((call) => (call === 1 ? new Response('{"error":{"message":"slow down"}}', { status: 429 }) : null))
    const embedder = createEmbedder({ apiKey: 'key', fetchImpl })
    const images = await embedder.images(Array.from({ length: 40 }, (_, n) => `data:image/jpeg;base64,${n}`))
    expect(images.vectors).toHaveLength(40)
    expect(bodies.map((body) => body.input.length).sort()).toEqual([32, 32, 8])
    expect(bodies[0]).toMatchObject({ model: 'google/gemini-embedding-2', dimensions: 768 })
    expect(bodies[0]!.input[0]).toMatchObject({ content: [{ type: 'image_url' }] })
    expect((await embedder.documents(Array.from({ length: 150 }, (_, n) => `t${n}`))).tokens).toBe(1500)

    const refused = fakeOpenRouter(() => new Response('{"error":{"message":"Key limit exceeded"}}', { status: 402 }))
    await expect(embedRequest('key', ['x'], refused.fetchImpl)).rejects.toBeInstanceOf(SpendCapError)
    expect(refused.bodies).toHaveLength(1)
  }, 15_000)

  it('caches queries and pictures so a repeat costs nothing', async () => {
    const { fetchImpl, bodies } = fakeOpenRouter()
    const embedder = createEmbedder({ apiKey: 'key', fetchImpl })
    await embedder.query('Dark Mode ')
    await embedder.query('dark mode')
    await embedder.image('data:image/jpeg;base64,AAAA')
    await embedder.image('data:image/jpeg;base64,AAAA')
    expect(bodies.map((body) => body.input[0])).toEqual(['task: search result | query: dark mode', { content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }] }])
  })
})
