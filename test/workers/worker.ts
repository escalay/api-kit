/**
 * The test Worker: imports the whole kit at global scope and builds an app on the first request, the way an app's
 * worker.ts does. `wrangler dev` and the workers project both start it, so a Node-only import or a random value made at
 * global scope fails here.
 */
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as kit from '../../src/index.js'
import '../../src/mcp/index.js'
import '../../src/a2a/index.js'
import '../../src/boards/index.js'
import '../../src/vector-search/index.js'
import { probeTelemetry } from './probe-telemetry.js'

type Env = { DB: D1Database }

const build = async (env: Env) => {
  const db = await kit.openDb(drizzle(env.DB) as unknown as kit.Db)
  await kit.migrate(db, 'probe', ['create table probe (id integer primary key, note text)', "insert into probe (note) values ('one'); insert into probe (note) values ('two')"])
  const guards = await kit.dbGuardStore(db)
  const app = kit.createAgentApi({
    title: 'Kit on Workers',
    version: '1.0.0',
    description: 'The kit running in workerd.',
    tags: [{ name: 'Probe', description: 'The probe.' }, kit.PEOPLE_TAG, kit.SETUP_TAG, kit.TELEMETRY_TAG],
    auth: { realm: 'probe', keys: kit.parseApiKeys(undefined), open: ['/probe', '/probe/*', '/llms.txt', '/agents/*', '/api/telemetry', ...kit.PEOPLE_OPEN_PATHS, ...kit.SETUP_OPEN_PATHS], session: kit.sessionOf(db) },
    guards: { store: guards },
  })
  // Passkeys run through @simplewebauthn/server on workerd; the code is a test value, never a real secret
  await kit.registerPeople(app, { db, rpName: 'Probe' })
  await kit.registerSetup(app, { db, code: 'PROBE-CODE', steps: [], guards })
  // Reads DO_NOT_TRACK and TELEMETRY from the Worker's bindings
  await probeTelemetry().register(app, { db, isOwner: (c) => kit.isAdmin(c.get('caller' as never)) })
  // Workers can't read a folder: the guide comes from a module, as `kit guide` writes it
  kit.serveGuide(app, { files: { 'llms.txt': '# Probe\n\nServed from {{origin}}.\n\n{{api.endpoints}}\n', 'agents/notes.md': '# Notes\n' }, vars: () => ({}), full: ['llms.txt', 'agents/*'] })
  app.use('/probe', kit.snapshotEtag(() => 'v1'))
  app.get('/probe', async (c) => c.json({ rows: await db.all(sql`select count(*) as n from probe`) }))
  // Each call adds a row: a replayed Idempotency-Key must not add another, whichever isolate answers
  app.use('/probe/notes', kit.rateLimit({ policy: 'probe', limit: 3, windowSeconds: 60, store: guards }))
  app.post('/probe/notes', async (c) => {
    await db.run(sql`insert into probe (note) values (${await c.req.text()})`)
    const [row] = await db.all<{ n: number }>(sql`select count(*) as n from probe`)
    return c.json({ count: row!.n }, 201)
  })
  return app
}

let ready: ReturnType<typeof build> | undefined

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    (ready ??= build(env).catch((error) => { ready = undefined; throw error })).then((app) => app.fetch(request, env, ctx)),
} satisfies ExportedHandler<Env>
