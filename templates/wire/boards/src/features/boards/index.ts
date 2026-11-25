/** Boards of __over_labels__, each with a note (`kit add boards --wire --items __over_name__`). */
import { BOARDS_MIGRATIONS, boardTools, linksOf, registerBoards } from '../../kit/index.js'
import type { Feature } from '../index.js'
import { feature as __over_camel__ } from '../__over_name__/index.js'
import { __over_camel__Repo } from '../__over_name__/repo.js'
import { __over_Singular__Schema } from '../__over_name__/routes.js'

export const feature: Feature = {
  name: 'boards', // the name its steps migrate under
  tag: { name: 'Boards', description: 'Your boards of __over_labels__, each with a note.' },
  migrations: BOARDS_MIGRATIONS,
  register: (app, { db }) =>
    registerBoards(app, { db, item: __over_Singular__Schema, refExample: '__over_kebab_singular__:one', itemOf: async (ref, origin) => {
      const row = await __over_camel__Repo(db).get(ref.slice('__over_kebab_singular__:'.length))
      return row ? { ...row, _links: linksOf(origin, { self: `/api/__over_name__/${row.id}` }) } : null
    } }),
  tools: boardTools({ noun: '__over_labels__', label: (item) => String(item.__over_first__), refExample: '__over_kebab_singular__:one' }),
  samples: async (request) => {
    const made = async (path: string, body: object) => ((await (await request(path, { method: 'POST', body: JSON.stringify(body) })).json()) as { id: string }).id
    // A __over_label__ as its own samples make one
    const one = (await __over_camel__.samples(request)).create___over_snake_singular__!
    const [id, ref] = [await made('/api/boards', { name: 'A sample' }), `__over_kebab_singular__:${await made('/api/__over_name__', one)}`]
    return { list_boards: {}, create_board: { name: 'Made by a tool' }, get_board: { id }, save_to_board: { id, ref }, remove_from_board: { id, ref } }
  },
}
