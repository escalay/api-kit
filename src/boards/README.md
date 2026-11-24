# boards

The owner's own collections of the app's items for a project, with a note per item: the part of a read-only catalog
you can write. Routes, MCP tools, and the reference shape of a kit feature.

Needs: `db`, `mcp`.

```ts
import { boardTools, registerBoards } from './kit/boards/index.js'

await registerBoards(app, { db, item: RecipeCardSchema, refExample: 'recipe:soup', itemOf: (ref, origin) => cardOfRef(ref, origin), suggestions })
const tools = boardTools({ noun: 'recipes', label: (recipe) => recipe.title, refExample: 'recipe:soup', suggestions: true })
```

Routes: `GET|POST /api/boards` (`?item=<ref>`: the boards holding it), `GET|PATCH|DELETE /api/boards/{id}`,
`PUT|DELETE /api/boards/{id}/items/{ref}` (idempotent), `GET /api/boards/{id}/suggestions`. Writes need `write`.

`boardTools` options: `noun` (what the items are called), `label` (an item's card → its line), `refExample` (the
app's own ref, as given to `registerBoards`: the tools' `ref` argument says `<type>:<id>, e.g. recipe:soup`, so an
agent sends a whole ref and not a bare id; left out, they name the shape alone), `suggestions`, `path`.

## The feature shape (copy it for your own features)

| File | What |
|---|---|
| `schema.ts` | the Drizzle tables and `BOARDS_MIGRATIONS` (step 1 = its tables) |
| `repo.ts` | `boardsRepo(db)`: the only queries, nothing about HTTP |
| `routes.ts` | `boardRoutes(config)`: the `createRoute` contracts and their schemas |
| `handlers.ts` | `boardHandlers(config, repo)`: request → repo → HAL; a missing board or item is a `ProblemError` |
| `tools.ts` | `boardTools`: the MCP tools over the routes |
| `refs.ts` | `boardRef(type, id)`, `parseBoardRef(ref)`, `BOARD_REF`: also copied with `boards-client` |
| `index.ts` | `registerBoards`: migrate, then wire routes to handlers |

## Rules

- A ref is `<type>:<id>`; the id may hold colons (`segment:episode:intro:2`). Build and read refs with
  `boardRef` / `parseBoardRef`, never by hand.
- **Boards are single-owner**: one set per deployment, and every caller with `read` (a key, an agent, a member) sees
  every board; every caller with `write` changes them. An app whose people each need their own boards keeps its own
  feature, in this shape, with an owner column.
- `PUT …/items/{ref}` adds the item or changes its note, idempotent also when two arrive together (the insert
  decides: one is 201, the other 200). Its note: left out (or blank) keeps the one it has, `null` clears it, text sets
  it. `save_to_board` and the browser client's `save(id, ref, note)` take the same three.
- An app whose boards also list other things (curated collections beside the owner's) keeps its own feature, in this shape.
- Standard: `docs/STANDARD.md` §17.
