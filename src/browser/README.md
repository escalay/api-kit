# browser

The browser side, for the app's frontend (not the API): typed clients for the search and board routes, headless
React hooks over them, and an optional shadcn search block. Logic only; each app draws its own UI.

| Part | Files | What |
|---|---|---|
| `search-client` | `search-client.ts` | `createSearchClient`, `createSearchController` (debounce, cancel, picture paste and drop) |
| `search-react` | `search-react.ts` | `useVectorSearch`, `usePictureInput`, `useSimilar` |
| `vector-search-ui` | `vector-search-block.tsx` | an optional search block (shadcn `button` + `input`) |
| `boards-client` | `boards-client.ts` + `../boards/refs.ts` | `createBoardsClient`: list, create, save, unsave, suggestions; `BoardsError` carries the problem |
| `boards-react` | `boards-react.ts` | `useBoards`, `useItemBoards` |
| `switches-client` | `switches-client.ts` | `createFeaturesClient`: the features for the person signed in (`isOn`, refresh on focus, `switch` with `dryRun`, `onDisabled` and `watchFetch` for every 403 `feature_disabled`); `isFeatureDisabled`, `whyOff` |
| `switches-react` | `switches-react.tsx` | `FeaturesProvider`, `useFeature`, `<Feature>`, `useFeatures`, `useSwitchFeature`, `useFeatureDisabled`, `featureHooks<Key>()` |
| `switches-ui` | `switches-block.tsx` | `FeatureSwitches` (the owner's panel, everyone's switch per feature, confirming what else stops: `groups` puts features in titled cards, nesting what needs another, `iconOf` gives each its icon tile, paid ones carry their plan as a badge and a card opens with where to get them; `keys` for one plain card; a status line only when the switch can't say it, such as who switched it off; a quiet line when a person or key has its own switch) and `FeatureDisabledNotice` (shadcn `button` + `switch`) |

```bash
# into the frontend, tracked by the API's kit.json
npx @escalay/kit add boards-react --dir apps/api/src/kit --web-dir ../../web/src/kit
# or one part with the shadcn CLI, into src/kit
npx shadcn add escalay/api-kit/boards-react
```

```ts
const boards = createBoardsClient<RecipeCard>()
const saved = (await boards.list()).find((b) => b.name === 'Saved') ?? (await boards.create('Saved'))
await boards.save(saved.id, boardRef('recipe', slug), 'the sun')
```

Feature switches in a React app, typed by the API's catalog (`src/features/catalog.ts`):

```tsx
export type FeatureKey = keyof typeof CATALOG
export const features = createFeaturesClient<FeatureKey>()
export const { useFeature, Feature, useSwitchFeature } = featureHooks<FeatureKey>()
const api = features.watchFetch(fetch)                       // the app's calls: a 403 feature_disabled refreshes the list

<FeaturesProvider client={features}>
  <Feature name="digest" off={<FeatureDisabledNotice name="digest" action={<UpgradeButton />} />}><Digest /></Feature>
  <FeatureSwitches canSwitch={me.role === 'owner'} />         // Settings
</FeaturesProvider>
useFeatureDisabled((problem) => toast.error(problem.detail)) // one alert for every switched-off call
```

## Rules

- The clients use the page's own sign-in (same-origin cookies); a failure is a typed error with the API's `detail`.
- Typechecked with bundler resolution (`tsconfig.web.json`).
- `useFeature` says `on: false` until the list arrived (`ready`), so a switchable screen never flashes in and out.
- Standard: `docs/STANDARD.md` §16, and §21 for the switches.
