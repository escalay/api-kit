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
| `embedMissing` | embeds only new or changed items, appends each batch as it returns, stops at `budget` (a 402/403 is a `SpendCapError`); one writer per ledger (`<file>.lock`) |
| `createEmbedder` | query-time embedding of words or a picture |
| `readLedger`, `vectorSpace`, `vectorOf`, `centroid` | load a ledger into packed arrays; the latest line per key wins |
| `nearest`, `standouts` | likeness, and only the rows that stand out from the whole catalog (z-score, with `minScore` floors) |
| `hashOf` | the content hash; byte-compatible across versions (a test pins it) |

## Rules

- Builds run off the request path (a job, or a larger machine), start with a pilot (`limit: 200`), always carry a `budget`.
- Ledgers are data: gitignored, kept offsite (object storage), baked into the image or synced in. A newer ledger left in another
  checkout means live search runs on stale vectors: keep one copy current.
- **One writer per ledger.** `embedMissing` holds `<file>.lock` (made only if missing, holding its process id) while it
  runs; a second run on the same file, in this process or another, throws naming the lock. A lock whose process is
  gone (a crash) is taken over on the same machine; a lock left on shared storage by another machine stays until
  someone deletes it. Two machines building one ledger at once is not supported: build in one place, sync the file.
- **A torn last line** (a write cut short by a crash) is left out by `readLedger` with one `console.warn`, and the next
  `embedMissing` drops it before appending (and embeds its item again, the only cost); a whole last line cut just
  before its newline is kept and ended first. Any other line that isn't JSON
  is damage appending never makes: `readLedger` throws with its line number, and the file is restored from its copy.
- Standard: `docs/STANDARD.md` §15.
