---
name: api-kit-feature
description: Use when adding a feature (a resource with routes, data and MCP tools) to an API built on the Escalay api-kit, or reshaping existing routes into the kit's feature folder. Covers schema, repo, routes, handlers, tools and the feature's test.
---

# Add a feature the kit's way

A feature is one folder, `src/features/<name>/`, with one shape. The kit's `boards` part
(`src/kit/boards/README.md`, when installed) is the reference.

## Steps

1. `npx @escalay/kit feature <plural-name>` in the app (`reading-lists`, kebab-case, plural).
   It makes the folder and lists the feature in `src/features/index.ts`. Done when `pnpm test` still passes.
2. Fill in the files, in this order:

| File | Holds | Rule |
|---|---|---|
| `schema.ts` | Drizzle tables, the migration steps | A step never changes once it has run anywhere; add a new one |
| `repo.ts` | every query | The only file that touches `db` |
| `routes.ts` | `createRoute` contracts and zod schemas | See "Routes" below |
| `handlers.ts` | request → repo → HAL | Errors are `throw new ProblemError('not_found', { detail })` |
| `tools.ts` | MCP tools over the routes | One `mcpTool` per task-sized route |
| `index.ts` | `register`, `tools`, `samples`, the tag | Wiring only |
| `<name>.test.ts` | the feature's own behaviour | Through `app.request`, not the repo |

3. On Workers, `pnpm migrations` after adding a migration step.
4. `pnpm guide` if you touched `guide/`. Never write an endpoint or tool list by hand.
5. `pnpm test && pnpm typecheck`.

## Routes

- A camelCase `operationId` (`listReadingLists`), a `summary` of 80 characters or fewer, a `description` whose first
  sentence says when to use it.
- Every parameter has a description and a real `example`. Every query parameter the handler reads is in the query
  schema: an unknown one answers 400.
- The 2xx schema is named (`.openapi('ReadingList', { description })`) and carries `_links` with `self`.
- Errors: `...problemResponses(400, 404)`. The `detail` says what to do next.
- Lists page by cursor (`limitQuery`, `cursorQuery`, `pageOf` from the `pagination` part).
- Work that is slow or costs money answers 202 with a run and sits behind `rateLimit`.

## Tools

- `snake_case` verb names (`get_reading_list`), a description that says when to use it.
- Arguments are named like the route's parameters (`q`, not `query`).
- `call` returns the route to call; `summarize` returns a few lines with ids and links.
- `cli` names its command, noun then verb, with an example: `cli: { name: 'reading-list view', examples: [{ run:
  'reading-list view rl_123', about: 'One list with its books' }] }`. Rules and jobs: the `api-kit-cli` skill.
- `samples` in `index.ts` gives each tool arguments that work, creating what the tool needs first. A tool with no
  sample fails `toolsRun`.

## Checks

| Rule | Verified by |
|---|---|
| Every route is documented to the standard | `lintOpenApi(doc)` returns `[]` in `test/api.test.ts` |
| Every tool lands on a real route | `toolRoutes(TOOLS, doc)` returns `[]` |
| Every tool runs | `toolsRun(TOOLS, app, samples)` returns `[]` |
| The guide has no empty placeholder | `guideGaps(...)` returns `[]` |
| The guide module is current | `pnpm guide`, then the `guide.gen.ts` test |
| Every tool has a command and an example | `cliGaps({ tools: TOOLS })` returns `[]`; with `sdk/`, also `pnpm sdk:types` |

All six run with `pnpm test`.

## Done when

`pnpm test` and `pnpm typecheck` pass, the feature is in `src/features/index.ts`, and only `repo.ts` imports the
database.
