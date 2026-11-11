/** __Pascal__: the feature as the app registers it (routes and tables), its MCP tools, and sample tool arguments. */
import { migrate } from '../../kit/index.js'
import type { Feature } from '../index.js'
import { __camel__Handlers } from './handlers.js'
import { __camel__Repo } from './repo.js'
import { PATH, routes, TAG } from './routes.js'
import { __CONST___MIGRATIONS } from './schema.js'
import { __camel__Tools } from './tools.js'

export const feature: Feature = {
  name: '__name__',
  tag: { name: TAG, description: '__Pascal__: make, list, change and delete them.' },
  migrations: __CONST___MIGRATIONS,
  register: async (app, { db }) => {
    await migrate(db, '__name__', __CONST___MIGRATIONS)
    const handle = __camel__Handlers(__camel__Repo(db))
    app.openapi(routes.list, handle.list)
    app.openapi(routes.get, handle.get)
    app.openapi(routes.create, handle.create)
    app.openapi(routes.update, handle.update)
    app.openapi(routes.remove, handle.remove)
  },
  tools: __camel__Tools,
  samples: async (request) => {
    const { id } = (await (await request(PATH, { method: 'POST', body: JSON.stringify({ title: 'A sample __label__' }) })).json()) as { id: string }
    return {
      list___snake__: {},
      get___snake_singular__: { id },
      create___snake_singular__: { title: 'Made by a tool' },
      update___snake_singular__: { id, body: 'Changed by a tool' },
      delete___snake_singular__: { id },
    }
  },
}
