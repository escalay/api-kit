/** Setup: the first person with the deployment's SETUP_CODE claims it as its owner (`kit add setup --wire`). */
import { dbGuardStore, parseApiKeys, registerSetup, SETUP_MIGRATIONS, SETUP_TAG } from '../../kit/index.js'
import type { Feature } from '../index.js'

export const feature: Feature = {
  name: 'setup', // the name its steps migrate under
  tag: SETUP_TAG,
  migrations: SETUP_MIGRATIONS,
  register: async (app, { db, env }) => registerSetup(app, { db, code: env.SETUP_CODE, guards: await dbGuardStore(db), fixedKeys: [...parseApiKeys(env.API_KEYS).values()], steps: [] }),
  tools: [],
  samples: async () => ({}),
}
