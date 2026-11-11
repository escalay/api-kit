/**
 * __title__: the kit's agent-ready API with this app's features on it. Each feature in `features/` brings its routes,
 * tables and MCP tools; this file only wires them: auth and OAuth, every feature, the agent guide, MCP.
 *
 * The same on every runtime: `server.ts` (Node) and `worker.ts` (Cloudflare Workers) each open the database and call it.
 *
 * @example
 * const app = await createApp({ db: await openDb('file:.state/state.sqlite'), env: process.env })
 */
import { FEATURES } from './features/index.js'
import { GUIDE_FILES } from './guide.gen.js'
import { accessOwner, createAgentApi, createOAuth, dbGuardStore, dbOAuthStore, parseApiKeys, serveGuide, type Db } from './kit/index.js'
import { inProcess, mcpServerFactory, mountMcp } from './kit/mcp/index.js'

export type Env = { API_KEYS?: string; OAUTH_SIGNING_KEY?: string; ACCESS_TEAM?: string; ACCESS_AUD?: string; PUBLIC_HOST?: string }

export const VERSION = '0.1.0'
export const TOOLS = FEATURES.flatMap((feature) => feature.tools)

export const createApp = async ({ db, env }: { db: Db; env: Env }) => {
  const access = env.ACCESS_TEAM && env.ACCESS_AUD ? { team: env.ACCESS_TEAM, audience: env.ACCESS_AUD } : undefined
  const oauth = env.OAUTH_SIGNING_KEY ? createOAuth({ name: '__title__', signingKey: env.OAUTH_SIGNING_KEY, store: await dbOAuthStore(db), owner: access ? accessOwner(access) : async () => null }) : undefined
  const app = createAgentApi({
    title: '__title__',
    version: VERSION,
    description: ['__title__.', '', '- **Auth:** `Authorization: Bearer <key>`, or an OAuth token the owner approves.', '- **Agent guide:** [/llms.txt](/llms.txt). **MCP:** `/mcp`.'].join('\n'),
    tags: FEATURES.map((feature) => feature.tag),
    auth: { realm: '__name__', keys: parseApiKeys(env.API_KEYS), access },
    oauth,
    // In the database, so every instance (each Worker isolate) shares Idempotency-Key answers
    guards: { store: await dbGuardStore(db) },
  })
  for (const feature of FEATURES) await feature.register(app, { db })
  // guide/ as a module (`pnpm guide` writes it), so it serves the same on Workers, which can't read a folder
  serveGuide(app, { files: GUIDE_FILES, vars: () => ({}), full: ['llms.txt'] })
  const factory = mcpServerFactory({ info: { name: '__name__', title: '__title__', version: VERSION }, instructions: '__title__: read the guide at /llms.txt first.', tools: TOOLS, callApi: inProcess(app) })
  mountMcp(app, { factory, allowedHostnames: [env.PUBLIC_HOST ?? 'localhost', 'localhost', '127.0.0.1'] })
  return app
}
