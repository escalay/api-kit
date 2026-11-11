/**
 * React hooks over `search-client.ts`: the state and actions of a search, with no markup. Each app draws its own search
 * box, picture chip and results; `vector-search.tsx` is one suggested way to, which an app can copy, restyle or skip.
 *
 *   useVectorSearch   one search (words, a picture, or one item's likeness) and what to do with it
 *   usePictureInput   paste (⌘V), drop and a file picker that hand over a picture
 *   useSimilar        items like one, reloaded when the id changes
 *
 * @example
 * const client = useMemo(() => createSearchClient<RecipeCard>({ path: '/api/search', similarPath: '/api/recipes/{slug}/similar' }), [])
 * const search = useVectorSearch(client, { limit: 48 })
 * const picture = usePictureInput({ onPicture: search.setPicture })
 * <input value={text} onChange={(event) => { setText(event.target.value); search.setWords(event.target.value) }} />
 * <div {...picture.dropProps}>{search.results.map((result) => <Card key={result.item.id} {...result.item} />)}</div>
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type DragEvent } from 'react'
import { createSearchController, listenForPictures, pictureFrom, type SearchBy, type SearchClient, type SearchController, type SearchFilters, type SearchState } from './search-client'

type ControllerOptions = Parameters<typeof createSearchController>[1]

/**
 * One search's state and actions. The controller lives as long as the component; a new client starts a new one.
 *
 * @example
 * const { status, results, error, input, setWords, setPicture, setBy, clear } = useVectorSearch(client)
 */
export const useVectorSearch = <Item>(client: SearchClient<Item>, options: ControllerOptions = {}): SearchState<Item> & Omit<SearchController<Item>, 'getState' | 'subscribe' | 'dispose'> => {
  const [controller, setController] = useState(() => createSearchController(client, options))
  const made = useRef(client)
  useEffect(() => {
    if (made.current === client) return
    made.current = client
    setController(createSearchController(client, options))
    // Options are read once per client, like a store's initial state
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])
  useEffect(() => () => controller.dispose(), [controller])
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState)
  const { setWords, setPicture, similarTo, setBy, setFilters, retry, clear } = controller
  return { ...state, setWords, setPicture, similarTo, setBy, setFilters, retry, clear }
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

/**
 * Paste, drop and pick a picture. Pastes are heard on the whole window by default (`paste: 'window'`), or only while
 * focus is inside `scope`; `dropProps` go on whatever should take a drop, `inputProps` on a hidden file input.
 *
 * @example
 * const picture = usePictureInput({ onPicture: search.setPicture })
 * <div {...picture.dropProps} data-dragging={picture.dragging}>…<button onClick={picture.openPicker}>Choose a picture</button><input {...picture.inputProps} /></div>
 */
export const usePictureInput = ({ onPicture, paste = 'window', scope }: { onPicture: (picture: File) => void; paste?: 'window' | 'scope' | false; scope?: { current: HTMLElement | null } }) => {
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const latest = useRef(onPicture)
  latest.current = onPicture
  useEffect(() => {
    const target = paste === 'window' ? window : paste === 'scope' ? scope?.current : null
    return target ? listenForPictures(target, (picture) => latest.current(picture), { drop: false }) : undefined
  }, [paste, scope])
  const take = useCallback((picture: File | null) => picture && latest.current(picture), [])
  return {
    dragging,
    openPicker: () => input.current?.click(),
    dropProps: {
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragging(true)
      },
      onDragLeave: () => setDragging(false),
      onDrop: (event: DragEvent) => {
        setDragging(false)
        const picture = pictureFrom(event.dataTransfer.files)
        if (!picture) return
        event.preventDefault()
        take(picture)
      },
    },
    inputProps: {
      ref: input,
      type: 'file' as const,
      accept: ACCEPT,
      hidden: true,
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        take(pictureFrom(event.target.files))
        event.target.value = ''
      },
    },
  }
}

/**
 * Items like one, by look (default) or meaning; reloads when the id, `by` or the filters change, and stays idle
 * without an id.
 *
 * @example
 * const { status, results } = useSimilar(client, recipe.slug, { by: 'look', limit: 12 })
 */
export const useSimilar = <Item>(client: SearchClient<Item>, id: string | null | undefined, { by = 'look', limit, filters }: { by?: Exclude<SearchBy, 'both'>; limit?: number; filters?: SearchFilters } = {}) => {
  const search = useVectorSearch(client, { by, limit, filters })
  const filterKey = JSON.stringify(filters ?? {})
  useEffect(() => {
    if (!id) return search.clear()
    search.similarTo(id)
    // The controller's actions are stable; the inputs are the id and settings
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  useEffect(() => {
    if (search.by !== by) search.setBy(by)
    if (JSON.stringify(search.filters) !== filterKey) search.setFilters(filters ?? {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [by, filterKey])
  return { status: search.status, results: search.results, error: search.error, retry: search.retry }
}
