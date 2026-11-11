// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createSearchClient, type SearchAnswer, type SearchClient } from '../src/browser/search-client.js'
import { usePictureInput, useSimilar, useVectorSearch } from '../src/browser/search-react.js'
import { VectorSearch } from '../src/browser/vector-search-block.js'

type Card = { id: string; client: string }

/** A client answering from a fixed catalog: words match by client name, a picture or likeness returns the foxes. */
const fakeClient = () => {
  const calls: string[] = []
  const catalog: Card[] = [{ id: 'fox', client: 'Fox Films' }, { id: 'fox2', client: 'Red Fox' }, { id: 'bird', client: 'Bird Air' }]
  const answer = (cards: Card[], query: string | null = null): SearchAnswer<Card> => ({ query, by: 'both', results: cards.map((item) => ({ score: 0.7, z: 5, space: 'look', item })), closest: [] })
  const client: SearchClient<Card> = {
    byWords: async (text, options) => (calls.push(`words ${text} ${options?.by}`), answer(catalog.filter((card) => card.client.toLowerCase().includes(text.toLowerCase())), text)),
    byPicture: async (_picture, options) => (calls.push(`picture ${options?.by}`), answer(catalog.slice(0, 2))),
    similar: async (id, options) => (calls.push(`similar ${id} ${options?.by}`), answer(catalog.filter((card) => card.id !== id && card.id.startsWith(id.slice(0, 3))))),
  }
  return { client, calls }
}
const picture = () => new File(['x'], 'fox.png', { type: 'image/png' })

afterEach(cleanup)

describe('useVectorSearch', () => {
  it('holds one search and its actions', async () => {
    const { client, calls } = fakeClient()
    const { result } = renderHook(() => useVectorSearch(client, { debounceMs: 0 }))
    expect(result.current.status).toBe('idle')
    act(() => result.current.setWords('fox'))
    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(result.current.results.map((row) => row.item.id)).toEqual(['fox', 'fox2'])
    act(() => result.current.setBy('meaning'))
    await waitFor(() => expect(calls).toEqual(['words fox both', 'words fox meaning']))
    act(() => result.current.setPicture(picture()))
    expect(result.current.input.kind).toBe('picture')
    await waitFor(() => expect(result.current.status).toBe('done'))
    expect(calls.at(-1)).toBe('picture meaning')
  })

  it('works against the real client the same way', async () => {
    const client = createSearchClient<Card>({ path: '/api/search', fetchImpl: (async () => new Response(JSON.stringify({ query: 'fox', by: 'both', _embedded: { results: [{ score: 0.7, z: 6, space: 'look', item: { id: 'fox', client: 'Fox Films' } }] } }))) as unknown as typeof fetch })
    const { result } = renderHook(() => useVectorSearch(client, { debounceMs: 0 }))
    act(() => result.current.setWords('fox'))
    await waitFor(() => expect(result.current.results).toHaveLength(1))
  })
})

describe('useSimilar', () => {
  it('loads likeness for an id and reloads when it changes', async () => {
    const { client, calls } = fakeClient()
    const { result, rerender } = renderHook(({ id }) => useSimilar(client, id), { initialProps: { id: 'fox' as string | null } })
    await waitFor(() => expect(result.current.results.map((row) => row.item.id)).toEqual(['fox2']))
    rerender({ id: 'bird' })
    await waitFor(() => expect(calls).toEqual(['similar fox look', 'similar bird look']))
    rerender({ id: null })
    await waitFor(() => expect(result.current.status).toBe('idle'))
  })
})

describe('usePictureInput', () => {
  it('hands over a pasted, dropped or picked picture', () => {
    const got: string[] = []
    const { result } = renderHook(() => usePictureInput({ onPicture: (file) => got.push(file.name) }))
    const paste = new Event('paste', { cancelable: true })
    Object.assign(paste, { clipboardData: { items: [{ kind: 'file', getAsFile: picture }] } })
    act(() => void window.dispatchEvent(paste))
    act(() => result.current.dropProps.onDrop({ dataTransfer: { files: [picture()] }, preventDefault: () => {} } as never))
    act(() => result.current.inputProps.onChange({ target: { files: [picture()], value: 'C:\\fakepath\\fox.png' } } as never))
    expect(got).toEqual(['fox.png', 'fox.png', 'fox.png'])
    expect(result.current.inputProps).toMatchObject({ type: 'file', hidden: true, accept: 'image/png,image/jpeg,image/webp,image/gif' })
  })
})

describe('VectorSearch block', () => {
  it('searches as you type, shows the app’s own cards, and switches comparison', async () => {
    const { client, calls } = fakeClient()
    render(<VectorSearch client={client} getKey={(card) => card.id} renderResult={({ item }) => <span>{item.client}</span>} />)
    expect(screen.getByRole('status').textContent).toContain('paste (⌘V)')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'fox' } })
    await waitFor(() => expect(screen.getByText('Red Fox')).toBeTruthy())
    expect(screen.getByRole('status').textContent).toBe('2 matches, best first')
    fireEvent.click(screen.getByRole('button', { name: 'Look' }))
    await waitFor(() => expect(calls.at(-1)).toBe('words fox look'))
    expect(screen.getByRole('button', { name: 'Look' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('takes a pasted picture, shows it in the field, and clears it', async () => {
    const { client } = fakeClient()
    render(<VectorSearch client={client} getKey={(card) => card.id} renderResult={({ item }) => <span>{item.client}</span>} />)
    const paste = new Event('paste', { cancelable: true })
    Object.assign(paste, { clipboardData: { items: [{ kind: 'file', getAsFile: picture }] } })
    act(() => void window.dispatchEvent(paste))
    expect(screen.getByAltText('Your picture')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('Fox Films')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Remove the picture' }))
    expect(screen.queryByAltText('Your picture')).toBeNull()
  })

  it('says when nothing stands out, and offers a retry on an error', async () => {
    const { client } = fakeClient()
    let fail = true
    const flaky: SearchClient<Card> = { ...client, byWords: async (text, options) => (fail ? Promise.reject(new Error('down')) : client.byWords(text, options)) }
    render(<VectorSearch client={flaky} getKey={(card) => card.id} renderResult={({ item }) => <span>{item.client}</span>} />)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'zebra' } })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('could not reach'))
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Nothing stands out'))
  })
})
