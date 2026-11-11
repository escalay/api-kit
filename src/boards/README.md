# boards

The owner's own collections of the app's items for a project, with a note per item: the part of a read-only catalog
you can write. Routes, MCP tools, and the reference shape of a kit feature.

Needs: `db`, `mcp`.

```ts
import { boardTools, registerBoards } from './kit/boards/index.js'

await registerBoards(app, { db, item: RecipeCardSchema, refExample: 'recipe:soup', itemOf: (ref, origin) => cardOfRef(ref, origin), suggestions })
const tools = boardTools({ noun: 'recipes', label: (recipe) => recipe.title, suggestions: true })
```

Routes: `GET|POST /api/boards` (`?item=<ref>`: the boards holding it), `GET|PATCH|DELETE /api/boards/{id}`,
`PUT|DELETE /api/boards/{id}/items/{ref}` (idempotent), `GET /api/boards/{id}/suggestions`. Writes need `write`.

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
- An app whose boards also list other things (curated collections beside the owner's) keeps its own feature, in this shape.
- Standard: `docs/STANDARD.md` §17.
