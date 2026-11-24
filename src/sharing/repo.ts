/**
 * Sharing in the database: the only place its tables are queried, and nothing about HTTP. Every statement that takes
 * an id from a route also takes the space (`and space_id = ?`), so an id from one space is never found at another.
 * Each once-only decision is one statement (`insert … select … where`, `update … where … returning`), with no
 * transaction, so it holds on node:sqlite, libSQL and D1 alike; a statement that loses a race answers "no row", never
 * throws. A limit is checked in the statement that writes past it (an invite past `MAX_OPEN_INVITES`), never by a
 * count read before. Times come in as `Date` and are kept as ISO text.
 *
 * @example
 * const repo = sharingRepo(db)
 * const member = await repo.claimInvite({ inviteId, spaceId, grantId, … }, new Date())   // its id, or null: spent, revoked, late
 */
import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm'
import { newId } from '../core/ids.js'
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { Db } from '../db/index.js'
import { sharingInvites, sharingMembers, sharingRequests, sharingSpaces, type EndedReason, type Lifetime, type Scope } from './schema.js'
import { MAX_OPEN_INVITES } from './states.js'

export type SpaceRow = typeof sharingSpaces.$inferSelect
export type InviteRow = typeof sharingInvites.$inferSelect
export type RequestRow = typeof sharingRequests.$inferSelect
export type MemberRow = typeof sharingMembers.$inferSelect
/** An invite or an ask with the member that redeemed it, if one did. */
export type InviteWithMember = InviteRow & { memberId: string | null }
export type RequestWithMember = RequestRow & { memberId: string | null }

export type NewInvite = Omit<InviteRow, 'id' | 'revokedAt'>
export type NewRequest = Omit<RequestRow, 'id' | 'state' | 'scope' | 'lifetime' | 'decidedBy' | 'decidedAt'>
/** A member as a claim writes it; `inviteId`, `requestId` and `via` come from the claim. */
export type NewMember = Omit<MemberRow, 'id' | 'via' | 'inviteId' | 'requestId' | 'endedAt' | 'endedReason'>
/** Where a list page starts: after this id (newest first), at most `limit` rows. */
export type PageAt = { after?: string; limit: number }

const iso = (at: Date) => at.toISOString()

/** A row's values in its table's column order: what `insert … select` writes. */
const valuesOf = <Row extends Record<string, unknown>>(table: SQLiteTable, row: Row): SQL => {
  const keys = Object.keys(getTableColumns(table)) as (keyof Row)[]
  return sql.join(keys.map((key) => sql`${row[key]}`), sql`, `)
}

const newMemberRow = (member: NewMember, claim: Pick<MemberRow, 'via' | 'inviteId' | 'requestId'>): MemberRow => ({ ...member, ...claim, id: newId('mem'), endedAt: null, endedReason: null })

const before = (id: SQLiteColumn, after?: string) => (after ? lt(id, after) : undefined)

export const sharingRepo = (db: Db) => {
  const inviteColumns = { ...getTableColumns(sharingInvites), memberId: sharingMembers.id }
  const requestColumns = { ...getTableColumns(sharingRequests), memberId: sharingMembers.id }
  const invitesWithMember = () => db.select(inviteColumns).from(sharingInvites).leftJoin(sharingMembers, eq(sharingMembers.inviteId, sharingInvites.id))
  const requestsWithMember = () => db.select(requestColumns).from(sharingRequests).leftJoin(sharingMembers, eq(sharingMembers.requestId, sharingRequests.id))
  const redeemed = sql`exists (select 1 from ${sharingMembers} where ${sharingMembers.inviteId} = ${sharingInvites.id})`
  const joined = sql`exists (select 1 from ${sharingMembers} where ${sharingMembers.requestId} = ${sharingRequests.id})`
  const unrevokedOpen = and(isNull(sharingInvites.revokedAt), sql`not ${redeemed}`)
  /** A space's invites that are open: not redeemed, not revoked, still in time. */
  const openAt = (spaceId: string, now: string) => and(eq(sharingInvites.spaceId, spaceId), unrevokedOpen, sql`${sharingInvites.redeemBy} > ${now}`)
  const grantsOf = (rows: { grantId: string }[]) => rows.map((row) => row.grantId)
  const endedColumns = { id: sharingMembers.id, grantId: sharingMembers.grantId, spaceId: sharingMembers.spaceId }
  const countWaiting = async (who: SQL, now: Date) => {
    const [row] = await db.select({ waiting: sql<number>`count(*)`.mapWith(Number) }).from(sharingRequests).where(and(who, eq(sharingRequests.state, 'waiting'), sql`${sharingRequests.expiresAt} > ${iso(now)}`))
    return row?.waiting ?? 0
  }

  return {
    // The space's settings

    /** A space's settings row, if the owner ever switched anything. */
    spaceAt: async (spaceId: string): Promise<SpaceRow | undefined> => (await db.select().from(sharingSpaces).where(eq(sharingSpaces.spaceId, spaceId)))[0],
    /** Switches Ask to join for a space; either way clears a pause and the unanswered count. */
    setAskToJoin: async (spaceId: string, on: boolean, now: Date) => {
      const settings = { askToJoin: on, askPausedAt: null, unansweredAsks: 0, updatedAt: iso(now) }
      await db.insert(sharingSpaces).values({ spaceId, ...settings }).onConflictDoUpdate({ target: sharingSpaces.spaceId, set: settings })
    },
    /** Counts an ask that lapsed or was refused unanswered; the tenth in a row pauses asking. */
    noteUnanswered: async (spaceId: string, pauseAt: number, now: Date) => {
      await db.update(sharingSpaces)
        .set({ unansweredAsks: sql`${sharingSpaces.unansweredAsks} + 1`, askPausedAt: sql`case when ${sharingSpaces.unansweredAsks} + 1 >= ${pauseAt} then coalesce(${sharingSpaces.askPausedAt}, ${iso(now)}) else ${sharingSpaces.askPausedAt} end`, updatedAt: iso(now) })
        .where(eq(sharingSpaces.spaceId, spaceId))
    },
    /** An ask the owner answered starts the unanswered count again. */
    noteAnswered: async (spaceId: string, now: Date) => {
      await db.update(sharingSpaces).set({ unansweredAsks: 0, updatedAt: iso(now) }).where(eq(sharingSpaces.spaceId, spaceId))
    },
    /** Drops a deleted space's settings. */
    forgetSpace: async (spaceId: string) => {
      await db.delete(sharingSpaces).where(eq(sharingSpaces.spaceId, spaceId))
    },

    // Invites

    /**
     * Adds an invite and returns its id, one statement: written only while its space holds fewer than
     * `MAX_OPEN_INVITES` open at the invite's `createdAt`. Null when the space is full, or when its link or code hash
     * is already taken (make new ones and retry); `countOpenInvites` tells the two apart.
     */
    addInvite: async (invite: NewInvite): Promise<string | null> => {
      const row: InviteRow = { ...invite, id: newId('inv'), revokedAt: null }
      const openNow = sql`(select count(*) from ${sharingInvites} where ${openAt(invite.spaceId, invite.createdAt)})`
      const [added] = await db.insert(sharingInvites)
        .select(sql`select ${valuesOf(sharingInvites, row)} where ${openNow} < ${MAX_OPEN_INVITES}`)
        .onConflictDoNothing()
        .returning({ id: sharingInvites.id })
      return added?.id ?? null
    },
    /** An invite of this space by its id. */
    inviteAt: async (spaceId: string, id: string): Promise<InviteWithMember | undefined> =>
      (await invitesWithMember().where(and(eq(sharingInvites.id, id), eq(sharingInvites.spaceId, spaceId))))[0],
    /** The invite a link's token names (by its HMAC); the link names its space. */
    inviteByLink: async (linkHash: string): Promise<InviteWithMember | undefined> => (await invitesWithMember().where(eq(sharingInvites.linkHash, linkHash)))[0],
    /** The invite a typed code names (by its HMAC), at this space. */
    inviteByCodeAt: async (spaceId: string, codeHash: string): Promise<InviteWithMember | undefined> =>
      (await invitesWithMember().where(and(eq(sharingInvites.codeHash, codeHash), eq(sharingInvites.spaceId, spaceId))))[0],
    /** The invite a typed code names at any space: only for a client that named no space, which the code then binds. */
    inviteByCodeAnywhere: async (codeHash: string): Promise<InviteWithMember | undefined> => (await invitesWithMember().where(eq(sharingInvites.codeHash, codeHash)))[0],
    /** A space's invites, newest first. */
    listInvites: (spaceId: string, page: PageAt): Promise<InviteWithMember[]> =>
      invitesWithMember().where(and(eq(sharingInvites.spaceId, spaceId), before(sharingInvites.id, page.after))).orderBy(desc(sharingInvites.id)).limit(page.limit),
    /** How many of a space's invites are open: not redeemed, not revoked, still in time. */
    countOpenInvites: async (spaceId: string, now: Date) => {
      const [row] = await db.select({ open: sql<number>`count(*)`.mapWith(Number) }).from(sharingInvites).where(openAt(spaceId, iso(now)))
      return row?.open ?? 0
    },
    /** Revokes an invite of this space that no one redeemed; false when it is not there, redeemed or revoked already. */
    revokeInvite: async (spaceId: string, id: string, now: Date) => {
      const revoked = await db.update(sharingInvites).set({ revokedAt: iso(now) }).where(and(eq(sharingInvites.id, id), eq(sharingInvites.spaceId, spaceId), unrevokedOpen)).returning({ id: sharingInvites.id })
      return revoked.length > 0
    },
    /** Invite again: revokes this space's unredeemed invites for the member, so only the newest works. */
    revokeInvitesReplacing: async (spaceId: string, memberId: string, now: Date) =>
      (await db.update(sharingInvites).set({ revokedAt: iso(now) }).where(and(eq(sharingInvites.replacesMemberId, memberId), eq(sharingInvites.spaceId, spaceId), unrevokedOpen)).returning({ id: sharingInvites.id })).length,
    /** Revokes the unredeemed invites an agent made under a grant that ended. */
    revokeInvitesMadeByGrant: async (grantId: string, now: Date) =>
      (await db.update(sharingInvites).set({ revokedAt: iso(now) }).where(and(eq(sharingInvites.madeByGrant, grantId), unrevokedOpen)).returning({ id: sharingInvites.id })).length,
    /** Revokes the unredeemed invites an agent made under a client that ended. */
    revokeInvitesMadeByClient: async (clientId: string, now: Date) =>
      (await db.update(sharingInvites).set({ revokedAt: iso(now) }).where(and(eq(sharingInvites.madeByClient, clientId), unrevokedOpen)).returning({ id: sharingInvites.id })).length,
    /** Revokes every unredeemed invite of a deleted space. */
    revokeInvitesOf: async (spaceId: string, now: Date) =>
      (await db.update(sharingInvites).set({ revokedAt: iso(now) }).where(and(eq(sharingInvites.spaceId, spaceId), unrevokedOpen)).returning({ id: sharingInvites.id })).length,

    // Asks to join

    /** Adds a waiting ask and returns its id; null when its ticket already has one. */
    addRequest: async (request: NewRequest): Promise<string | null> => {
      const [added] = await db.insert(sharingRequests).values({ ...request, id: newId('req'), state: 'waiting' }).onConflictDoNothing().returning({ id: sharingRequests.id })
      return added?.id ?? null
    },
    /** An ask of this space by its id. */
    requestAt: async (spaceId: string, id: string): Promise<RequestWithMember | undefined> =>
      (await requestsWithMember().where(and(eq(sharingRequests.id, id), eq(sharingRequests.spaceId, spaceId))))[0],
    /** The ask a ticket made (by its hash), at the ticket's space. */
    requestByTicket: async (spaceId: string, ticketHash: string): Promise<RequestWithMember | undefined> =>
      (await requestsWithMember().where(and(eq(sharingRequests.ticketHash, ticketHash), eq(sharingRequests.spaceId, spaceId))))[0],
    /** A space's asks, newest first. */
    listRequests: (spaceId: string, page: PageAt): Promise<RequestWithMember[]> =>
      requestsWithMember().where(and(eq(sharingRequests.spaceId, spaceId), before(sharingRequests.id, page.after))).orderBy(desc(sharingRequests.id)).limit(page.limit),
    /** How many asks wait at a space. */
    countWaitingAt: (spaceId: string, now: Date) => countWaiting(eq(sharingRequests.spaceId, spaceId), now),
    /** How many asks wait from one address (by its key), at any space. */
    countWaitingFrom: (addressKey: string, now: Date) => countWaiting(eq(sharingRequests.addressKey, addressKey), now),
    /** Approves a waiting ask of this space still in time; false otherwise. */
    approveRequest: async (spaceId: string, id: string, decision: { scope: Scope; lifetime: Lifetime; decidedBy: string }, now: Date) => {
      const approved = await db.update(sharingRequests)
        .set({ ...decision, state: 'approved', decidedAt: iso(now) })
        .where(and(eq(sharingRequests.id, id), eq(sharingRequests.spaceId, spaceId), eq(sharingRequests.state, 'waiting'), sql`${sharingRequests.expiresAt} > ${iso(now)}`))
        .returning({ id: sharingRequests.id })
      return approved.length > 0
    },
    /** Refuses an ask of this space, waiting or approved, still in time, no one joined by it; false otherwise. */
    refuseRequest: async (spaceId: string, id: string, decidedBy: string, now: Date) => {
      const refused = await db.update(sharingRequests)
        .set({ state: 'refused', decidedBy, decidedAt: iso(now) })
        .where(and(eq(sharingRequests.id, id), eq(sharingRequests.spaceId, spaceId), inArray(sharingRequests.state, ['waiting', 'approved']), sql`${sharingRequests.expiresAt} > ${iso(now)}`, sql`not ${joined}`))
        .returning({ id: sharingRequests.id })
      return refused.length > 0
    },
    /** Refuses every ask still waiting at a space: asking switched off, or the space deleted. */
    refuseWaitingAt: async (spaceId: string, decidedBy: string, now: Date) =>
      (await db.update(sharingRequests).set({ state: 'refused', decidedBy, decidedAt: iso(now) }).where(and(eq(sharingRequests.spaceId, spaceId), eq(sharingRequests.state, 'waiting'))).returning({ id: sharingRequests.id })).length,

    // Members

    /**
     * The invite claim, one statement: writes the member only when the invite is of the member's space, not revoked, in
     * time, and redeemed by no one. Its id, or null (the unique `invite_id` refuses a racing second claim the same way).
     */
    claimInvite: async (inviteId: string, member: NewMember, now: Date): Promise<string | null> => {
      const row = newMemberRow(member, { via: 'invite', inviteId, requestId: null })
      const [added] = await db.insert(sharingMembers)
        .select(sql`select ${valuesOf(sharingMembers, row)} from ${sharingInvites} where ${and(eq(sharingInvites.id, inviteId), eq(sharingInvites.spaceId, member.spaceId), sql`${sharingInvites.redeemBy} > ${iso(now)}`, unrevokedOpen)}`)
        .onConflictDoNothing()
        .returning({ id: sharingMembers.id })
      return added?.id ?? null
    },
    /** The ask claim, one statement: writes the member only when the ask, of the member's space, is approved, in time, and unused. */
    claimRequest: async (requestId: string, member: NewMember, now: Date): Promise<string | null> => {
      const row = newMemberRow(member, { via: 'request', inviteId: null, requestId })
      const [added] = await db.insert(sharingMembers)
        .select(sql`select ${valuesOf(sharingMembers, row)} from ${sharingRequests} where ${and(eq(sharingRequests.id, requestId), eq(sharingRequests.spaceId, member.spaceId), eq(sharingRequests.state, 'approved'), sql`${sharingRequests.expiresAt} > ${iso(now)}`, sql`not ${joined}`)}`)
        .onConflictDoNothing()
        .returning({ id: sharingMembers.id })
      return added?.id ?? null
    },
    /** A member the owner approved; its id, or null when its grant already has one. */
    addOwnerMember: async (member: NewMember): Promise<string | null> => {
      const [added] = await db.insert(sharingMembers).values(newMemberRow(member, { via: 'owner', inviteId: null, requestId: null })).onConflictDoNothing().returning({ id: sharingMembers.id })
      return added?.id ?? null
    },
    /** The member a grant made, at whatever space: what `accepts` and `onRevoke` start from. */
    memberByGrant: async (grantId: string): Promise<MemberRow | undefined> => (await db.select().from(sharingMembers).where(eq(sharingMembers.grantId, grantId)))[0],
    /** A member of this space by its id. */
    memberAt: async (spaceId: string, id: string): Promise<MemberRow | undefined> => (await db.select().from(sharingMembers).where(and(eq(sharingMembers.id, id), eq(sharingMembers.spaceId, spaceId))))[0],
    /** A space's members, newest first, without the removed and the replaced. */
    listMembers: (spaceId: string, page: PageAt): Promise<MemberRow[]> =>
      db.select().from(sharingMembers)
        .where(and(eq(sharingMembers.spaceId, spaceId), or(isNull(sharingMembers.endedReason), sql`${sharingMembers.endedReason} not in ('removed', 'replaced')`), before(sharingMembers.id, page.after)))
        .orderBy(desc(sharingMembers.id))
        .limit(page.limit),
    /** Notes a member's use, only when the last note is older than `staleBefore`: at most one write an hour. */
    noteSeen: async (grantId: string, staleBefore: Date, now: Date) => {
      await db.update(sharingMembers).set({ lastSeenAt: iso(now) }).where(and(eq(sharingMembers.grantId, grantId), lt(sharingMembers.lastSeenAt, iso(staleBefore))))
    },
    /** Ends a live member of this space; its grant, to revoke, or null when it was not live there. */
    endMember: async (spaceId: string, id: string, reason: EndedReason, now: Date): Promise<string | null> => {
      const [ended] = await db.update(sharingMembers).set({ endedAt: iso(now), endedReason: reason }).where(and(eq(sharingMembers.id, id), eq(sharingMembers.spaceId, spaceId), isNull(sharingMembers.endedAt))).returning({ grantId: sharingMembers.grantId })
      return ended?.grantId ?? null
    },
    /** Ends the live member a grant made; the row ended, or null when there was none live. */
    endMemberOfGrant: async (grantId: string, reason: EndedReason, now: Date) =>
      (await db.update(sharingMembers).set({ endedAt: iso(now), endedReason: reason }).where(and(eq(sharingMembers.grantId, grantId), isNull(sharingMembers.endedAt))).returning(endedColumns))[0] ?? null,
    /** Ends every live member a client made (its registration revoked); the rows ended. */
    endMembersOfClient: (clientId: string, now: Date) =>
      db.update(sharingMembers).set({ endedAt: iso(now), endedReason: 'client_revoked' }).where(and(eq(sharingMembers.clientId, clientId), isNull(sharingMembers.endedAt))).returning(endedColumns),
    /** Ends every live member of a deleted space; their grants, to revoke. */
    endMembersOf: async (spaceId: string, now: Date) =>
      grantsOf(await db.update(sharingMembers).set({ endedAt: iso(now), endedReason: 'space_gone' }).where(and(eq(sharingMembers.spaceId, spaceId), isNull(sharingMembers.endedAt))).returning({ grantId: sharingMembers.grantId })),
    /** Deletes the member a withdrawn grant wrote: it never became one, so its invite or ask is open again. */
    deleteMemberOfGrant: async (grantId: string) => {
      await db.delete(sharingMembers).where(eq(sharingMembers.grantId, grantId))
    },

    // Aging, for sweep

    /** Ends live members past their lifetime; the rows ended. */
    endExpiredMembers: (now: Date) =>
      db.update(sharingMembers).set({ endedAt: iso(now), endedReason: 'expired' }).where(and(isNull(sharingMembers.endedAt), isNotNull(sharingMembers.expiresAt), lte(sharingMembers.expiresAt, iso(now)))).returning(endedColumns),
    /** Ends live members unseen since `unseenSince`; the rows ended. */
    endLapsedMembers: (unseenSince: Date, now: Date) =>
      db.update(sharingMembers).set({ endedAt: iso(now), endedReason: 'lapsed' }).where(and(isNull(sharingMembers.endedAt), lte(sharingMembers.lastSeenAt, iso(unseenSince)))).returning(endedColumns),
    /** Deletes members that ended before `endedBefore`; how many. */
    deleteEndedMembers: async (endedBefore: Date) => (await db.delete(sharingMembers).where(lte(sharingMembers.endedAt, iso(endedBefore))).returning({ id: sharingMembers.id })).length,
    /** Deletes invites that stopped being open before `closedBefore` (revoked, or past `redeem_by`); how many. */
    deleteClosedInvites: async (closedBefore: Date) =>
      (await db.delete(sharingInvites).where(or(lte(sharingInvites.revokedAt, iso(closedBefore)), lte(sharingInvites.redeemBy, iso(closedBefore)))).returning({ id: sharingInvites.id })).length,
    /** Deletes asks refused or lapsed before `closedBefore`; how many. */
    deleteClosedRequests: async (closedBefore: Date) =>
      (await db.delete(sharingRequests).where(or(and(eq(sharingRequests.state, 'refused'), lte(sharingRequests.decidedAt, iso(closedBefore))), lte(sharingRequests.expiresAt, iso(closedBefore)))).returning({ id: sharingRequests.id })).length,
  }
}

export type SharingRepo = ReturnType<typeof sharingRepo>
