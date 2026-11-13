# testing

Checks that keep an API agent-ready as it grows. Each returns a list of problems, `[]` when all is well, so a test is
one line and a failure says exactly what to fix.

Needs: `guide`.

```ts
import { guideGaps, guideRoutes, lintOpenApi, toolRoutes, toolsRun } from './kit/testing/index.js'

const doc = await (await app.request('/openapi.json', { headers })).json()
expect(lintOpenApi(doc)).toEqual([])
expect(guideRoutes(guideFiles(GUIDE_DIR), doc)).toEqual([])
expect(guideGaps(guideFiles(GUIDE_DIR), vars, { doc, tools: TOOLS })).toEqual([])
expect(toolRoutes(TOOLS, doc)).toEqual([])
expect(await toolsRun(TOOLS, app, { search_notes: { q: 'soup' }, get_note: { slug: 'fox' } }, { headers })).toEqual([])
```

| Check | Catches |
|---|---|
| `lintOpenApi` | an operation an agent can't find or understand: missing ids, summaries, descriptions, tags, examples, problem errors |
| `guideRoutes` | a `GET /api/…` the guide mentions that doesn't exist |
| `guideGaps` | a `{{placeholder}}` nothing fills (a typo like `{{api.endpoint}}`) |
| `toolRoutes` | a tool whose call names no documented route |
| `toolsRun` | a tool that names the right route and still fails when run: a mangled id, a wrong parameter, a summary showing `undefined` or throwing. A tool with no sample arguments fails it, so a new tool can't ship untested |
| `cliGaps` | a command the app's CLI can't offer well: a tool or resource without a `cli` name, a name taken twice or shadowing a job or a built-in, a plural noun, an argument without a description, a tool or job without an example, an example that names a flag the command lacks (`singular: [...]` adds nouns that end in s) |

`cliSnapshot({ app, version, tools, resources, jobs })` is every command as the CLI package carries it
(`sdk/cli/commands.json`): `scripts/openapi.ts` writes it as `JSON.stringify(snapshot, null, 2) + '\n'`, and
`sdk/test/cli.test.ts` compares the file byte for byte, so a changed tool fails until `pnpm sdk:types` runs.

```ts
const { tools, resources } = mountedMcp(app)
expect(cliGaps({ tools, resources, jobs })).toEqual([])
```

## Rules

- Name every tool's command (`cli` on `mcpTool`) when the tool is written; `cliGaps` runs in every app's tests.
- Run `toolsRun` over every tool in every app, with sample ids from the test's fixture data; tools run in order, so
  make what they need (a board) first and put deleting tools last.
- Give the app an injectable embedder and data paths (`createApp(env, { embedder })`) so tests need no network or reload.
