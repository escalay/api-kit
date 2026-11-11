# mcp

An MCP server over the routes: each tool is a thin call to a route, run in-process with the caller's own credentials,
so the API and MCP can't drift. It also serves resources, prompts, skills and the Server Card.

Needs: `core`, `@modelcontextprotocol/server`.

```ts
import { inProcess, mcpServerFactory, mcpTool, mountMcp } from './kit/mcp/index.js'

const getNote = mcpTool({
  name: 'get_note', title: 'One note', description: 'A note with its author, year and tags. Use after a search.',
  input: z.object({ slug: z.string().describe('From a search result.') }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  call: ({ slug }) => ({ path: `/api/notes/${encodeURIComponent(slug)}` }),
  summarize: (note) => `${note.title} (${note.year}) · ${note._links.self.href}`,
})
mountMcp(app, { factory: mcpServerFactory({ info, instructions, tools: [getNote], callApi: inProcess(app) }), allowedHostnames: [host, 'localhost'] })
```

| Export | What |
|---|---|
| `mcpTool`, `mcpResource` | a tool (route call + summary) and an attachable resource |
| `routeOf`, `ROUTE_META` | a tool's route (`GET /api/v1/recipes/{id}`), published in `tools/list` as `_meta["api-kit/route"]`; set `route` on a tool whose path is built in steps |
| `mcpServerFactory` | the server: info, instructions, tools, resources, prompts, skills; `toolsTtlMs` sets how long clients cache `tools/list` (default an hour) |
| `mountMcp` | `/mcp` (Streamable HTTP, MCP 2026-07-28 with a fallback for older clients) and the Server Card |
| `inProcess(app)` / `overHttp(origin, key)` | how tools reach the routes: in the same process, or over HTTP for a stdio entry |
| `callWaiting` | follows a 202 run until it finishes, so a slow route still answers the tool |

## Rules

- One tool per task-sized route, `snake_case` verbs, a description that says when to use it; arguments named like the
  route's parameters. The summary is what an agent reads first: a few lines per result with ids and links.
- Every tool runs in the app's tests: `toolsRun` (testing module). Standard: `docs/STANDARD.md` §11.
