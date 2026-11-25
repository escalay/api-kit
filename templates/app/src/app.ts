/**
 * __title__: the kit's agent-ready API with this app's features on it. Each feature in `features/` brings its routes,
 * tables and MCP tools; this file only wires them: auth and OAuth, every feature, the agent guide, MCP.
 *
 * The same on every runtime: `server.ts` (Node) and `worker.ts` (Cloudflare Workers) each open the database and call it.
 *
 * @example
 * const app = await createApp({ db: await openDb('file:.state/state.sqlite'), env: process.env, address: 'socket' })
 */
import BRAND from '../brand/brand.js'
import { BRAND_ASSETS } from './brand.gen.js'
import { CATALOG } from './features/catalog.js'
import { flagsOf } from './features/flags.js'
import { FEATURES } from './features/index.js'
import { GUIDE_FILES } from './guide.gen.js'
import { accessOwner, createAgentApi, createBrand, createOAuth, dbGuardStore, dbOAuthStore, featureTools, parseApiKeys, serveGuide, type AddressTrust, type Db } from './kit/index.js'
import { guideSkills, inProcess, mcpServerFactory, mountMcp } from './kit/mcp/index.js'
// kit:imports (a part's imports, `kit add <part> --wire`; each marker below is where it writes)

export type Env = { API_KEYS?: string; OAUTH_SIGNING_KEY?: string; ACCESS_TEAM?: string; ACCESS_AUD?: string; PUBLIC_HOST?: string; FEATURES_OFF?: string }

/** The kit parts a feature calls, made here and handed to each (sharing's `forget` when a space goes): `{ sharing?: Sharing }` once added. */
export type Parts = Record<string, never>

// kit:module
export const VERSION = '0.1.0'
// A switchable feature's tools name their switch, so a 403 from one names a switch an agent can find
export const TOOLS = FEATURES.flatMap((feature) => (feature.switch ? featureTools(feature.tools, CATALOG, feature.switch) : feature.tools))

/** `address`: where an anonymous caller's address comes from, which only the runtime knows (server.ts, worker.ts). */
export const createApp = async ({ db, env, address }: { db: Db; env: Env; address?: AddressTrust }) => {
  const access = env.ACCESS_TEAM && env.ACCESS_AUD ? { team: env.ACCESS_TEAM, audience: env.ACCESS_AUD } : undefined
  // Who may approve a sign-in on the kit's pages: the person Access proved. With the people part (`kit add people`),
  // ask its session too, or a deploy signed in by passkey alone can never approve (its README's owner asks Access too):
  // async (c) => { const person = await personOf(c, db); return person?.role === 'owner' ? person.email : null }
  const owner = access ? accessOwner(access) : async () => null
  // kit:setup
  // A refresh sent twice within 30 seconds (two tabs, a retry) gets the same successor instead of ending the sign-in
  const oauth = env.OAUTH_SIGNING_KEY ? createOAuth({ name: '__title__', signingKey: env.OAUTH_SIGNING_KEY, store: await dbOAuthStore(db), owner, reuseGraceSeconds: 30 }) : undefined
  const app = createAgentApi({
    title: '__title__',
    version: VERSION,
    description: ['__title__.', '', '- **Auth:** `Authorization: Bearer <key>`, or an OAuth token the owner approves.', '- **Agent guide:** [/llms.txt](/llms.txt). **MCP:** `/mcp`.'].join('\n'),
    tags: FEATURES.map((feature) => feature.tag),
    auth: { realm: '__name__', keys: parseApiKeys(env.API_KEYS), access },
    oauth,
    // brand/ (`npx @escalay/kit brand` renders it): the favicon and icons, and the name MCP, the docs and the guide show
    brand: createBrand(BRAND, BRAND_ASSETS),
    // People who open the address land in the browser app (web/, under /app); agents asking for Markdown get the guide // preset:app
    home: 'app', // preset:app
    address,
    // In the database, so every instance (each Worker isolate) shares Idempotency-Key answers
    guards: { store: await dbGuardStore(db) },
  })
  // A switchable feature sees the app through its gate, so every route it adds answers 403 feature_disabled while off
  const flags = flagsOf(db, env)
  const parts: Parts = {}
  for (const feature of FEATURES) await feature.register(feature.switch ? flags.gated(app, feature.switch) : app, { db, flags, env, parts })
  // guide/ as a module (`pnpm guide` writes it), so it serves the same on Workers, which can't read a folder
  serveGuide(app, { files: GUIDE_FILES, vars: () => ({}), full: ['llms.txt', 'skills/*'] })
  // The product's own skills (guide/skills/), offered over MCP too: as skills, and each playbook as a prompt
  const { prompts, skills } = await guideSkills({ files: GUIDE_FILES })
  const factory = mcpServerFactory({ info: { name: '__name__', version: VERSION }, instructions: '__title__: read the guide at /llms.txt first.', tools: TOOLS, prompts, skills, callApi: inProcess(app) })
  mountMcp(app, { factory, allowedHostnames: [env.PUBLIC_HOST ?? 'localhost', 'localhost', '127.0.0.1'] })
  // kit:mounts
  return app
}
