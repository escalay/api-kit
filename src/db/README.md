# db

The app's database through Drizzle: one `openDb` per app, and every feature's `repo.ts` queries through it. The same
queries run on a local SQLite file today and on Turso or D1 later; only how the database is opened changes.

Needs: `drizzle-orm` (0.45). On Node ≥ 22.16, `node:sqlite` (with `setReturnArrays`); on Cloudflare Workers, a D1
binding. No native module. The module imports on both: `node:sqlite` loads only when a path asks for it.

```ts
import { migrate, openDb, testDb } from './kit/index.js'

const db = await openDb(`file:${join(env.STATE_DIR, 'state.sqlite')}`)   // a path, ':memory:', or an open DatabaseSync
await migrate(db, 'notes', NOTES_MIGRATIONS)                             // each feature brings its own steps
const rows = await db.select().from(notes).where(eq(notes.id, id))       // in repo.ts only

const db = await openDb(drizzle(createClient({ url, authToken })))       // Turso: any async Drizzle SQLite database
const db = await openDb(drizzle(env.DB))                                 // Cloudflare D1 (drizzle-orm/d1), in worker.ts
const db = await testDb()                                               // tests: empty, in memory
```

| Export | What |
|---|---|
| `openDb(source)` | a path or `file:` URL or `:memory:` or `DatabaseSync` → Drizzle over node:sqlite (the `sqlite-proxy` driver, rows as arrays so same-named columns in a join stay apart); a Drizzle database → used as it is; any other URL → an error naming what to do |
| `migrate(db, feature, steps)` | applies the steps not yet applied, in order, each in a transaction, recorded in `kit_migrations (feature, step)`; on D1 (which refuses `begin`) each step and its record go as one atomic batch |
| `dbGuardStore(db)` | the guards' state (`core/guards.ts`) in table `kit_guards`, each check one atomic statement: rate windows and Idempotency-Key answers shared by every instance. On Workers pass it to `createAgentApi({ guards: { store } })` and every `rateLimit` |
| `testDb()` | Node: an empty in-memory database; workerd: the test Worker's `DB` binding (storage is kept apart per test file, not per test) |
| `Db` | the type every repo takes |

## Rules

- **Only a feature's `repo.ts` queries the database.** Handlers call the repo, never `db`. That keeps a move off SQLite to
  the repos, and SQLite-only SQL (FTS5, `json_each`) inside a repo function.
- **A migration step never changes once it has run anywhere.** A change is a new step at the end. Step 1 of a table
  that already exists is its exact `create table if not exists …`, so live data is adopted.
- One step may hold several statements separated by `;` (not triggers: give a trigger its own step).
- **Rows have one shape on every database only through the query builder.** Raw `db.all(sql…)` returns arrays on
  node:sqlite and objects on D1: a repo uses `db.select()`, or names its columns and reads both shapes.
- Read-only catalogs (a built store, JSON in memory) don't go through `db`; they stay behind their own store module.
- Decision record: `docs/decisions/0001-features-drizzle-scaffold.md`.
