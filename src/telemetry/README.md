# telemetry

A daily anonymous usage report for a product people deploy for themselves, so its makers learn how many run it, which
version, and roughly how much each is used, without learning who or what. One POST a day to the product's collector;
the owner sees exactly what is sent and can switch it off.

Needs: `db`, `mcp` (for the tool).

| File | What |
|---|---|
| `schema.ts` | the `telemetry` table (one row: instance, since, enabled, last_sent_at, latest) and `TELEMETRY_MIGRATIONS` |
| `repo.ts` | `telemetryRepo`: the row (made on the first run), the switch, the stamps |
| `routes.ts` | `telemetryRoutes`: `GET` and `PATCH {path}` |
| `tools.ts` | `telemetryTools`: `get_telemetry` |
| `index.ts` | `telemetry` (`register`, `sendDaily`, `bodyOf`), `countRange`, `dayRange`, `coarseReport`, `TELEMETRY_TAG` |

## What is sent

`POST ${url}/v1/${product}` with exactly this body, and nothing else (the collector refuses other keys):

```json
{ "schema": 1, "instance": "0b6f6a3e-2f7c-4d1e-9a51-3f0f4b8f2c11", "version": "1.4.2", "report": { "notes": "11-100", "search_used": true } }
```

- `instance`: a random v4 UUID made on the deployment's first run. It ties one day's report to the next and to
  nothing else.
- `version`: like `1.2.3` or `1.2.3-beta.1`; anything else and nothing is sent.
- `report`: what the app's `collect` returns, **coarse ranges and booleans only**: counts through `countRange`
  (`0`, `1-10`, `11-100`, `101-1k`, `1k-10k`, `10k+`), ages through `dayRange` (`0`, `1-7`, `8-30`, `31-90`,
  `91-365`, `365+`), yes/no as `true`/`false`. A field with a fixed set of words (how it was installed) is declared in
  `choices`, and only those words pass. Never ids, names, emails, URLs, free text or exact numbers.
  `coarseReport` enforces it: a key that isn't lowercase `snake_case` or a value that isn't one of those ranges or a
  boolean is dropped, so a slip can't leak.

## Routes

```
GET   /api/telemetry   { on, why, enabled, endpoint, body, since, lastSentAt, latest }: body is exactly what is sent
PATCH /api/telemetry   { enabled } (owner only, through the isOwner hook) → the same
```

## Wiring

```ts
const usage = telemetry({
  product: 'notes', schemaVersion: 1, version: VERSION, url: 'https://pulse.example.com',
  collect: async (db) => ({ notes: countRange(await countNotes(db)), oldest_note: dayRange(await oldestNoteDays(db)), search_used: await searched(db) }),
})
await usage.register(app, { db, isOwner: (c) => isAdmin(c.get('caller'), fixedKeys) })
// MCP: tools: [...featureTools, ...telemetryTools()]; toolsRun sample: get_telemetry: {}

// worker.ts: a daily Cron Trigger ("0 3 * * *" in wrangler.jsonc)
export default { fetch, scheduled: (_event, env, ctx) => ctx.waitUntil(usage.sendDaily(db, env)) }
// Node: once an hour is fine, it sends at most once a UTC day
setInterval(() => void usage.sendDaily(db, process.env), 3_600_000)
```

`sendDaily` returns `{ sent, why }` for the app's logs.

## Rules

- Off, and nothing sent, when `DO_NOT_TRACK=1` (or `true`) or `TELEMETRY=off` is set, or the owner switched it off;
  `GET` says which. The route reads those from the Worker's bindings, else `process.env` (or pass `env`).
- Nothing in the first 24 hours after the first run; then at most one try per UTC day, recorded before the POST, so a
  dead collector is not hit again until tomorrow. A 5 second timeout. It never throws into the app.
- When the collector answers `{ "latest": "1.5.0" }`, `latest` is kept and shown: the newest version there is.
- Raise `schemaVersion` whenever `collect` changes what it returns.
- Say in the product's README and setup page that it reports, what, and how to switch it off.
- Standard: `docs/STANDARD.md` §18.
