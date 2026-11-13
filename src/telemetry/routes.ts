/** The telemetry routes as OpenAPI contracts: what the daily report would send, and the owner's switch. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema } from '../core/hal.js'
import { problemResponses } from '../core/problem.js'

const TelemetryBodySchema = z
  .object({
    schema: z.number().int().openapi({ description: 'The version of the report’s shape.', example: 1 }),
    instance: z.string().openapi({ description: 'A random id made on this deployment’s first run; it names no person or place.', example: '0b6f6a3e-2f7c-4d1e-9a51-3f0f4b8f2c11' }),
    version: z.string().openapi({ description: 'The version of the product running here.', example: '1.4.2' }),
    report: z.record(z.string(), z.union([z.string(), z.boolean()])).openapi({ description: 'Coarse ranges and yes/no answers, never ids or text.', example: { boards: '11-100', search_used: true } }),
  })
  .openapi('TelemetryBody', { description: 'The body the daily report sends, exactly.' })

const TelemetrySchema = z
  .object({
    on: z.boolean().openapi({ description: 'Whether the daily report is sent: the owner’s switch, and neither `DO_NOT_TRACK=1` nor `TELEMETRY=off` set.' }),
    why: z.string().openapi({ description: 'Why it is on or off, in a sentence.', example: 'Sent once a day, from 24 hours after the first run.' }),
    enabled: z.boolean().openapi({ description: 'The owner’s switch alone (`PATCH` changes it).' }),
    endpoint: z.string().openapi({ description: 'Where the report goes.', example: 'https://pulse.example.com/v1/notes' }),
    body: TelemetryBodySchema,
    since: z.string().openapi({ description: 'The first run; nothing is sent in the 24 hours after it.' }),
    lastSentAt: z.string().nullable().openapi({ description: 'When a report was last sent (tried, at most once a day). Null: never.' }),
    latest: z.string().nullable().openapi({ description: 'The newest version the collector named in its last answer. Null: none yet.', example: '1.5.0' }),
    _links: LinksSchema,
  })
  .openapi('Telemetry', { description: 'The daily anonymous usage report: whether it is on, and exactly what it would send.' })

export const telemetryRoutes = ({ path, tag }: { path: string; tag: string }) => ({
  get: createRoute({
    method: 'get',
    path,
    operationId: 'getTelemetry',
    tags: [tag],
    summary: 'The usage report',
    description: 'Whether the daily anonymous usage report is on, and exactly the body it would send now: coarse ranges and yes/no answers, never ids or text.',
    responses: { 200: { content: { [HAL_JSON]: { schema: TelemetrySchema } }, description: 'The report and its state.' }, ...problemResponses(401) },
  }),
  update: createRoute({
    method: 'patch',
    path,
    operationId: 'updateTelemetry',
    tags: [tag],
    summary: 'Switch the usage report on or off',
    description: 'Turns the daily usage report on or off for this deployment. Owner only. `DO_NOT_TRACK=1` or `TELEMETRY=off` in the environment keep it off whatever this says.',
    request: {
      body: {
        required: true,
        content: { 'application/json': { schema: z.object({ enabled: z.boolean().openapi({ description: 'true to send the report, false to stop.', example: false }) }).openapi('TelemetryInput', { description: 'The switch.' }) } },
      },
    },
    responses: { 200: { content: { [HAL_JSON]: { schema: TelemetrySchema } }, description: 'Switched.' }, ...problemResponses(400, 401, 403) },
  }),
})

export type TelemetryRoutes = ReturnType<typeof telemetryRoutes>
