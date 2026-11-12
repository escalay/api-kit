/**
 * People: the owner and the members of a deployment, how each signs in, and the team screen's routes. The owner
 * signs in with a passkey (made after claiming the deployment, `setup` part); members come through Cloudflare Access,
 * which proves their email, and this part decides whether that email is on the team. A signed-in browser holds a
 * random token in an HttpOnly cookie; only its SHA-256 is stored.
 *   GET    {sessionPath}                               who this browser is signed in as (never needs a key)
 *   DELETE {sessionPath}                               sign out
 *   POST   {sessionPath}/passkeys/register/options|verify   add a passkey (signed in, or with an enrolment from setup)
 *   POST   {sessionPath}/passkeys/login/options|verify      sign in with a passkey, for 30 days
 *   GET    {sessionPath}/passkeys · DELETE …/{id}           your passkeys
 *   GET    {teamPath} · POST · PATCH|DELETE …/people/{id} · DELETE …/domains/{domain}   the team (writes: owner only)
 *
 * @example
 * const fixedKeys = [...parseApiKeys(env.API_KEYS).values()]
 * const app = createAgentApi({ …, tags: [...tags, PEOPLE_TAG], auth: { realm, keys, open: [...PEOPLE_OPEN_PATHS], session: sessionOf(db), access: access && { ...access, roleOf: roleOf(db) } } })
 * await registerPeople(app, { db, rpName: 'Mailroom', fixedKeys })
 */
import type { OpenAPIHono } from '@hono/zod-openapi'
import { migrate, type Db } from '../db/index.js'
import { peopleHandlers } from './handlers.js'
import { peopleRepo } from './repo.js'
import { peopleRoutes } from './routes.js'
import { PEOPLE_MIGRATIONS } from './schema.js'

export { peopleRepo, type PeopleRepo } from './repo.js'
export { PersonSchema, peopleRoutes, type PeopleRoutes } from './routes.js'
export { challenges, passkeys, people, PEOPLE_MIGRATIONS, sessions, teamDomains, type PasskeyRow, type PersonRow } from './schema.js'
export { endSession, isAdmin, personOf, roleOf, SESSION_DAYS, sessionOf, startEnrolment, startSession } from './session.js'
export { teamTools } from './tools.js'

export const PEOPLE_TAG = { name: 'People', description: 'Signing in with a passkey, the browser session, and the team.' }

/** The routes that must stay open to anonymous callers: the session check and the passkey ceremonies (they check the cookie or an enrolment themselves). */
export const PEOPLE_OPEN_PATHS = ['/api/session', '/api/session/passkeys/register/*', '/api/session/passkeys/login/*']

export type PeopleOptions = {
  /** The app's database; the people tables are migrated into it. */
  db: Db
  /** The name a passkey prompt shows, e.g. "Mailroom". */
  rpName: string
  /** The names of the keys in `API_KEYS`: they may change the team like the owner. */
  fixedKeys?: string[]
  /** Default `/api/session` and `/api/team`; keep `PEOPLE_OPEN_PATHS` in step if you change the first. */
  sessionPath?: string
  teamPath?: string
  /** The cookie's name, prefixed `__Host-` on https. Default `session`. */
  cookie?: string
  tag?: string
}

/** Registers the people routes on the app, after migrating their tables. Call it after `createAgentApi`. */
export const registerPeople = async (app: OpenAPIHono, { db, rpName, fixedKeys = [], sessionPath = '/api/session', teamPath = '/api/team', cookie = 'session', tag = PEOPLE_TAG.name }: PeopleOptions) => {
  await migrate(db, 'people', PEOPLE_MIGRATIONS)
  const routes = peopleRoutes({ sessionPath, teamPath, tag })
  const handle = peopleHandlers(peopleRepo(db), { db, rpName, sessionPath, teamPath, cookie, fixedKeys })
  for (const name of Object.keys(routes) as (keyof typeof routes)[]) app.openapi(routes[name], handle[name] as never)
}
