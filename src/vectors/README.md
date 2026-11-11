# vectors

Embeddings with Gemini Embedding 2 through OpenRouter: what things look like (`look`, from pictures) and what they are
about (`meaning`, from text), kept in append-only ledgers keyed by a content hash, so a rerun pays only for what
changed. Plus the maths search needs: `nearest`, `standouts`, `centroid`.

Needs: nothing else from the kit. An OpenRouter key per app.

```ts
import { embedMissing, embedRequest, readLedger, vectorSpace, nearest } from './kit/index.js'

const run = await embedMissing({ file: 'data/vectors/meaning.jsonl', items, embed: (inputs) => embedRequest(key, inputs), batchSize: 100, budget: 0.5 })
const space = vectorSpace(await readLedger('data/vectors/meaning.jsonl'), (key) => store.has(key))
const similar = nearest(space, vectorOf(space, 'note:1')!, { limit: 12 })
```

| Export | What |
|---|---|
| `embedMissing` | embeds only new or changed items, appends each batch as it returns, stops at `budget` (a 402/403 is a `SpendCapError`) |
| `createEmbedder` | query-time embedding of words or a picture |
| `readLedger`, `vectorSpace`, `vectorOf`, `centroid` | load a ledger into packed arrays; the latest line per key wins |
| `nearest`, `standouts` | likeness, and only the rows that stand out from the whole catalog (z-score, with `minScore` floors) |
| `hashOf` | the content hash; byte-compatible across versions (a test pins it) |

## Rules

- Builds run off the request path (a job, or a larger machine), start with a pilot (`limit: 200`), always carry a `budget`.
- Ledgers are data: gitignored, kept offsite (object storage), baked into the image or synced in. A newer ledger left in another
  checkout means live search runs on stale vectors: keep one copy current.
- Standard: `docs/STANDARD.md` §15.
