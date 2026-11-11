/**
 * Board refs: how a board addresses an item, `<type>:<id>`. The type is a short lowercase word the app chooses
 * (`recipe`, `segment`); the id is everything after the first colon and may hold colons itself
 * (`segment:episode:intro:2`). Shared by `boards` (server) and `boards-client` (browser), so both read refs
 * the same way.
 *
 * @example
 * boardRef('recipe', 'soup')                        // 'recipe:soup'
 * parseBoardRef('segment:episode:intro:2')  // { type: 'segment', id: 'episode:intro:2' }
 * parseBoardRef('fox')                           // null: no type
 */

/** A whole ref: a type, a colon, an id of word characters, dots, colons and hyphens. */
export const BOARD_REF = /^([a-z][\w-]*):([\w.:-]+)$/

/** The ref for an item of this type. */
export const boardRef = (type: string, id: string) => `${type}:${id}`

/** A ref's type and id, or null when it isn't a ref. */
export const parseBoardRef = (ref: string): { type: string; id: string } | null => {
  const match = BOARD_REF.exec(ref)
  return match ? { type: match[1]!, id: match[2]! } : null
}
