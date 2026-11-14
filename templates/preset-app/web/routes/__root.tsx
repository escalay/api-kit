import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'
import { FeaturesProvider } from '../kit/browser/switches-react'
import { features } from '../lib/features'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // Every page can ask whether a feature is on (`useFeature`, `<Feature>` from web/lib/features.ts)
  component: () => (
    <FeaturesProvider client={features}>
      <main className="mx-auto max-w-2xl px-4 py-16">
        <Outlet />
      </main>
    </FeaturesProvider>
  ),
})
