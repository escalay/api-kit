/**
 * A key-value store with expiry: what the OAuth server keeps (codes, tokens, registrations) and A2A's tasks. Values
 * are small JSON objects under a `kind` and an id; `expiresAt` is epoch seconds, and an expired value reads as null.
 * `memoryStore` is for tests and single-process scripts; `dbOAuthStore(db)` (`oauth`) keeps them in the app's database.
 *
 * @example
 * const store = memoryStore()
 * await store.put('a2a-task', id, task, Math.floor(Date.now() / 1000) + 86_400)
 */
export type KeyValueStore = {
  get: (kind: string, id: string) => Promise<Record<string, unknown> | null>
  put: (kind: string, id: string, value: Record<string, unknown>, expiresAt: number) => Promise<void>
  delete: (kind: string, id: string) => Promise<void>
}

const now = () => Math.floor(Date.now() / 1000)

/** A store in memory. */
export const memoryStore = (): KeyValueStore => {
  const rows = new Map<string, { value: Record<string, unknown>; expiresAt: number }>()
  return {
    get: async (kind, id) => {
      const row = rows.get(`${kind}:${id}`)
      return row && row.expiresAt > now() ? row.value : null
    },
    put: async (kind, id, value, expiresAt) => void rows.set(`${kind}:${id}`, { value, expiresAt }),
    delete: async (kind, id) => void rows.delete(`${kind}:${id}`),
  }
}
