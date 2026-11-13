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
| `cli` on a tool or resource, `cliOf`, `CLI_META` | its command on the app's CLI, noun then verb (`cli: { name: 'note view', examples: [{ run: 'note view n_1', about: 'One note' }] }`), published with its positional arguments (the route's path parameters) as `_meta["api-kit/cli"]` |
| `PROBLEM_META`, `PENDING_META` | a failed call carries its problem (with `status`) in `_meta["api-kit/problem"]`; one still working names its run in `_meta["api-kit/pending"]` |
| `mountedMcp(app)` | the tools and resources `mountMcp` serves, for `cliGaps` and `cliSnapshot` |
| `guideSkills({ files, fill })` | the guide's skill folders as the factory's `skills` and `prompts` (one prompt per playbook); `fill` renders a file first when a skill uses placeholders |
| `mcpServerFactory` | the server: info, instructions, tools, resources, prompts, skills; `toolsTtlMs` sets how long clients cache `tools/list` (default an hour) |
| `mountMcp` | `/mcp` (Streamable HTTP, MCP 2026-07-28 with a fallback for older clients) and the Server Card |
| `inProcess(app)` / `overHttp(origin, key)` | how tools reach the routes: in the same process, or over HTTP for a stdio entry |
| `callWaiting` | follows a 202 run until it finishes, so a slow route still answers the tool |

## Rules

- One tool per task-sized route, `snake_case` verbs, a description that says when to use it; arguments named like the
  route's parameters. The summary is what an agent reads first: a few lines per result with ids and links.
- Every tool names its command (`cli`) with an example: `cliGaps` (testing module). Read-only is the default only for a
  `GET`; a destructive tool says `destructiveHint: true`.
- A resource template's query variables (`{?format}`) may be left out of a URI.
- Every tool runs in the app's tests: `toolsRun` (testing module). Standard: `docs/STANDARD.md` §11 and §19.
