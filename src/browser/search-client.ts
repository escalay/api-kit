/**
 * The browser side of `vector-search`, without a framework: a typed client for its three routes, a controller that
 * holds one search's state (words debounced, a picture at once, every new search cancelling the last), and the
 * helpers that turn a paste or a drop into a picture. A plain viewer uses these directly; React apps use
 * `search-react.ts`, which wraps the same controller. Nothing here draws anything: each app renders its own results.
 *
 * Requests run with the page's own sign-in (same-origin cookies), so the browser never holds an API key. A failed
 * call is a `SearchError` carrying the API's problem: `code`, `detail`, and `retryAfter` for a 429 or 503.
 *
 * @example
 * const client = createSearchClient<RecipeCard>({ path: '/api/search', similarPath: '/api/recipes/{id}/similar' })
 * const search = createSearchController(client)
 * search.subscribe(() => render(search.getState()))
 * input.addEventListener('input', () => search.setWords(input.value))
 * listenForPictures(window, (picture) => search.setPicture(picture))
 */

export type SearchBy = 'look' | 'meaning' | 'both'
export type SearchResult<Item> = { score: number; z: number | null; space: 'look' | 'meaning'; item: Item }
/** `closest`: only when nothing cleared the bar, the nearest few below it (not matches; show them as such). */
export type SearchAnswer<Item> = { query: string | null; by: SearchBy; results: SearchResult<Item>[]; closest: SearchResult<Item>[] }
export type SearchFilters = Record<string, string | number | boolean | undefined>
export type SearchOptions = { by?: SearchBy; limit?: number; filters?: SearchFilters; signal?: AbortSignal }

/** A failed search, as the API's problem+json described it. */
export class SearchError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: string
  readonly retryAfter: number | null

  constructor(status: number, code: string, detail: string, retryAfter: number | null = null) {
    super(detail)
    this.status = status
    this.code = code
    this.detail = detail
    this.retryAfter = retryAfter
  }
}

export type SearchClient<Item> = {
  /** Items that match words. */
  byWords: (text: string, options?: SearchOptions) => Promise<SearchAnswer<Item>>
  /** Items that look like a picture: a file or blob, or a data URL. */
  byPicture: (picture: Blob | string, options?: SearchOptions) => Promise<SearchAnswer<Item>>
  /** Items like one, by its id. */
  similar: (id: string, options?: SearchOptions) => Promise<SearchAnswer<Item>>
}

const queryOf = ({ by, limit, filters = {} }: SearchOptions) => {
  const params = new URLSearchParams()
  if (by) params.set('by', by)
  if (limit) params.set('limit', String(limit))
  for (const [name, value] of Object.entries(filters)) if (value !== undefined && value !== '') params.set(name, String(value))
  return params
}

/**
 * A client for the routes `registerVectorSearch` serves. `fetchImpl` and `headers` are for tests and for callers
 * outside the page (a key in a script); a page needs neither.
 *
 * @example
 * const client = createSearchClient<RecipeCard>({ path: '/api/search', similarPath: '/api/recipes/{slug}/similar' })
 * const { results } = await client.byWords('a fox made of triangles', { by: 'look', filters: { decade: '1970s' } })
 */
export const createSearchClient = <Item>({ path, similarPath, fetchImpl = (...args) => fetch(...args), headers = {} }: { path: string; similarPath?: string; fetchImpl?: typeof fetch; headers?: Record<string, string> }): SearchClient<Item> => {
  const call = async (url: string, init: RequestInit = {}): Promise<SearchAnswer<Item>> => {
    const response = await fetchImpl(url, { credentials: 'same-origin', ...init, headers: { accept: 'application/json', ...headers, ...(init.headers as Record<string, string>) } })
    const body = (await response.json().catch(() => null)) as { query?: string | null; by?: SearchBy; _embedded?: { results?: SearchResult<Item>[]; closest?: SearchResult<Item>[] }; code?: string; detail?: string; title?: string } | null
    if (!response.ok) {
      const retry = Number(response.headers.get('retry-after'))
      throw new SearchError(response.status, body?.code ?? 'error', body?.detail ?? body?.title ?? `The search failed (${response.status}).`, Number.isFinite(retry) && retry > 0 ? retry : null)
    }
    return { query: body?.query ?? null, by: body?.by ?? 'both', results: body?._embedded?.results ?? [], closest: body?._embedded?.closest ?? [] }
  }
  return {
    byWords: (text, options = {}) => {
      const params = queryOf(options)
      params.set('q', text)
      return call(`${path}?${params}`, { signal: options.signal })
    },
    byPicture: (picture, options = {}) => {
      const params = queryOf(options)
      const suffix = params.size ? `?${params}` : ''
      if (typeof picture === 'string') return call(`${path}${suffix}`, { method: 'POST', body: JSON.stringify({ image: picture }), headers: { 'content-type': 'application/json' }, signal: options.signal })
      const form = new FormData()
      form.append('image', picture)
      return call(`${path}${suffix}`, { method: 'POST', body: form, signal: options.signal })
    },
    similar: (id, options = {}) => {
      if (!similarPath) return Promise.reject(new SearchError(404, 'not_found', 'This client has no similarPath.'))
      const params = queryOf(options)
      return call(`${similarPath.replace(/\{\w+\}/, encodeURIComponent(id))}${params.size ? `?${params}` : ''}`, { signal: options.signal })
    },
  }
}

/** What is being searched for: nothing yet, words, a picture (with an object URL to show it), or one item's likeness. */
export type SearchInput = { kind: 'idle' } | { kind: 'words'; text: string } | { kind: 'picture'; picture: Blob; preview: string } | { kind: 'similar'; id: string }

export type SearchState<Item> = {
  input: SearchInput
  by: SearchBy
  filters: SearchFilters
  status: 'idle' | 'loading' | 'done' | 'error'
  results: SearchResult<Item>[]
  /** The nearest below the bar when `results` is empty. */
  closest: SearchResult<Item>[]
  error: SearchError | null
}

export type SearchController<Item> = {
  getState: () => SearchState<Item>
  /** Calls `listener` after every change; returns the unsubscribe. */
  subscribe: (listener: () => void) => () => void
  /** Words, debounced; fewer than `minLength` characters clears the results. */
  setWords: (text: string) => void
  setPicture: (picture: Blob) => void
  similarTo: (id: string) => void
  /** Reruns the current search with the new setting. */
  setBy: (by: SearchBy) => void
  setFilters: (filters: SearchFilters) => void
  retry: () => void
  clear: () => void
  /** Cancels what is running and frees the picture preview. */
  dispose: () => void
}

/**
 * One search's state over a client: words wait `debounceMs` after the last keystroke, a picture or a likeness runs at
 * once, and a newer search aborts an older one, so results never arrive out of order. `by` defaults to `both` for
 * words and `look` for pictures and likeness, until set.
 *
 * @example
 * const search = createSearchController(client, { limit: 48 })
 * search.subscribe(() => paint(search.getState()))
 * search.setWords('bauhaus lettermark')
 */
export const createSearchController = <Item>(client: SearchClient<Item>, { debounceMs = 250, minLength = 2, limit, by: fixedBy, filters: initialFilters = {} }: { debounceMs?: number; minLength?: number; limit?: number; by?: SearchBy; filters?: SearchFilters } = {}): SearchController<Item> => {
  let state: SearchState<Item> = { input: { kind: 'idle' }, by: fixedBy ?? 'both', filters: initialFilters, status: 'idle', results: [], closest: [], error: null }
  let chosenBy = fixedBy
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let running: AbortController | undefined

  const set = (next: Partial<SearchState<Item>>) => {
    state = { ...state, ...next }
    listeners.forEach((listener) => listener())
  }
  const freePreview = (input: SearchInput) => {
    if (input.kind === 'picture') URL.revokeObjectURL(input.preview)
  }
  const byFor = (input: SearchInput): SearchBy => chosenBy ?? (input.kind === 'words' ? 'both' : 'look')

  const run = () => {
    clearTimeout(timer)
    running?.abort()
    const { input } = state
    if (input.kind === 'idle') return set({ status: 'idle', results: [], closest: [], error: null })
    const controller = new AbortController()
    running = controller
    const by = byFor(input)
    const options = { by: input.kind === 'similar' && by === 'both' ? 'look' : by, limit, filters: state.filters, signal: controller.signal } as const
    set({ status: 'loading', by, error: null })
    const answer = input.kind === 'words' ? client.byWords(input.text, options) : input.kind === 'picture' ? client.byPicture(input.picture, options) : client.similar(input.id, options)
    answer.then(
      ({ results, closest }) => controller === running && set({ status: 'done', results, closest }),
      (error: unknown) => {
        if (controller !== running || controller.signal.aborted) return
        set({ status: 'error', error: error instanceof SearchError ? error : new SearchError(0, 'network', 'The search could not reach the server. Check the connection and retry.') })
      },
    )
  }
  const start = (input: SearchInput, wait = 0) => {
    freePreview(state.input)
    clearTimeout(timer)
    set({ input })
    if (wait) timer = setTimeout(run, wait)
    else run()
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setWords: (text) => (text.trim().length < minLength ? start({ kind: 'idle' }) : start({ kind: 'words', text: text.trim() }, debounceMs)),
    setPicture: (picture) => start({ kind: 'picture', picture, preview: URL.createObjectURL(picture) }),
    similarTo: (id) => start({ kind: 'similar', id }),
    setBy: (by) => {
      chosenBy = by
      set({ by })
      run()
    },
    setFilters: (filters) => {
      set({ filters })
      run()
    },
    retry: run,
    clear: () => start({ kind: 'idle' }),
    dispose: () => {
      clearTimeout(timer)
      running?.abort()
      freePreview(state.input)
    },
  }
}

const IMAGE = /^image\/(png|jpeg|webp|gif)$/

/**
 * The first picture in a paste, a drop or a file list, or null.
 *
 * @example
 * window.addEventListener('paste', (event) => { const picture = pictureFrom(event.clipboardData) })
 */
export const pictureFrom = (source: DataTransfer | FileList | null | undefined): File | null => {
  if (!source) return null
  const files = 'items' in source ? Array.from(source.items, (item) => (item.kind === 'file' ? item.getAsFile() : null)) : Array.from(source)
  return files.find((file): file is File => !!file && IMAGE.test(file.type)) ?? null
}

/**
 * Listens on `target` (the window, or a drop zone) for a pasted (⌘V) or dropped picture. A paste without a picture,
 * or one another handler already took, is left alone, so typing and pasting text keep working. Returns the cleanup.
 *
 * @example
 * const stop = listenForPictures(window, (picture) => search.setPicture(picture))
 */
export const listenForPictures = (target: EventTarget, onPicture: (picture: File) => void, { paste = true, drop = true }: { paste?: boolean; drop?: boolean } = {}) => {
  const onPaste = (event: Event) => {
    const clipboard = (event as ClipboardEvent).clipboardData
    const picture = event.defaultPrevented ? null : pictureFrom(clipboard)
    if (!picture) return
    event.preventDefault()
    onPicture(picture)
  }
  const onDragOver = (event: Event) => {
    if ((event as DragEvent).dataTransfer?.types.includes('Files')) event.preventDefault()
  }
  const onDrop = (event: Event) => {
    const picture = pictureFrom((event as DragEvent).dataTransfer?.files)
    if (!picture) return
    event.preventDefault()
    onPicture(picture)
  }
  if (paste) target.addEventListener('paste', onPaste)
  if (drop) {
    target.addEventListener('dragover', onDragOver)
    target.addEventListener('drop', onDrop)
  }
  return () => {
    target.removeEventListener('paste', onPaste)
    target.removeEventListener('dragover', onDragOver)
    target.removeEventListener('drop', onDrop)
  }
}
