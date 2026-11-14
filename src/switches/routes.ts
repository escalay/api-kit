/** The feature switches as OpenAPI contracts: the list, one feature, and the owner's switch. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema } from '../core/hal.js'
import { problemResponses } from '../core/problem.js'

export const switchRoutes = ({ path, tag, keys }: { path: string; tag: string; keys: readonly string[] }) => {
  const example = keys[0] ?? 'webhooks'
  const OverrideSchema = z.object({
    scope: z.string().openapi({ description: 'Who it applies to: `everyone`, `person:<email>` or `key:<name>`.', example: 'everyone' }),
    on: z.boolean(),
    changedBy: z.string().openapi({ description: 'Who switched it: an email or a key’s name.', example: 'owner@example.com' }),
    changedAt: z.string().openapi({ example: '2026-11-14T09:00:00.000Z' }),
  })
  const FeatureSchema = z
    .object({
      key: z.string().openapi({ description: 'The feature’s stable key: the same in the database, `FEATURES_OFF` and a flag service.', example }),
      title: z.string(),
      description: z.string().openapi({ description: 'What switching it off stops.' }),
      on: z.boolean().openapi({ description: 'Whether it works for you: its own switch and every feature it needs.' }),
      own: z.boolean().openapi({ description: 'Its own switch alone.' }),
      source: z.string().openapi({ description: 'What decided its own switch: `locked` (the environment), a provider’s name, or `default`.', example: 'database' }),
      reason: z.string().openapi({ description: 'Why, in OpenFeature’s words: `STATIC` (everyone’s switch), `TARGETING_MATCH` (yours), `DEFAULT`, `LOCKED`.', example: 'STATIC' }),
      scope: z.string().optional().openapi({ description: 'The stored switch that decided it.', example: 'everyone' }),
      changedBy: z.string().optional().openapi({ description: 'Who switched it, when a store says.', example: 'owner@example.com' }),
      changedAt: z.string().optional().openapi({ description: 'When it was switched, when a store says.', example: '2026-11-14T09:00:00.000Z' }),
      blockedBy: z.array(z.string()).openapi({ description: 'Features it needs that are off.' }),
      default: z.boolean().openapi({ description: 'Whether it is on when nothing is stored.' }),
      locked: z.boolean().openapi({ description: 'Switched off by `FEATURES_OFF` in the environment: no switch here changes it.' }),
      needs: z.array(z.string()).openapi({ description: 'Features it cannot work without.' }),
      alsoOff: z.array(z.string()).openapi({ description: 'Features that stop when this one is switched off.' }),
      requires: z.string().optional().openapi({ description: 'What a license must grant for it to work at all; absent for a free feature.', example: 'enterprise' }),
      licensed: z.boolean().optional().openapi({ description: 'Whether this deployment’s license grants what it requires; absent for a free feature.' }),
      overrides: z.array(OverrideSchema).openapi({ description: 'The stored switches for it: everyone’s, and any for one person or key.' }),
      _links: LinksSchema,
    })
    .openapi('Feature', { description: 'One switchable feature, as it is for the caller, and the switches stored for it.' })
  const ChangeSchema = z.object({ key: z.string(), on: z.boolean().openapi({ description: 'What it would be (or now is).' }), was: z.boolean() })
  const SwitchedSchema = z
    .object({
      dryRun: z.boolean().openapi({ description: 'true: nothing was changed, this is what would happen.' }),
      key: z.string(),
      scope: z.string(),
      on: z.boolean().nullable(),
      changes: z.array(ChangeSchema).openapi({ description: 'Every feature whose state changes for that scope, this one and those that need it.' }),
      feature: FeatureSchema,
    })
    .openapi('FeatureSwitched', { description: 'A switch made, or with `dryRun`, what it would change.' })
  const keyParam = z.object({ key: z.string().openapi({ param: { name: 'key', in: 'path' }, description: 'The feature’s key, from the list.', example }) })

  return {
    list: createRoute({
      method: 'get',
      path,
      operationId: 'listFeatures',
      tags: [tag],
      summary: 'The features and their switches',
      description: 'Every feature that can be switched off, whether it works for you and what decided it, and where switches come from. A feature that is off answers its routes with 403 `feature_disabled`.',
      responses: {
        200: {
          content: {
            [HAL_JSON]: {
              schema: z
                .object({
                  count: z.number().int(),
                  license: z
                    .object({
                      status: z.enum(['valid', 'missing', 'expired', 'invalid']),
                      why: z.string().openapi({ example: 'Licensed to Acme (enterprise).' }),
                      plan: z.string().nullable(),
                      licensee: z.string().nullable(),
                      expiresAt: z.string().nullable(),
                      grants: z.array(z.string()).openapi({ description: 'What it unlocks: the plan and its grants.' }),
                      upgrade: z.string().nullable().openapi({ description: 'Where a license is bought or asked for.' }),
                    })
                    .nullable()
                    .openapi({ description: 'The deployment’s license, when the app sells features; null when it has no paid features.' }),
                  providers: z.array(z.string()).openapi({ description: 'Where switches come from, asked in this order.', example: ['database'] }),
                  writable: z.string().nullable().openapi({ description: 'The provider the switch route changes; null: none, switches are changed where they come from.', example: 'database' }),
                  locked: z.array(z.string()).openapi({ description: 'Features switched off by `FEATURES_OFF`.' }),
                  unknownOff: z.array(z.string()).openapi({ description: 'Names in `FEATURES_OFF` that are no feature: they switch nothing off.' }),
                  _embedded: z.object({ features: z.array(FeatureSchema) }),
                  _links: LinksSchema,
                })
                .openapi('FeatureList', { description: 'The features and their switches.' }),
            },
          },
          description: 'The features.',
        },
        ...problemResponses(401),
      },
    }),
    get: createRoute({
      method: 'get',
      path: `${path}/{key}`,
      operationId: 'getFeature',
      tags: [tag],
      summary: 'One feature',
      description: 'Whether one feature works for you, what decided it, and the switches stored for it.',
      request: { params: keyParam },
      responses: { 200: { content: { [HAL_JSON]: { schema: FeatureSchema } }, description: 'The feature.' }, ...problemResponses(401, 404) },
    }),
    update: createRoute({
      method: 'patch',
      path: `${path}/{key}`,
      operationId: 'switchFeature',
      tags: [tag],
      summary: 'Switch a feature on or off',
      description:
        'Switches a feature for everyone, one person or one API key; `on: null` removes that switch so the next less specific one decides. Owner only. Switching a feature off stops the features that need it too (`changes` lists them); try it first with `?dryRun=true`. 409 when `FEATURES_OFF` locks it or another provider manages it.',
      request: {
        params: keyParam,
        query: z.object({ dryRun: z.enum(['true', 'false']).optional().openapi({ description: '`true`: change nothing, answer what would change.', example: 'true' }) }),
        body: {
          required: true,
          content: {
            'application/json': {
              schema: z
                .object({
                  on: z.boolean().nullable().openapi({ description: 'true on, false off, null to remove this scope’s switch.', example: false }),
                  scope: z.string().optional().openapi({ description: 'Who it applies to: `everyone` (the default), `person:<email>` or `key:<name>`.', example: 'everyone' }),
                })
                .openapi('FeatureSwitch', { description: 'The switch.' }),
            },
          },
        },
      },
      responses: { 200: { content: { [HAL_JSON]: { schema: SwitchedSchema } }, description: 'Switched, or what would change.' }, ...problemResponses(400, 401, 403, 404, 409) },
    }),
  }
}

export type SwitchRoutes = ReturnType<typeof switchRoutes>
