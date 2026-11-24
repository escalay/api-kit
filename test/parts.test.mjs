import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GOALS, orderOf, partsMarkdown, skillsIn, starterParts, withReadmeTables } from '../scripts/parts.mjs'

const root = join(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const registry = JSON.parse(read('registry.json'))
const parts = registry.items.filter((item) => !item.meta?.root)
const names = parts.map((item) => item.name)
const sections = [...read('docs/STANDARD.md').matchAll(/^## (\d+)\. /gm)].map((match) => Number(match[1]))

describe('docs/PARTS.md, the map of the parts', () => {
  it('is what `pnpm parts` writes from registry.json, so it is never stale', () => {
    expect(read('docs/PARTS.md'), 'docs/PARTS.md is stale: run `pnpm parts`').toBe(partsMarkdown(registry, read('cli.mjs')))
  })

  it('has a row for every part, and names the root items apart', () => {
    const markdown = read('docs/PARTS.md')
    for (const name of names) expect(markdown, name).toMatch(new RegExp(`^\\| \`${name}\` \\|`, 'm'))
    for (const item of registry.items.filter((one) => one.meta?.root)) expect(markdown).toContain(`npx shadcn add escalay/api-kit/${item.name}`)
  })

  it('gives every part the STANDARD sections that exist, and every browser layer a server part', () => {
    for (const item of parts) {
      expect(item.meta?.standard, `${item.name}: meta.standard`).toEqual(expect.arrayContaining([expect.any(Number)]))
      for (const section of item.meta.standard) expect(sections, `${item.name}: §${section}`).toContain(section)
      if (item.meta.web) expect(names.filter((name) => !parts.find((one) => one.name === name).meta?.web), `${item.name}: meta.layerOf`).toContain(item.meta.layerOf)
      else expect(item.meta.layerOf, item.name).toBeUndefined()
    }
  })

  it('lists each goal’s parts after the parts they need, all of them real', () => {
    for (const goal of GOALS) {
      const order = orderOf(registry, goal.parts ?? starterParts(read('cli.mjs')))
      for (const name of order) expect(names, `${goal.goal}: ${name}`).toContain(name)
      for (const [at, name] of order.entries()) {
        const needs = (parts.find((item) => item.name === name).registryDependencies ?? []).filter((dependency) => dependency.startsWith('escalay/api-kit/'))
        for (const need of needs) expect(order.indexOf(need.slice('escalay/api-kit/'.length)), `${goal.goal}: ${name} needs ${need}`).toBeLessThan(at)
      }
    }
  })

  it('reads the starter’s parts from cli.mjs, the list `init` copies', () => {
    expect(starterParts(read('cli.mjs'))).toEqual(['core', 'db', 'oauth', 'guide', 'mcp', 'brand', 'switches', 'testing'])
  })

  it('names in api-kit-build exactly the parts `init` copies, in its order', () => {
    const named = starterParts(read('cli.mjs')).map((name) => `\`${name}\``)
    const sentence = `\`init\` copies ${named.slice(0, -1).join(', ')} and ${named.at(-1)}.`
    expect(read('skills/api-kit-build/SKILL.md').replace(/\s*\n\s*/g, ' ')).toContain(sentence)
  })
})

/** Every STANDARD section a text points at (`§7`, both ends of `§1–3`), leaving other documents' `§3.3` alone. */
const standardRefs = (text) => [...text.matchAll(/§(\d+)(?:–(\d+))?(?![.\d])/g)].flatMap(([, from, to]) => (to ? [from, to] : [from]).map(Number))
const outOfRange = (text, count) => standardRefs(text).filter((number) => number < 1 || number > count)

describe('docs/STANDARD.md’s section numbers', () => {
  it('run 1, 2, 3… with none missing or repeated, so a §N never moves', () => {
    expect(sections).toEqual(sections.map((_, index) => index + 1))
  })

  it('bound every §N in the skills, cli.mjs, README.md and the app template', () => {
    const skills = readdirSync(join(root, 'skills')).map((name) => `skills/${name}/SKILL.md`)
    for (const path of [...skills, 'cli.mjs', 'README.md', 'templates/app/AGENTS.md']) expect(outOfRange(read(path), sections.length), path).toEqual([])
  })

  it('catch a reference past the last section, at either end of a range', () => {
    expect(standardRefs('§7 and §1–3, RFC 9728 §3.3')).toEqual([7, 1, 3])
    expect(outOfRange('§7, §24 and §1–30', 23)).toEqual([24, 30])
  })
})

describe('the root README', () => {
  it('names every part in its parts table and links docs/PARTS.md', () => {
    const readme = read('README.md')
    const table = readme.slice(readme.indexOf('## Parts'), readme.indexOf('\n## ', readme.indexOf('## Parts') + 1))
    for (const name of names) expect(table, name).toContain(`\`${name}\``)
    expect(table).toContain('](docs/PARTS.md)')
  })

  it('has the parts and skills tables `pnpm parts` writes, so neither is stale', () => {
    expect(read('README.md'), 'README.md is stale: run `pnpm parts`').toBe(withReadmeTables(read('README.md'), registry, skillsIn(root)))
  })

  it('gives each part its registry description and its README', () => {
    const readme = read('README.md')
    for (const item of parts) {
      const path = item.files.find((file) => file.path.endsWith('/README.md')).path
      expect(readme, item.name).toContain(`| \`${item.name}\` | ${item.description.replace(/\s+/g, ' ').trim()} | [${path.split('/')[1]}](${path}) |`)
    }
  })

  it('gives each skill folder a row, saying when to use it from its frontmatter', () => {
    const skills = skillsIn(root)
    expect(skills.map((skill) => skill.name)).toEqual(readdirSync(join(root, 'skills')).sort())
    for (const { name, description } of skills) expect(read('README.md'), name).toContain(`| [\`${name}\`](skills/${name}/SKILL.md) | ${description.replace(/^Use when /, '')} |`)
  })

  it('refuses a README that lost a table’s markers, rather than dropping the table', () => {
    const readme = read('README.md')
    expect(() => withReadmeTables(readme.replace('<!-- skills:end -->', ''), registry, skillsIn(root))).toThrow('skills:end')
    expect(() => withReadmeTables(readme.replace(/<!-- parts:start[^\n]*\n/, ''), registry, skillsIn(root))).toThrow('parts:start')
  })
})
