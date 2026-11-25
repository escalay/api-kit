/** The __over_labels__ as the sharing part's spaces, each __over_label__'s id its space's name (`kit add sharing --wire`). */
import type { Db } from '../../kit/index.js'
import { __over_camel__Repo } from './repo.js'

export const spacesOf = (db: Db) => {
  const byId = async (id: string) => {
    const row = await __over_camel__Repo(db).get(id)
    return row ? { id: row.id, name: row.id, title: String(row.__over_first__) } : null
  }
  return { byName: byId, byId }
}
