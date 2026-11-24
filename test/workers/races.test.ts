import { describe, expect, it } from 'vitest'
import { BOARDS_MIGRATIONS, boardsRepo } from '../../src/boards/index.js'
import { migrate, PEOPLE_MIGRATIONS, peopleRepo, TELEMETRY_MIGRATIONS, telemetryRepo, testDb } from '../../src/index.js'

// D1 keeps one database per test file, so each test uses its own ids
describe('one statement decides a race, on D1', () => {
  it('takes a challenge once when two verifies arrive together', async () => {
    const db = await testDb()
    await migrate(db, 'people', PEOPLE_MIGRATIONS)
    const repo = peopleRepo(db)
    await repo.addChallenge({ id: 'wch_d1_race', kind: 'login', challenge: 'c', personId: null, expiresAt: new Date(Date.now() + 60_000).toISOString() })
    const taken = await Promise.all([repo.takeChallenge('wch_d1_race', 'login'), repo.takeChallenge('wch_d1_race', 'login')])
    expect(taken.filter(Boolean)).toHaveLength(1)
  })

  it('stamps the day\'s report once when two replicas send together', async () => {
    const db = await testDb()
    await migrate(db, 'telemetry', TELEMETRY_MIGRATIONS)
    const repo = telemetryRepo(db)
    await repo.state()
    const at = new Date().toISOString()
    expect((await Promise.all([repo.markSent(at), repo.markSent(at)])).sort()).toEqual([false, true])
  })

  it('adds a board item once when two saves arrive together', async () => {
    const db = await testDb()
    await migrate(db, 'boards', BOARDS_MIGRATIONS)
    const repo = boardsRepo(db)
    const id = await repo.create({ name: 'Race', description: null })
    expect((await Promise.all([repo.save(id, 'logo:fox', 'one'), repo.save(id, 'logo:fox', 'two')])).sort()).toEqual(['added', 'noted'])
    expect((await repo.items(id)).length).toBe(1)
  })
})
