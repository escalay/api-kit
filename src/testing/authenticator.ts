/**
 * A passkey authenticator in software, for tests: it answers WebAuthn registration and sign-in options the way a
 * phone or a security key would (ES256, attestation "none", user present and verified), so passkey flows run in CI
 * with no browser. Never use it outside tests: its keys live in memory.
 *
 * @example
 * const device = await softAuthenticator()
 * const options = await (await post('/api/session/passkeys/register/options', { enrolment })).json()
 * await post('/api/session/passkeys/register/verify', { enrolment, response: await device.register(options, origin) })
 * const login = await (await post('/api/session/passkeys/login/options', {})).json()
 * await post('/api/session/passkeys/login/verify', { challengeId: login.challengeId, response: await device.login(login.options, origin) })
 */

type Bytes = Uint8Array<ArrayBuffer>
type Cbor = number | string | Bytes | Cbor[] | Map<number | string, Cbor> | { [key: string]: Cbor }

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (text: string): Bytes => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
const concat = (...parts: Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let at = 0
  for (const part of parts) out.set(part, (at += part.length) - part.length)
  return out
}
const sha256 = async (bytes: Uint8Array): Promise<Bytes> => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Bytes))
const utf8 = (text: string): Bytes => new TextEncoder().encode(text) as Bytes

/** The smallest CBOR encoder WebAuthn needs: unsigned and negative integers, byte and text strings, arrays, maps. */
const cbor = (value: Cbor): Bytes => {
  const head = (major: number, length: number): Bytes =>
    length < 24 ? Uint8Array.of((major << 5) | length) : length < 256 ? Uint8Array.of((major << 5) | 24, length) : Uint8Array.of((major << 5) | 25, length >> 8, length & 255)
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value)
  if (typeof value === 'string') return concat(head(3, utf8(value).length), utf8(value))
  if (value instanceof Uint8Array) return concat(head(2, value.length), value)
  if (Array.isArray(value)) return concat(head(4, value.length), ...value.map(cbor))
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value)
  return concat(head(5, entries.length), ...entries.flatMap(([key, item]) => [cbor(key), cbor(item)]))
}

/** WebCrypto signs ECDSA as raw r‖s; WebAuthn wants it as an ASN.1 DER sequence. */
const derOf = (raw: Uint8Array): Bytes => {
  const int = (bytes: Uint8Array) => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    const trimmed = bytes.slice(start)
    const body = trimmed[0]! & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed
    return concat(Uint8Array.of(0x02, body.length), body)
  }
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)))
  return concat(Uint8Array.of(0x30, body.length), body)
}

type CreationOptions = { challenge: string; rp: { id?: string; name: string }; user: { id: string } }
type RequestOptions = { challenge: string; rpId?: string }

export const softAuthenticator = async () => {
  const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const credentialId = crypto.getRandomValues(new Uint8Array(16))
  let counter = 0
  let userHandle: string | undefined
  const rpOf = (rpId: string | undefined, origin: string) => rpId ?? new URL(origin).hostname
  const clientData = (type: string, challenge: string, origin: string) => utf8(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  // Flags: user present (0x01), user verified (0x04); 0x40 when attested credential data follows
  const authData = async (rpId: string, flags: number, extra: Uint8Array = new Uint8Array()) =>
    concat(await sha256(utf8(rpId)), Uint8Array.of(flags), Uint8Array.of((counter >>> 24) & 255, (counter >>> 16) & 255, (counter >>> 8) & 255, counter & 255), extra)

  return {
    credentialId: b64url(credentialId),

    /** The response a browser hands back from `navigator.credentials.create(options)`. */
    register: async (options: CreationOptions, origin: string) => {
      userHandle = options.user.id
      const coseKey = new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64url(jwk.x!)],
        [-3, fromB64url(jwk.y!)],
      ])
      const attested = concat(new Uint8Array(16), Uint8Array.of(0, credentialId.length), credentialId, cbor(coseKey))
      const data = await authData(rpOf(options.rp.id, origin), 0x01 | 0x04 | 0x40, attested)
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key' as const,
        response: {
          clientDataJSON: b64url(clientData('webauthn.create', options.challenge, origin)),
          attestationObject: b64url(cbor({ fmt: 'none', attStmt: {}, authData: data })),
          transports: ['internal'],
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      }
    },

    /** The response a browser hands back from `navigator.credentials.get(options)`. */
    login: async (options: RequestOptions, origin: string) => {
      counter++
      const data = await authData(rpOf(options.rpId, origin), 0x01 | 0x04)
      const client = clientData('webauthn.get', options.challenge, origin)
      const signed = concat(data, await sha256(client))
      const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signed))
      return {
        id: b64url(credentialId),
        rawId: b64url(credentialId),
        type: 'public-key' as const,
        response: {
          clientDataJSON: b64url(client),
          authenticatorData: b64url(data),
          signature: b64url(derOf(signature)),
          ...(userHandle ? { userHandle } : {}),
        },
        clientExtensionResults: {},
        authenticatorAttachment: 'platform' as const,
      }
    },
  }
}
