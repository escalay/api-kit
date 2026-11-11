# 0001 Feature folders, Drizzle for write state, a scaffolder

Status: accepted · Released: v0.10.0 (toolsRun, refs, --web-dir), v0.11.0 (db, Drizzle, oauth part), v1.0.0 (folders, init, feature)

## Context

The kit's stores (boards, OAuth) and each app's state held raw `node:sqlite` queries next to the HTTP handlers, so
moving off a local SQLite file meant rewriting queries in every app, and apps grew one large `api/index.ts`. Two bugs
came from things defined or tested nowhere: the board ref format (`type:id`, copied by hand) and MCP tools that
pointed at a real route but failed when run.

## Decisions

1. **Feature folders, one shape.** Kit and apps: `features/<name>/` with `schema.ts` (Drizzle tables + zod types),
   `repo.ts` (the only file with queries), `routes.ts` (createRoute contracts), `handlers.ts` (request → repo →
   HAL, errors → problems), `tools.ts` (MCP tools over the routes), `index.ts` (`registerX(app, { db })`).
2. **Drizzle for write state, not catalogs.** Boards, OAuth and every app's state tables go through Drizzle repos.
   Read-only catalogs (a built SQLite store, JSON in memory) stay behind their own store modules.
3. **SQLite family now.** One schema serves `node:sqlite` files, Turso/libSQL and D1: `openDb` opens a file itself and
   takes any other Drizzle SQLite database as it is (Turso via `drizzle-orm/libsql`, D1 via `drizzle(env.DB)`).
   Postgres comes later as a second `schema.ts` per feature; repos stay unchanged, and SQLite-only SQL lives inside
   repo functions.
4. **Driver: drizzle-orm 0.45 (stable) `sqlite-proxy` over `node:sqlite`.** No native module, so container builds
   need no build tools. The stable line has no `node:sqlite` driver.
5. **Existing data is adopted, not recreated.** A table's first migration step matches the table that already exists
   exactly, so live rows come through. An app whose boards also list other things keeps its own `features/boards`
   in this shape, with `parseBoardRef`, instead of `registerBoards`.
6. **Kit housekeeping:** `toolsRun` in `testing` (every tool run against its route), `boardRef`/`parseBoardRef`
   (`refs.ts`) in `boards` and `boards-client`, OAuth out of `core` as its own part, one `kit.json` per app for
   server and browser files, `kit init` and `kit feature` generators.

## Consequences

- v1.0 changed import paths (`./kit/boards/index.js`): each app moves once.
- Queries are async (the proxy driver), so repo functions return promises.
