/**
 * A suggested search UI over the `search-react` hooks, as a shadcn block: a search field that also takes a pasted (⌘V),
 * dropped or picked picture, a look/meaning/both switch, a live status line and a results grid. The app renders each
 * result (`renderResult`), so cards stay its own. Copy it, restyle it or skip it: the hooks carry all the logic.
 *
 * Install: `pnpm dlx shadcn@latest add @escalay/vector-search-ui` (README: registry setup), or `kit add
 * vector-search-ui --dir src/components/vector-search`. Needs the shadcn `button` and `input` (Radix or Base UI alike).
 *
 * @example
 * const client = useMemo(() => createSearchClient<RecipeCard>({ path: '/api/search', similarPath: '/api/recipes/{slug}/similar' }), [])
 * <VectorSearch client={client} getKey={(recipe) => recipe.slug} renderResult={({ item }) => <RecipeCard recipe={item} />} />
 */
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { SearchBy, SearchClient, SearchResult } from './search-client'
import { usePictureInput, useVectorSearch } from './search-react'

const BY: { value: SearchBy; label: string }[] = [
  { value: 'both', label: 'Both' },
  { value: 'look', label: 'Look' },
  { value: 'meaning', label: 'Meaning' },
]

export function VectorSearch<Item>({ client, renderResult, getKey, placeholder = 'Describe it, or paste a picture', limit, className }: { client: SearchClient<Item>; renderResult: (result: SearchResult<Item>) => ReactNode; getKey: (item: Item) => string; placeholder?: string; limit?: number; className?: string }) {
  const search = useVectorSearch(client, { limit })
  const [text, setText] = useState('')
  const picture = usePictureInput({
    onPicture: (file) => {
      setText('')
      search.setPicture(file)
    },
  })
  const status =
    search.status === 'loading' ? 'Searching…'
    : search.status === 'error' ? search.error?.detail
    : search.status === 'done' ? (search.results.length ? `${search.results.length} ${search.results.length === 1 ? 'match' : 'matches'}, best first` : 'Nothing stands out. Try other words, or compare by both.')
    : 'Type what you are looking for, or paste (⌘V), drop or choose a picture.'

  return (
    <div {...picture.dropProps} data-dragging={picture.dragging || undefined} className={cn('flex flex-col gap-4 rounded-lg', picture.dragging && 'ring-2 ring-ring ring-offset-2', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex min-w-0 flex-1 items-center">
          {search.input.kind === 'picture' ? (
            <span className="absolute left-1.5 flex items-center">
              <img src={search.input.preview} alt="Your picture" className="size-7 rounded object-cover" />
              <button type="button" aria-label="Remove the picture" onClick={search.clear} className="-ml-2 -mt-6 grid size-4 place-items-center rounded-full bg-foreground text-[10px] leading-none text-background">
                ×
              </button>
            </span>
          ) : null}
          <Input
            type="search"
            value={text}
            placeholder={search.input.kind === 'picture' ? 'Searching by your picture' : placeholder}
            aria-label="Search"
            className={cn(search.input.kind === 'picture' && 'pl-12')}
            onChange={(event) => {
              setText(event.target.value)
              search.setWords(event.target.value)
            }}
          />
        </div>
        <Button type="button" variant="outline" onClick={picture.openPicker}>
          Picture
        </Button>
        <input {...picture.inputProps} />
        <div role="group" aria-label="Compare by" className="flex gap-1">
          {BY.map(({ value, label }) => (
            <Button key={value} type="button" size="sm" variant={search.by === value ? 'secondary' : 'ghost'} aria-pressed={search.by === value} onClick={() => search.setBy(value)}>
              {label}
            </Button>
          ))}
        </div>
      </div>
      <p role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-muted-foreground">
        {status}
        {search.status === 'error' ? (
          <Button type="button" variant="link" size="sm" onClick={search.retry}>
            Retry
          </Button>
        ) : null}
      </p>
      {search.results.length ? (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {search.results.map((result) => (
            <li key={getKey(result.item)}>{renderResult(result)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
