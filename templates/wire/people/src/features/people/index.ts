/** People: the team, its roles and passkeys, as a feature (`kit add people --wire`); listed before setup. */
import { parseApiKeys, PEOPLE_MIGRATIONS, PEOPLE_TAG, registerPeople, teamTools } from '../../kit/index.js'
import type { Feature } from '../index.js'

export const feature: Feature = {
  name: 'people', // the name its steps migrate under
  tag: PEOPLE_TAG,
  migrations: PEOPLE_MIGRATIONS,
  register: (app, { db, env }) => registerPeople(app, { db, rpName: '__title__', fixedKeys: [...parseApiKeys(env.API_KEYS).values()] }),
  tools: teamTools(),
  samples: async (request) => {
    // POST /api/team answers the whole team, not the person added
    const { people } = (await (await request('/api/team', { method: 'POST', body: JSON.stringify({ email: 'sample@example.com' }) })).json()) as { people: { id: string; email: string }[] }
    const { id } = people.find((person) => person.email === 'sample@example.com')!
    return { list_team: {}, add_to_team: { domain: 'example.org' }, change_team_role: { id, role: 'member' }, remove_from_team: { id } }
  },
}
