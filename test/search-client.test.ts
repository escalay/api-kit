import { describe, expect, it } from 'vitest'
import { createSearchClient, createSearchController, listenForPictures, pictureFrom, SearchError } from '../src/browser/search-client.js'
import { auth, png, sampleApi } from './logos-fixture.js'

type Card = { id: string; client: string }

/** A client against the sample API in this process, counting the requests it makes. */
const clientFor = (app = sampleApi(), { delay = 0 } = {}) => {
  const urls: string[] = []
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    urls.push(`${init?.method ?? 'GET'} ${url}`)
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    return app.request(url, init)
  }) as typeof fetch
  return { client: createSearchClient<Card>({ path: '/api/search', similarPath: '/api/logos/{slug}/similar', fetchImpl, headers: auth }), urls }
}
const until = async (check: () => boolean) => {
  for (let n = 0; n < 200 && !check(); n++) await new Promise((resolve) => setTimeout(resolve, 5))
  expect(check()).toBe(true)
}
const ids = (results: { item: Card }[]) => results.map((result) => result.item.id)

describe('search client', () => {
  it('calls the three routes with filters and reads the results', async () => {
    const { client, urls } = clientFor()
    expect(ids((await client.byWords('fox', { filters: { decade: '1980s', empty: undefined } })).results)).toEqual(['logo:fox2'])
    expect(ids((await client.byPicture(new Blob([new Uint8Array(await png())], { type: 'image/png' }), { limit: 1 })).results)).toEqual(['logo:fox'])
    expect(ids((await client.byPicture(`data:image/png;base64,${(await png()).toString('base64')}`, { by: 'look' })).results)).toEqual(['logo:fox', 'logo:fox2'])
    expect(await client.similar('fox', { limit: 1 })).toMatchObject({ by: 'look', results: [{ item: { id: 'logo:fox2' }, z: null }] })
    expect(urls).toEqual(['GET /api/search?decade=1980s&q=fox', 'POST /api/search?limit=1', 'POST /api/search?by=look', 'GET /api/logos/fox/similar?limit=1'])
  })

  it('turns a problem into a SearchError an app can show', async () => {
    const { client } = clientFor(sampleApi({ spaces: {} }))
    const error = await client.byWords('fox').catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SearchError)
    expect(error).toMatchObject({ status: 503, code: 'unavailable', retryAfter: 3600 })
    expect((error as SearchError).detail).toContain('not built yet')
  })
})

describe('search controller', () => {
  it('waits for typing to stop, and clears below the minimum length', async () => {
    const { client, urls } = clientFor()
    const search = createSearchController(client, { debounceMs: 20 })
    const seen: string[] = []
    search.subscribe(() => seen.push(search.getState().status))
    search.setWords('f')
    expect(search.getState().status).toBe('idle')
    search.setWords('fo')
    search.setWords('fox')
    await until(() => search.getState().status === 'done')
    expect(urls).toEqual(['GET /api/search?by=both&q=fox'])
    expect(ids(search.getState().results)).toEqual(['logo:fox', 'logo:fox2'])
    expect(seen).toContain('loading')
    search.setWords('')
    expect(search.getState()).toMatchObject({ status: 'idle', results: [] })
  })

  it('never lets an older search overwrite a newer one', async () => {
    const { client } = clientFor(sampleApi(), { delay: 30 })
    const search = createSearchController(client, { debounceMs: 0 })
    search.similarTo('bird')
    search.setWords('fox')
    await until(() => search.getState().status === 'done')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(search.getState().input).toEqual({ kind: 'words', text: 'fox' })
    expect(ids(search.getState().results)).toEqual(['logo:fox', 'logo:fox2'])
  })

  it('searches a picture by look with a preview, reruns on a new setting, and frees the preview', async () => {
    const { client, urls } = clientFor()
    const search = createSearchController(client, { filters: { decade: '1980s' } })
    search.setPicture(new Blob([new Uint8Array(await png())], { type: 'image/png' }))
    const { input } = search.getState()
    expect(input.kind === 'picture' && input.preview.startsWith('blob:')).toBe(true)
    await until(() => search.getState().status === 'done')
    expect(ids(search.getState().results)).toEqual(['logo:fox2'])
    search.setFilters({})
    await until(() => search.getState().status === 'done' && search.getState().results.length === 2)
    search.setBy('meaning')
    await until(() => search.getState().status === 'done')
    expect(urls).toEqual(['POST /api/search?by=look&decade=1980s', 'POST /api/search?by=look', 'POST /api/search?by=meaning'])
    search.clear()
    expect(search.getState().status).toBe('idle')
    search.dispose()
  })

  it('reports an unreachable server as a network error it can retry', async () => {
    let down = true
    const client = createSearchClient<Card>({ path: '/api/search', fetchImpl: (async (url: string, init?: RequestInit) => {
      if (down) throw new TypeError('fetch failed')
      return sampleApi().request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...auth } })
    }) as typeof fetch })
    const search = createSearchController(client, { debounceMs: 0 })
    search.setWords('fox')
    await until(() => search.getState().status === 'error')
    expect(search.getState().error).toMatchObject({ code: 'network' })
    down = false
    search.retry()
    await until(() => search.getState().status === 'done')
  })
})

describe('pictures from a paste or a drop', () => {
  const file = (type: string) => new File(['x'], 'a', { type })

  it('takes the first picture and ignores other files', () => {
    const items = (...files: File[]) => ({ items: [{ kind: 'string', getAsFile: () => null }, ...files.map((one) => ({ kind: 'file', getAsFile: () => one }))] }) as unknown as DataTransfer
    expect(pictureFrom(items(file('text/plain'), file('image/png')))?.type).toBe('image/png')
    expect(pictureFrom(items(file('image/svg+xml')))).toBeNull()
    expect(pictureFrom([file('image/webp')] as unknown as FileList)?.type).toBe('image/webp')
    expect(pictureFrom(null)).toBeNull()
  })

  it('hears a pasted picture, leaves text pastes alone, and stops when cleaned up', () => {
    const target = new EventTarget()
    const got: File[] = []
    const stop = listenForPictures(target, (picture) => got.push(picture))
    const paste = (files: File[]) => {
      const event = new Event('paste', { cancelable: true })
      Object.assign(event, { clipboardData: { items: files.map((one) => ({ kind: 'file', getAsFile: () => one })) } })
      target.dispatchEvent(event)
      return event
    }
    expect(paste([file('image/png')]).defaultPrevented).toBe(true)
    expect(paste([]).defaultPrevented).toBe(false)
    stop()
    paste([file('image/png')])
    expect(got).toHaveLength(1)
  })
})
