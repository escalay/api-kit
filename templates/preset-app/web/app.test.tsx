import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { createAppRouter } from './router'

afterEach(() => vi.unstubAllGlobals())

test('the home page shows what the API answers', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ status: 'ok' }))
  const queryClient = new QueryClient()
  const router = createAppRouter(queryClient, createMemoryHistory({ initialEntries: ['/app/'] }))

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )

  expect(await screen.findByText('The API says: ok')).toBeTruthy()
})
