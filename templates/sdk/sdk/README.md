# __package__

A typed client for __Title__. Point it at a deployment. It needs only `fetch`, so it runs in Node 20+, Cloudflare
Workers, Deno, Bun and browsers, and it has no dependencies.

```ts
import { create__Pascal__ } from '__package__'

const __camel__ = create__Pascal__({ baseUrl: 'https://api.example.com', apiKey: process.env.API_KEY })
```

## Errors

Every failure is a `__Pascal__Error` with `status`, a stable `code` (`not_found`, `conflict`, `bad_request`,
`unauthorized`, …, or `network` when the API could not be reached) and a `detail` that says what to change.

Creates and changes carry an `Idempotency-Key`, and a request whose connection fails is retried once.

## The `__bin__` command

The package's bin: every MCP tool of __Title__ as `__bin__ <noun> <verb>`, and the jobs in `cli/jobs/`. It talks to
the deployment's `/mcp` and needs Node 20.10 or later and nothing else.

```sh
npx __package__ auth login https://api.example.com    # a code to approve in a browser, on any device
npx __package__                                       # the jobs, then every noun and its verbs
npx __package__ help agents                           # the rules agents follow: stdout, --json, exit codes
```

`__PREFIX___URL` and `__PREFIX___API_KEY` sign in without a browser (CI, agents). `cli/engine/` is the kit's
(`kit cli --update` takes a newer one); `cli/bin.ts`, `cli/jobs/` and `cli/commands.json` (written by
`pnpm sdk:types`) are this app's.
