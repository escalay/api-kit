---
name: api-kit-feature
description: Use when adding a feature (a resource with routes, data and MCP tools) to an API built on the Escalay api-kit, making a feature one the owner can switch off, removing a feature (the starter's notes sample), or reshaping existing routes into the kit's feature folder. Covers kit feature (--fields, --switch), schema, repo, routes, handlers, tools, the feature switch and the feature's test.
---

# Add a feature the kit's way

A feature is one folder, `src/features/<name>/`, with one shape. The kit's `boards` part
(`src/kit/boards/README.md`, when installed) is the reference.

## Steps

1. `npx @escalay/kit feature <plural-name> --fields "<name>:<type> …"` in the app (`recipes`, kebab-case, plural;
   `--fields "name:string minutes:int tags:string[] notes:text?"`: `string`, `text`, `int`, `number`, `bool`,
   `string[]`, `enum(to-read|reading|done)` (one of those values: zod, the column and a SQL check), `?` when it may
   be left out). It makes the folder with those fields in every file (without `--fields`, a title and a body), a
   list paged by cursor, and lists the feature in `src/features/index.ts`. It says the singular it took
   (`shelves` → `shelve`): `--singular shelf` names it. `--no-remove` leaves out delete (route, tool, sample).
   Done when `pnpm test` still passes.
   A feature the app can work without (sending, webhooks, a report) takes `--switch`: it is also listed in
   `src/features/catalog.ts` (write there what switching it off stops) and named in its `index.ts` (`switch`), so
   `src/app.ts` registers it through `gated`: every route it adds answers `403 feature_disabled` while the owner has
   it off, and its tools say which switch they belong to. Background work asks `isOn` (`src/kit/switches/README.md`).
   Never a switch for what the app cannot run without (sign-in, its main data).
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
   Removing a feature (the starter's `notes` once a real one exists): `npx @escalay/kit feature --remove notes`
   takes out its folder, its import and list lines in `src/features/index.ts` and its entry in `catalog.ts`, and
   names any file still importing it; then `pnpm migrations` (it removes the feature's files from `migrations/`).
4. `pnpm guide` if you touched `guide/`. Never write an endpoint or tool list by hand.
5. `pnpm test && pnpm typecheck`.

## Routes

- A camelCase `operationId` (`listReadingLists`), a `summary` of 80 characters or fewer, a `description` whose first
  sentence says when to use it.
- Every parameter has a description and a real `example`. Every query parameter the handler reads is in the query
  schema: an unknown one answers 400.
- The 2xx schema is named (`.openapi('ReadingList', { description })`) and carries `_links` with `self`.
- A PATCH body is the input schema's `.partial()`. Never `.default()` in an input schema a PATCH reuses: a field the
  PATCH leaves out gets the default and overwrites what was there. Default in the repo's `create` instead.
- Errors: `...problemResponses(400, 404)`. The `detail` says what to do next.
- Lists page by cursor (`limitQuery`, `cursorQuery`, `pageOf` from the `pagination` part).
- Work that is slow or costs money answers 202 with a run and sits behind `rateLimit`.

## An action route

A change with a name of its own (`POST /api/books/{id}/done`) is a route beside `update`, for a feature made with
`--fields "title:string status:enum(to-read|reading|done)"`. Each block names its file and place:

```ts
// routes.ts, in routes
  done: createRoute({
    method: 'post', path: `${PATH}/{id}/done`, operationId: 'markBookDone', tags: [TAG], summary: 'Mark a book done', description: 'Sets its status to done; marking it again changes nothing.',
    request: { params: z.object({ id }) },
    responses: { 200: ok('The book.', BookSchema), ...problemResponses(401, 403, 404) },
  }),
// handlers.ts, before the return, which adds done
  const done: RouteHandler<Routes['done']> = async (c) => {
    const { id } = c.req.valid('param')
    await rowOf(id)
    await repo.update(id, { status: 'done' })
    return c.json(cardOf(originOf(c), await rowOf(id)), 200)
  }
// index.ts, in register; and mark_book_done: { id } in samples
    app.openapi(routes.done, handle.done)
// tools.ts, before delete_book (toolsRun runs them in order, and its sample deletes the book)
  mcpTool({
    name: 'mark_book_done', title: 'Mark a book done', description: 'Sets a book’s status to done, when the user finished it.',
    input: z.object({ id }),
    annotations: { idempotentHint: true, openWorldHint: false },
    cli: { name: 'book done', examples: [{ run: 'book done <id>', about: 'Mark it done' }] },
    call: ({ id }) => ({ method: 'POST', path: `${PATH}/${encodeURIComponent(id)}/done` }),
    summarize: (row: Card) => `Done: ${line(row)}`,
  }),
```

## A resource inside another

Recipes on a shelf: `kit feature recipes --under shelves --fields "name:string"`, once `shelves` exists. Each recipe
has a `shelfId` (`"shelf_id" text not null references shelves(id) on delete cascade`, set from the path, never the
body); its list and making are `GET` and `POST /api/shelves/{shelf}/recipes`, a shelf that isn't there a 404 whose
`detail` names `GET /api/shelves`; one recipe stays at `/api/recipes/{id}`. `list_recipes` and `create_recipe` take
`shelf`, and `samples` and the tests make a shelf first, as the shelf's own samples do. Deleting a shelf deletes its
recipes (the test `deletes a shelf’s recipes with it`). A child made by kit 1.35.0 or earlier has no cascade, so deleting
a parent with children answers 500: a migration step never changes, so have the parent's `remove` delete the children
first (`db.delete(recipes).where(eq(recipes.shelfId, id))` before its own row).

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
