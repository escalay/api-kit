/** The setup routes as OpenAPI contracts: is it claimed, claim or recover it, and the checklist. */
import { createRoute, z } from '@hono/zod-openapi'
import { HAL_JSON, LinksSchema } from '../core/hal.js'
import { problemResponses } from '../core/problem.js'

const SetupStatusSchema = z
  .object({
    claimed: z.boolean().openapi({ description: 'Whether an owner has claimed this deployment.' }),
    codeSet: z.boolean().openapi({ description: 'Whether a setup code is set (`SETUP_CODE`). Without one, nobody can claim.' }),
    recovery: z.boolean().openapi({ description: 'Claimed, and the setup code was changed since: the owner can add a new passkey with the new code.' }),
    _links: LinksSchema,
  })
  .openapi('SetupStatus', { description: 'Where this deployment is in its setup.' })

const ClaimSchema = z
  .object({
    mode: z.enum(['claim', 'recover']).openapi({ description: '`claim`: you are now the owner. `recover`: you are the owner again.' }),
    enrolment: z.string().openapi({ description: 'Send it with the passkey registration: it lets you add a passkey before you are signed in. Lasts 15 minutes.' }),
    _links: LinksSchema,
  })
  .openapi('SetupClaim', { description: 'The owner is set; next, make a passkey with the enrolment.' })

const StepSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    why: z.string(),
    minutes: z.number().openapi({ description: 'About how long the step takes by hand.' }),
    optional: z.boolean(),
    ok: z.boolean().openapi({ description: 'Checked just now, for real: true only when it works.' }),
    detail: z.string().openapi({ description: 'What the check found, and what to do when it is not ok.' }),
    fixUrl: z.string().nullable().openapi({ description: 'Where to fix it, when that is a page elsewhere (a dashboard).' }),
  })
  .openapi('SetupStep', { description: 'One step of the setup, with what a check of it found.' })

export const setupRoutes = ({ path, tag }: { path: string; tag: string }) => ({
  status: createRoute({
    method: 'get',
    path,
    operationId: 'getSetup',
    tags: [tag],
    summary: 'Setup status',
    description: 'Whether this deployment is claimed, whether a setup code is set, and whether recovery is open. Never needs a key.',
    security: [],
    responses: { 200: { content: { [HAL_JSON]: { schema: SetupStatusSchema } }, description: 'The status.' } },
  }),
  claim: createRoute({
    method: 'post',
    path: `${path}/claim`,
    operationId: 'claimSetup',
    tags: [tag],
    summary: 'Claim or recover the deployment',
    description:
      'With the setup code from the deploy form (`SETUP_CODE`): the first person to send it becomes the owner. Once claimed, a different code (the secret was changed) lets the owner back in. Either way the answer carries an enrolment for making a passkey. 5 tries an hour per address, 20 a day in all.',
    security: [],
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z
              .object({
                code: z.string().min(1).max(100).openapi({ description: 'The setup code.', example: 'K7Q2-9XMD' }),
                email: z.email().openapi({ description: 'The owner’s email: where Mailroom-style tools send what is meant for the owner.', example: 'owner@example.com' }),
                name: z.string().max(80).optional(),
              })
              .openapi('SetupClaimInput', { description: 'The setup code and the owner’s email.' }),
          },
        },
      },
    },
    responses: { 200: { content: { [HAL_JSON]: { schema: ClaimSchema } }, description: 'Claimed or recovered.' }, ...problemResponses(400, 403, 409, 429, 503) },
  }),
  checklist: createRoute({
    method: 'get',
    path: `${path}/checklist`,
    operationId: 'getSetupChecklist',
    tags: [tag],
    summary: 'The setup checklist',
    description: 'Every setup step, each checked for real just now: it is ok only when the thing works. Owner only.',
    responses: {
      200: { content: { [HAL_JSON]: { schema: z.object({ done: z.number().int(), total: z.number().int(), _embedded: z.object({ steps: z.array(StepSchema) }), _links: LinksSchema }).openapi('SetupChecklist', { description: 'The steps and what their checks found.' }) } }, description: 'The checklist.' },
      ...problemResponses(401, 403),
    },
  }),
})

export type SetupRoutes = ReturnType<typeof setupRoutes>
