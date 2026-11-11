import { describe, expect, it } from 'vitest'
import type { GuardStore } from '../src/index.js'

/** What every GuardStore must do: the same checks run on memory and on the database, on Node and in workerd. */
export const guardStoreContract = (name: string, make: () => Promise<GuardStore>) =>
  describe(`GuardStore: ${name}`, () => {
    it('counts calls in a window, atomically, and starts a stale window over', async () => {
      const store = await make()
      const id = `rate-${crypto.randomUUID()}`
      const used = await Promise.all(Array.from({ length: 10 }, () => store.count(id, 60_000, 1_000)))
      expect(used.map((window) => window.used).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(await store.count(id, 60_000, 30_000)).toEqual({ start: 1_000, used: 11 })
      expect(await store.count(id, 60_000, 61_000)).toEqual({ start: 61_000, used: 1 })
    })

    it('lets one request hold a key, replays its answer, and frees a key on release or when the lock lapses', async () => {
      const store = await make()
      const id = `key-${crypto.randomUUID()}`
      const claims = await Promise.all(Array.from({ length: 5 }, () => store.claim(id, 60_000, 1_000)))
      expect(claims.filter((claim) => claim === null)).toHaveLength(1)
      expect(claims.filter((claim) => claim === 'running')).toHaveLength(4)
      const answer = { bodyHash: 'h', status: 201, headers: [['content-type', 'application/json']] as [string, string][], body: btoa('{"ok":true}') }
      await store.save(id, answer, 100_000)
      expect(await store.claim(id, 60_000, 2_000)).toEqual(answer)
      await store.release(id)
      expect(await store.claim(id, 60_000, 3_000)).toEqual(answer)
      expect(await store.claim(id, 60_000, 100_000)).toBeNull()

      const failed = `key-${crypto.randomUUID()}`
      expect(await store.claim(failed, 60_000, 1_000)).toBeNull()
      await store.release(failed)
      expect(await store.claim(failed, 60_000, 1_001)).toBeNull()
      expect(await store.claim(failed, 60_000, 70_000)).toBeNull()
    })
  })
