// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Board, BoardsClient } from '../src/browser/boards-client.js'
import { useBoards, useItemBoards } from '../src/browser/boards-react.js'

/** A client over an in-memory list of boards. */
const fakeClient = () => {
  const boards: (Board<string> & { refs: Set<string> })[] = []
  const shape = ({ refs, ...board }: Board<string> & { refs: Set<string> }): Board<string> => ({ ...board, items: refs.size })
  const client: BoardsClient<string> = {
    list: async (ref) => boards.filter((board) => !ref || board.refs.has(ref)).map(shape),
    create: async (name) => {
      const board = { id: `b${boards.length + 1}`, name, description: null, items: 0, createdAt: '', updatedAt: '', refs: new Set<string>() }
      boards.push(board)
      return shape(board)
    },
    get: async (id) => shape(boards.find((board) => board.id === id)!),
    rename: async (id, { name }) => {
      const board = boards.find((one) => one.id === id)!
      board.name = name ?? board.name
      return shape(board)
    },
    remove: async (id) => void boards.splice(boards.findIndex((board) => board.id === id), 1),
    save: async (id, ref) => {
      const board = boards.find((one) => one.id === id)!
      board.refs.add(ref)
      return shape(board)
    },
    unsave: async (id, ref) => void boards.find((board) => board.id === id)!.refs.delete(ref),
    suggestions: async () => [],
  }
  return client
}

afterEach(cleanup)

describe('board hooks', () => {
  it('lists boards and reloads after making, renaming and deleting one', async () => {
    const client = fakeClient()
    const { result } = renderHook(() => useBoards(client))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    await act(async () => void (await result.current.create('Saved')))
    expect(result.current.boards.map((board) => board.name)).toEqual(['Saved'])
    await act(async () => void (await result.current.rename('b1', { name: 'Kept' })))
    expect(result.current.boards[0]!.name).toBe('Kept')
    await act(async () => result.current.remove('b1'))
    expect(result.current.boards).toEqual([])
  })

  it('knows where an item is saved and toggles it on a board', async () => {
    const client = fakeClient()
    await client.create('Saved')
    await client.create('Brief')
    const { result } = renderHook(() => useItemBoards(client, 'logo:fox'))
    await waitFor(() => expect(result.current.holding.size).toBe(0))
    await act(async () => result.current.toggle('b2'))
    expect([...result.current.holding]).toEqual(['b2'])
    await act(async () => result.current.toggle('b2'))
    expect(result.current.holding.size).toBe(0)
  })
})
