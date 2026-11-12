/**
 * Setup: claiming a fresh deployment and the checklist of what the deploy could not do. The setup code is a secret
 * typed into the deploy form (`SETUP_CODE`); the first person to send it becomes the owner and gets an enrolment to
 * make their passkey (`people` part). Without a code nobody can claim (fails closed). Changing the secret later opens
 * recovery for the owner (a passkey works only on the host it was made on, and devices get lost). Each checklist step
 * is the app's own and is checked for real, every time.
 *   GET  {path}            claimed? code set? recovery open? (never needs a key)
 *   POST {path}/claim      { code, email } → { mode: claim|recover, enrolment }   (5 an hour per address, 20 a day)
 *   GET  {path}/checklist  every step, checked now (owner only)
 *
 * @example
 * await registerPeople(app, { db, rpName: 'Mailroom', fixedKeys })
 * await registerSetup(app, { db, code: env.SETUP_CODE, guards: await dbGuardStore(db), fixedKeys, steps: [
 *   { id: 'domain', title: 'Choose the mail domain', why: 'Addresses are made on it.', minutes: 1, check: async () => ({ ok: domains.length > 0, detail: … }) },
 * ] })
 */
import type { OpenAPIHono, RouteHandler } from '@hono/zod-openapi'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { hashApiKey, type Caller } from '../core/auth.js'
import type { GuardStore } from '../core/guards.js'
import { linksOf, originOf } from '../core/hal.js'
import { newId } from '../core/ids.js'
import { ProblemError } from '../core/problem.js'
import { migrate, type Db } from '../db/index.js'
import { isAdmin, peopleRepo, startEnrolment } from '../people/index.js'
import { setupRoutes, type SetupRoutes } from './routes.js'
import { SETUP_MIGRATIONS, setupState } from './schema.js'

export { setupRoutes, type SetupRoutes } from './routes.js'
export { SETUP_MIGRATIONS, setupState, type SetupStateRow } from './schema.js'

export const SETUP_TAG = { name: 'Setup', description: 'Claiming the deployment, recovering it, and the setup checklist.' }
/** The routes that must stay open to anonymous callers. */
export const SETUP_OPEN_PATHS = ['/api/setup', '/api/setup/claim']

/** One step of an app's setup. Its check runs for real on every look, and says what to do when it is not ok. */
export type SetupStep = {
  id: string
  title: string
  why: string
  minutes: number
  optional?: boolean
  check: (c: Context) => Promise<{ ok: boolean; detail: string; fixUrl?: string }>
}

export type SetupOptions = {
  db: Db
  /** The setup code from the environment (`env.SETUP_CODE`). Unset: claiming is refused. */
  code: string | undefined
  steps: SetupStep[]
  /** Where claim attempts are counted (`dbGuardStore(db)`: every instance shares it). */
  guards: GuardStore
  fixedKeys?: string[]
  path?: string
  tag?: string
}

const PER_ADDRESS = { limit: 5, windowMs: 3_600_000 }
const IN_ALL = { limit: 20, windowMs: 86_400_000 }
const CHECK_MS = 5000

/** Registers the setup routes, after migrating the setup table. Needs `registerPeople` first. */
export const registerSetup = async (app: OpenAPIHono, { db, code, steps, guards, fixedKeys = [], path = '/api/setup', tag = SETUP_TAG.name }: SetupOptions) => {
  await migrate(db, 'setup', SETUP_MIGRATIONS)
  const routes = setupRoutes({ path, tag })
  const people = peopleRepo(db)
  const stateOf = async () => (await db.select().from(setupState).where(eq(setupState.id, 1)))[0]
  const codeHash = code?.trim() ? hashApiKey(code.trim()) : undefined
  const links = (c: Context) => linksOf(originOf(c), { self: path, claim: `${path}/claim`, checklist: `${path}/checklist`, session: '/api/session' })

  const status: RouteHandler<SetupRoutes['status']> = async (c) => {
    const state = await stateOf()
    return c.json({ claimed: Boolean(state), codeSet: Boolean(codeHash), recovery: Boolean(state && codeHash && state.codeHash !== codeHash), _links: links(c) }, 200, { 'cache-control': 'no-store' })
  }

  const claim: RouteHandler<SetupRoutes['claim']> = async (c) => {
    const now = Date.now()
    const address = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'local'
    const mine = await guards.count(`setup-claim ip:${address}`, PER_ADDRESS.windowMs, now)
    const all = await guards.count('setup-claim all', IN_ALL.windowMs, now)
    if (mine.used > PER_ADDRESS.limit || all.used > IN_ALL.limit)
      throw new ProblemError('too_many_requests', { detail: 'Too many setup attempts: wait an hour (or a day, when many were tried) and check the code in the deploy settings.' })
    if (!codeHash) throw new ProblemError('unavailable', { detail: 'No setup code is set, so nobody can claim this deployment. Set the SETUP_CODE secret (`wrangler secret put SETUP_CODE`, or in the dashboard) and try again.' })
    const { code: given, email, name } = c.req.valid('json')
    if (hashApiKey(given.trim()) !== codeHash) throw new ProblemError('forbidden', { detail: 'That setup code is not right. It is the SETUP_CODE secret set when this was deployed.' })
    const state = await stateOf()
    const at = new Date().toISOString()
    if (!state) {
      const existing = await people.byEmail(email)
      const ownerId = existing?.id ?? newId('prs')
      if (existing) await people.setRole(existing.id, 'owner')
      else await people.add({ id: ownerId, email, role: 'owner', name: name ?? null, createdAt: at, lastSeenAt: null })
      await db.insert(setupState).values({ id: 1, claimedAt: at, ownerId, codeHash })
      return c.json({ mode: 'claim' as const, enrolment: await startEnrolment(db, ownerId), _links: links(c) }, 200, { 'cache-control': 'no-store' })
    }
    if (state.codeHash === codeHash) throw new ProblemError('conflict', { detail: 'This deployment is already claimed. To get back in without a passkey, change the SETUP_CODE secret and use the new code here.' })
    const owner = await people.byEmail(email)
    if (owner?.role !== 'owner') throw new ProblemError('forbidden', { detail: 'Recovery is for an owner: use the email the deployment was claimed with.' })
    // The rotated code works once: it becomes the code that last opened setup
    await db.update(setupState).set({ codeHash, recoveredAt: at }).where(eq(setupState.id, 1))
    return c.json({ mode: 'recover' as const, enrolment: await startEnrolment(db, owner.id), _links: links(c) }, 200, { 'cache-control': 'no-store' })
  }

  const checklist: RouteHandler<SetupRoutes['checklist']> = async (c) => {
    if (!isAdmin(c.get('caller' as never) as Caller | undefined, fixedKeys)) throw new ProblemError('forbidden', { detail: 'Only the owner (or a key from API_KEYS) can see the setup checklist.' })
    const results = await Promise.all(
      steps.map(async ({ check, optional = false, ...step }) => {
        const found = await Promise.race([
          check(c).catch((error: Error) => ({ ok: false, detail: `The check failed: ${error.message}` })),
          new Promise<{ ok: boolean; detail: string }>((resolve) => setTimeout(() => resolve({ ok: false, detail: 'The check took too long.' }), CHECK_MS)),
        ])
        return { ...step, optional, ok: found.ok, detail: found.detail, fixUrl: ('fixUrl' in found ? found.fixUrl : undefined) ?? null }
      }),
    )
    return c.json({ done: results.filter((step) => step.ok).length, total: results.length, _embedded: { steps: results }, _links: links(c) }, 200, { 'cache-control': 'no-store' })
  }

  app.openapi(routes.status, status)
  app.openapi(routes.claim, claim)
  app.openapi(routes.checklist, checklist)
}
