import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { README_SHAPE } from '../scripts/parts.mjs'

// One source per fact: each fact the docs give lives in one place, and the other places link to it
const root = join(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const folders = readdirSync(join(root, 'src'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const skills = readdirSync(join(root, 'skills')).map((name) => `skills/${name}/SKILL.md`)
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

  it('gives every decision record one line', () => {
    for (const file of readdirSync(join(root, 'docs/decisions'))) {
      const lines = agents.split('\n').filter((line) => line.includes(`](docs/decisions/${file})`))
      expect(lines, file).toHaveLength(1)
    }
  })
})

describe('decision records', () => {
  it.each(readdirSync(join(root, 'docs/decisions')))('%s says its status and the version it shipped in, no hand list', (file) => {
    const text = read(`docs/decisions/${file}`)
    expect(text).toMatch(/^Status: [a-z]+ \(since v\d+\.\d+\.\d+\)/m)
    expect(text).not.toContain('Released:')
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
    for (const folder of folders) expect(sizes[folder], `${folder}: cut or move text, never raise the cap`).toBeLessThanOrEqual(OVER[folder] ?? CEILING)
  })

  it('lists only READMEs over the ceiling, each with a cap close above it', () => {
    expect(Object.keys(OVER), 'a README over the ceiling is cut or split, never added here').toEqual(['oauth'])
    for (const [folder, cap] of Object.entries(OVER)) {
      expect(sizes[folder], `${folder}: under the ceiling now, so drop it from OVER`).toBeGreaterThan(CEILING)
      expect(cap - sizes[folder], `${folder}: shrank, so lower its cap`).toBeLessThanOrEqual(2 * 1024)
    }
  })
})

describe('what `update` does with your edits', () => {
  const copies = ['README.md', 'AGENTS.md', 'skills/api-kit-build/SKILL.md']

  it('is written in docs/upgrading.md › Taking a new version only', () => {
    const upgrading = read('docs/upgrading.md')
    const section = upgrading.slice(upgrading.indexOf('## Taking a new version'), upgrading.indexOf('\n## ', upgrading.indexOf('## Taking a new version')))
    expect(section).toMatch(/leaves `kit\.json` at that\s+version/)
    for (const path of ['README.md', 'AGENTS.md', 'docs/STANDARD.md', 'docs/PARTS.md', ...skills, ...folders.map((folder) => `src/${folder}/README.md`)])
      expect(read(path), path).not.toMatch(/leaves `kit\.json` at that/)
  })

  it.each(copies)('%s links it', (path) => {
    expect(read(path)).toContain('upgrading.md#taking-a-new-version')
  })
})

describe('the README shape', () => {
  /** The shape's sections, as a sentence names them: `Use it when` → `use`, `Wire it` → `wire`. */
  const sections = README_SHAPE.map(([heading]) => heading.toLowerCase().replace(/ it( when)?$/, ''))
  /** A paragraph naming most of the shape's sections is a copy of it. */
  const copiesShape = (text) =>
    text
      .replaceAll('’', "'")
      .split(/\n\s*\n/)
      .some((paragraph) => sections.filter((section) => new RegExp(`(^|[^\\w'])${section}\\b`, 'i').test(paragraph.replaceAll('*', ''))).length >= 8)

  it('is listed in docs/PARTS.md, from README_SHAPE', () => {
    expect(copiesShape(read('docs/PARTS.md'))).toBe(true)
  })

  it.each(['README.md', 'AGENTS.md', ...skills])('%s points at README_SHAPE rather than copy it', (path) => {
    expect(copiesShape(read(path))).toBe(false)
  })

  it.each(['AGENTS.md', 'skills/api-kit-part/SKILL.md'])('%s names where it lives', (path) => {
    expect(read(path)).toContain('README_SHAPE')
    expect(read(path)).toContain('docs/PARTS.md')
  })
})

describe('the shape of a feature', () => {
  const listsShape = (text) => /schema\.ts[\s\S]{0,160}repo\.ts[\s\S]{0,160}routes\.ts/.test(text)

  it('is written in docs/STANDARD.md §1', () => {
    const standard = read('docs/STANDARD.md')
    expect(listsShape(standard.slice(standard.indexOf('## 1. '), standard.indexOf('## 2. ')))).toBe(true)
  })

  it.each(['README.md', 'AGENTS.md', 'skills/api-kit-part/SKILL.md'])('%s links it', (path) => {
    const text = read(path)
    expect(listsShape(text)).toBe(false)
    expect(text).toMatch(/STANDARD\.md[^\n]*§1\b|STANDARD §1\b/)
  })
})
