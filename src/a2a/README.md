# a2a

A2A 1.0 over the MCP tools: an Agent Card at `/.well-known/agent-card.json` and a JSON-RPC endpoint at `/a2a` whose
skills are tools. Another agent sends a message naming a skill; a slow route leaves the task working and `GetTask`
asks again.

Needs: `mcp`.

```ts
import { mountA2A } from './kit/a2a/index.js'

mountA2A(app, {
  info: { name: 'Recipes', description: 'Finds recipes for a description.', version },
  skills: [{ tool: tools.find((t) => t.name === 'search_recipes')!, text: 'q', tags: ['recipes'], examples: ['a quick soup'] }],
  callApi: inProcess(app),
  store: oauthStore,        // any KeyValueStore; tasks are kept a day
  oauth: !!oauth,           // advertise the OAuth server beside keys
})
```

## Rules

- Pick the 1–3 tools another agent would delegate to; the first skill answers a message that names none.
- Spec source of truth: `a2aproject/A2A` `specification/a2a.proto` (JSON is camelCase, enums SCREAMING_CASE, header
  `A2A-Version: 1.0`).
