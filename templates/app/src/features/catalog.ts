/**
 * The features an owner can switch off, by keys that never change: the same name in the database, in `FEATURES_OFF`
 * and in a flag service. A rename keeps the old key in `renamedFrom`. `kit feature <name> --switch` adds one here.
 * Leave out what the app cannot work without (sign-in, its main data): only additive features belong here.
 *
 * @example
 * digest: { title: 'Daily digest', description: 'One mail a day with what changed.', needs: ['sending'], default: false },
 * audit: { title: 'Audit export', description: 'Every change as a file.', requires: 'enterprise' },
 */
import { defineFeatures } from '../kit/index.js'

export const CATALOG = defineFeatures({
  // kit:catalog
})

export type FeatureKey = keyof typeof CATALOG
