import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// One source per fact: each fact the docs give lives in one place, and the other places link to it
const root = join(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const agents = read('AGENTS.md')

describe('AGENTS.md', () => {
  it('leaves the parts to docs/PARTS.md: no row for a part’s files', () => {
    const firstCells = agents.split('\n').filter((line) => line.startsWith('| ')).map((line) => line.split('|')[1])
    const partPaths = firstCells.flatMap((cell) => [...cell.matchAll(/`(src\/[^`]*)`/g)].map((match) => match[1])).filter((path) => path !== 'src/<part>/')
    expect(partPaths).toEqual([])
    expect(agents.split('\n').find((line) => line.startsWith('| `src/<part>/` |'))).toContain('](docs/PARTS.md)')
  })
})
