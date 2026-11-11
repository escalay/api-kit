# pagination

Cursor pages and sorting for lists of any size, so every list pages the same way: HAL with its items under
`_embedded.<name>`, `count` on the page, `total` only when it is cheap, and `_links.next` until there is no more.

Needs: `core`.

```ts
import { cursorQuery, decodeCursor, limitQuery, pageOf, pageSchema, sortQuery } from './kit/index.js'

request: { query: z.object({ limit: limitQuery({ fallback: 50 }), cursor: cursorQuery, ...sortQuery(['newest', 'name'], 'newest') }) },
responses: { 200: { content: { [HAL_JSON]: { schema: pageSchema('RecipePage', 'recipes', RecipeSchema, 'Recipes, newest first.') } }, description: 'Recipes.' } },

const after = decodeCursor(query.cursor, z.object({ id: z.string() }))           // 400 on a cursor it didn't make
const rows = await repo.after(after?.id ?? '', limit + 1)                         // one extra row says there is more
return c.json(pageOf({ origin, path: c.req.path, query, name: 'recipes', items: rows.slice(0, limit).map(card),
  next: rows.length > limit ? { id: rows[limit - 1]!.id } : null }), 200)
```

| Export | What |
|---|---|
| `limitQuery({ fallback, max })`, `cursorQuery`, `sortQuery(fields, fallback)` | the query parameters, described (`sortQuery` gives `sortBy` + `order`) |
| `pageOf({ origin, path, query, name, items, next, total })` | the page, with `_links.next` carrying the encoded cursor |
| `pageSchema(component, name, item, description)` | the page's OpenAPI schema |
| `encodeCursor` / `decodeCursor(cursor, schema)` | opaque cursors (base64url JSON), validated on the way in |

## Rules

- Cursors, not page numbers, when the data can change between calls: rows inserted mid-read never shift a page.
- An agent follows `_links.next.href` until it is absent; it never builds a cursor itself.
- Standard: `docs/STANDARD.md` §4.
