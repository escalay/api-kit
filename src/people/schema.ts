/** The people of a deployment (an owner and members), their passkeys, their signed-in browser sessions, and the short-lived WebAuthn challenges between two calls. */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const people = sqliteTable('people', {
  id: text('id').primaryKey(),
  /** Lowercase. The owner's is given at claim; a member's is the one Cloudflare Access proves. */
  email: text('email').notNull().unique(),
  role: text('role', { enum: ['owner', 'member'] }).notNull(),
  name: text('name'),
  createdAt: text('created_at').notNull(),
  lastSeenAt: text('last_seen_at'),
})

/** Whole email domains whose people are members without being listed one by one. */
export const teamDomains = sqliteTable('team_domains', {
  domain: text('domain').primaryKey(),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').notNull(),
})

export const passkeys = sqliteTable('passkeys', {
  /** The credential id, base64url. */
  id: text('id').primaryKey(),
  personId: text('person_id').notNull(),
  /** The COSE public key, base64url (text keeps the table portable across SQLite engines). */
  publicKey: text('public_key').notNull(),
  counter: integer('counter').notNull(),
  transports: text('transports', { mode: 'json' }).$type<string[]>().notNull(),
  deviceType: text('device_type').notNull(),
  backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
  /** The host it was made on: a passkey works only there. */
  rpId: text('rp_id').notNull(),
  name: text('name'),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
})

export const sessions = sqliteTable('sessions', {
  /** The SHA-256 of the cookie's token: the token itself is never stored. */
  hash: text('hash').primaryKey(),
  personId: text('person_id').notNull(),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  userAgent: text('user_agent'),
})

/** A challenge waits here between "options" and "verify"; an enrolment lets someone not yet signed in add their first passkey. */
export const challenges = sqliteTable('webauthn_challenges', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['register', 'login', 'enrol'] }).notNull(),
  challenge: text('challenge').notNull(),
  personId: text('person_id'),
  expiresAt: text('expires_at').notNull(),
})

export const PEOPLE_MIGRATIONS = [
  'create table if not exists people (id text primary key, email text not null unique, role text not null, name text, created_at text not null, last_seen_at text)',
  'create table if not exists team_domains (domain text primary key, created_at text not null, created_by text not null)',
  'create table if not exists passkeys (id text primary key, person_id text not null, public_key text not null, counter integer not null, transports text not null, device_type text not null, backed_up integer not null, rp_id text not null, name text, created_at text not null, last_used_at text)',
  'create index if not exists passkeys_by_person on passkeys (person_id)',
  'create table if not exists sessions (hash text primary key, person_id text not null, created_at text not null, expires_at text not null, user_agent text)',
  'create table if not exists webauthn_challenges (id text primary key, kind text not null, challenge text not null, person_id text, expires_at text not null)',
] as const

export type PersonRow = typeof people.$inferSelect
export type PasskeyRow = typeof passkeys.$inferSelect
