import { count as countAll, like } from 'drizzle-orm'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { dbGuardStore, GUARD_MIGRATIONS, idempotency, kitGuards, migrate, showOnce, type Db, type GuardStore } from '../src/index.js'

/** Counts a store's rows whose id starts with `prefix`, for the checks that can't be seen through `GuardStore`. */
export type RowCount = (prefix: string) => Promise<number>

/** `dbGuardStore` over `db`, with its rows counted in `kit_guards`. */
export const countedDbStore = async (db: Db) => ({
  store: await dbGuardStore(db),
  rows: async (prefix: string) => (await db.select({ n: countAll() }).from(kitGuards).where(like(kitGuards.id, `${prefix}%`)))[0]!.n,
})

/**
 * What every GuardStore must do: the same checks run on memory and on the database, on Node and in workerd. `counted`
 * makes a store with a way to count its rows, for a store whose pruning can be seen.
 */
export const guardStoreContract = (name: string, make: () => Promise<GuardStore>, counted?: () => Promise<{ store: GuardStore; rows: RowCount }>) =>
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

    it('keeps the answer of a request that outlived its lock, even after a prune', async () => {
      const store = await make()
      const id = `slow-${crypto.randomUUID()}`
      expect(await store.claim(id, 60_000, 1_000)).toBeNull()
      await store.count(`slow-other-${crypto.randomUUID()}`, 1_000, 62_000)
      const answer = { bodyHash: 'h', status: 201, headers: [] as [string, string][], body: btoa('{}') }
      await store.save(id, answer, 200_000)
      expect(await store.claim(id, 60_000, 63_000)).toEqual(answer)
    })

    it('holds no secret from an answer shown once, only what a replay is told', async () => {
      const store = await make()
      const saved: string[] = []
      const recording: GuardStore = { ...store, save: (id, answer, expiresAt) => (saved.push(id), store.save(id, answer, expiresAt)) }
      const secret = `sk_${crypto.randomUUID()}`
      const app = new Hono()
      app.use('*', idempotency({ store: recording }))
      app.post('/api/keys', (c) => {
        showOnce(c, 'Made the key ci (GET /api/keys/key_1); the key was shown once and is never shown again.')
        return c.json({ id: 'key_1', key: secret }, 201, { location: '/api/keys/key_1' })
      })
      const post = () => app.request('/api/keys', { method: 'POST', headers: { 'idempotency-key': `once-${crypto.randomUUID()}`, 'content-type': 'application/json' }, body: '{"name":"ci"}' })
      expect((await post()).status).toBe(201)
      const kept = await store.claim(saved[0]!, 60_000, Date.now())
      expect(kept).toEqual({ bodyHash: expect.any(String), shownOnce: 'Made the key ci (GET /api/keys/key_1); the key was shown once and is never shown again.' })
      expect(JSON.stringify(kept)).not.toContain(secret)
    })

    if (counted) it('prunes expired rows while running, at most once a minute', async () => {
      const { store, rows: count } = await counted()
      const prefix = `prune-${crypto.randomUUID()}`
      await store.count(`${prefix}-window`, 1_000, 1_000)
      expect(await store.claim(`${prefix}-key`, 1_000, 1_000)).toBeNull()
      expect(await count(prefix)).toBe(2)
      // Both have lapsed, but the last prune was under a minute ago
      await store.count(`${prefix}-later`, 1_000, 30_000)
      expect(await count(prefix)).toBe(3)
      await store.count(`${prefix}-next`, 1_000, 61_000)
      expect(await count(prefix)).toBe(1)
      expect(await store.claim(`${prefix}-last`, 1_000, 122_000)).toBeNull()
      expect(await count(prefix)).toBe(1)
    })
  })

/**
 * The `kit_guards` table as 1.30.0 left it, upgraded: its stored idempotency answers (which could hold a key shown
 * once) are gone after the next migrate, and its rate windows stay. Runs on node:sqlite and D1.
 */
export const guardTableUpgrade = (name: string, makeDb: () => Promise<Db>) =>
  describe(`kit_guards from 1.30.0: ${name}`, () => {
    it('drops the stored idempotency answers on the next start, and keeps the rate windows', async () => {
      const db = await makeDb()
      await migrate(db, 'guards', GUARD_MIGRATIONS.slice(0, 1))
      const secret = `sk_${crypto.randomUUID()}`
      const answer = { bodyHash: 'h', status: 201, headers: [['location', '/api/keys/key_1']], body: btoa(JSON.stringify({ id: 'key_1', key: secret })) }
      const later = Date.now() + 86_400_000
      // This test's rows carry their own prefix, whatever else the database holds
      const prefix = `upgrade-${crypto.randomUUID()}`
      await db.insert(kitGuards).values([
        { kind: 'key', id: `${prefix} POST /api/keys k1`, start: 0, used: 0, value: JSON.stringify(answer), expiresAt: later },
        { kind: 'key', id: `${prefix} POST /api/keys k2`, start: 0, used: 0, value: '', expiresAt: later },
        { kind: 'rate', id: `${prefix} paid`, start: 1_000, used: 7, value: '', expiresAt: later },
      ])
      await dbGuardStore(db)
      const rows = await db.select().from(kitGuards).where(like(kitGuards.id, `${prefix}%`))
      expect(rows).toEqual([{ kind: 'rate', id: `${prefix} paid`, start: 1_000, used: 7, value: '', expiresAt: later }])
      expect(JSON.stringify(rows)).not.toContain(answer.body)
    })
  })
