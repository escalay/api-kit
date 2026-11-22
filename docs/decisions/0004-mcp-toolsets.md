# 0004 MCP toolsets: a client loads the tools its job needs

Status: accepted, 22 November 2026.

## Context

Every tool a server lists sits in the model's context for the whole session: its name, its description and its input
schema. The first large app on the kit serves 122 tools, about 173 KB on the wire, of which about 119 KB (some 30,000
tokens) is what a model reads; its flows alone are 28 tools and about 40 KB, while the tools most agents use, signing up
with an address, waiting for mail, reading it and replying, are about 23 tools and 28 KB. `mcpServerFactory` registered
every tool for every request, so an agent that only signs up paid for the flow editor in every turn.

The SDK (`@modelcontextprotocol/server` 2.4) builds a server per request and hands the factory the request
(`requestInfo`); `tools/list` has no paging, and `tools/call` refuses a tool that isn't registered.

## Decisions

1. **Toolsets are chosen by a query on the same endpoint**: `/mcp?tools=core,flows` (comma-separated, or `tools`
   repeated; names lowercased). A path per set (`/mcp/flows`) was rejected: the auth relay, the OAuth protected-resource
   metadata (matched by path), the Server Card, `recordMounted` and the allowed hosts all key on one path, and each
   would need a copy per set.

2. **A plain `/mcp` lists every tool**, as does `?tools=all`. The app's CLI reads the live `tools/list` and surface
   checks compare it with the code, so the default can't shrink. Agents are taught the smaller sets instead: by the
   server's instructions, the Server Card, the guide (`{{mcp.toolsets}}`) and the docs.

3. **A tool belongs to the sets in its `toolset`, `core` when it names none.** `core` means what most agents need,
   and untagged tools land there because that is where a tool goes until someone decides it is specialised: moving
   tools out of `core` is the act of designing sets. A tool may be in several sets (`['core', 'flows']`), so a tool two
   jobs need is never missing from either. `inToolset(name, tools)` puts a feature's tools in a set and leaves a tool
   that names its own alone. `all` is a selector, never a set; names are lowercase, a letter first, at most 32
   characters, and the factory throws on anything else.

4. **Unknown set names are ignored and named in the instructions; with none left the connection lists every tool.**
   A JSON-RPC error was the other choice. It stops the connection outright, and hosted clients tend to show a failed
   connection without its message, so the agent never sees which names exist. It also turns a renamed set into an
   outage for every client still asking for the old name. Ignoring a name keeps the connection working, and the
   instructions start with `Unknown toolsets ignored: …` and then list the sets that exist.

5. **A tool outside the selection can't be called on that connection.** The SDK answers such a call with a bare
   protocol error (`-32602 Tool x not found`), which names neither the set nor the fix. `mountMcp` answers it before
   the SDK, as a failed call like any other (`isError`, a `404 not_found` problem in `_meta["api-kit/problem"]`) whose
   detail names the tool's set and the URL that adds it. A name no set has keeps the SDK's answer.

6. **One tools array per selection, so one hash per selection.** The factory keeps a map from the sorted names of
   existing sets to the filtered array; a query string never becomes a key, so the map is bounded by the sets the app
   has. `toolsHashOf` stays a `WeakMap` per array, so `tools/list` and every call carry the hash of their own
   selection, and the plain list keeps the very array it was given, and with it its hash. `toolset` is part of the
   hashed listing only when a tool sets it.

7. **A server whose tools are all in `core` is unchanged**: the same instructions, the same `_meta` on each tool, no
   `_meta` on the Server Card, the same hash. The query is ignored there.

8. **Measured, not guessed.** `toolsetSizes(tools)` counts the bytes of each tool's name, description and input schema
   (as JSON, the way a model reads them; about 4 bytes a token), per tool and per set. The instructions and the
   guide round the same numbers; an app holds `core` under its budget in a test, and `kit mcp size` prints the table
   from the app's own copy of the kit (loading `TOOLS` from `src/app.ts`, as `doctor` loads the app for `cliGaps`).
   On the first app it gives the 122 tools as 119.5 KB.

## Consequences

- `McpTool` gains an optional `toolset`; `AgentMcpFactory` gains `select(url)` and `toolsets()`. Apps that set
  nothing behave exactly as before.
- Designing sets is part of building tools: the kit's `api-kit-feature` skill carries the reference
  (`references/toolsets.md`), and `api-kit-review` checks the budget.
- Resources and prompts are not split: they cost nothing until read.
- OAuth clients that compare the server URL with the protected resource by path accept the query; a client that
  compares the whole URL would not, and is checked by hand when an app first adopts sets.
