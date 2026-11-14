/**
 * A daily anonymous usage report, for a product people deploy for themselves: once a day, from 24 hours after the
 * first run, it POSTs `{ schema, instance, version, report }` to `${url}/v1/${product}`. The instance is a random v4
 * UUID made on the first run; the report holds only coarse ranges (`countRange`, `dayRange`) and yes/no answers.
 * It sends nothing when `DO_NOT_TRACK=1` or `TELEMETRY=off` is set or the owner switched it off, and it never throws
 * into the app.
 *   GET   {path}   whether it is on, and exactly the body it would send
 *   PATCH {path}   { enabled } (owner only)
 *
 * @example
 * const usage = telemetry({ product: 'notes', schemaVersion: 1, version: '1.4.2', url: 'https://pulse.example.com',
 *   collect: async (db) => ({ notes: countRange(await countNotes(db)), search_used: await searchedThisWeek(db) }) })
 * await usage.register(app, { db, isOwner: (c) => isAdmin(c.get('caller'), fixedKeys) })
 * export default { fetch, scheduled: (_event, env, ctx) => ctx.waitUntil(usage.sendDaily(db, env)) }
 */
import type { OpenAPIHono, RouteHandler } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { linksOf, originOf } from '../core/hal.js'
import { ProblemError } from '../core/problem.js'
import { migrate, type Db } from '../db/index.js'
import { telemetryRepo } from './repo.js'
import { telemetryRoutes, type TelemetryRoutes } from './routes.js'
import { TELEMETRY_MIGRATIONS, type TelemetryRow } from './schema.js'

export { telemetryRepo, type TelemetryRepo } from './repo.js'
export { telemetryRoutes, type TelemetryRoutes } from './routes.js'
export { TELEMETRY_MIGRATIONS, telemetryState, type TelemetryRow } from './schema.js'
export { telemetryTools } from './tools.js'

export const TELEMETRY_TAG = { name: 'Telemetry', description: 'The daily anonymous usage report: what it sends, and the owner’s switch.' }

/** A value a report may hold: a range from `countRange` or `dayRange`, or a yes/no answer. */
export type TelemetryValue = string | boolean
export type TelemetryReport = Record<string, TelemetryValue>
/** The body the collector takes, and nothing else. */
export type TelemetryBody = { schema: number; instance: string; version: string; report: TelemetryReport }
/** What turns the report off from the environment: `DO_NOT_TRACK=1` or `TELEMETRY=off`. */
export type TelemetryEnv = { DO_NOT_TRACK?: string; TELEMETRY?: string }

export type TelemetryConfig = {
  /** The product's name, the last segment of the collector's path: lowercase letters, digits and hyphens. */
  product: string
  /** The version of the report's shape; raise it when `collect` changes what it returns. */
  schemaVersion: number
  /** The version running, `1.2.3` or `1.2.3-beta.1`. */
  version: string
  /** The collector's origin, e.g. `https://pulse.example.com`. */
  url: string
  /** The report: coarse ranges and yes/no answers only, plus the `choices` declared below. Anything else is dropped. */
  collect: (db: Db) => TelemetryReport | Promise<TelemetryReport>
  /** Fields that hold one of a fixed set of words, e.g. `{ install: ['deploy-button', 'wrangler', 'other'] }`. */
  choices?: Record<string, readonly string[]>
  /** For tests: the fetch that sends it. */
  fetch?: typeof fetch
  /**
   * The owner's switch kept elsewhere, e.g. a feature switch (`switches` part), so the app has one switch for it, not
   * two; the report's own `enabled` column is then left alone.
   */
  switch?: { isOn: () => boolean | Promise<boolean>; set: (enabled: boolean, by: string) => Promise<void> }
}

export type TelemetryRegisterOptions = {
  db: Db
  /** Whether the caller may switch the report (e.g. `isAdmin(caller, fixedKeys)` with the people part). */
  isOwner: (c: Context) => boolean | Promise<boolean>
  /** Where the switches from the environment are read; by default the Worker's bindings, else `process.env`. */
  env?: (c: Context) => TelemetryEnv
  path?: string
  tag?: string
}

const COUNT_RANGES = ['0', '1-10', '11-100', '101-1k', '1k-10k', '10k+'] as const
const DAY_RANGES = ['0', '1-7', '8-30', '31-90', '91-365', '365+'] as const
const RANGES = new Set<string>([...COUNT_RANGES, ...DAY_RANGES])
const KEY = /^[a-z][a-z0-9_]{0,39}$/
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9a-z.]{1,20})?$/
const PRODUCT = /^[a-z0-9][a-z0-9-]{0,39}$/
const DAY_MS = 86_400_000
const SEND_MS = 5000

/** countRange puts a count in its range: `0`, `1-10`, `11-100`, `101-1k`, `1k-10k` or `10k+`. @example countRange(42) // '11-100' */
export const countRange = (count: number): (typeof COUNT_RANGES)[number] =>
  count <= 0 ? '0' : count <= 10 ? '1-10' : count <= 100 ? '11-100' : count <= 1000 ? '101-1k' : count <= 10_000 ? '1k-10k' : '10k+'

/** dayRange puts a number of days in its range: `0`, `1-7`, `8-30`, `31-90`, `91-365` or `365+`. @example dayRange(12) // '8-30' */
export const dayRange = (days: number): (typeof DAY_RANGES)[number] =>
  days < 1 ? '0' : days <= 7 ? '1-7' : days <= 30 ? '8-30' : days <= 90 ? '31-90' : days <= 365 ? '91-365' : '365+'

/** coarseReport keeps what a report may hold: lowercase keys whose values are a range, a boolean or one of the key's declared choices; the rest is dropped. */
export const coarseReport = (report: Record<string, unknown>, choices: Record<string, readonly string[]> = {}): TelemetryReport =>
  Object.fromEntries(
    Object.entries(report).filter(
      ([key, value]) => KEY.test(key) && (typeof value === 'boolean' || (typeof value === 'string' && (RANGES.has(value) || (Object.hasOwn(choices, key) && choices[key]!.includes(value))))),
    ),
  ) as TelemetryReport

const callerName = (c: Context) => {
  const caller = c.get('caller' as never) as { kind?: string; name?: string; email?: string; owner?: string } | undefined
  return caller?.email ?? caller?.owner ?? caller?.name ?? 'unknown'
}

const processEnv = (): TelemetryEnv => (globalThis as { process?: { env?: TelemetryEnv } }).process?.env ?? {}
const envOf = (c: Context): TelemetryEnv => {
  const bindings = (c.env ?? {}) as TelemetryEnv
  return { DO_NOT_TRACK: bindings.DO_NOT_TRACK ?? processEnv().DO_NOT_TRACK, TELEMETRY: bindings.TELEMETRY ?? processEnv().TELEMETRY }
}

/**
 * The usage report for one product: `register` adds its routes, `sendDaily` is for the app's scheduled handler, and
 * `bodyOf` is the body as it would be sent now.
 *
 * @example
 * const usage = telemetry({ product: 'notes', schemaVersion: 1, version: VERSION, url: 'https://pulse.example.com', collect: async (db) => ({ notes: countRange(await countNotes(db)) }) })
 */
export const telemetry = (config: TelemetryConfig) => {
  const endpoint = `${config.url.replace(/\/+$/, '')}/v1/${config.product}`

  /** Why nothing may be sent, whatever the day, or null. */
  const offBecause = (env: TelemetryEnv, row: TelemetryRow) => {
    if (['1', 'true'].includes(String(env.DO_NOT_TRACK ?? '').toLowerCase())) return 'DO_NOT_TRACK is set in the environment.'
    if (['off', 'false', '0'].includes(String(env.TELEMETRY ?? '').toLowerCase())) return 'TELEMETRY=off is set in the environment.'
    if (!row.enabled) return 'The owner switched it off.'
    if (!PRODUCT.test(config.product)) return `The product name "${config.product}" is not lowercase letters, digits and hyphens.`
    if (!Number.isInteger(config.schemaVersion) || config.schemaVersion < 1) return `The schema version ${config.schemaVersion} is not a whole number from 1.`
    if (!VERSION.test(config.version)) return `The version "${config.version}" is not like 1.2.3.`
    return null
  }

  const bodyFor = async (db: Db, row: TelemetryRow): Promise<TelemetryBody> => ({ schema: config.schemaVersion, instance: row.instance, version: config.version, report: coarseReport(await config.collect(db), config.choices) })

  /** The body as it would be sent now, made from the app's `collect`. */
  /** The row, with `enabled` read from the app's own switch when it keeps one. */
  const stateOf = async (db: Db): Promise<TelemetryRow> => {
    const row = await telemetryRepo(db).state()
    return config.switch ? { ...row, enabled: await config.switch.isOn() } : row
  }

  const bodyOf = async (db: Db) => {
    await migrate(db, 'telemetry', TELEMETRY_MIGRATIONS)
    return bodyFor(db, await stateOf(db))
  }

  /**
   * Sends the day's report when it is due, for the app's scheduled handler: at most once a UTC day, never in the first
   * 24 hours, never when switched off. Tried at most once a day even when the collector is down; never throws.
   */
  const sendDaily = async (db: Db, env: TelemetryEnv = {}): Promise<{ sent: boolean; why: string }> => {
    try {
      await migrate(db, 'telemetry', TELEMETRY_MIGRATIONS)
      const repo = telemetryRepo(db)
      const row = await stateOf(db)
      const off = offBecause(env, row)
      if (off) return { sent: false, why: off }
      const now = new Date()
      if (now.getTime() - Date.parse(row.since) < DAY_MS) return { sent: false, why: 'Nothing is sent in the first 24 hours.' }
      if (row.lastSentAt?.slice(0, 10) === now.toISOString().slice(0, 10)) return { sent: false, why: 'Already sent today.' }
      const body = await bodyFor(db, row)
      await repo.markSent(now.toISOString())
      const answer = await (config.fetch ?? fetch)(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_MS) })
      if (!answer.ok) return { sent: false, why: `The collector answered ${answer.status}.` }
      const { latest } = ((await answer.json().catch(() => ({}))) ?? {}) as { latest?: unknown }
      if (typeof latest === 'string' && VERSION.test(latest)) await repo.setLatest(latest)
      return { sent: true, why: 'Sent.' }
    } catch (error) {
      return { sent: false, why: `Not sent: ${(error as Error).message}` }
    }
  }

  /** Registers `GET` and `PATCH {path}`, after migrating the telemetry table. */
  const register = async (app: OpenAPIHono, { db, isOwner, env = envOf, path = '/api/telemetry', tag = TELEMETRY_TAG.name }: TelemetryRegisterOptions) => {
    await migrate(db, 'telemetry', TELEMETRY_MIGRATIONS)
    const repo = telemetryRepo(db)
    // The first run starts here: the instance id and the 24 hours of quiet
    await repo.state()
    const routes = telemetryRoutes({ path, tag })
    const reportOf = async (c: Context) => {
      const row = await stateOf(db)
      const off = offBecause(env(c), row)
      return {
        on: !off,
        why: off ?? 'Sent once a day, from 24 hours after the first run.',
        enabled: row.enabled,
        endpoint,
        body: await bodyFor(db, row),
        since: row.since,
        lastSentAt: row.lastSentAt,
        latest: row.latest,
        _links: linksOf(originOf(c), { self: path }),
      }
    }

    const get: RouteHandler<TelemetryRoutes['get']> = async (c) => c.json(await reportOf(c), 200, { 'cache-control': 'no-store' })
    const update: RouteHandler<TelemetryRoutes['update']> = async (c) => {
      if (!(await isOwner(c))) throw new ProblemError('forbidden', { detail: 'Only the owner can switch the usage report.' })
      const { enabled } = c.req.valid('json')
      if (config.switch) await config.switch.set(enabled, callerName(c))
      else await repo.setEnabled(enabled)
      return c.json(await reportOf(c), 200, { 'cache-control': 'no-store' })
    }
    app.openapi(routes.get, get)
    app.openapi(routes.update, update)
  }

  return { register, sendDaily, bodyOf }
}

export type Telemetry = ReturnType<typeof telemetry>
