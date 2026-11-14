/**
 * The app's feature switches in the browser: one client (fresh on focus, after a switch and after any 403
 * feature_disabled met through `features.watchFetch(fetch)`) and the hooks typed by `src/features/catalog.ts`.
 *
 * @example
 * <Feature name="digest" off={<p>This feature is disabled.</p>}><Digest /></Feature>
 * const { on, why } = useFeature('digest')
 */
import type { FeatureKey } from '../../src/features/catalog'
import { createFeaturesClient } from '../kit/browser/switches-client'
import { featureHooks } from '../kit/browser/switches-react'

export const features = createFeaturesClient<FeatureKey>()
export const { useFeature, useFeatures, useSwitchFeature, Feature } = featureHooks<FeatureKey>()
