import type { QueryClient } from '@tanstack/react-query'
import { createRouter, type RouterHistory } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

/** The app's router. The Worker answers everything outside /app, so the router owns only what is under it. */
export const createAppRouter = (queryClient: QueryClient, history?: RouterHistory) =>
  createRouter({ routeTree, basepath: '/app', context: { queryClient }, defaultPreload: 'intent', history })

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
