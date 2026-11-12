import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp, TOOLS } from '../src/app.js'
import { FEATURES } from '../src/features/index.js'
import { guideFiles, guideModuleSource, hashApiKey, testDb } from '../src/kit/index.js'
import { guideGaps, lintOpenApi, toolRoutes, toolsRun } from '../src/kit/testing/index.js'

const GUIDE_DIR = fileURLToPath(new URL('../guide', import.meta.url))
const KEY = 'test-key'
const headers = { authorization: `Bearer ${KEY}` }
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

  it('fills every placeholder in the agent guide', async () => {
    expect(guideGaps(guideFiles(GUIDE_DIR), {}, { doc: await doc(), tools: TOOLS })).toEqual([])
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

  it('serves the guide folder as it is now (run `pnpm guide` after editing guide/)', () => {
    expect(readFileSync(new URL('../src/guide.gen.ts', import.meta.url), 'utf8')).toBe(guideModuleSource(guideFiles(GUIDE_DIR)))
  })
})
