/** People, passkeys, sessions and challenges in the database: the only place they are queried. */
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { challenges, passkeys, people, sessions, teamDomains, type PasskeyRow, type PersonRow } from './schema.js'

const now = () => new Date().toISOString()

export const peopleRepo = (db: Db) => ({
  list: () => db.select().from(people).orderBy(asc(people.createdAt)),
  get: async (id: string) => (await db.select().from(people).where(eq(people.id, id)))[0],
  byEmail: async (email: string) => (await db.select().from(people).where(eq(people.email, email.toLowerCase())))[0],
  owners: async () => (await db.select({ id: people.id }).from(people).where(eq(people.role, 'owner'))).length,
  add: (row: PersonRow) => db.insert(people).values({ ...row, email: row.email.toLowerCase() }),
  setRole: (id: string, role: PersonRow['role']) => db.update(people).set({ role }).where(eq(people.id, id)),
  seen: (id: string) => db.update(people).set({ lastSeenAt: now() }).where(eq(people.id, id)),
  /** Removes a person with their passkeys and sessions. */
  remove: async (id: string) => {
    await db.delete(passkeys).where(eq(passkeys.personId, id))
    await db.delete(sessions).where(eq(sessions.personId, id))
    await db.delete(people).where(eq(people.id, id))
  },

  domains: () => db.select().from(teamDomains).orderBy(asc(teamDomains.domain)),
  hasDomain: async (domain: string) => (await db.select().from(teamDomains).where(eq(teamDomains.domain, domain)))[0] !== undefined,
  addDomain: (domain: string, createdBy: string) => db.insert(teamDomains).values({ domain, createdBy, createdAt: now() }).onConflictDoNothing(),
  removeDomain: (domain: string) => db.delete(teamDomains).where(eq(teamDomains.domain, domain)),

  passkeysOf: (personId: string) => db.select().from(passkeys).where(eq(passkeys.personId, personId)).orderBy(asc(passkeys.createdAt)),
  passkey: async (id: string) => (await db.select().from(passkeys).where(eq(passkeys.id, id)))[0],
  addPasskey: (row: PasskeyRow) => db.insert(passkeys).values(row),
  usedPasskey: (id: string, counter: number) => db.update(passkeys).set({ counter, lastUsedAt: now() }).where(eq(passkeys.id, id)),
  removePasskey: (id: string) => db.delete(passkeys).where(eq(passkeys.id, id)),
  removePasskeysOf: (personId: string) => db.delete(passkeys).where(eq(passkeys.personId, personId)),

  session: async (hash: string) =>
    (
      await db
        .select({ person: people, expiresAt: sessions.expiresAt })
        .from(sessions)
        .innerJoin(people, eq(people.id, sessions.personId))
        .where(eq(sessions.hash, hash))
    )[0],
  addSession: (hash: string, personId: string, expiresAt: string, userAgent: string | null) => db.insert(sessions).values({ hash, personId, expiresAt, userAgent, createdAt: now() }),
  removeSession: (hash: string) => db.delete(sessions).where(eq(sessions.hash, hash)),

  addChallenge: (row: typeof challenges.$inferInsert) => db.insert(challenges).values(row),
  /** Reads a challenge without using it up (an enrolment is checked at "options" and taken at "verify"). */
  peekChallenge: async (id: string, kind: (typeof challenges.$inferSelect)['kind']) => {
    const row = (await db.select().from(challenges).where(and(eq(challenges.id, id), eq(challenges.kind, kind))))[0]
    return row && row.expiresAt > now() ? row : undefined
  },
  /** Takes a challenge: it can be used once, and not after it expired. */
  takeChallenge: async (id: string, kind: (typeof challenges.$inferSelect)['kind']) => {
    const row = (await db.select().from(challenges).where(and(eq(challenges.id, id), eq(challenges.kind, kind))))[0]
    if (!row) return undefined
    await db.delete(challenges).where(eq(challenges.id, id))
    return row.expiresAt > now() ? row : undefined
  },
  /** Drops what expired: challenges, and sessions past their date. */
  sweep: async () => {
    await db.delete(challenges).where(lt(challenges.expiresAt, now()))
    await db.delete(sessions).where(lt(sessions.expiresAt, now()))
  },
  count: async () => Number((await db.select({ n: sql<number>`count(*)` }).from(people))[0]?.n ?? 0),
})

export type PeopleRepo = ReturnType<typeof peopleRepo>
