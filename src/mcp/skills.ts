/**
 * The guide's skill folders as what an MCP server offers: the skills themselves (Skills extension, SEP-2640) and one
 * prompt per playbook. `mcpServerFactory` takes both, so a product's skills reach an agent three ways from one copy:
 * over HTTP (`serveGuide`), through MCP, and installed from the deployment or the repository.
 *
 * @example
 * const { prompts, skills } = await guideSkills({ files: GUIDE_FILES })
 * mcpServerFactory({ info, instructions, tools, prompts, skills, callApi: inProcess(app) })
 */
import { memorySkillFiles, SkillsExtension } from '@modelcontextprotocol/server/ext/skills'
import type { McpPrompt } from './index.js'

const HOUR = 3_600_000
const SKILLS = 'skills/'
/** `<skill>/references/<playbook>.md`: one playbook of a skill. */
const PLAYBOOK = /^[\w-]+\/references\/([\w-]+)\.md$/

/**
 * guideSkills reads `skills/<name>/SKILL.md` and `skills/<name>/references/*.md` out of the guide's files. Each
 * playbook becomes a prompt named after its file, titled by its heading and described by its first paragraph line.
 * `fill` renders a file first, for skills that use placeholders: `(text) => fillTemplate(text, { origin }).text`.
 */
export const guideSkills = async ({
  files,
  fill = (text) => text,
}: {
  files: Map<string, string> | Record<string, string>
  fill?: (text: string) => string
}) => {
  const entries = files instanceof Map ? [...files] : Object.entries(files)
  const skills = entries.flatMap(([path, text]): [string, string][] => (path.startsWith(SKILLS) ? [[path.slice(SKILLS.length), fill(text)]] : []))
  const prompts = skills.flatMap(([path, text]): McpPrompt[] => {
    const name = path.match(PLAYBOOK)?.[1]
    if (!name) return []
    const lines = text.split('\n')
    return [{ name, title: lines.find((line) => line.startsWith('# '))?.slice(2) ?? name, description: lines.find((line) => line && !line.startsWith('#')) ?? name, text: () => text }]
  })
  return {
    prompts,
    /** Left out when the guide has no skill folder. */
    skills: skills.length ? await SkillsExtension.load(memorySkillFiles(Object.fromEntries(skills)), { cacheHint: { ttlMs: HOUR, cacheScope: 'private' } }) : undefined,
  }
}
