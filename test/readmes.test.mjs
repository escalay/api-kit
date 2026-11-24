import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { README_SHAPE, sectionsOf } from '../scripts/parts.mjs'

const root = join(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const registry = JSON.parse(read('registry.json'))
const folders = readdirSync(join(root, 'src'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
const upgrading = read('docs/upgrading.md')

/** The `##` sections of a README, by heading, with the text under each (code blocks kept whole). */
const sectionsIn = (text) => {
  const sections = new Map()
  let heading = null
  let fenced = false
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced
    if (!fenced && line.startsWith('## ')) {
      heading = line.slice(3).trim()
      sections.set(heading, '')
    } else if (heading) sections.set(heading, `${sections.get(heading)}${line}\n`)
  }
  return sections
}

const VERSION = '\\d+\\.\\d+\\.\\d+'
const NOTE_HEADING = new RegExp(`^(?:(${VERSION})|Unreleased \\(after (${VERSION})\\))(?:: .+)?$`)
const newer = (a, b) => {
  const [x, y] = [a, b].map((version) => version.split('.').map(Number))
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}

/** What is wrong with docs/upgrading.md's `###` headings: each a version or `Unreleased (after <released>)`, a topic after `: ` allowed, newest first. */
const noteHeadingProblems = (text, released) => {
  const problems = []
  let part = null
  let last = null
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) [part, last] = [line.slice(3), null]
    if (!line.startsWith('### ') || !part) continue
    const heading = line.slice(4)
    const [, version, after] = NOTE_HEADING.exec(heading) ?? []
    if (!version && !after) problems.push(`${part}: "${heading}" is neither a version nor Unreleased (after ${released})`)
    else if (after && after !== released) problems.push(`${part}: "${heading}" names ${after}, the last release is ${released}`)
    else if (after && last) problems.push(`${part}: "${heading}" comes after ${last}; Unreleased goes first`)
    else if (version && last && newer(version, last) > 0) problems.push(`${part}: ${version} comes after ${last}; newest first`)
    if (version) last = version
  }
  return problems
}

describe('docs/upgrading.md', () => {
  const released = JSON.parse(read('.release-please-manifest.json'))['.']

  it('heads each note with a version or Unreleased (after the last release), newest first', () => {
    expect(noteHeadingProblems(upgrading, released)).toEqual([])
  })

  it('catches a heading left Unreleased past a release, out of order, or in another form', () => {
    const notes = (...headings) => `## core\n\n${headings.map((heading) => `### ${heading}\n\n- a note\n`).join('\n')}`
    expect(noteHeadingProblems(notes('Unreleased (after 1.2.0)', '1.2.0: approvals', '1.2.0', '1.1.0'), '1.2.0')).toEqual([])
    expect(noteHeadingProblems(notes('Unreleased (after 1.1.0)', '1.1.0'), '1.2.0')).toEqual(['core: "Unreleased (after 1.1.0)" names 1.1.0, the last release is 1.2.0'])
    expect(noteHeadingProblems(notes('1.1.0', '1.2.0'), '1.2.0')).toEqual(['core: 1.2.0 comes after 1.1.0; newest first'])
    expect(noteHeadingProblems(notes('1.9.0', '1.10.0'), '1.10.0')).toEqual(['core: 1.10.0 comes after 1.9.0; newest first'])
    expect(noteHeadingProblems(notes('1.2.0', 'Unreleased (after 1.2.0)'), '1.2.0')).toEqual(['core: "Unreleased (after 1.2.0)" comes after 1.2.0; Unreleased goes first'])
    expect(noteHeadingProblems(notes('v1.2.0', 'Unreleased'), '1.2.0')).toEqual(['core: "v1.2.0" is neither a version nor Unreleased (after 1.2.0)', 'core: "Unreleased" is neither a version nor Unreleased (after 1.2.0)'])
  })
})

describe.each(folders)('src/%s/README.md has the one README shape', (folder) => {
  const text = read(`src/${folder}/README.md`)
  const sections = sectionsIn(text)
  const items = registry.items.filter((item) => item.files.some((file) => file.path === `src/${folder}/README.md`))

  it('opens with its name and one paragraph saying what it is', () => {
    const [title, blank, ...rest] = text.split('\n')
    expect(title).toBe(`# ${folder}`)
    expect(blank).toBe('')
    const intro = rest.slice(0, rest.findIndex((line) => line.startsWith('## ')))
    const paragraph = intro.join('\n').trim()
    expect(paragraph, 'one paragraph, no list, table or code').toMatch(/^[^-|`#\s]/)
    expect(paragraph.split(/\n\s*\n/), 'one paragraph').toHaveLength(1)
  })

  it('has the sections in order, and no others', () => {
    expect([...sections.keys()]).toEqual(README_SHAPE.map(([heading]) => heading))
  })

  it('says how to add each of its parts', () => {
    for (const item of items) expect(sections.get('Add it'), item.name).toMatch(new RegExp(`npx @escalay/kit add (?:[\\w-]+ )*${item.name}\\b`))
  })

  it('gives a block to copy, an options table and a failure table', () => {
    expect(sections.get('Wire it')).toMatch(/```(ts|tsx)\n/)
    expect(sections.get('Options')).toContain('| Option | Type | Default | What it does |')
    expect(sections.get('Failure modes')).toContain('| The caller sees | Why |')
  })

  it('draws its flows in Mermaid', () => {
    const diagrams = [...sections.get('Flows').matchAll(/```mermaid\n([^\n]*)/g)].map((match) => match[1])
    expect(diagrams.length).toBeGreaterThan(0)
    for (const kind of diagrams) expect(kind).toMatch(/^(sequenceDiagram|stateDiagram-v2|flowchart (LR|TD))$/)
    // A semicolon ends a Mermaid statement, so one inside a label cuts the diagram
    for (const [, body] of text.matchAll(/```mermaid\n([\s\S]*?)```/g)) expect(body).not.toContain(';')
    // A state diagram's label runs from the first colon: a second one is a parse error
    for (const [, body] of text.matchAll(/```mermaid\nstateDiagram-v2\n([\s\S]*?)```/g))
      for (const line of body.split('\n').filter((one) => one.includes('-->'))) expect(line.split(':').length, line).toBeLessThanOrEqual(2)
  })

  it('names the STANDARD sections the registry gives its parts', () => {
    const numbers = [...new Set(items.flatMap((item) => item.meta.standard))].sort((a, b) => a - b)
    expect(sections.get('Rules')).toContain(`Standard: \`docs/STANDARD.md\` ${sectionsOf(numbers)}`)
  })

  it('says something under Limits and Tests', () => {
    for (const heading of ['Limits', 'Tests']) expect(sections.get(heading)?.trim(), heading).toBeTruthy()
  })

  it('sends upgrades to its section of docs/upgrading.md', () => {
    expect(sections.get('Upgrading')).toContain(`docs/upgrading.md#${folder}`)
    expect(upgrading).toMatch(new RegExp(`^## ${folder}$`, 'm'))
  })
})
