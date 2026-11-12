/** The browser session: a random token in an HttpOnly cookie, only its SHA-256 in the database. Also who counts as an admin, and enrolments. */
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { hashApiKey, type Caller, type Role } from '../core/auth.js'
import type { Db } from '../db/index.js'
import { peopleRepo } from './repo.js'

export const SESSION_DAYS = 30
const DAY_MS = 86_400_000
const ENROLMENT_MINUTES = 15

const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
/** `__Host-` makes the browser refuse the cookie unless it is Secure, host-only and for `/`; plain http (local dev) can't carry it. */
const cookieName = (c: Context, base: string) => (new URL(c.req.url).protocol === 'https:' ? `__Host-${base}` : base)

/** Starts a session for a person and sets its cookie on the answer. */
export const startSession = async (c: Context, db: Db, personId: string, base = 'session') => {
  const token = randomToken()
  const expires = new Date(Date.now() + SESSION_DAYS * DAY_MS)
  await peopleRepo(db).addSession(hashApiKey(token), personId, expires.toISOString(), c.req.header('user-agent')?.slice(0, 200) ?? null)
  setCookie(c, cookieName(c, base), token, { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Lax', path: '/', expires })
}

/** Ends this browser's session and clears its cookie. */
export const endSession = async (c: Context, db: Db, base = 'session') => {
  const name = cookieName(c, base)
  const token = getCookie(c, name)
  if (token) await peopleRepo(db).removeSession(hashApiKey(token))
  deleteCookie(c, name, { path: '/', secure: name.startsWith('__Host-') })
}

/** The person this browser is signed in as, or null. */
export const personOf = async (c: Context, db: Db, base = 'session') => {
  const token = getCookie(c, cookieName(c, base))
  if (!token) return null
  const found = await peopleRepo(db).session(hashApiKey(token))
  return found && found.expiresAt > new Date().toISOString() ? found.person : null
}

/**
 * sessionOf is what `createAgentApi`'s auth takes as `session`: the request → its signed-in person, or null.
 *
 * @example
 * createAgentApi({ …, auth: { realm, keys, session: sessionOf(db), access: { team, audience, roleOf: roleOf(db) } } })
 */
export const sessionOf = (db: Db, base = 'session') => async (c: Context) => {
  const person = await personOf(c, db, base)
  return person ? { email: person.email, role: person.role } : null
}

/** roleOf is what Access takes as `roleOf`: an email Access proved → its role on the team, or null to refuse it. */
export const roleOf = (db: Db) => async (email: string): Promise<Role | null> => {
  const repo = peopleRepo(db)
  const person = await repo.byEmail(email)
  if (person) return person.role
  const domain = email.split('@')[1]
  return domain && (await repo.hasDomain(domain)) ? 'member' : null
}

/** isAdmin: the owner, or a key from the deployment's `API_KEYS`. Members, keys made through the API and agents are not. */
export const isAdmin = (caller: Caller | undefined, fixedKeys: string[] = []) =>
  (caller?.kind === 'person' && caller.role === 'owner') || (caller?.kind === 'key' && fixedKeys.includes(caller.name))

/** startEnrolment lets a person who is not signed in add their first passkey (after claiming or recovering a deployment); it returns the one-time enrolment. */
export const startEnrolment = async (db: Db, personId: string) => {
  const token = randomToken()
  await peopleRepo(db).addChallenge({ id: hashApiKey(token), kind: 'enrol', challenge: '', personId, expiresAt: new Date(Date.now() + ENROLMENT_MINUTES * 60_000).toISOString() })
  return token
}
