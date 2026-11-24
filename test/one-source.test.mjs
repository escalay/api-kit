import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// One source per fact: each fact the docs give lives in one place, and the other places link to it
const root = join(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const folders = readdirSync(join(root, 'src'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const agents = read('AGENTS.md')

/** The lines outside code fences. */
const proseOf = (text) => {
  let fenced = false
  return text.split('\n').filter((line) => {
    if (line.startsWith('```')) fenced = !fenced
    return !fenced && !line.startsWith('```')
  })
}

describe('AGENTS.md', () => {
  it('leaves the parts to docs/PARTS.md: no row for a part’s files', () => {
    const firstCells = agents.split('\n').filter((line) => line.startsWith('| ')).map((line) => line.split('|')[1])
    const partPaths = firstCells.flatMap((cell) => [...cell.matchAll(/`(src\/[^`]*)`/g)].map((match) => match[1])).filter((path) => path !== 'src/<part>/')
    expect(partPaths).toEqual([])
    expect(agents.split('\n').find((line) => line.startsWith('| `src/<part>/` |'))).toContain('](docs/PARTS.md)')
  })
})

describe.each(folders)('src/%s/README.md is said once', (folder) => {
  const text = read(`src/${folder}/README.md`)

  it('gives each ### heading once', () => {
    const headings = proseOf(text).filter((line) => line.startsWith('### '))
    expect(headings.filter((heading, at) => headings.indexOf(heading) !== at)).toEqual([])
  })
})

describe('the size of a part’s README', () => {
  // A README ships into every app that has the part, and an agent reads it whole
  const CEILING = 20 * 1024
  // Only ever shrinks: a README over the ceiling is cut or split, never added here. A cap sits at most 2 KB above
  // its README, so a README that shrinks takes its cap down with it
  const OVER = { oauth: 57 * 1024 }
  const sizes = Object.fromEntries(folders.map((folder) => [folder, Buffer.byteLength(read(`src/${folder}/README.md`))]))

  it('stays under the ceiling, or under its own cap', () => {
    for (const folder of folders) expect(sizes[folder], folder).toBeLessThanOrEqual(OVER[folder] ?? CEILING)
  })

  it('lists only READMEs over the ceiling, each with a cap close above it', () => {
    for (const [folder, cap] of Object.entries(OVER)) {
      expect(sizes[folder], folder).toBeGreaterThan(CEILING)
      expect(cap - sizes[folder], folder).toBeLessThanOrEqual(2 * 1024)
    }
  })
})
