/**
 * The sharing tables, and the SQL that makes them (one migration step per change, never edited once shipped). Every
 * time is ISO 8601 text from `toISOString()`, so times compare as text. The step's SQL holds no comments: the step is
 * split on `;` outside quotes, so an apostrophe in a comment would break it. What each column means is here.
 */
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const SCOPES = ['read', 'write'] as const
export const LIFETIMES = ['7d', '30d', 'until_revoked'] as const
export const REQUEST_STATES = ['waiting', 'approved', 'refused'] as const
export const VIAS = ['invite', 'request', 'owner'] as const
export const ENDED_REASONS = ['revoked', 'replayed', 'client_revoked', 'expired', 'lapsed', 'replaced', 'removed', 'space_gone'] as const

export type Scope = (typeof SCOPES)[number]
export type Lifetime = (typeof LIFETIMES)[number]
export type EndedReason = (typeof ENDED_REASONS)[number]

/** A space's sharing settings; a space with no row has asking off. */
export const sharingSpaces = sqliteTable('sharing_spaces', {
  /** The app's id for the space (`spaces.byId`), never its name: a renamed space keeps its row. */
  spaceId: text('space_id').primaryKey(),
  /** 1 when the owner switched Ask to join on for this space. */
  askToJoin: integer('ask_to_join', { mode: 'boolean' }).notNull().default(false),
  /** Set when 10 asks in a row went unanswered: asking pauses until the owner switches it again. */
  askPausedAt: text('ask_paused_at'),
  /** Asks that lapsed or were refused unanswered since the last answered one, or the owner's switch. */
  unansweredAsks: integer('unanswered_asks').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
})

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

/** One ask to join a space, waiting on the owner. Joined is a member row with this `request_id`. */
export const sharingRequests = sqliteTable(
  'sharing_requests',
  {
    id: text('id').primaryKey(),
    spaceId: text('space_id').notNull(),
    /** SHA-256 of the kit's consent ticket: Continue completes only that one. */
    ticketHash: text('ticket_hash').notNull().unique(),
    /** HMAC of the asker's address under the address key: one waiting ask per address, the address never stored. */
    addressKey: text('address_key').notNull(),
    /** The name the asker gave. */
    name: text('name').notNull(),
    /** Six digits shown to the asker and beside the request; never typed. */
    shownCode: text('shown_code').notNull(),
    /** The client's name after the character rule: its own claim. */
    appName: text('app_name').notNull(),
    /** The return's host, or `this computer`. */
    returnsTo: text('returns_to').notNull(),
    state: text('state', { enum: REQUEST_STATES }).notNull(),
    /** What the owner approved; null until then. */
    scope: text('scope', { enum: SCOPES }),
    lifetime: text('lifetime', { enum: LIFETIMES }),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
    createdAt: text('created_at').notNull(),
    /** The held ticket's own expiry: lapsed once it passes. */
    expiresAt: text('expires_at').notNull(),
  },
  (table) => [index('sharing_requests_space').on(table.spaceId, table.state), index('sharing_requests_address').on(table.addressKey, table.state), index('sharing_requests_expires').on(table.expiresAt)],
)

/** One grant into one space: an app signed in once, by invite, by ask, or by the owner's approval. */
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
    /** Unique: the claim. */
    requestId: text('request_id').unique(),
    scope: text('scope', { enum: SCOPES }).notNull(),
    lifetime: text('lifetime', { enum: LIFETIMES }).notNull(),
    joinedAt: text('joined_at').notNull(),
    /** Null is until revoked. */
    expiresAt: text('expires_at'),
    /** Written by `accepts` at most once an hour. */
    lastSeenAt: text('last_seen_at').notNull(),
    /** When `accepts` first saw its token; null while pending, when a failed token exchange may still be undone. */
    firstUsedAt: text('first_used_at'),
    endedAt: text('ended_at'),
    endedReason: text('ended_reason', { enum: ENDED_REASONS }),
  },
  (table) => [index('sharing_members_space').on(table.spaceId), index('sharing_members_client').on(table.clientId), index('sharing_members_seen').on(table.lastSeenAt), index('sharing_members_ended').on(table.endedAt)],
)

/** The tables as SQL, one step per change, never edited once shipped. Step 1: four tables and ten indexes. */
export const SHARING_MIGRATIONS = [
  `create table if not exists sharing_spaces (space_id text primary key, ask_to_join integer not null default 0, ask_paused_at text, unanswered_asks integer not null default 0, updated_at text not null);
create table if not exists sharing_invites (id text primary key, space_id text not null, label text not null, invited_by text not null, made_by_client text, made_by_grant text, link_hash text not null unique, code_hash text not null unique, scope text not null, lifetime text not null, replaces_member_id text, created_at text not null, redeem_by text not null, revoked_at text);
create index if not exists sharing_invites_space on sharing_invites(space_id);
create index if not exists sharing_invites_redeem_by on sharing_invites(redeem_by);
create index if not exists sharing_invites_maker on sharing_invites(made_by_grant);
create table if not exists sharing_requests (id text primary key, space_id text not null, ticket_hash text not null unique, address_key text not null, name text not null, shown_code text not null, app_name text not null, returns_to text not null, state text not null, scope text, lifetime text, decided_by text, decided_at text, created_at text not null, expires_at text not null);
create index if not exists sharing_requests_space on sharing_requests(space_id, state);
create index if not exists sharing_requests_address on sharing_requests(address_key, state);
create index if not exists sharing_requests_expires on sharing_requests(expires_at);
create table if not exists sharing_members (id text primary key, grant_id text not null unique, client_id text not null, space_id text not null, label text not null, app_name text not null, returns_to text not null, via text not null, invite_id text unique, request_id text unique, scope text not null, lifetime text not null, joined_at text not null, expires_at text, last_seen_at text not null, first_used_at text, ended_at text, ended_reason text);
create index if not exists sharing_members_space on sharing_members(space_id);
create index if not exists sharing_members_client on sharing_members(client_id);
create index if not exists sharing_members_seen on sharing_members(last_seen_at);
create index if not exists sharing_members_ended on sharing_members(ended_at)`,
] as const
