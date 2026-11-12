import { queryOptions, useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'

const health = queryOptions({
  queryKey: ['health'],
  queryFn: async (): Promise<{ status: string }> => {
    const response = await fetch('/api/health')
    if (!response.ok) throw new Error(`The API answered ${response.status}`)
    return response.json()
  },
})

const Home = () => {
  const { data } = useSuspenseQuery(health)
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">__title__</h1>
      <p className="mt-2 text-neutral-600">The API says: {data.status}</p>
      <p className="mt-6 text-sm text-neutral-500">
        Agents start at{' '}
        <a className="underline" href="/llms.txt">
          /llms.txt
        </a>
        ; the routes are at{' '}
        <a className="underline" href="/docs">
          /docs
        </a>
        .
      </p>
    </>
  )
}

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(health),
  component: Home,
})
