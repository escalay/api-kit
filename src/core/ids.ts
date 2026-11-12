/** Ids that sort by the time they were made, so the newest of a list is the greatest id. */

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
let lastTick = 0

/** randomLetters returns letters and digits that are hard to misread (no 0, o, 1, l, i). */
export const randomLetters = (length: number) => Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) => ALPHABET[byte % ALPHABET.length]).join('')

/**
 * newId returns `<prefix>_<time><random>`, e.g. `adr_0mh2k1x9zabcdefghjk`. Two ids made in the same millisecond still
 * come out in the order they were made (a Worker's clock stands still during a request), by counting the time forward.
 */
export const newId = (prefix: string) => {
  lastTick = Math.max(Date.now(), lastTick + 1)
  return `${prefix}_${lastTick.toString(36).padStart(9, '0')}${randomLetters(10)}`
}
