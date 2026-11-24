import { describe, expect, it } from 'vitest'
import { memoryJobs, newId, originOfRequest, queueJobs, waitFor } from '../src/index.js'

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

  it('takes a forwarded host only when it is a bare host[:port], and a forwarded proto only when http or https', () => {
    const originWith = (headers: Record<string, string>) => originOfRequest(new Request('http://10.0.0.2:8080/x', { headers }))
    const taken: [Record<string, string>, string][] = [
      [{}, 'http://10.0.0.2:8080'],
      [{ 'x-forwarded-host': 'cookbook.example.test' }, 'http://cookbook.example.test'],
      [{ 'x-forwarded-host': 'cookbook.example.test:8443', 'x-forwarded-proto': 'https' }, 'https://cookbook.example.test:8443'],
      [{ 'x-forwarded-host': 'app_1.internal' }, 'http://app_1.internal'],
      [{ 'x-forwarded-host': '203.0.113.7' }, 'http://203.0.113.7'],
      [{ 'x-forwarded-host': '[::1]:3000' }, 'http://[::1]:3000'],
      // A list: the first item, the host the first proxy saw
      [{ 'x-forwarded-host': 'first.example.test, second.example.test', 'x-forwarded-proto': 'HTTPS, http' }, 'https://first.example.test'],
    ]
    for (const [headers, origin] of taken) expect(originWith(headers), JSON.stringify(headers)).toBe(origin)
    const ignored = ['localhost/s/soups', 'localhost/s/soups, cookbook.example.test', 'localhost?x', 'localhost#x', 'someone@localhost', 'local host', 'localhost\\s', 'local%2fhost', 'localhost;x', '', ' ', '[::1', 'localhost:abc', 'localhost:99999', '999.1.1.1']
    for (const host of ignored) expect(originWith({ 'x-forwarded-host': host, 'x-forwarded-proto': 'https' }), host).toBe('https://10.0.0.2:8080')
    for (const proto of ['javascript', 'ftp', 'http://x/?', 'https:', '']) expect(originWith({ 'x-forwarded-proto': proto, 'x-forwarded-host': 'cookbook.example.test' }), proto).toBe('http://cookbook.example.test')
  })
})
