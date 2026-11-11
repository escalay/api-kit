# web

The front door: an app's own web pages served by the API. An optional public page at `/`, the browser app under
`/app` behind the sign-in, old addresses redirected, and hashed assets cached for good.

Needs: `core`, `@hono/node-server`.

```ts
import { frontDoorOpen, serveFrontDoor } from './kit/index.js'

const web = { dir: join(APP_DIR, 'web/dist'), private: true }
const app = createAgentApi({ …, auth: { …, open: frontDoorOpen(web) } })   // the pages' files carry no data
// … routes, guide, MCP …
serveFrontDoor(app, web)                                                    // last: it answers what nothing else did
```

## Rules

- Register it last. Vite's hashed `/assets/` are served unversioned (a `?v=` on them loads each module twice).
- In private mode `/` redirects to `/app` and nothing public names the service.
- Not to be confused with the browser modules (`browser/`), which go into the frontend.
