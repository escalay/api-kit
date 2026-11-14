/**
 * The browser side of `switches`, without a framework: the features as the API says they are for the person signed
 * in, kept fresh (on focus, after any switch, after any 403 `feature_disabled` the app's own calls meet), and the
 * owner's switch. React apps use `switches-react.tsx`; the store works anywhere `fetch` does.
 *
 * @example
 * const features = createFeaturesClient<FeatureKey>()
 * features.subscribe(() => render(features.getState()))
 * if (features.isOn('digest')) showDigestTab()
 * const api = features.watchFetch(fetch) // every call through it that meets feature_disabled refreshes the list
 */

/** One feature as `GET /api/features` gives it. */
export type FeatureView<Key extends string = string> = {
  key: Key
  title: string
  description: string
  /** Whether it works for the caller: its own switch, and every feature it needs. */
  on: boolean
  own: boolean
  source: string
  reason: string
  scope?: string
  changedBy?: string
  changedAt?: string
  blockedBy: Key[]
  default: boolean
  locked: boolean
  needs: Key[]
  alsoOff: Key[]
  /** What a license must grant for it to work at all; absent for a free feature. */
  requires?: string
  /** Whether the deployment's license grants it; absent for a free feature. */
  licensed?: boolean
  overrides: { scope: string; on: boolean; changedBy: string; changedAt: string }[]
}

export type FeatureChange<Key extends string = string> = { key: Key; on: boolean; was: boolean }
export type FeatureSwitched<Key extends string = string> = { dryRun: boolean; key: Key; scope: string; on: boolean | null; changes: FeatureChange<Key>[]; feature: FeatureView<Key> }

/** The 403 an API answers for a switched-off feature, as its problem+json says it. */
export type FeatureDisabledProblem = { code: 'feature_disabled'; status: 403; detail: string; feature: string; blockedBy: string[]; switchOn: string; reason?: string; scope?: string; changedBy?: string; changedAt?: string; locked?: boolean }

/** isFeatureDisabled says whether a parsed problem (or a thrown error carrying one) is a switched-off feature's 403. @example isFeatureDisabled(await response.json()) */
export const isFeatureDisabled = (value: unknown): value is FeatureDisabledProblem =>
  typeof value === 'object' && value !== null && (value as { code?: unknown }).code === 'feature_disabled' && typeof (value as { feature?: unknown }).feature === 'string'

/** A failed call to the switch routes, as the API's problem described it. */
export class FeaturesError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, detail: string) {
    super(detail)
    this.status = status
    this.code = code
  }
}

/** The deployment's license, as the list says it (never the key). */
export type LicenseView = { status: 'valid' | 'missing' | 'expired' | 'invalid'; why: string; plan: string | null; licensee: string | null; expiresAt: string | null; grants: string[]; upgrade: string | null }

export type FeaturesState<Key extends string = string> = {
  status: 'loading' | 'ready' | 'error'
  features: Partial<Record<Key, FeatureView<Key>>>
  /** Null when the app sells no features. */
  license: LicenseView | null
  /** The last refresh's error, kept beside the last good list. */
  error: FeaturesError | null
}

export type FeaturesClientOptions = {
  /** Where the switch routes live. `/api/features` unless given. */
  path?: string
  /** The fetch that carries the page's own sign-in. The window's unless given. */
  fetch?: typeof fetch
  /** Refresh when the page comes back into view. On unless false. */
  refreshOnFocus?: boolean
}

const FOCUS_EVENTS = ['focus', 'visibilitychange'] as const

/**
 * createFeaturesClient is the features for the person signed in, as a small store: `getState` and `subscribe` (for
 * any framework), `isOn`, `refresh`, `switch` (owner only; `dryRun` says what would change), `onDisabled` (hear every
 * feature_disabled 403 the app meets, for an alert or an upgrade prompt) and `watchFetch`.
 *
 * @example
 * const features = createFeaturesClient<'digest' | 'sending'>({ path: '/api/features' })
 * await features.refresh()
 * features.isOn('digest') // true
 */
export const createFeaturesClient = <Key extends string = string>({ path = '/api/features', fetch: send = (...args) => globalThis.fetch(...args), refreshOnFocus = true }: FeaturesClientOptions = {}) => {
  let state: FeaturesState<Key> = { status: 'loading', features: {}, license: null, error: null }
  const listeners = new Set<() => void>()
  const disabledListeners = new Set<(problem: FeatureDisabledProblem) => void>()
  const set = (next: Partial<FeaturesState<Key>>) => {
    state = { ...state, ...next }
    for (const listener of listeners) listener()
  }

  const call = async <T>(url: string, init?: RequestInit): Promise<T> => {
    const response = await send(url, { ...init, headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
    const body = (await response.json().catch(() => ({}))) as T & { code?: string; detail?: string; title?: string }
    if (!response.ok) throw new FeaturesError(response.status, body.code ?? 'unknown', body.detail ?? body.title ?? `HTTP ${response.status}`)
    return body
  }

  let inFlight: Promise<void> | undefined
  /** Reads the list again; calls made while one is under way share it. */
  const refresh = () =>
    (inFlight ??= call<{ license?: LicenseView | null; _embedded: { features: FeatureView<Key>[] } }>(path)
      .then((list) => set({ status: 'ready', error: null, license: list.license ?? null, features: Object.fromEntries(list._embedded.features.map((feature) => [feature.key, feature])) as FeaturesState<Key>['features'] }))
      .catch((error: unknown) => set({ status: state.status === 'ready' ? 'ready' : 'error', error: error instanceof FeaturesError ? error : new FeaturesError(0, 'network', String(error)) }))
      .finally(() => (inFlight = undefined)))

  /** Hands a feature_disabled problem to every `onDisabled` listener, and refreshes the list it contradicts. */
  const noticeProblem = (problem: unknown) => {
    if (!isFeatureDisabled(problem)) return false
    for (const listener of disabledListeners) listener(problem)
    void refresh()
    return true
  }

  const onFocus = () => {
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refresh()
  }
  const target = refreshOnFocus && typeof window !== 'undefined' ? window : undefined
  for (const name of FOCUS_EVENTS) target?.addEventListener(name, onFocus)

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    refresh,
    /** Whether a feature works for the caller; undefined until the list arrived or for a key it does not hold. */
    isOn: (key: Key): boolean | undefined => state.features[key]?.on,
    /**
     * Switches a feature for a scope (owner only): `on: null` removes that scope's switch. With `dryRun` nothing
     * changes and the answer lists what would; otherwise the list is read again after.
     */
    switch: async (key: Key, change: { on: boolean | null; scope?: string }, { dryRun = false }: { dryRun?: boolean } = {}) => {
      const answer = await call<FeatureSwitched<Key>>(`${path}/${encodeURIComponent(key)}${dryRun ? '?dryRun=true' : ''}`, { method: 'PATCH', body: JSON.stringify(change) })
      if (!dryRun) await refresh()
      return answer
    },
    /** Hears every feature_disabled 403 noticed by `noticeProblem` or `watchFetch`. */
    onDisabled: (listener: (problem: FeatureDisabledProblem) => void) => {
      disabledListeners.add(listener)
      return () => void disabledListeners.delete(listener)
    },
    noticeProblem,
    /** A fetch that behaves like the one given, and notices any feature_disabled 403 passing through it. */
    watchFetch:
      (inner: typeof fetch): typeof fetch =>
      async (...args) => {
        const response = await inner(...args)
        if (response.status === 403) void response.clone().json().then(noticeProblem, () => false)
        return response
      },
    dispose: () => {
      for (const name of FOCUS_EVENTS) target?.removeEventListener(name, onFocus)
      listeners.clear()
      disabledListeners.clear()
    },
  }
}

export type FeaturesClient<Key extends string = string> = ReturnType<typeof createFeaturesClient<Key>>

/**
 * whyOff says, in a sentence, why a feature is off for the caller, from the list alone; empty when it is on.
 *
 * @example
 * whyOff(features.relay, features) // 'Relay needs Sending, which is off for everyone.'
 */
export const whyOff = <Key extends string>(feature: FeatureView<Key> | undefined, features: Partial<Record<Key, FeatureView<Key>>> = {}): string => {
  if (!feature || feature.on) return ''
  const cause = feature.blockedBy.length ? features[feature.blockedBy[0]!] : feature
  const offBy = (view: FeatureView<Key> | undefined) => {
    if (!view) return 'is off'
    if (view.requires && view.licensed === false) return `needs a license granting ${view.requires}`
    if (view.locked) return 'is switched off in the deployment’s settings'
    if (view.source === 'default') return 'is off unless switched on'
    return `is off ${!view.scope || view.scope === 'everyone' ? 'for everyone' : 'for you'}`
  }
  return cause === feature ? `${feature.title} ${offBy(feature)}.` : `${feature.title} needs ${cause?.title ?? feature.blockedBy[0]}, which ${offBy(cause)}.`
}
