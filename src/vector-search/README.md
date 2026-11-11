# vector-search

Search by words, by picture and by likeness, as three routes and their MCP tools, on the vectors module's spaces.

Needs: `vectors`, `mcp`.

```ts
import { registerVectorSearch, vectorSearchTools } from './kit/vector-search/index.js'

registerVectorSearch(app, {
  path: '/api/search', similarPath: '/api/recipes/{slug}/similar', name: 'Recipe', noun: 'recipes', tag: 'Search', item: RecipeCardSchema,
  spaces: () => vectors, embedder: () => embedder, itemOf: (key, origin) => cardOf(key, origin), keyOf: (slug) => `recipe:${slug}`,
  filters: { shape: { decade: z.string().optional() }, keep: ({ decade }) => decade ? (key) => byKey.get(key)?.decade === decade : undefined },
})
const tools = vectorSearchTools({ path: '/api/search', similarPath: '/api/recipes/{slug}/similar', noun: 'recipes', label: (recipe) => recipe.title })
```

Routes: `GET {path}?q=&by=look|meaning|both` (words, one embedding), `POST {path}` (a picture: multipart or a JSON data
URL), `GET {similarPath}?by=` (likeness, free). Results are HAL, `_embedded.results[]` of `{ score, z, space, item }`;
rows below the bar come back as `_embedded.closest`.

## Rules

- Measure the bar on each catalog with real and nonsense queries (`minZ`, `minScore`) and write it in the guide's trust page.
- The similar route takes an item's id or its board ref (`recipe:soup`); it tries the id as given first, so ids that
  hold a colon (`episode:<slug>`) work.
- Standard: `docs/STANDARD.md` §15.
