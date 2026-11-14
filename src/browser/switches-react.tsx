/**
 * React over `switches-client.ts`: the features for the person signed in, with no markup of their own.
 *
 *   FeaturesProvider     one client for the tree (it loads the list once mounted)
 *   useFeature           one feature: on, ready, why it is off
 *   <Feature>            shows its children while a feature is on, `off` (a notice, an upgrade, a sign-up) while not
 *   useFeatures          the whole list and the client
 *   useSwitchFeature     the owner's switch, with a preview of what else stops
 *   useFeatureDisabled   hears every feature_disabled 403 the app meets, for an alert
 *
 * Typed by the app's own keys: `const { useFeature, Feature } = featureHooks<FeatureKey>()`.
 *
 * @example
 * const features = createFeaturesClient<FeatureKey>()
 * <FeaturesProvider client={features}><App /></FeaturesProvider>
 * <Feature name="digest" off={<FeatureDisabledNotice name="digest" />}><DigestTab /></Feature>
 * const { on } = useFeature('digest')
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { whyOff, type FeatureChange, type FeatureDisabledProblem, type FeaturesClient, type FeatureView } from './switches-client'

const FeaturesContext = createContext<FeaturesClient | null>(null)

/** Hands one features client to the tree below and loads the list. @example <FeaturesProvider client={features}>…</FeaturesProvider> */
export const FeaturesProvider = <Key extends string>({ client, children }: { client: FeaturesClient<Key>; children: ReactNode }) => {
  useEffect(() => {
    void client.refresh()
  }, [client])
  return <FeaturesContext.Provider value={client as unknown as FeaturesClient}>{children}</FeaturesContext.Provider>
}

const useClient = <Key extends string>() => {
  const client = useContext(FeaturesContext)
  if (!client) throw new Error('Feature hooks need a <FeaturesProvider> above them.')
  return client as unknown as FeaturesClient<Key>
}

/** The whole list for the caller, its status, and the client. @example const { features, status, refresh } = useFeatures() */
export const useFeatures = <Key extends string = string>() => {
  const client = useClient<Key>()
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState)
  return { ...state, client, refresh: client.refresh }
}

/**
 * One feature for the caller. `on` is false until the list arrived (`ready`), so nothing switchable flashes in, and
 * true when the list could not be loaded (the API still answers 403 for a feature that is off); `why` says why it is
 * off, in a sentence.
 *
 * @example
 * const { on, ready, why } = useFeature('digest')
 */
export const useFeature = <Key extends string = string>(key: Key) => {
  const { features, status } = useFeatures<Key>()
  const feature = features[key]
  // A list that failed to load says nothing about the feature: show it, and let the API's own 403 decide
  return { on: feature?.on ?? status === 'error', ready: status !== 'loading', feature, why: whyOff(feature, features) }
}

/**
 * Shows its children while a feature is on, and `off` once the list says it is not (nothing while it loads, unless
 * `loading` is given).
 *
 * @example
 * <Feature name="digest" off={<FeatureDisabledNotice name="digest" />}><DigestTab /></Feature>
 */
export const Feature = <Key extends string = string>({ name, children, off = null, loading = null }: { name: Key; children: ReactNode; off?: ReactNode; loading?: ReactNode }) => {
  const { on, ready } = useFeature(name)
  return <>{!ready ? loading : on ? children : off}</>
}

/**
 * The owner's switch: `preview` asks what else would change (nothing is written), `apply` switches and reloads the
 * list. `pending` and `error` are for the button.
 *
 * @example
 * const { preview, apply, pending } = useSwitchFeature()
 * const changes = await preview('sending', false) // [{ key: 'sending', … }, { key: 'relay', … }]
 */
export const useSwitchFeature = <Key extends string = string>() => {
  const client = useClient<Key>()
  const [pending, setPending] = useState<Key | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const run = useCallback(
    async (key: Key, on: boolean | null, scope: string | undefined, dryRun: boolean): Promise<FeatureChange<Key>[]> => {
      setPending(key)
      setError(null)
      try {
        return (await client.switch(key, { on, ...(scope ? { scope } : {}) }, { dryRun })).changes
      } catch (failure) {
        setError(failure as Error)
        throw failure
      } finally {
        setPending(null)
      }
    },
    [client],
  )
  return {
    preview: useCallback((key: Key, on: boolean | null, scope?: string) => run(key, on, scope, true), [run]),
    apply: useCallback((key: Key, on: boolean | null, scope?: string) => run(key, on, scope, false), [run]),
    pending,
    error,
  }
}

/**
 * Calls `listener` for every feature_disabled 403 the app's calls meet (through `watchFetch` or `noticeProblem`), so
 * one place can show an alert, an upgrade or a sign-up.
 *
 * @example
 * useFeatureDisabled((problem) => toast.error(problem.detail))
 */
export const useFeatureDisabled = (listener: (problem: FeatureDisabledProblem) => void) => {
  const client = useClient()
  const latest = useRef(listener)
  latest.current = listener
  useEffect(() => client.onDisabled((problem) => latest.current(problem)), [client])
}

/**
 * The hooks and `<Feature>` typed by an app's own keys, so a misspelt key fails to compile.
 *
 * @example
 * export const { useFeature, Feature, useSwitchFeature } = featureHooks<keyof typeof CATALOG>()
 */
export const featureHooks = <Key extends string>() => ({
  useFeature: (key: Key) => useFeature<Key>(key),
  useFeatures: () => useFeatures<Key>(),
  useSwitchFeature: () => useSwitchFeature<Key>(),
  Feature: (props: { name: Key; children: ReactNode; off?: ReactNode; loading?: ReactNode }) => <Feature<Key> {...props} />,
})

export type { FeatureView }
