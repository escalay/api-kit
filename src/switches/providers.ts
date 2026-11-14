/**
 * Where switches come from. A provider answers for some keys and stays silent on the rest; the switches part asks
 * each provider in order and takes the first answer. The shapes follow OpenFeature (a targeting key, a value and a
 * reason) without depending on it, so any flag service fits behind `fromSdk`.
 */
import type { Caller } from '../core/auth.js'

/**
 * Who a switch is resolved for. `targetingKey` names one caller (`person:ana@example.com`, `key:laptop`); empty means
 * everyone (work no caller started, such as incoming mail or a scheduled job).
 */
export type FlagContext = { targetingKey?: string; kind?: 'person' | 'key'; email?: string; key?: string; agent?: string }

/** Why a provider answered as it did, in OpenFeature's words. */
export type FlagReason = 'STATIC' | 'TARGETING_MATCH' | 'DEFAULT' | 'DISABLED' | 'ERROR' | 'CACHED' | 'SPLIT' | 'UNKNOWN'

/** A provider's answer for one key. `scope` is which stored switch decided it (`everyone`, `person:…`), and `by` and `at` who switched it and when, when it knows. */
export type FlagAnswer = { value: boolean; reason: FlagReason; scope?: string; by?: string; at?: string }

/** One stored switch, as a writable provider lists it. */
export type FlagOverride = { key: string; scope: string; on: boolean; changedBy: string; changedAt: string }

/** A change to one stored switch; `on: null` removes it, so the next less specific one decides. */
export type FlagChange = { key: string; scope: string; on: boolean | null; by: string }

export type ResolveOptions = {
  /** Skip any cache: for an action that leaves the app (a send, a delivery) right after a switch may have changed. */
  fresh?: boolean
  /** Each key's old names (`renamedFrom`), which a store may still hold. */
  oldNames?: Readonly<Record<string, readonly string[]>>
}

export type FlagProvider = {
  /** Its name in answers and errors, e.g. `database` or `posthog`. */
  name: string
  /** Answers for the keys it knows, in one call per request; a key left out is not this provider's to decide. */
  resolve: (keys: readonly string[], context: FlagContext, options?: ResolveOptions) => Promise<Record<string, FlagAnswer | undefined>>
  /** Present when the app may change switches here (the owner's `PATCH`). */
  write?: (change: FlagChange, options?: ResolveOptions) => Promise<void>
  /** The stored switches, for the list of features. */
  overrides?: (options?: ResolveOptions) => Promise<FlagOverride[]>
}

/** A scope a switch can be stored for: everyone, one person, or one API key. */
const SCOPE = /^(everyone|person:[^\s@]+@[^\s@]+|key:[\w.-]+)$/

/** isScope says whether a string is a scope a switch can be stored for: `everyone`, `person:<email>` or `key:<name>`. @example isScope('key:laptop') // true */
export const isScope = (scope: string) => SCOPE.test(scope)

/**
 * contextOf turns the authenticated caller into the context switches are resolved for: a person by email, an API key by
 * name, an OAuth agent as the person who approved it. No caller resolves for everyone.
 *
 * @example
 * contextOf(c.get('caller')) // { targetingKey: 'key:laptop', kind: 'key', key: 'laptop' }
 */
export const contextOf = (caller: Caller | undefined): FlagContext => {
  if (!caller) return {}
  if (caller.kind === 'key') return { targetingKey: `key:${caller.name}`, kind: 'key', key: caller.name }
  if (caller.kind === 'person') return { targetingKey: `person:${caller.email}`, kind: 'person', email: caller.email }
  return { targetingKey: `person:${caller.owner}`, kind: 'person', email: caller.owner, agent: caller.name }
}

/** contextOfScope is the context a stored scope applies to: `person:ana@example.com` → that person; `everyone` → nobody in particular. */
export const contextOfScope = (scope: string): FlagContext => {
  if (scope === 'everyone') return {}
  const [kind, ...rest] = scope.split(':')
  const name = rest.join(':')
  return kind === 'key' ? { targetingKey: scope, kind: 'key', key: name } : { targetingKey: scope, kind: 'person', email: name }
}

/**
 * memoryProvider answers the same fixed values for every caller: for tests, or switches set in code.
 *
 * @example
 * memoryProvider({ webhooks: false })
 */
export const memoryProvider = (values: Readonly<Record<string, boolean>>, name = 'memory'): FlagProvider => ({
  name,
  resolve: async (keys) => Object.fromEntries(keys.filter((key) => Object.hasOwn(values, key)).map((key) => [key, { value: values[key]!, reason: 'STATIC' as const }])),
})

type FlagValue = boolean | string | number | null | undefined
export type SdkOptions = {
  name: string
  /** The flag's name in the service for a feature key, e.g. `(key) => \`notes-${key}\``. The key itself unless given. */
  flagKeyOf?: (key: string) => string
  /** One flag for one caller, when the SDK has no call for all of them. */
  isOn?: (flagKey: string, context: FlagContext) => FlagValue | Promise<FlagValue>
  /** Every flag for one caller in one call (preferred: one request per caller, not one per key). */
  allFlags?: (context: FlagContext) => Record<string, FlagValue> | Promise<Record<string, FlagValue>>
  /** How long one caller's answers are kept, in ms. 5000 unless given. */
  cacheMs?: number
  /** How long the service may take before its answers are skipped for this call, in ms. 300 unless given. */
  timeoutMs?: number
}

const SDK_CACHE_LIMIT = 500

/** A flag service's value read as on or off: true, `"on"`, `"true"` or a variant other than `"off"`/`"control"` is on. */
const valueAsOn = (value: FlagValue): boolean | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return !['off', 'false', 'control', ''].includes(value.toLowerCase())
}

const within = <T>(ms: number, work: Promise<T>) =>
  Promise.race([work, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms))])

/**
 * fromSdk puts any flag service behind the provider shape: give it `allFlags` (preferred) or `isOn` from the vendor's
 * SDK. Answers are kept per caller for `cacheMs`; a service slower than `timeoutMs` or failing is skipped, so the next
 * provider or the catalog's default decides, and the app keeps running.
 *
 * @example
 * fromSdk({ name: 'posthog', allFlags: (context) => posthog.getAllFlags(context.targetingKey ?? 'everyone') })
 * fromSdk({ name: 'launchdarkly', isOn: (flag, context) => ld.variation(flag, { key: context.targetingKey ?? 'everyone' }, undefined) })
 */
export const fromSdk = ({ name, flagKeyOf = (key) => key, isOn, allFlags, cacheMs = 5000, timeoutMs = 300 }: SdkOptions): FlagProvider => {
  if (!isOn && !allFlags) throw new Error(`fromSdk "${name}" needs allFlags or isOn.`)
  const cache = new Map<string, { at: number; answers: Record<string, FlagAnswer | undefined> }>()
  const ask = async (keys: readonly string[], context: FlagContext) => {
    if (allFlags) {
      const flags = await allFlags(context)
      return Object.fromEntries(keys.map((key) => [key, valueAsOn(flags[flagKeyOf(key)])]))
    }
    return Object.fromEntries(await Promise.all(keys.map(async (key) => [key, valueAsOn(await isOn!(flagKeyOf(key), context))] as const)))
  }
  return {
    name,
    resolve: async (keys, context, { fresh } = {}) => {
      const who = context.targetingKey ?? 'everyone'
      const kept = cache.get(who)
      if (!fresh && kept && Date.now() - kept.at < cacheMs && keys.every((key) => Object.hasOwn(kept.answers, key))) return kept.answers
      try {
        const values = await within(timeoutMs, ask(keys, context))
        const answers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value === undefined ? undefined : { value, reason: 'TARGETING_MATCH' as const }]))
        if (cache.size >= SDK_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
        cache.set(who, { at: Date.now(), answers })
        return answers
      } catch (error) {
        console.warn(`flags: ${name} skipped: ${(error as Error).message}`)
        return {}
      }
    },
  }
}
