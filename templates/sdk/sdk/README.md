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
