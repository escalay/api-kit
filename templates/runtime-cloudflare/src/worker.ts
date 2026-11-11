/**
 * __title__ on Cloudflare Workers: the D1 binding through Drizzle, then the same `createApp` as on Node. The app is built
 * on the first request of each isolate (Workers allow no I/O or random values at global scope) and kept for the next.
 */
import { drizzle } from 'drizzle-orm/d1'
import { createApp, type Env } from './app.js'
import { openDb, type Db } from './kit/index.js'

type Bindings = Env & { DB: D1Database }

let ready: ReturnType<typeof createApp> | undefined

export default {
  fetch: (request, env, ctx) =>
    (ready ??= openDb(drizzle(env.DB) as unknown as Db).then((db) => createApp({ db, env })).catch((error) => {
      ready = undefined
      throw error
    })).then((app) => app.fetch(request, env, ctx)),
} satisfies ExportedHandler<Bindings>
