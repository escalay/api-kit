# guide

The agent guide: `/llms.txt`, `/llms-full.txt`, `/agents/*.md` and `/skills/*` from Markdown templates, filled per
request. Everything the code knows (endpoints, tools, playbooks, how to get unstuck) is generated from the OpenAPI
document and the MCP tools, so the guide can't drift from the API.

Needs: `core`.

```ts
import { guideFiles, serveGuide } from './kit/index.js'

serveGuide(app, { dir: GUIDE_DIR, vars: () => ({ counts: { notes: store.notes.length } }), full: ['llms.txt', 'agents/*', 'skills/*'] })
serveGuide(app, { files: GUIDE_FILES, vars, full })   // Workers can't read a folder: `kit guide` writes src/guide.gen.ts
```

```md
# Notes
> {{counts.notes}} notes. Start with GET /api/search?q=…

## Endpoints
{{api.endpoints}}

## MCP tools ({{mcp.count}})
{{mcp.tools}}
```

| File | What |
|---|---|
| `guide.ts` | `serveGuide` (from `dir`, or `files` on Workers), `guideFiles(dir)`, `guideModuleSource(files)` (the text `kit guide` writes; an app's test compares its `guide.gen.ts` to it), `fillTemplate` |
| `reference.ts` | the generated parts: `{{api.endpoints}}`, `{{api.operations}}`, `{{api.unblock}}`, `{{mcp.tools}}`, `{{mcp.count}}`, `{{mcp.resources}}`, `{{skills.<name>.playbooks}}` |

## Rules

- Write only what the code can't know: concepts, trust and measured accuracy, real-id examples, playbook steps and
  judgement. Never hand-write a list of endpoints or tools.
- Layout: `guide/llms.txt`, `guide/agents/{concepts,endpoints,trust,mcp}.md`, `guide/skills/<name>/SKILL.md` +
  `references/*.md` (served as MCP prompts too).
- Test it: `guideRoutes` and `guideGaps` (the testing module) return `[]`. Standard: `docs/STANDARD.md` §10.
