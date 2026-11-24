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
