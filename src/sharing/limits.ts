/**
 * The typed code's limits, always on: per address and per space, counted before the lookup, so a guess costs the same
 * whether or not it is right and whether or not the space exists; and per ticket, counted on each wrong code, so the
 * fifth ends that sign-in. Kept in the guard store (`dbGuardStore(db)` by default), so every instance shares them.
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
/** Typed codes at one space (or at no space, for a client that named none): 60 in 10 minutes. */
const PER_SPACE = { limit: 60, windowMs: 10 * MINUTE }
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
     * Counts a typed code from this address (kept by its HMAC), then at this space (`any` for none); the seconds to wait
     * when either is spent, else null. A code refused at its address never spends the space's budget, so one address
     * can't lock others out.
     */
    retryAfter: async (c: Context, space: string) => {
      const fromHere = await overBy(`sharing-code ip:${addressKeyOf(keys, addressOf(c, address))}`, PER_ADDRESS)
      if (fromHere) return fromHere
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
