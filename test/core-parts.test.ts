import { describe, expect, it } from 'vitest'
import { memoryJobs, newId, queueJobs, waitFor } from '../src/index.js'

describe('core parts', () => {
  it('makes ids that sort by when they were made, even in one millisecond', () => {
    const ids = Array.from({ length: 50 }, () => newId('adr'))
    expect(ids.every((id) => /^adr_[0-9a-z]{9}[a-z2-9]{10}$/.test(id))).toBe(true)
    expect([...ids].sort()).toEqual(ids)
  })

  it('waits until something turns up, or gives up after the timeout', async () => {
    let calls = 0
    expect(await waitFor(async () => (++calls >= 3 ? 'found' : undefined), 5, 1)).toBe('found')
    const started = Date.now()
    expect(await waitFor(async () => undefined, 0)).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(50)
  })

  it('queues jobs with a delay Queues accept, and keeps them in memory for tests', async () => {
    const sent: unknown[] = []
    await queueJobs({ send: async (body, options) => void sent.push({ body, options }) }).send({ kind: 'x' }, { delaySeconds: 99_999.4 })
    expect(sent).toEqual([{ body: { kind: 'x' }, options: { delaySeconds: 43_200 } }])
    const jobs = memoryJobs<{ kind: string }>()
    await jobs.send({ kind: 'y' })
    expect(jobs.sent).toEqual([{ job: { kind: 'y' }, delaySeconds: 0 }])
  })
})
