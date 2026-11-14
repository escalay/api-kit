/**
 * The feature catalog: every switchable feature of an app, by a stable key, in one file the app owns. The key is the
 * name a database row, `FEATURES_OFF` and a flag service all use, so it never changes; a rename keeps the old name in
 * `renamedFrom`.
 */

/** One switchable feature. */
export type FeatureSpec = {
  /** Its name in a list of switches, e.g. `Webhooks`. */
  title: string
  /** What switching it off stops, in a sentence. */
  description: string
  /** Whether it is on when nothing says otherwise. On unless given. */
  default?: boolean
  /** Features it cannot work without: when one is off, this one is off too. */
  needs?: readonly string[]
  /** Keys it had before, still read from stores and `FEATURES_OFF`. */
  renamedFrom?: readonly string[]
  /** What a license must grant for it to work at all, e.g. `enterprise` (see `license.ts`); free unless given. */
  requires?: string
}

export type Catalog = Readonly<Record<string, FeatureSpec>>

/** A feature key: lowercase words joined by hyphens, e.g. `usage-report`. */
const FEATURE_KEY = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

/**
 * defineFeatures checks a catalog once, at boot, and returns it typed: keys are kebab-case, every `needs` names a
 * feature of the catalog with no loop, and no old name is used twice.
 *
 * @example
 * export const CATALOG = defineFeatures({
 *   sending: { title: 'Sending', description: 'Mail out from the app.' },
 *   digest: { title: 'Daily digest', description: 'One mail a day with what changed.', needs: ['sending'], default: false },
 * })
 */
export const defineFeatures = <const C extends Catalog>(catalog: C): C => {
  const keys = Object.keys(catalog)
  const oldNames = new Set<string>()
  for (const [key, spec] of Object.entries(catalog)) {
    if (!FEATURE_KEY.test(key)) throw new Error(`Feature key "${key}" is not lowercase words joined by hyphens.`)
    if (spec.requires !== undefined && !FEATURE_KEY.test(spec.requires)) throw new Error(`Feature "${key}" requires "${spec.requires}", which is not lowercase words joined by hyphens.`)
    for (const need of spec.needs ?? []) if (!keys.includes(need)) throw new Error(`Feature "${key}" needs "${need}", which is not in the catalog.`)
    for (const old of spec.renamedFrom ?? []) {
      if (keys.includes(old) || oldNames.has(old)) throw new Error(`The old name "${old}" of "${key}" is already a key or another feature's old name.`)
      oldNames.add(old)
    }
  }
  for (const key of keys) needsInOrder(catalog, key)
  return catalog
}

/** needsInOrder lists every feature a key needs, directly or through others, and throws on a loop. */
export const needsInOrder = (catalog: Catalog, key: string, path: string[] = []): string[] => {
  if (path.includes(key)) throw new Error(`Features need each other in a loop: ${[...path, key].join(' → ')}.`)
  return [...new Set((catalog[key]?.needs ?? []).flatMap((need) => [need, ...needsInOrder(catalog, need, [...path, key])]))]
}

/** dependentsOf lists the features that stop when a key stops: those that need it, directly or through others. */
export const dependentsOf = (catalog: Catalog, key: string): string[] => Object.keys(catalog).filter((other) => needsInOrder(catalog, other).includes(key))

/** keyOf gives a name's current key, following `renamedFrom`; undefined for a name the catalog does not know. */
export const keyOf = (catalog: Catalog, name: string): string | undefined =>
  Object.hasOwn(catalog, name) ? name : Object.entries(catalog).find(([, spec]) => spec.renamedFrom?.includes(name))?.[0]

/** A comma-separated list of names, as `FEATURES_OFF=webhooks,digest` gives it. */
const LIST_SEPARATOR = /[\s,]+/

/** parseFeatureList splits a setting such as `FEATURES_OFF` into its names. @example parseFeatureList('webhooks, digest') // ['webhooks', 'digest'] */
export const parseFeatureList = (value: string | undefined): string[] => (value ?? '').split(LIST_SEPARATOR).filter(Boolean)
