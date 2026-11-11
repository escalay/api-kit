/**
 * The browser side of `boards`, without a framework: a typed client for the board routes, run with the page's own
 * sign-in. A plain viewer uses it directly; React apps use `boards-react.ts`. A failed call is a `BoardsError` carrying
 * the API's problem (`code`, `detail`), so an app can show what to do.
 *
 * @example
 * const boards = createBoardsClient<RecipeCard>()
 * const saved = (await boards.list()).find((board) => board.name === 'Saved') ?? (await boards.create('Saved'))
 * await boards.save(saved.id, 'recipe:soup', 'the sun')
 */

export { BOARD_REF, boardRef, parseBoardRef } from '../boards/refs.js'

export type BoardEntry<Item> = { ref: string; note: string | null; addedAt: string; item: Item | null }
export type Board<Item> = { id: string; name: string; description: string | null; items: number; createdAt: string; updatedAt: string; entries?: BoardEntry<Item>[] }

/** A failed board call, as the API's problem+json described it. */
export class BoardsError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: string

  constructor(status: number, code: string, detail: string) {
    super(detail)
    this.status = status
    this.code = code
    this.detail = detail
  }
}

type BoardJson<Item> = Omit<Board<Item>, 'entries'> & { _embedded?: { items: BoardEntry<Item>[] } }
const boardOf = <Item>({ _embedded, ...board }: BoardJson<Item>): Board<Item> => ({ ...board, ...(_embedded ? { entries: _embedded.items } : {}) })

export type BoardsClient<Item> = {
  /** Every board, newest change first; with `ref`, only the boards holding it. */
  list: (ref?: string) => Promise<Board<Item>[]>
  create: (name: string, description?: string) => Promise<Board<Item>>
  /** A board with its entries. */
  get: (id: string) => Promise<Board<Item>>
  rename: (id: string, change: { name?: string; description?: string }) => Promise<Board<Item>>
  remove: (id: string) => Promise<void>
  /** Puts an item on a board (or changes its note); harmless to repeat. */
  save: (id: string, ref: string, note?: string) => Promise<Board<Item>>
  unsave: (id: string, ref: string) => Promise<void>
  suggestions: (id: string, limit?: number) => Promise<Item[]>
}

/**
 * A client for the routes `registerBoards` serves. `fetchImpl` and `headers` are for tests and scripts; a page needs
 * neither.
 *
 * @example
 * const boards = createBoardsClient<RecipeCard>({ path: '/api/boards' })
 * const holding = await boards.list('recipe:soup') // where it is saved
 */
export const createBoardsClient = <Item>({ path = '/api/boards', fetchImpl = (...args) => fetch(...args), headers = {} }: { path?: string; fetchImpl?: typeof fetch; headers?: Record<string, string> } = {}): BoardsClient<Item> => {
  const call = async (url: string, init: RequestInit = {}) => {
    const response = await fetchImpl(url, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}), ...headers } })
    const body = response.status === 204 ? null : await response.json().catch(() => null)
    if (!response.ok) throw new BoardsError(response.status, body?.code ?? 'error', body?.detail ?? body?.title ?? `The board call failed (${response.status}).`)
    return body
  }
  const at = (id: string) => `${path}/${encodeURIComponent(id)}`
  return {
    list: async (ref) => ((await call(ref ? `${path}?item=${encodeURIComponent(ref)}` : path))._embedded.boards as BoardJson<Item>[]).map(boardOf),
    create: async (name, description) => boardOf(await call(path, { method: 'POST', body: JSON.stringify({ name, ...(description ? { description } : {}) }) })),
    get: async (id) => boardOf(await call(at(id))),
    rename: async (id, change) => boardOf(await call(at(id), { method: 'PATCH', body: JSON.stringify(change) })),
    remove: async (id) => void (await call(at(id), { method: 'DELETE' })),
    save: async (id, ref, note) => boardOf(await call(`${at(id)}/items/${encodeURIComponent(ref)}`, { method: 'PUT', body: JSON.stringify(note ? { note } : {}) })),
    unsave: async (id, ref) => void (await call(`${at(id)}/items/${encodeURIComponent(ref)}`, { method: 'DELETE' })),
    suggestions: async (id, limit) => (await call(`${at(id)}/suggestions${limit ? `?limit=${limit}` : ''}`))._embedded.items as Item[],
  }
}
