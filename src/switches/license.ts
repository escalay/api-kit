/**
 * License keys for paid features, checked offline: a key is a JWT signed with ES256 by the product's private key
 * (`kit license mint`), and the app holds only the public key. A catalog entry with `requires: 'enterprise'` is off
 * until a valid key grants `enterprise`; nothing calls home.
 *
 * Claims: `iss` the product, `sub` who it is for, `plan`, `grants` (what it unlocks; the plan counts as one), `exp`,
 * and `aud` when the key is bound to one deployment.
 */
import { importJWK, jwtVerify, type JWK } from 'jose'

/** What a deployment's license allows, as checked now. Never holds the key itself. */
export type LicenseState = {
  status: 'valid' | 'missing' | 'expired' | 'invalid'
  /** Why it is not valid, in a sentence; `Licensed to …` when it is. */
  why: string
  plan: string | null
  licensee: string | null
  expiresAt: string | null
  /** What it unlocks: its plan and its `grants`. Empty unless valid. */
  grants: string[]
}

export type LicenseOptions = {
  /** The key the deployment was given (a setting such as `LICENSE_KEY`); unset means no license. */
  key: string | undefined
  /** The product's public key (ES256), as JWK. Shipped in the app's code; the private key never is. */
  publicKey: JWK
  /** The product's name, the key's `iss`: a key for another product is refused. */
  product: string
  /** This deployment's id, for keys bound to one (`aud`); a key with no `aud` works anywhere. */
  instance?: string
  /** Where a license is bought or asked for, shown with every feature it would unlock. */
  upgrade?: string
}

const NO_LICENSE: Omit<LicenseState, 'status' | 'why'> = { plan: null, licensee: null, expiresAt: null, grants: [] }

/** A JWT's three base64url parts. */
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/

/**
 * verifyLicense checks one key against the product's public key and says what it allows. It never throws: a bad
 * key is `invalid` with the reason.
 *
 * @example
 * await verifyLicense({ key: env.LICENSE_KEY, publicKey: LICENSE_PUBLIC_KEY, product: 'notes' }) // { status: 'valid', plan: 'enterprise', grants: ['enterprise'], … }
 */
export const verifyLicense = async ({ key, publicKey, product, instance }: LicenseOptions, now = new Date()): Promise<LicenseState> => {
  const given = key?.trim()
  if (!given) return { status: 'missing', why: 'No license key is set.', ...NO_LICENSE }
  if (!JWT_SHAPE.test(given)) return { status: 'invalid', why: 'The license key is not a key: it should be three parts joined by dots.', ...NO_LICENSE }
  try {
    const { payload } = await jwtVerify(given, await importJWK(publicKey, 'ES256'), { issuer: product, algorithms: ['ES256'], currentDate: now, clockTolerance: 60 })
    const audience = [payload.aud ?? []].flat()
    if (audience.length && (!instance || !audience.includes(instance))) return { status: 'invalid', why: 'The license key is for another deployment.', ...NO_LICENSE }
    const plan = typeof payload.plan === 'string' ? payload.plan : null
    const grants = [...new Set([...(plan ? [plan] : []), ...(Array.isArray(payload.grants) ? payload.grants.filter((grant): grant is string => typeof grant === 'string') : [])])]
    const licensee = typeof payload.sub === 'string' ? payload.sub : null
    return { status: 'valid', why: `Licensed to ${licensee ?? 'this deployment'}${plan ? ` (${plan})` : ''}.`, plan, licensee, expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null, grants }
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ERR_JWT_EXPIRED') return { status: 'expired', why: 'The license key has expired.', ...NO_LICENSE }
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') return { status: 'invalid', why: `The license key is not for ${product}.`, ...NO_LICENSE }
    return { status: 'invalid', why: 'The license key is not signed by this product.', ...NO_LICENSE }
  }
}

const RECHECK_MS = 60 * 60_000

/**
 * licenseOf is a deployment's license for the switches part: checked on first use and again every hour (so a key
 * expires on time), `upgrade` where to get one.
 *
 * @example
 * switches({ catalog: CATALOG, providers, license: licenseOf({ key: env.LICENSE_KEY, publicKey: LICENSE_PUBLIC_KEY, product: 'notes', upgrade: 'https://example.com/pricing' }) })
 */
export const licenseOf = (options: LicenseOptions) => {
  let kept: { at: number; state: Promise<LicenseState> } | undefined
  const state = () => {
    if (!kept || Date.now() - kept.at >= RECHECK_MS) kept = { at: Date.now(), state: verifyLicense(options) }
    return kept.state
  }
  return { state, upgrade: options.upgrade }
}

export type License = ReturnType<typeof licenseOf>
