import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import BRAND from '../brand/brand.js'
import { createApp, TOOLS } from '../src/app.js'
import { BRAND_ASSETS } from '../src/brand.gen.js'
import { FEATURES } from '../src/features/index.js'
import { guideFiles, guideModuleSource, hashApiKey, testDb } from '../src/kit/index.js'
import { guideSkillProblems } from '../src/kit/mcp/index.js'
import { cliGaps, guideGaps, guideRoutes, lintOpenApi, toolRoutes, toolsRun } from '../src/kit/testing/index.js'

const GUIDE_DIR = fileURLToPath(new URL('../guide', import.meta.url))
const KEY = 'test-key'
const headers = { authorization: `Bearer ${KEY}` }
// One app for these checks: each reads the whole app (its document, tools, guide) and none counts rows. A test that
// counts what it made gets an app of its own, as a feature's test does
const app = await createApp({ db: await testDb(), env: { API_KEYS: `tester:${hashApiKey(KEY)}` } })
const request = async (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { ...headers, 'content-type': 'application/json', ...(init.headers as Record<string, string>) } })
const doc = async () => (await app.request('/openapi.json', { headers })).json()

describe('the API', () => {
  it('documents every route to the standard, and every tool lands on one', async () => {
    expect(lintOpenApi(await doc())).toEqual([])
    expect(toolRoutes(TOOLS, await doc())).toEqual([])
  })

  it('runs every MCP tool against its route', async () => {
    const samples = Object.assign({}, ...(await Promise.all(FEATURES.map((feature) => feature.samples(request)))))
    expect(await toolsRun(TOOLS, app, samples, { headers })).toEqual([])
  })

  it('names every tool’s command for the command line, with an example', () => {
    expect(cliGaps({ tools: TOOLS })).toEqual([])
  })

  it('fills every placeholder in the agent guide', async () => {
    expect(guideGaps(guideFiles(GUIDE_DIR), {}, { doc: await doc(), tools: TOOLS, brand: BRAND })).toEqual([])
  })

  it('names only routes the API has in the agent guide', async () => {
    expect(guideRoutes(guideFiles(GUIDE_DIR), await doc())).toEqual([])
  })

  it('names itself with brand/ on MCP and the Server Card, and serves its icon', async () => {
    expect((await app.request('/icon.svg')).status).toBe(200)
    const card = await (await app.request('/mcp/server-card')).json()
    expect(card).toMatchObject({ title: BRAND.title, description: BRAND.description })
    // The SVG last; once `npx @escalay/kit brand` has rendered the PNGs, the inline one Claude shows comes first
    expect(card.icons.at(-1)).toMatchObject({ mimeType: 'image/svg+xml' })
    expect(card.icons[0].src.startsWith('data:image/png;base64,')).toBe('png' in BRAND_ASSETS)
  })

  it('offers its skill to install, with every playbook, and links each from the skill', async () => {
    const files = guideFiles(GUIDE_DIR)
    const index = (await (await app.request('/.well-known/agent-skills/index.json')).json()) as { skills: { name: string }[] }
    const skills = [...files.keys()].flatMap((path) => path.match(/^skills\/([^/]+)\/SKILL\.md$/)?.[1] ?? [])
    expect(index.skills.map((skill) => skill.name).sort()).toEqual(skills.sort())
    for (const skill of skills) {
      const playbooks = [...files.keys()].filter((path) => path.startsWith(`skills/${skill}/references/`))
      // A product skill installs from the repository as it is: no placeholder, and no playbook the skill does not name
      for (const path of [`skills/${skill}/SKILL.md`, ...playbooks]) expect(files.get(path), path).not.toMatch(/\{\{[^}]+\}\}/)
      for (const path of playbooks) expect(files.get(`skills/${skill}/SKILL.md`), path).toContain(path.slice(`skills/${skill}/`.length))
    }
  })

  it('loads every skill as its MCP server reads it (quote a description with a colon in it)', async () => {
    expect(await guideSkillProblems({ files: guideFiles(GUIDE_DIR) })).toEqual([])
  })

  it('serves the guide folder as it is now (run `pnpm guide` after editing guide/)', () => {
    expect(readFileSync(new URL('../src/guide.gen.ts', import.meta.url), 'utf8')).toBe(guideModuleSource(guideFiles(GUIDE_DIR)))
  })
})
