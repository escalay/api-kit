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

With `createAgentApi({ brand })` the card's `iconUrl` is the brand's 512 PNG (else its SVG); `brand` here overrides it.

## Rules

- Pick the 1–3 tools another agent would delegate to; the first skill answers a message that names none.
- A task belongs to the caller that sent it, and only it may get, list or cancel it. An OAuth agent is its client and
  grant (`agent:<client_id>/<grant>`, as the guards key it), never the name it registered, so two clients that call
  themselves the same are two owners. An API key is its key name.
- A slow route (202 and a run) leaves the task working and keeps the run's `Location` on the task: `GetTask` polls
  that run and never calls the tool again while it works. When the run is done, the answer is the run's
  `_links.result` when it has one (it must answer in the tool route's shape, which the skill summarizes), else the
  tool called once more for its cached answer, as the standard's 202 rule says. A route that keeps no cache (an
  order, a payment) links its result, or that repeat call starts the work again: a 202 is never taken for an answer,
  so the task then stays working on the new run. A task stored by 1.29.0 has no run kept: `GetTask` calls its tool
  again, as it did then.
- A task that ended stays ended: a `GetTask` in flight when `CancelTask` lands finds the task canceled when it saves,
  and answers it canceled. The check reads the store before writing (`KeyValueStore` has no conditional write), so on
  a database store two instances can still cross within one read and write.
- Spec source of truth: `a2aproject/A2A` `specification/a2a.proto` (JSON is camelCase, enums SCREAMING_CASE, header
  `A2A-Version: 1.0`).
