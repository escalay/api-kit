# __title__

An agent-ready HTTP API built on [api-kit](https://github.com/escalay/api-kit): documented OpenAPI at `/docs`, an MCP
server at `/mcp`, and a guide for agents at `/llms.txt`.

<!-- deploy-button --> <!-- runtime:workers -->
`npx @escalay/kit button --write` puts the Deploy to Cloudflare button here once the repository is on GitHub. <!-- runtime:workers -->
<!-- /deploy-button --> <!-- runtime:workers -->

## Start

```bash
pnpm install && pnpm format && pnpm test && pnpm dev
```

On Workers, `pnpm migrations` writes `migrations/` first, and again after a feature gains a migration step. <!-- runtime:workers -->

`AGENTS.md` has the commands, the layout and how changes ship.
