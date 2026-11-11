/**
 * Embeddings and vector search as apps built on the kit share them. Gemini Embedding 2 (through OpenRouter) puts text and
 * images in one 768-dimension space, so an item gets up to two vectors:
 *   look     its picture, flattened onto white at most 384 px: "looks like this", search by a pasted image
 *   meaning  its words in Gemini's document format: what it shows and is about
 * and a query, typed or pasted, is compared against either. Vectors come back unit length: a dot product is the cosine.
 *
 * A paid call is never lost: `embedMissing` appends each batch to an append-only JSONL ledger the moment it returns,
 * keyed by a hash of model, size and content, so a crash, a rerun or another machine pays only for what changed. A
 * 402/403 from OpenRouter (the key's cap or the account's credit) is a `SpendCapError` that stops the run.
 *
 * Plain fetch for texts and images alike: the AI SDK's embed() takes strings only.
 *
 * @example
 * const embedder = createEmbedder({ apiKey: process.env.OPENROUTER_API_KEY! })
 * await embedMissing({ file: 'vectors/meaning.jsonl', items: notes.map((note) => ({ key: note.id, content: documentText(note.client, [note.industry]) })), embed: embedder.documents })
 * const meaning = vectorSpace(await readLedger('vectors/meaning.jsonl'))
 * standouts(meaning, await embedder.query('a fox made of triangles'), { limit: 24 })
 */
import { createHash } from 'node:crypto'
import { appendFile, readFile } from 'node:fs/promises'

export const EMBEDDING_MODEL = 'google/gemini-embedding-2'
export const DIMENSIONS = 768
export const IMAGE_PX = 384
/** The least a row must stand out (standard deviations above the query's mean) to count as a match; see `standouts`. */
export const MIN_Z = 3.5

const ENDPOINT = 'https://openrouter.ai/api/v1/embeddings'
// Gemini's batchEmbedContents limit for texts; images are heavier per request
const TEXTS_PER_REQUEST = 100
const IMAGES_PER_REQUEST = 32
const RETRY_ON = /\b(408|429|5\d\d)\b|fetch failed|ECONNRESET|ETIMEDOUT|terminated/

/** OpenRouter refused for money: the key's own cap or the account's credit ran out. Stops a build; a route answers 503. */
export class SpendCapError extends Error {}

/** A text, or an image as a data URL (`imageDataUrl`). */
export type EmbeddingInput = string | { image: string }
export type Embedded = { vectors: Float32Array[]; tokens: number; cost: number }
export type LedgerLine = { key: string; hash: string; vector: string }
export type VectorSpace = { keys: string[]; matrix: Float32Array; rowOf: Map<string, number> }
export type Match = { key: string; score: number }

/**
 * A document in the format Gemini Embedding 2 reads (it has no task type; it reads these prefixes). Empty parts drop.
 *
 * @example
 * documentText('Doctor with a patient', ['A consultation.', 'Category: Medical']) // 'title: Doctor with a patient | text: A consultation.. Category: Medical'
 */
export const documentText = (title: string, parts: (string | null | undefined | false)[]) => `title: ${title} | text: ${parts.filter(Boolean).join('. ')}`

/** A search in Gemini's query format. @example queryText(' dark mode ') // 'task: search result | query: dark mode' */
export const queryText = (query: string) => `task: search result | query: ${query.trim()}`

/** Changes with the content, the model or the size, so the ledger re-embeds exactly what went stale. @example hashOf(documentText(…)) */
export const hashOf = (content: string | Uint8Array) => createHash('sha256').update(`${EMBEDDING_MODEL}|${DIMENSIONS}|`).update(content).digest('hex').slice(0, 16)

/**
 * Any image → the JPEG data URL a look vector is made from: at most 384 px (258 tokens), transparency on white. Loads
 * `sharp` on first use, so an app that embeds only text never needs it.
 *
 * @example
 * await imageDataUrl(pngBuffer)
 */
export const imageDataUrl = async (input: Uint8Array | string) => {
  const { default: sharp } = await import('sharp')
  const jpeg = await sharp(input).resize(IMAGE_PX, IMAGE_PX, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer()
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}

const toUnitVector = (values: ArrayLike<number>) => {
  const vector = Float32Array.from(values)
  let length = 0
  for (const value of vector) length += value * value
  length = Math.sqrt(length) || 1
  return vector.map((value) => value / length)
}

/** A vector as the ledger stores it, and back. @example decodeVector(encodeVector(v)) */
export const encodeVector = (vector: Float32Array) => Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64')
export const decodeVector = (base64: string) => {
  const bytes = Buffer.from(base64, 'base64')
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

const withRetries = async <T>(attempt: () => Promise<T>, tries = 6): Promise<T> => {
  for (let n = 1; ; n++) {
    try {
      return await attempt()
    } catch (error) {
      if (error instanceof SpendCapError || n >= tries || !RETRY_ON.test(String(error))) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.min(60_000, 2 ** n * 500)))
    }
  }
}

/**
 * One OpenRouter request: inputs → unit vectors in order, with what it says it cost. Retries rate limits and server
 * errors with backoff; throws `SpendCapError` on 402/403.
 *
 * @example
 * const { vectors, cost } = await embedRequest(key, [queryText('soup'), { image: await imageDataUrl(png) }])
 */
export const embedRequest = (apiKey: string, inputs: EmbeddingInput[], fetchImpl: typeof fetch = fetch): Promise<Embedded> =>
  withRetries(async () => {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDING_MODEL, dimensions: DIMENSIONS, input: inputs.map((input) => (typeof input === 'string' ? input : { content: [{ type: 'image_url', image_url: { url: input.image } }] })) }),
    })
    const body = (await response.json().catch(() => ({}))) as { data?: { index: number; embedding: number[] }[]; usage?: { prompt_tokens?: number; cost?: number }; error?: { message?: string } }
    if (response.status === 402 || response.status === 403) throw new SpendCapError(`OpenRouter ${response.status}: ${body.error?.message ?? 'refused'}`)
    if (!response.ok || body.data?.length !== inputs.length) throw new Error(`OpenRouter ${response.status}: ${body.error?.message ?? `${body.data?.length ?? 0} of ${inputs.length} embeddings`}`)
    return { vectors: [...body.data].sort((a, b) => a.index - b.index).map((item) => toUnitVector(item.embedding)), tokens: body.usage?.prompt_tokens ?? 0, cost: body.usage?.cost ?? 0 }
  })

const inBatches = async (apiKey: string, fetchImpl: typeof fetch, inputs: EmbeddingInput[], size: number): Promise<Embedded> => {
  const batches = await Promise.all(Array.from({ length: Math.ceil(inputs.length / size) }, (_, n) => embedRequest(apiKey, inputs.slice(n * size, (n + 1) * size), fetchImpl)))
  return { vectors: batches.flatMap((batch) => batch.vectors), tokens: batches.reduce((sum, batch) => sum + batch.tokens, 0), cost: batches.reduce((sum, batch) => sum + batch.cost, 0) }
}

/**
 * The embedder an app holds: documents and images in batches for a build, and queries (typed or a picture) for a
 * search, each cached (the last `cacheSize`) so a repeated query costs nothing.
 *
 * @example
 * const embedder = createEmbedder({ apiKey: env.OPENROUTER_API_KEY })
 * await embedder.query('a lettermark with negative space') // Float32Array(768)
 * await embedder.image(await imageDataUrl(upload))         // a picture as a query
 */
export const createEmbedder = ({ apiKey, fetchImpl = fetch, cacheSize = 500 }: { apiKey: string; fetchImpl?: typeof fetch; cacheSize?: number }) => {
  const cache = new Map<string, Float32Array>()
  const cached = async (id: string, input: EmbeddingInput) => {
    const hit = cache.get(id)
    if (hit) return hit
    const [vector] = (await embedRequest(apiKey, [input], fetchImpl)).vectors
    if (cache.size >= cacheSize) cache.delete(cache.keys().next().value!)
    cache.set(id, vector!)
    return vector!
  }
  return {
    /** Documents (`documentText`) → vectors in order, 100 per request. */
    documents: (texts: string[]) => inBatches(apiKey, fetchImpl, texts, TEXTS_PER_REQUEST),
    /** Image data URLs → vectors in order, 32 per request. */
    images: (dataUrls: string[]) => inBatches(apiKey, fetchImpl, dataUrls.map((image) => ({ image })), IMAGES_PER_REQUEST),
    /** A typed search in Gemini's query format; case and spacing don't make a new call. */
    query: (query: string) => cached(`q:${query.trim().toLowerCase()}`, queryText(query.trim().toLowerCase())),
    /** A picture as a query (`imageDataUrl` first). */
    image: (dataUrl: string) => cached(`i:${hashOf(dataUrl)}`, { image: dataUrl }),
  }
}

export type Embedder = ReturnType<typeof createEmbedder>

// ---- Ledgers: one JSONL per space, append-only, the last line per key wins ----

/** A space's ledger by key; a missing file is an empty ledger. @example const ledger = await readLedger('vectors/look.jsonl') */
export const readLedger = async (file: string): Promise<Map<string, LedgerLine>> => {
  const text = await readFile(file, 'utf8').catch(() => '')
  return new Map(text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerLine).map((line) => [line.key, line]))
}

/** Adds lines to a ledger; never rewrites it. @example await appendLedger(file, [{ key, hash, vector: encodeVector(v) }]) */
export const appendLedger = (file: string, lines: LedgerLine[]) => appendFile(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''))

export type LedgerItem = {
  key: string
  /** What the vector is made from: a document's text, or an image's bytes. Its hash decides whether it is stale. */
  content: string | Uint8Array
  /** What to send, when it differs from `content` (an image's data URL); made only for stale items. */
  input?: () => EmbeddingInput | Promise<EmbeddingInput>
}

export type EmbedRun = { embedded: number; fresh: number; failed: string[]; tokens: number; cost: number; stopped?: 'budget' | 'spend cap' }

/**
 * Embeds the items whose vectors are missing or stale and appends each batch to the ledger as soon as it returns, so
 * nothing paid for is lost. Starts no new batch once `budget` (USD, as OpenRouter reports it) is spent, and stops on a
 * `SpendCapError`; a rerun picks up where it stopped. `limit` embeds at most that many (a pilot). An item whose input
 * can't be made (a picture that won't render) is skipped and named in `failed`; the rest of its batch still goes.
 *
 * @example
 * await embedMissing({ file: 'vectors/look.jsonl', items: notes.map((l) => ({ key: l.id, content: l.svg, input: async () => ({ image: await imageDataUrl(l.png) }) })), embed: (inputs) => embedRequest(key, inputs), batchSize: 32, budget: 2, limit: 200 })
 */
export const embedMissing = async ({ file, items, embed, batchSize = 100, concurrency = 4, budget = Infinity, limit = Infinity, log = () => {} }: { file: string; items: LedgerItem[]; embed: (inputs: EmbeddingInput[]) => Promise<Embedded>; batchSize?: number; concurrency?: number; budget?: number; limit?: number; log?: (message: string) => void }): Promise<EmbedRun> => {
  const ledger = await readLedger(file)
  const outdated = items.map((item) => ({ item, hash: hashOf(item.content) })).filter(({ item, hash }) => ledger.get(item.key)?.hash !== hash)
  const stale = outdated.slice(0, limit)
  const run: EmbedRun = { embedded: 0, fresh: items.length - outdated.length, failed: [], tokens: 0, cost: 0 }
  const batches = Array.from({ length: Math.ceil(stale.length / batchSize) }, (_, n) => stale.slice(n * batchSize, (n + 1) * batchSize))
  let next = 0
  const worker = async () => {
    while (next < batches.length && !run.stopped) {
      if (run.cost >= budget) {
        run.stopped = 'budget'
        return
      }
      const made = await Promise.allSettled(batches[next++]!.map(async ({ item, hash }) => ({ item, hash, input: await (item.input?.() ?? (typeof item.content === 'string' ? item.content : Promise.reject(new Error(`${item.key}: bytes need an input() that makes the image data URL`)))) })))
      const batch = made.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
      for (const result of made)
        if (result.status === 'rejected') {
          const reason = String((result.reason as Error)?.message ?? result.reason)
          run.failed.push(reason)
          log(`skipped: ${reason}`)
        }
      if (!batch.length) continue
      const inputs = batch.map(({ input }) => input)
      try {
        const { vectors, tokens, cost } = await embed(inputs)
        await appendLedger(file, batch.map(({ item, hash }, n) => ({ key: item.key, hash, vector: encodeVector(vectors[n]!) })))
        run.embedded += batch.length
        run.tokens += tokens
        run.cost += cost
        log(`${run.embedded}/${stale.length} embedded · ${run.tokens} tokens · $${run.cost.toFixed(4)}`)
      } catch (error) {
        if (!(error instanceof SpendCapError)) throw error
        run.stopped = 'spend cap'
        log(String(error.message))
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker))
  return run
}

// ---- Search ----

/**
 * A ledger as a searchable matrix; `keep` drops keys no longer in the catalog.
 *
 * @example
 * const look = vectorSpace(await readLedger('vectors/look.jsonl'), (key) => catalog.has(key))
 */
export const vectorSpace = (ledger: Map<string, LedgerLine>, keep: (key: string) => boolean = () => true): VectorSpace => {
  const keys = [...ledger.keys()].filter(keep)
  const matrix = new Float32Array(keys.length * DIMENSIONS)
  keys.forEach((key, row) => matrix.set(decodeVector(ledger.get(key)!.vector), row * DIMENSIONS))
  return { keys, matrix, rowOf: new Map(keys.map((key, row) => [key, row])) }
}

/** One key's vector, or undefined. @example vectorOf(look, 'note:1') */
export const vectorOf = (space: VectorSpace, key: string) => {
  const row = space.rowOf.get(key)
  return row === undefined ? undefined : space.matrix.subarray(row * DIMENSIONS, (row + 1) * DIMENSIONS)
}

/** The normalised mean of some rows: a collection's style as one vector. @example centroid(look, pack.keys) */
export const centroid = (space: VectorSpace, keys: string[]) => {
  const sum = new Float32Array(DIMENSIONS)
  for (const key of keys) {
    const row = vectorOf(space, key)
    if (row) for (let d = 0; d < DIMENSIONS; d++) sum[d]! += row[d]!
  }
  return toUnitVector(sum)
}

const similarities = (space: VectorSpace, query: Float32Array) => {
  const scores = new Float32Array(space.keys.length)
  for (let row = 0, at = 0; row < scores.length; row++) {
    let sum = 0
    for (let d = 0; d < DIMENSIONS; d++, at++) sum += space.matrix[at]! * query[d]!
    scores[row] = sum
  }
  return scores
}

type Pick = { limit: number; keep?: (key: string) => boolean; groupOf?: (key: string) => string; perGroup?: number }

// Sorts only the rows that pass, then caps each group (an app, a pack) so a page isn't one group's items
const best = (space: VectorSpace, scores: Float32Array, pass: (row: number) => boolean, { limit, keep = () => true, groupOf, perGroup = Infinity }: Pick) => {
  const rows: number[] = []
  for (let row = 0; row < scores.length; row++) if (pass(row) && keep(space.keys[row]!)) rows.push(row)
  rows.sort((a, b) => scores[b]! - scores[a]!)
  const taken = new Map<string, number>()
  const picked: number[] = []
  for (const row of rows) {
    if (picked.length >= limit) break
    const group = groupOf?.(space.keys[row]!)
    if (group !== undefined) {
      if ((taken.get(group) ?? 0) >= perGroup) continue
      taken.set(group, (taken.get(group) ?? 0) + 1)
    }
    picked.push(row)
  }
  return picked
}

const rounded = (value: number) => Math.round(value * 1000) / 1000

/**
 * The `limit` rows most like `query` that `keep` allows, best first, at most `perGroup` per `groupOf`. For "similar to
 * this item", where there is always an answer.
 *
 * @example
 * nearest(look, vectorOf(look, 'note:1')!, { limit: 12, keep: (key) => key !== 'note:1' })
 */
export const nearest = (space: VectorSpace, query: Float32Array, pick: Pick): Match[] => {
  const scores = similarities(space, query)
  return best(space, scores, () => true, pick).map((row) => ({ key: space.keys[row]!, score: rounded(scores[row]!) }))
}

/**
 * The rows that stand out for this query, best first, with how far they stand out (`z`). Gemini's similarities sit in
 * a narrow band (a nonsense query scored 0.52–0.60 against everything, real matches 0.55–0.71), so no fixed floor
 * separates them. Scoring every row gives the query's own distribution: a match is `minZ` standard deviations above its
 * mean. Noise alone reaches about √(2 ln n) among n rows, so the default bar rises with the catalog (3.5 at 552 rows,
 * 4.12 at 42k, measured on a 42k-row catalogue). `keep` applies after, so a small filtered set can still stand out.
 * A query matching nothing returns nothing. `minScore` adds a raw-similarity floor for a corpus that is all about one
 * subject, where everything stands out a little and only the score separates a real match.
 *
 * @example
 * standouts(meaning, await embedder.query('a fox'), { limit: 24, groupOf: (key) => authorOf(key), perGroup: 3 })
 */
export const standouts = (space: VectorSpace, query: Float32Array, { minZ, minScore = -Infinity, ...pick }: Pick & { minZ?: number; minScore?: number }): (Match & { z: number })[] => {
  const scores = similarities(space, query)
  if (scores.length < 2) return best(space, scores, () => true, pick).map((row) => ({ key: space.keys[row]!, score: rounded(scores[row]!), z: 0 }))
  let mean = 0
  for (const score of scores) mean += score / scores.length
  let variance = 0
  for (const score of scores) variance += (score - mean) ** 2 / scores.length
  const deviation = Math.sqrt(variance) || 1
  const bar = minZ ?? Math.max(MIN_Z, Math.sqrt(2 * Math.log(scores.length)) - 0.5)
  const floor = Math.max(mean + bar * deviation, minScore)
  return best(space, scores, (row) => scores[row]! >= floor, pick).map((row) => ({ key: space.keys[row]!, score: rounded(scores[row]!), z: rounded((scores[row]! - mean) / deviation) }))
}
