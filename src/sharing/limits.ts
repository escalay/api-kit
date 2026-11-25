/**
 * The typed code's limits, always on: per address, per address at a space, and a ceiling per space, counted before the
 * lookup, so a guess costs the same whether or not it is right and whether or not the space exists; and per ticket,
 * counted on each wrong code, so the fifth ends that sign-in. Kept in the guard store (`dbGuardStore(db)` by default),
 * so every instance shares them.
 *
 * @example
 * const limits = codeLimitsOf(config.limits, config.keys)
 * const retry = await limits.retryAfter(c, 'soups')   // seconds to wait, or null
 * if (await limits.lastTry(ticket)) return oauth.complete(c, ticket, 'deny')
 */
import type { Context } from 'hono'
import { addressOf, type AddressTrust, type GuardStore } from '../core/guards.js'
import { addressKeyOf, ticketHashOf, type SharingKeys } from './secrets.js'

const MINUTE = 60 * 1000
/** Typed codes from one address: 10 a minute. */
const PER_ADDRESS = { limit: 10, windowMs: MINUTE }
/** Typed codes from one address at one space (or at no space, for a client that named none): 10 in 10 minutes. */
const PER_ADDRESS_AT_SPACE = { limit: 10, windowMs: 10 * MINUTE }
/** Typed codes at one space from every address: 600 in 10 minutes, the ceiling a spray from many addresses meets. */
const PER_SPACE = { limit: 600, windowMs: 10 * MINUTE }
/** Wrong codes one sign-in may type; the last ends it. */
const WRONG_CODES_PER_TICKET = 5
/** Longer than any ticket lives (a held one, a week at most), so a ticket's count never starts over. */
const TICKET_WINDOW_MS = 8 * 24 * 60 * MINUTE

/** Where the limits count, and how the caller's address is read (default: as the app reads it). */
export type SharingLimits = { store: GuardStore; address?: AddressTrust }

/**
 * The typed code's counters over a guard store: `retryAfter` before a lookup, `lastTry` on a wrong code.
 *
 * @example
 * const limits = codeLimitsOf({ store: await dbGuardStore(db) }, sharingKeys(env.SHARING_SECRET))
 */
export const codeLimitsOf = ({ store, address }: SharingLimits, keys: SharingKeys) => {
  /** Counts one call against a window; the seconds until it ends when past its limit, else null. */
  const overBy = async (id: string, { limit, windowMs }: { limit: number; windowMs: number }) => {
    const now = Date.now()
    const { start, used } = await store.count(id, windowMs, now)
    if (used <= limit) return null
    return Math.max(1, Math.ceil((start + windowMs - now) / 1000))
  }

  return {
    /**
     * Counts a typed code from this address (kept by its HMAC), then from it at this space (`any` for none), then at the
     * space; the seconds to wait at the first one spent, else null. A code refused by one never spends the next, so one
     * address spends only its own budget at a space; it takes codes from about 60 addresses to reach the ceiling.
     */
    retryAfter: async (c: Context, space: string) => {
      const from = `ip:${addressKeyOf(keys, addressOf(c, address))}`
      const fromHere = await overBy(`sharing-code ${from}`, PER_ADDRESS)
      if (fromHere) return fromHere
      const fromHereAtSpace = await overBy(`sharing-code ${from} space:${space}`, PER_ADDRESS_AT_SPACE)
      if (fromHereAtSpace) return fromHereAtSpace
      return overBy(`sharing-code space:${space}`, PER_SPACE)
    },
    /** Counts a wrong code on a ticket (kept by its hash); true when that was its last try. */
    lastTry: async (ticket: string) => {
      const { used } = await store.count(`sharing-code ticket:${ticketHashOf(ticket)}`, TICKET_WINDOW_MS, Date.now())
      return used >= WRONG_CODES_PER_TICKET
    },
  }
}

export type CodeLimits = ReturnType<typeof codeLimitsOf>
