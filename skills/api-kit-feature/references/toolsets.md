# Designing MCP toolsets

Every tool a connection lists costs context for the whole session: its name, its description and its input schema,
about 4 bytes a token. Toolsets let an agent load only what its job needs: `/mcp?tools=core,flows`. A plain `/mcp`
still lists everything. The rules are in `src/kit/mcp/README.md` and the standard (§11, Toolsets); this page is how to
choose the sets.

## When to split

- Measure first: `npx @escalay/kit mcp size` in the app (or `toolsetSizes(TOOLS)` in a test).
- Under about 25 tools and 30 KB: leave every tool in `core`. One set is the right answer for a small API.
- Over it: split. Start by deciding what stays in `core`, then move the rest out.

## What goes in `core`

`core` is the job most agents come for, end to end, and nothing else. For a mail API: make an address, wait for mail,
read it, reply, follow its link, and `who_am_i`. Test it against the product's main playbook: an agent with only
`core` finishes that playbook without reconnecting.

Budget: about **30 KB and 20 to 25 tools**. Over budget, cut the heaviest descriptions first
(`kit mcp size --set core` lists them heaviest first) before moving a tool out.

## The other sets

- **One set per kind of work**, the way a playbook or a role sees it: `flows` (building automations), `delivery`
  (webhooks and destinations), `drafts`, `admin` (team, keys, models, settings). Group by job, never by feature
  folder or route prefix: a feature's tools usually share a set, but a set may span features.
- **Short lowercase nouns**, stable once published: a renamed set drops silently from clients still asking for the
  old name (the instructions say so, but the agent loses those tools).
- **A tool two jobs need is in both** (`toolset: ['core', 'flows']`). Never make an agent connect with a set only for
  one lookup tool.
- Four to six sets. More than that and agents ask for `all` anyway.

## How to tag

```ts
// A feature's tools: one line in the feature's tools.ts or where TOOLS is built
export const flowTools = inToolset('flows', [listFlows, createFlow, …])
// One tool in several sets, or kept in core while its feature moves out
mcpTool({ name: 'who_am_i', toolset: 'core', … })
inToolset('admin', keyTools().map((tool) => (tool.name === 'who_am_i' ? { ...tool, toolset: 'core' } : tool)))
```

## Keep each tool light

- The description says when to use it and what comes back, in two or three sentences. Long how-tos belong in the
  product's skill (`guide/skills/`), which costs nothing until read.
- Describe each argument once and briefly; an enum says more than a paragraph.
- Reuse zod schemas between tools so the same field reads the same everywhere; a big nested input (a whole flow
  definition) is the heaviest thing a tool can carry: accept it as one described object, not every field spelled out.

## Hold the budget

```ts
it('keeps core lean', () => {
  const core = toolsetSizes(TOOLS).sets.find((set) => set.name === 'core')!
  expect(core.bytes).toBeLessThan(30_000)
  expect(core.tools.length).toBeLessThanOrEqual(25)
})
```

Then teach agents to connect small: the product's skill and `llms.txt` name the URL with `?tools=core` and which set
each playbook needs (`{{mcp.toolsets}}` lists them with sizes). Done when the main playbook runs on `core` alone and
the test above passes.
