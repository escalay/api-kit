/** __Pascal__: the feature as the app registers it (routes and tables), its MCP tools, and sample tool arguments. */
import { migrate } from '../../kit/index.js'
import type { Feature } from '../index.js'
import { __camel__Handlers } from './handlers.js'
import { __camel__Repo } from './repo.js'
import { feature as __parent_camel__ } from '../__parent__/index.js' // feature:under
import { __parent_camel__Repo } from '../__parent__/repo.js' // feature:under
import { PATH, routes, TAG } from './routes.js' // feature:flat
import { pathUnder, routes, TAG } from './routes.js' // feature:under
import { __CONST___MIGRATIONS } from './schema.js'
import { __camel__Tools } from './tools.js'

export const feature: Feature = {
  name: '__name__',
  tag: { name: TAG, description: '__Pascal__: make, list, change and delete them.' }, // feature:remove
  tag: { name: TAG, description: '__Pascal__: make, list and change them.' }, // feature:no-remove
  migrations: __CONST___MIGRATIONS,
  register: async (app, { db }) => {
    await migrate(db, '__name__', __CONST___MIGRATIONS)
    const handle = __camel__Handlers(__camel__Repo(db)) // feature:flat
    const handle = __camel__Handlers(__camel__Repo(db), __parent_camel__Repo(db)) // feature:under
    app.openapi(routes.list, handle.list)
    app.openapi(routes.get, handle.get)
    app.openapi(routes.create, handle.create)
    app.openapi(routes.update, handle.update)
    app.openapi(routes.remove, handle.remove) // feature:remove
  },
  tools: __camel__Tools,
  samples: async (request) => {
    const { id } = (await (await request(PATH, { method: 'POST', body: JSON.stringify(__sample__) })).json()) as { id: string } // feature:flat
    // A __parent_label__ as its own samples make one, then one of its __labels__ // feature:under
    const { id: __parent_param__ } = (await (await request('/api/__parent__', { method: 'POST', body: JSON.stringify((await __parent_camel__.samples(request)).create___parent_snake_singular__) })).json()) as { id: string } // feature:under
    const { id } = (await (await request(pathUnder(__parent_param__), { method: 'POST', body: JSON.stringify(__sample__) })).json()) as { id: string } // feature:under
    return {
      list___snake__: {}, // feature:flat
      list___snake__: { __parent_snake_singular__: __parent_param__ }, // feature:under
      get___snake_singular__: { id },
      create___snake_singular__: __sample__, // feature:flat
      create___snake_singular__: { __parent_snake_singular__: __parent_param__, __sample_entries__ }, // feature:under
      update___snake_singular__: { id, __patch_entries__ },
      delete___snake_singular__: { id }, // feature:remove
    }
  },
}
