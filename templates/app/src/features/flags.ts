/**
 * Where feature switches come from: the one line to change for a flag service, e.g.
 * `[fromSdk({ name: 'posthog', allFlags: (context) => posthog.getAllFlags(context.targetingKey ?? 'everyone') }), databaseProvider(db)]`.
 * Paid features (`requires` in the catalog) need `license: licenseOf({ key: env.LICENSE_KEY, publicKey, product })`.
 */
import { databaseProvider, parseFeatureList, switches, type Db, type FlagProvider } from '../kit/index.js'
import { CATALOG } from './catalog.js'

export const flagProviders = (db: Db): FlagProvider[] => [databaseProvider(db)]

/** flagsOf is the app's switches: the catalog, the providers above, and what `FEATURES_OFF` locks off. */
export const flagsOf = (db: Db, env: { FEATURES_OFF?: string }) => switches({ catalog: CATALOG, providers: flagProviders(db), off: parseFeatureList(env.FEATURES_OFF) })

export type Flags = ReturnType<typeof flagsOf>
