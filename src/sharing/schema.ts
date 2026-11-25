/**
 * The sharing tables, and the SQL that makes them (one migration step per change, never edited once shipped). Every
 * time is ISO 8601 text from `toISOString()`, so times compare as text. The step's SQL holds no comments: the step is
 * split on `;` outside quotes, so an apostrophe in a comment would break it. What each column means is here.
 */
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const SCOPES = ['read', 'write'] as const
export const LIFETIMES = ['7d', '30d', 'until_revoked'] as const
export const VIAS = ['invite', 'owner'] as const
export const ENDED_REASONS = ['revoked', 'replayed', 'client_revoked', 'expired', 'lapsed', 'replaced', 'removed', 'space_gone'] as const

export type Scope = (typeof SCOPES)[number]
export type Lifetime = (typeof LIFETIMES)[number]
export type EndedReason = (typeof ENDED_REASONS)[number]

/** One invite to one space for one person: single use, redeemed by `redeem_by`. */
export const sharingInvites = sqliteTable(
  'sharing_invites',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    /** Who it is for ("Sam"), shown to the owner and on the member it makes. */
    label: text('label').notNull(),
    /** Who made it: the owner's email, a key's name, or `agent:<client>`. */
    invitedBy: text('invited_by').notNull(),
    /** Set when an agent made it: its open invites are revoked when that client ends. */
    madeByClient: text('made_by_client'),
    /** Set when an agent made it: its open invites are revoked when that grant ends. */
    madeByGrant: text('made_by_grant'),
    /** HMAC of the link's token under the link key; never the token. */
    linkHash: text('link_hash').notNull().unique(),
    /** HMAC of the normalised typed code under the code key; never the code. */
    codeHash: text('code_hash').notNull().unique(),
    scope: text('scope', { enum: SCOPES }).notNull(),
    lifetime: text('lifetime', { enum: LIFETIMES }).notNull(),
    /** Invite again: the member this invite replaces once it joins. */
    replacesMemberId: text('replaces_member_id'),
    createdAt: text('created_at').notNull(),
    /** Created + 24 hours. Redeemed is not a column: a member row with this `invite_id` exists. */
    redeemBy: text('redeem_by').notNull(),
    revokedAt: text('revoked_at'),
  },
  (table) => [index('sharing_invites_space').on(table.spaceId), index('sharing_invites_redeem_by').on(table.redeemBy), index('sharing_invites_maker').on(table.madeByGrant)],
)

/** One grant into one space: an app signed in once, by invite or by the owner's approval. */
export const sharingMembers = sqliteTable(
  'sharing_members',
  {
    /** What routes name. */
    id: text('id').primaryKey(),
    /** The kit's grant; never leaves the server. */
    grantId: text('grant_id').notNull().unique(),
    clientId: text('client_id').notNull(),
    spaceId: text('space_id').notNull(),
    label: text('label').notNull(),
    /** The client's name after the character rule: its own claim. */
    appName: text('app_name').notNull(),
    /** The return's host, or `this computer`. */
    returnsTo: text('returns_to').notNull(),
    via: text('via', { enum: VIAS }).notNull(),
    /** Unique: the claim. SQLite allows many NULLs under `unique`. */
    inviteId: text('invite_id').unique(),
    scope: text('scope', { enum: SCOPES }).notNull(),
    lifetime: text('lifetime', { enum: LIFETIMES }).notNull(),
    joinedAt: text('joined_at').notNull(),
    /** Null is until revoked. */
    expiresAt: text('expires_at'),
    /** Written by `accepts` at most once an hour. */
    lastSeenAt: text('last_seen_at').notNull(),
    endedAt: text('ended_at'),
    endedReason: text('ended_reason', { enum: ENDED_REASONS }),
  },
  (table) => [index('sharing_members_space').on(table.spaceId), index('sharing_members_client').on(table.clientId), index('sharing_members_seen').on(table.lastSeenAt), index('sharing_members_ended').on(table.endedAt)],
)

/** The tables as SQL, one step per change, never edited once shipped. Step 1: two tables and seven indexes. */
export const SHARING_MIGRATIONS = [
  `create table if not exists sharing_invites (id text primary key, space_id text not null, label text not null, invited_by text not null, made_by_client text, made_by_grant text, link_hash text not null unique, code_hash text not null unique, scope text not null, lifetime text not null, replaces_member_id text, created_at text not null, redeem_by text not null, revoked_at text);
create index if not exists sharing_invites_space on sharing_invites(space_id);
create index if not exists sharing_invites_redeem_by on sharing_invites(redeem_by);
create index if not exists sharing_invites_maker on sharing_invites(made_by_grant);
create table if not exists sharing_members (id text primary key, grant_id text not null unique, client_id text not null, space_id text not null, label text not null, app_name text not null, returns_to text not null, via text not null, invite_id text unique, scope text not null, lifetime text not null, joined_at text not null, expires_at text, last_seen_at text not null, ended_at text, ended_reason text);
create index if not exists sharing_members_space on sharing_members(space_id);
create index if not exists sharing_members_client on sharing_members(client_id);
create index if not exists sharing_members_seen on sharing_members(last_seen_at);
create index if not exists sharing_members_ended on sharing_members(ended_at)`,
] as const
