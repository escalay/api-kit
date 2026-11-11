/**
 * React hooks over `boards-client.ts`: the owner's boards and where one item is saved, with no markup. Each app draws
 * its own lists, menus and save buttons.
 *
 *   useBoards       every board, and making, renaming and deleting them
 *   useItemBoards   the boards holding one item, and saving it to or taking it off a board
 *
 * @example
 * const boards = useMemo(() => createBoardsClient<RecipeCard>(), [])
 * const { boards: all, create } = useBoards(boards)
 * const { holding, toggle } = useItemBoards(boards, `recipe:${recipe.slug}`)
 * all.map((board) => <label key={board.id}><input type="checkbox" checked={holding.has(board.id)} onChange={() => toggle(board.id)} />{board.name}</label>)
 */
import { useCallback, useEffect, useState } from 'react'
import type { Board, BoardsClient, BoardsError } from './boards-client'

type Status = 'loading' | 'ready' | 'error'

/**
 * Every board, newest change first, reloaded after each change made through it.
 *
 * @example
 * const { boards, status, create, rename, remove } = useBoards(client)
 */
export const useBoards = <Item>(client: BoardsClient<Item>) => {
  const [boards, setBoards] = useState<Board<Item>[]>([])
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<BoardsError | null>(null)
  const reload = useCallback(async () => {
    try {
      setBoards(await client.list())
      setStatus('ready')
      setError(null)
    } catch (caught) {
      setStatus('error')
      setError(caught as BoardsError)
    }
  }, [client])
  useEffect(() => void reload(), [reload])
  const after =
    <Args extends unknown[], Result>(change: (...args: Args) => Promise<Result>) =>
    async (...args: Args) => {
      const result = await change(...args)
      await reload()
      return result
    }
  return { boards, status, error, reload, create: after(client.create), rename: after(client.rename), remove: after(client.remove) }
}

/**
 * Where one item is saved: the ids of the boards holding it, and saving it to or taking it off one. Stays idle without
 * a ref.
 *
 * @example
 * const { holding, toggle, save } = useItemBoards(client, `recipe:${slug}`)
 */
export const useItemBoards = <Item>(client: BoardsClient<Item>, ref: string | null | undefined) => {
  const [holding, setHolding] = useState<Set<string>>(new Set())
  const reload = useCallback(async () => setHolding(ref ? new Set((await client.list(ref)).map((board) => board.id)) : new Set()), [client, ref])
  useEffect(() => void reload().catch(() => setHolding(new Set())), [reload])
  const save = async (boardId: string, note?: string) => {
    if (!ref) return
    await client.save(boardId, ref, note)
    await reload()
  }
  const toggle = async (boardId: string) => {
    if (!ref) return
    if (holding.has(boardId)) await client.unsave(boardId, ref)
    else await client.save(boardId, ref)
    await reload()
  }
  return { holding, save, toggle, reload }
}
