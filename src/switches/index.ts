/**
 * Feature switches: the app's additive features listed in one catalog, each on or off for everyone, one person or one
 * API key, and one place every route and background job asks. A switched-off feature stays listed in the API and
 * answers `403 feature_disabled` ("This feature is disabled."); its background work does nothing.
 *
 * Where the switches come from is one line, `providers`: the app's database today, a flag service tomorrow, both in
 * order. The keys are the catalog's, the same in every store.
 *   GET   {path}         every feature, on or off for the caller, and why
 *   GET   {path}/{key}   one feature
 *   PATCH {path}/{key}   { on: true | false | null, scope? } (owner only; `?dryRun=true` says what would change)
 *
 * @example
 * const flags = switches({ catalog: CATALOG, providers: [databaseProvider(db)], off: parseFeatureList(env.FEATURES_OFF) })
 * await flags.register(app, { isOwner: (c) => isAdmin(c.get('caller'), fixedKeys) })
 * registerWebhooks(flags.gated(app, 'webhooks'), …)          // every route it adds answers 403 while off
 * if (await flags.isOn('webhooks')) await pumpWebhooks(db)    // background work asks too
 */
import type { OpenAPIHono, RouteHandler } from '@hono/zod-openapi'
import type { Context, MiddlewareHandler } from 'hono'
import type { Caller } from '../core/auth.js'
import { linksOf, originOf } from '../core/hal.js'
import { ProblemError, problemResponses } from '../core/problem.js'
import { dependentsOf, keyOf, needsInOrder, type Catalog } from './catalog.js'
import { contextOf, contextOfScope, isScope, type FlagAnswer, type FlagContext, type FlagOverride, type FlagProvider, type FlagReason, type ResolveOptions } from './providers.js'
import { switchRoutes, type SwitchRoutes } from './routes.js'

export { defineFeatures, dependentsOf, keyOf, needsInOrder, parseFeatureList, type Catalog, type FeatureSpec } from './catalog.js'
export { contextOf, contextOfScope, fromSdk, isScope, memoryProvider, type FlagAnswer, type FlagChange, type FlagContext, type FlagOverride, type FlagProvider, type FlagReason, type ResolveOptions, type SdkOptions } from './providers.js'
export { databaseProvider, switchesRepo, type SwitchesRepo } from './repo.js'
export { switchRoutes, type SwitchRoutes } from './routes.js'
export { featureSwitches, SWITCH_MIGRATIONS, type FeatureSwitchRow } from './schema.js'
export { featureTools, switchTools } from './tools.js'

export const SWITCHES_TAG = { name: 'Features', description: 'The switchable features: which are on, for whom, and the owner’s switches.' }

/** What a feature is for one caller, and what decided it. */
export type FeatureState = {
  key: string
  /** Whether it works for this caller: its own switch, and every feature it needs. */
  on: boolean
  /** Its own switch alone. */
  own: boolean
  /** What decided its own switch: `locked` (the environment), a provider's name, or `default` (the catalog). */
  source: string
  reason: FlagReason | 'LOCKED'
  /** The stored switch that decided it, when a provider says. */
  scope?: string
  /** Who switched it, and when, when a provider says. */
  changedBy?: string
  changedAt?: string
  /** Features it needs that are off, which turn it off whatever its own switch says. */
  blockedBy: string[]
}

export type SwitchesConfig<C extends Catalog> = {
  catalog: C
  /** Where switches come from, asked in order; the first answer wins and the catalog's default decides the rest. */
  providers: FlagProvider[]
  /** Features switched off by the environment (`FEATURES_OFF`), whatever any store says. Old names are read too. */
  off?: readonly string[]
  /** Where the switches' routes live, for the `switchOn` link in a 403. `/api/features` unless given. */
  path?: string
}

export type SwitchesRegisterOptions = {
  /** Whether the caller may switch features (e.g. `isAdmin(caller, fixedKeys)`). */
  isOwner: (c: Context) => boolean | Promise<boolean>
  /** Told about every switch that changed, e.g. to log an event. */
  onSwitch?: (change: { key: string; scope: string; on: boolean | null; by: string }, c: Context) => void | Promise<void>
  tag?: string
}

/** Who a stored scope switched a feature off for, in words. */
const forWhom = (scope: string | undefined) => (!scope || scope === 'everyone' ? 'for everyone' : scope.startsWith('key:') ? `for the key ${scope.slice(4)}` : `for ${scope.slice(7)}`)

/** Why a feature is off, in a sentence: its own switch, or the one it needs. @example 'Reading fields (`extract`) is off for everyone, switched off by owner at 2026-11-14 10:02 UTC.' */
const disabledBecause = (catalog: Catalog, state: FeatureState, cause: FeatureState) => {
  const name = (key: string) => `${catalog[key]?.title ?? key} (\`${key}\`)`
  const offBy =
    cause.source === 'locked'
      ? 'is switched off by FEATURES_OFF in the deployment’s settings'
      : cause.source === 'default'
        ? 'is off unless switched on'
        : `is off ${forWhom(cause.scope)}${cause.changedBy ? `, switched off by ${cause.changedBy}${cause.changedAt ? ` at ${cause.changedAt.slice(0, 16).replace('T', ' ')} UTC` : ''}` : ` (${cause.source})`}`
  return cause === state ? `${name(state.key)} ${offBy}.` : `${name(state.key)} needs ${name(cause.key)}, which ${offBy}.`
}

/** What turns a feature back on, in a sentence. */
const howToSwitchOn = (cause: FeatureState, switchOn: string) =>
  cause.source === 'locked'
    ? 'Only the deployment’s settings can switch it on: remove it from FEATURES_OFF.'
    : `An owner switches it on with switch_feature {"key": "${cause.key}", "state": "on"} or PATCH ${switchOn} {"on": true}; ask them rather than retrying, and never switch it yourself to finish a task.`

const callerOf = (c: Context) => c.get('caller' as never) as Caller | undefined
const nameOf = (caller: Caller | undefined) => (caller?.kind === 'person' ? caller.email : caller?.kind === 'agent' ? caller.owner : (caller?.name ?? 'unknown'))

/**
 * switches is the app's one feature-switch layer: `isOn` and `assertOn` for code, `gated` and `gate` for routes,
 * `register` for the API, `set` for code that switches (a setup step, a settings screen).
 *
 * @example
 * const flags = switches({ catalog: CATALOG, providers: [databaseProvider(db)] })
 * await flags.isOn('digest', contextOf(caller)) // true
 */
export const switches = <C extends Catalog>({ catalog, providers, off = [], path = '/api/features' }: SwitchesConfig<C>) => {
  type Key = keyof C & string
  const keys = Object.keys(catalog)
  const oldNames = Object.fromEntries(keys.map((key) => [key, catalog[key]!.renamedFrom ?? []]))
  const locked = new Set(off.map((name) => keyOf(catalog, name)).filter((key) => key !== undefined))
  /** Names in `FEATURES_OFF` the catalog does not know: a typo that switches nothing off. */
  const unknownOff = off.filter((name) => keyOf(catalog, name) === undefined)
  const writer = providers.find((provider) => provider.write)
  const options = (fresh?: boolean): ResolveOptions => ({ fresh, oldNames })

  type Own = Pick<FeatureState, 'own' | 'source' | 'reason' | 'scope' | 'changedBy' | 'changedAt'>
  /** Each feature's own switch: a lock, else the first provider that answers, else the catalog's default. */
  const ownOf = async (context: FlagContext, fresh?: boolean) => {
    const own: Record<string, Own> = {}
    for (const key of locked) own[key] = { own: false, source: 'locked', reason: 'LOCKED' }
    for (const provider of providers) {
      const open = keys.filter((key) => !own[key])
      if (!open.length) break
      const answers: Record<string, FlagAnswer | undefined> = await provider.resolve(open, context, options(fresh)).catch((error: Error) => {
        console.warn(`flags: ${provider.name} skipped: ${error.message}`)
        return {}
      })
      for (const key of open) {
        const answer = answers[key]
        if (answer) own[key] = { own: answer.value, source: provider.name, reason: answer.reason, ...(answer.scope ? { scope: answer.scope } : {}), ...(answer.by ? { changedBy: answer.by } : {}), ...(answer.at ? { changedAt: answer.at } : {}) }
      }
    }
    for (const key of keys) own[key] ??= { own: catalog[key]!.default ?? true, source: 'default', reason: 'DEFAULT' }
    return own
  }

  /** Each feature for a caller: its own switch, turned off by any feature it needs that is off. */
  const settle = (own: Record<string, Own>): Record<string, FeatureState> =>
    Object.fromEntries(
      keys.map((key) => {
        const blockedBy = needsInOrder(catalog, key).filter((need) => !own[need]!.own)
        return [key, { key, ...own[key]!, on: own[key]!.own && blockedBy.length === 0, blockedBy }]
      }),
    )

  /** Every feature for one caller (everyone when no context), in one call per provider. */
  const stateOf = async (context: FlagContext = {}, { fresh }: { fresh?: boolean } = {}) => settle(await ownOf(context, fresh))

  /** Whether one feature works for a caller; `fresh` skips the caches, for an action that leaves the app. */
  const isOn = async (key: Key, context: FlagContext = {}, { fresh }: { fresh?: boolean } = {}) => (await stateOf(context, { fresh }))[key]!.on

  /** A 403 that names the feature, who it is off for, who switched it and how it comes back on. */
  const disabled = (state: FeatureState, all: Record<string, FeatureState>) => {
    const cause = all[state.blockedBy[0] ?? state.key]!
    const switchOn = `${path}/${cause.key}`
    return new ProblemError('feature_disabled', {
      detail: `This feature is disabled. ${disabledBecause(catalog, state, cause)} ${howToSwitchOn(cause, switchOn)}`,
      extensions: {
        feature: state.key,
        blockedBy: state.blockedBy,
        reason: cause.reason,
        ...(cause.scope ? { scope: cause.scope } : {}),
        ...(cause.changedBy ? { changedBy: cause.changedBy, changedAt: cause.changedAt } : {}),
        ...(cause.source === 'locked' ? { locked: true } : {}),
        switchOn,
      },
    })
  }

  /** Throws `feature_disabled` (403) unless the feature works for the caller. */
  const assertOn = async (key: Key, context: FlagContext = {}, { fresh }: { fresh?: boolean } = {}) => {
    const all = await stateOf(context, { fresh })
    if (!all[key]!.on) throw disabled(all[key]!, all)
  }

  /** A route middleware: 403 `feature_disabled` for the caller while the feature is off. Runs after auth, before validation. */
  const gate =
    (key: Key): MiddlewareHandler =>
    async (c, next) => {
      await assertOn(key, contextOf(callerOf(c)))
      await next()
    }

  /**
   * gated is the app as one feature sees it: every route the feature adds through it (`openapi`, `get`, `post`, …)
   * answers 403 while the feature is off, and documents that 403.
   */
  const gated = (app: OpenAPIHono, key: Key): OpenAPIHono => {
    const check = gate(key)
    const withGate = (method: string) => (route: string, ...handlers: unknown[]) => (app as unknown as Record<string, (...rest: unknown[]) => unknown>)[method]!(route, check, ...handlers)
    return new Proxy(app, {
      get(target, prop, receiver) {
        if (prop === 'openapi')
          return (route: Parameters<OpenAPIHono['openapi']>[0], ...rest: unknown[]) => {
            const middleware = [check, ...(route.middleware ? [route.middleware].flat() : [])]
            const responses = route.responses[403] ? route.responses : { ...route.responses, ...problemResponses(403) }
            return (target.openapi as (...all: unknown[]) => unknown)({ ...route, middleware, responses }, ...rest)
          }
        if (typeof prop === 'string' && ['get', 'post', 'put', 'patch', 'delete'].includes(prop)) return withGate(prop)
        const value = Reflect.get(target, prop, receiver) as unknown
        return typeof value === 'function' ? (value as (...all: unknown[]) => unknown).bind(target) : value
      },
    })
  }

  /** The provider that already decides a key for a scope, ahead of the one the API writes to; such a switch is changed there. */
  const managedElsewhere = async (key: string, scope: string) => {
    for (const provider of providers) {
      if (provider === writer) return undefined
      const answers: Record<string, FlagAnswer | undefined> = await provider.resolve([key], contextOfScope(scope), options(true)).catch(() => ({}))
      if (answers[key]) return provider.name
    }
    return undefined
  }

  /** What each feature would be for a scope after a change, next to what it is now: the features that would change. */
  const previewOf = async (key: string, scope: string, on: boolean | null) => {
    const context = contextOfScope(scope)
    const now = await ownOf(context, true)
    const after = { ...now }
    if (on !== null) after[key] = { own: on, source: writer!.name, reason: scope === 'everyone' ? 'STATIC' : 'TARGETING_MATCH', scope }
    // Cleared: the next less specific switch decides, which for a person or a key is everyone's
    else after[key] = scope === 'everyone' ? { own: catalog[key]!.default ?? true, source: 'default', reason: 'DEFAULT' } : (await ownOf({}, true))[key]!
    const before = settle(now)
    const later = settle(after)
    return keys.filter((other) => before[other]!.on !== later[other]!.on).map((other) => ({ key: other, on: later[other]!.on, was: before[other]!.on }))
  }

  /** The checks before a change, as a problem; nothing when it may go ahead. */
  const refusalOf = async (key: string, scope: string): Promise<ProblemError | undefined> => {
    if (!isScope(scope)) return new ProblemError('bad_request', { detail: `"${scope}" is not a scope: use everyone, person:<email> or key:<name>.` })
    if (locked.has(key)) return new ProblemError('conflict', { detail: `"${key}" is switched off by FEATURES_OFF in the environment; remove it there to switch it here.` })
    if (!writer) return new ProblemError('conflict', { detail: `Switches here come from ${providers.map((provider) => provider.name).join(', ') || 'nothing'}, none of which the API can change.` })
    const elsewhere = await managedElsewhere(key, scope)
    if (elsewhere) return new ProblemError('conflict', { detail: `"${key}" is managed in ${elsewhere} for ${scope}: change it there.` })
    return undefined
  }

  /** Switches one feature for one scope (`on: null` removes that scope's switch); for code, after its own permission check. */
  const set = async ({ key, scope = 'everyone', on, by }: { key: Key; scope?: string; on: boolean | null; by: string }) => {
    const refusal = await refusalOf(key, scope)
    if (refusal) throw refusal
    await writer!.write!({ key, scope, on, by }, options(true))
  }

  /** The list of features as the API shows it to one caller. */
  const listFor = async (c: Context) => {
    const state = await stateOf(contextOf(callerOf(c)), { fresh: true })
    const overrides: FlagOverride[] = (await writer?.overrides?.(options(true))) ?? []
    const origin = originOf(c)
    const featureOf = (key: string) => ({
      ...state[key]!,
      title: catalog[key]!.title,
      description: catalog[key]!.description,
      default: catalog[key]!.default ?? true,
      locked: locked.has(key),
      needs: [...(catalog[key]!.needs ?? [])],
      alsoOff: dependentsOf(catalog, key),
      overrides: overrides.filter((override) => override.key === key).map(({ scope, on, changedBy, changedAt }) => ({ scope, on, changedBy, changedAt })),
      _links: linksOf(origin, { self: `${path}/${key}`, switch: `${path}/${key}` }),
    })
    return { featureOf, overrides }
  }

  /** Registers `GET {path}`, `GET` and `PATCH {path}/{key}`. */
  const register = async (app: OpenAPIHono, { isOwner, onSwitch, tag = SWITCHES_TAG.name }: SwitchesRegisterOptions) => {
    const routes = switchRoutes({ path, tag, keys })
    const known = (name: string) => {
      const key = keyOf(catalog, name)
      if (!key) throw new ProblemError('not_found', { detail: `No feature "${name}". The features are: ${keys.join(', ')}.` })
      return key
    }

    const list: RouteHandler<SwitchRoutes['list']> = async (c) => {
      const { featureOf } = await listFor(c)
      return c.json(
        {
          count: keys.length,
          providers: providers.map((provider) => provider.name),
          writable: writer?.name ?? null,
          locked: [...locked],
          unknownOff,
          _embedded: { features: keys.map(featureOf) },
          _links: linksOf(originOf(c), { self: path }),
        },
        200,
        { 'cache-control': 'no-store' },
      )
    }
    const get: RouteHandler<SwitchRoutes['get']> = async (c) => c.json((await listFor(c)).featureOf(known(c.req.valid('param').key)), 200, { 'cache-control': 'no-store' })
    const update: RouteHandler<SwitchRoutes['update']> = async (c) => {
      if (!(await isOwner(c))) throw new ProblemError('forbidden', { detail: 'Only the owner can switch features.' })
      const key = known(c.req.valid('param').key)
      const { on, scope = 'everyone' } = c.req.valid('json')
      const refusal = await refusalOf(key, scope)
      if (refusal) throw refusal
      const changes = await previewOf(key, scope, on)
      if (c.req.valid('query').dryRun === 'true') return c.json({ dryRun: true, key, scope, on, changes, feature: (await listFor(c)).featureOf(key) }, 200, { 'cache-control': 'no-store' })
      const by = nameOf(callerOf(c))
      await writer!.write!({ key, scope, on, by }, options(true))
      await onSwitch?.({ key, scope, on, by }, c)
      return c.json({ dryRun: false, key, scope, on, changes, feature: (await listFor(c)).featureOf(key) }, 200, { 'cache-control': 'no-store' })
    }
    app.openapi(routes.list, list)
    app.openapi(routes.get, get)
    app.openapi(routes.update, update)
  }

  return { catalog, keys, unknownOff, stateOf, isOn, assertOn, gate, gated, set, register }
}

export type Switches<C extends Catalog = Catalog> = ReturnType<typeof switches<C>>
