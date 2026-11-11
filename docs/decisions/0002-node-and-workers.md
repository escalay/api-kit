# 0002 One kit, two runtimes: Node and Cloudflare Workers

Status: accepted · Released: v1.2.0 (imports and runs on workerd; D1 migrations; workers test project), v1.3.0 (guard state in the database), v1.4.0 (guide from a module), v1.5.0 (`init --runtime`), v1.5.1 (scaffold fixes), v1.5.2 (D1 migration files replay over a `migrate()`-made database)

## Context

New services start on Cloudflare Workers. The
kit ran only on Node: `db` imported `node:sqlite` at the top, `cache` made a random id at global scope (Workers refuse
it, so importing the kit stopped a Worker starting), and `migrate` opened transactions with `begin`, which D1 refuses.
Drizzle was adopted (0001) so the database could move without the features changing; this uses that.

## Decisions

1. **Same layers on both runtimes.** Features, repos, routes, handlers, tools and `createApp` don't change. Only the
   entry differs: `server.ts` (Node, a container) or `worker.ts` (Workers), each opening the database and calling
   `createApp`.
2. **Keep `node:crypto`, `node:zlib`, `Buffer`.** Workers provide them under `nodejs_compat` (on by default from
   compatibility date 2026-08-04), and `hashOf` / `hashApiKey` must keep producing the bytes already paid for and
   stored. Moving to `crypto.subtle` would make them async and change every app.
3. **Nothing at global scope that Workers refuse.** Random values, I/O and timers happen on first use
   (`snapshotEtag`'s start id); `snapshotEtag` takes `boot` so a deploy's isolates share one ETag.
4. **D1 through Drizzle, migrations as batches.** `openDb(drizzle(env.DB))`; `migrate` sends each step and its
   `kit_migrations` record as one D1 batch (atomic). Durable Object SQLite is not a `Db` (its driver is sync) and
   holds no feature data.
5. **Row shapes:** raw `db.all(sql…)` rows are arrays on node:sqlite and objects on D1; repos use the query builder or
   name their columns.
6. **One suite, two projects.** Vitest `node` (every test) and `workers` (`@cloudflare/vitest-plugin`, inside
   workerd). `test/workers/worker.ts` imports the whole kit at global scope and serves a probe app over D1, so a
   regression fails to start rather than failing in production.
7. **Shared state lives in the database (v1.3).** Idempotency and rate limits keep state in a `GuardStore`;
   `dbGuardStore(db)` makes every check one atomic SQLite statement, so all isolates agree. Not KV (eventually
   consistent), not the Rate Limiting binding (10 s or 60 s windows only). A2A's tasks go in a database store too
   (`dbOAuthStore(db)` fits); on Workers it warns when left in memory.
8. **The guide ships as a module on Workers (v1.4).** `kit guide` writes the folder as `GUIDE_FILES`;
   `serveGuide({ files })` serves it exactly as from the folder. The folder stays the source.
9. **`init --runtime both|cloudflare|node` (v1.5), `both` by default.** One `app.ts`; Node adds `server.ts` and the
   container, Workers add `worker.ts`, `wrangler.jsonc` and a workerd test project. Migrations run at deploy: each
   feature declares its `migrations`, `pnpm migrations` writes one D1 file per step with its `kit_migrations` record
   (refusing to rewrite a shipped step), `wrangler d1 migrations apply` runs them, and `migrate()` at runtime finds
   them done (it stays the fallback for local dev). App scripts use the app's own `tsx` and kit copy, never the network.

## Next (each its own release)

v1.6 the front door on Static
Assets; later a `realtime` module (Durable Objects with hibernating WebSockets, `wait(key, ms)`).
