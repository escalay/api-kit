import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GOALS, orderOf, partsMarkdown, starterParts } from '../scripts/parts.mjs'

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
})

describe('the root README', () => {
  it('names every part in its parts table and links docs/PARTS.md', () => {
    const readme = read('README.md')
    const table = readme.slice(readme.indexOf('## Parts'), readme.indexOf('\n## ', readme.indexOf('## Parts') + 1))
    for (const name of names) expect(table, name).toContain(`\`${name}\``)
    expect(table).toContain('](docs/PARTS.md)')
  })
})
