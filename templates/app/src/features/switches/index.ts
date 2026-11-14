/**
 * The feature switches as a feature of their own, always on: `GET /api/features`, `GET`/`PATCH /api/features/{key}`
 * (a deployment key only) and their tools. `switch_feature` is offered once the catalog has a feature to switch.
 */
import { SWITCH_MIGRATIONS, SWITCHES_TAG, switchTools } from '../../kit/index.js'
import { CATALOG } from '../catalog.js'
import type { Feature } from '../index.js'

const [first] = Object.keys(CATALOG)

export const feature: Feature = {
  name: 'switches',
  tag: SWITCHES_TAG,
  migrations: SWITCH_MIGRATIONS,
  // The deployment's keys (API_KEYS) switch; give people roles with the kit's people part
  register: async (app, { flags }) => flags.register(app, { isOwner: (c) => (c.get('caller' as never) as { kind?: string } | undefined)?.kind === 'key' }),
  tools: switchTools({ example: first }).filter((tool) => first || tool.name !== 'switch_feature'),
  samples: async () => ({ list_features: {}, ...(first ? { switch_feature: { key: first, state: 'off', preview: true } } : {}) }),
}
