# switches

Feature switches: every feature an app can work without, listed once, each on or off for everyone, one person or one
API key, and one place every route and background job asks. The owner switches through the API; a feature that is
off stays listed and answers `403 feature_disabled` ("This feature is disabled.").

Where the switches come from is one line: the app's own database today, a flag service (PostHog, LaunchDarkly,
anything with an SDK) tomorrow, or both in order. The keys are the catalog's in every one of them.

Needs: `db`, `mcp` (for the tools).

| File | What |
|---|---|
| `catalog.ts` | `defineFeatures` (checks the catalog at boot), `needsInOrder`, `dependentsOf`, `keyOf` (old names too), `parseFeatureList` |
| `providers.ts` | `FlagProvider` (OpenFeature-shaped: a targeting key, a value, a reason), `contextOf` (the caller as a context), `contextOfScope`, `isScope`, `memoryProvider`, `fromSdk` |
| `schema.ts` | the `feature_switches` table (key, scope, on, changed_by, changed_at) and `SWITCH_MIGRATIONS` |
| `repo.ts` | `switchesRepo`, `databaseProvider` (the table as a provider, read whole and kept 5 s) |
| `routes.ts` | `switchRoutes`: `GET {path}`, `GET` and `PATCH {path}/{key}` |
| `tools.ts` | `switchTools`: `list_features`, `switch_feature` |
| `index.ts` | `switches` (`isOn`, `assertOn`, `gate`, `gated`, `set`, `stateOf`, `register`), `SWITCHES_TAG` |

## The catalog: one file the app owns

```ts
// src/features/catalog.ts
export const CATALOG = defineFeatures({
  sending: { title: 'Sending', description: 'Mail out from the app: replies, new mail, answers.' },
  digest: { title: 'Daily digest', description: 'One mail a day with what changed.', needs: ['sending'], default: false },
  webhooks: { title: 'Webhooks', description: 'Events posted to other services.', renamedFrom: ['hooks'] },
})
```

- A **key** is lowercase words joined by hyphens. It is the name in the database, in `FEATURES_OFF` and in a flag
  service, so it never changes. A rename keeps the old name in `renamedFrom`; stores and `FEATURES_OFF` still read it,
  and the next switch moves a stored row to the new key.
- `needs`: a feature is off whenever one it needs is off (`blockedBy` says which). Loops are refused at boot.
- `default`: on unless given.

## Providers: one line

```ts
// src/features/flags.ts
export const flagProviders = (db: Db): FlagProvider[] => [databaseProvider(db)]
// later, a flag service decides first and the database the rest:
export const flagProviders = (db: Db): FlagProvider[] => [fromSdk({ name: 'posthog', allFlags: (context) => posthog.getAllFlags(context.targetingKey ?? 'everyone') }), databaseProvider(db)]
```

Each provider is asked in order for the keys still undecided; the first answer wins, and the catalog's default
decides what nobody answered. `FEATURES_OFF` comes before all of them.

- `databaseProvider(db)`: the `feature_switches` table. A row per feature and scope: `everyone`, `person:<email>` or
  `key:<name>`; the caller's own row wins over everyone's. It is the one the API writes to.
- `fromSdk({ name, allFlags | isOn, flagKeyOf?, cacheMs?, timeoutMs? })`: any flag service. `allFlags` (one call per
  caller) is preferred over `isOn` (one per key). `flagKeyOf` maps a key to the service's flag name. A value of
  `true`, `"on"` or a variant other than `"off"`/`"control"` is on; `undefined` means "not mine", and the next
  provider decides. Answers are kept per caller for `cacheMs` (5 s); a service slower than `timeoutMs` (300 ms) or
  failing is skipped for that call.
- `memoryProvider({ key: bool })`: fixed values, for tests or code.
- Your own: an object with `name`, `resolve(keys, context, options)` and, to be switchable through the API, `write`
  and `overrides`.

## Wiring

```ts
const flags = switches({ catalog: CATALOG, providers: flagProviders(db), off: parseFeatureList(env.FEATURES_OFF) })
await flags.register(app, { isOwner: (c) => isAdmin(c.get('caller'), fixedKeys), onSwitch: (change) => recordEvent(db, 'feature.switched', change) })
registerWebhooks(flags.gated(app, 'webhooks'), …)                   // its routes answer 403 while off
if (await flags.isOn('webhooks')) await pump(db)                    // background work: everyone's switch
await flags.assertOn('sending', contextOf(caller), { fresh: true }) // an action that leaves the app, as the caller
// MCP: tools: [...featureTools, ...switchTools()]; toolsRun samples: list_features: {}, switch_feature: { key, state: 'off', preview: true }
```

## Routes

```
GET   /api/features         every feature for you: on, own, source, reason, blockedBy, needs, alsoOff, overrides; providers, writable, locked, unknownOff
GET   /api/features/{key}   one feature
PATCH /api/features/{key}   { on: true | false | null, scope? } (owner only) → { dryRun, changes, feature }; ?dryRun=true changes nothing
```

A 403 for a switched-off feature:

```json
{ "code": "feature_disabled", "status": 403, "title": "Feature disabled", "detail": "This feature is disabled.", "feature": "digest", "blockedBy": ["sending"], "switchOn": "/api/features/sending" }
```

## Rules

- Only additive features go in the catalog. Sign-in, the app's main data and the switches' own routes are core and
  never gated.
- The gate runs after auth and before validation: no key gets 401, a switched-off feature 403 whatever the body.
- Work with no caller (incoming mail, queue jobs, scheduled runs) is resolved for everyone; an OAuth agent as the
  person who approved it.
- Answers are cached (the database's rows 5 s per isolate, a flag service's answers 5 s per caller). An action that
  leaves the app passes `fresh: true`.
- `PATCH` answers 409 when `FEATURES_OFF` locks the feature, when no provider can be written, or when a provider
  before the writable one decides it for that scope ("managed in posthog: change it there").
- Every switch the API makes goes to `onSwitch`: log it as an event.
- Standard: `docs/STANDARD.md` §21.
