/**
 * Every feature of the app, one folder each (`kit feature <name>` makes one and lists it here):
 *   schema.ts    Drizzle tables + the SQL migration steps
 *   repo.ts      the only file with queries
 *   routes.ts    OpenAPI contracts (createRoute)
 *   handlers.ts  request → repo → HAL answer, errors as problems
 *   tools.ts     MCP tools over the routes
 *   index.ts     the feature: register, tools, sample tool arguments for the tests
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import type { Db } from '../kit/index.js'
import type { McpTool } from '../kit/mcp/index.js'
import type { FeatureKey } from './catalog.js'
import type { Flags } from './flags.js'
import { feature as switches } from './switches/index.js'
// kit:imports

export type Feature = {
  name: string
  /** Its key in `catalog.ts` when an owner can switch it off: every route it adds then answers 403 while off. */
  switch?: FeatureKey
  /** The OpenAPI tag its routes carry. */
  tag: { name: string; description: string }
  /** Its tables as SQL steps, in order (also written to `migrations/` for D1 by `pnpm migrations`). */
  migrations: readonly string[]
  /** Migrates its tables, then registers its routes. */
  register: (app: OpenAPIHono, context: { db: Db; flags: Flags }) => Promise<void>
  tools: McpTool[]
  /** Sample arguments for each of its tools (making what they need through the API), for `toolsRun`. */
  samples: (request: (path: string, init?: RequestInit) => Promise<Response>) => Promise<Record<string, Record<string, unknown>>>
}

export const FEATURES: Feature[] = [
  switches,
  // kit:features
]
