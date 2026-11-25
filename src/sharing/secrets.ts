/**
 * The part's secrets: an invite's link token and typed code, made here and kept only as HMACs; and four keys derived
 * from the app's sharing secret (HKDF-SHA256, one label each), so a key leaked from one use opens no other. Rotating
 * the secret voids open invites; members keep working.
 *
 * @example
 * const keys = sharingKeys(env.SHARING_SECRET)
 * const token = newLinkToken()                  // kept only as its HMAC: nothing serves an invite's link yet
 * const code = newInviteCode()                  // 'BDKM-QXTW', shown once
 * await repo.addInvite({ …, linkHash: linkHashOf(keys, token), codeHash: codeHashOf(keys, code) })
 */
import { createHash, createHmac, hkdfSync, randomBytes, randomInt } from 'node:crypto'

/** The letters of a typed code: no vowels (no words), none easily misread. 20 letters, 8 of them: about 34.6 bits. */
export const CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
const CODE_LENGTH = 8
/** The fewest bytes a sharing secret may hold. */
export const SECRET_BYTES = 32

export type SharingKeys = { link: Buffer; code: Buffer; cookie: Buffer; address: Buffer }

const derive = (secret: string, label: string) => Buffer.from(hkdfSync('sha256', secret, '', label, 32))

/** The part's four keys from the app's sharing secret; throws when it holds fewer than 32 bytes. */
export const sharingKeys = (secret: string): SharingKeys => {
  if (Buffer.byteLength(secret) < SECRET_BYTES) throw new Error(`sharing: the secret holds ${Buffer.byteLength(secret)} bytes; give it ${SECRET_BYTES} or more random bytes of its own, from the app's secret store (never the OAuth signing key)`)
  return { link: derive(secret, 'sharing-link'), code: derive(secret, 'sharing-code'), cookie: derive(secret, 'sharing-cookie'), address: derive(secret, 'sharing-address') }
}

const mac = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest('base64url')

/** An invite link's token: 192 random bits. */
export const newLinkToken = () => randomBytes(24).toString('base64url')

/** An invite's typed code, `XXXX-XXXX` from `CODE_ALPHABET`, each letter drawn without bias. */
export const newInviteCode = () => {
  const letters = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('')
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}

/** A typed code as it is compared: case, dashes and spaces don't matter. */
export const normalisedCode = (typed: string) => typed.toUpperCase().replace(/[^A-Z]/g, '')

/** What `sharing_invites.link_hash` holds for a token. */
export const linkHashOf = (keys: SharingKeys, token: string) => mac(keys.link, token)

/** What `sharing_invites.code_hash` holds for a typed code. */
export const codeHashOf = (keys: SharingKeys, typed: string) => mac(keys.code, normalisedCode(typed))

/** The key a typed code's limits count an address by: an HMAC, so the guard store never holds the address. */
export const addressKeyOf = (keys: SharingKeys, address: string) => mac(keys.address, address)

/** The key a typed code's limits count a consent ticket by: its SHA-256. */
export const ticketHashOf = (ticket: string) => createHash('sha256').update(ticket).digest('hex')
