/**
 * The guide's skill folders as what an MCP server offers: the skills themselves (Skills extension, SEP-2640) and one
 * prompt per playbook. `mcpServerFactory` takes both, so a product's skills reach an agent three ways from one copy:
 * over HTTP (`serveGuide`), through MCP, and installed from the deployment or the repository.
 *
 * @example
 * const { prompts, skills } = await guideSkills({ files: GUIDE_FILES })
 * mcpServerFactory({ info, instructions, tools, prompts, skills, callApi: inProcess(app) })
 */
import { ResourceNotFoundError, ResourceTemplate, UriTemplate, type McpServer, type ReadResourceTemplateCallback, type Resource } from '@modelcontextprotocol/server'
import { memorySkillFiles, SKILLS_EXTENSION_ID, SkillsExtension, type Skill, type SkillCatalog } from '@modelcontextprotocol/server/ext/skills'
import type { McpPrompt } from './index.js'

const HOUR = 3_600_000
const SKILLS = 'skills/'
const BASE = 'skill://'
/** `<skill>/references/<playbook>.md`: one playbook of a skill. */
const PLAYBOOK = /^[\w-]+\/references\/([\w-]+)\.md$/
/** A skill with more references than this lists only its `SKILL.md` in `resources/list`; a folder read still names them all. */
const LISTED_REFERENCES = 20

/** A Markdown file's title (its first `# ` heading) and description (its first line of text). */
const aboutOf = (text: string, fallback: string) => {
  const lines = text.split('\n')
  return { title: lines.find((line) => line.startsWith('# '))?.slice(2) ?? fallback, description: lines.find((line) => line && !line.startsWith('#')) ?? fallback }
}

/** What guideSkills read about each reference file, by URI: the catalog itself only knows sizes and digests. */
const ABOUT = new WeakMap<SkillCatalog, Map<string, { title: string; description: string }>>()

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
    return name ? [{ name, ...aboutOf(text, name), text: () => text }] : []
  })
  if (!skills.length) return { prompts, skills: undefined }
  const catalog = await SkillsExtension.load(memorySkillFiles(Object.fromEntries(skills)), { cacheHint: { ttlMs: HOUR, cacheScope: 'private' } })
  ABOUT.set(catalog, new Map(skills.map(([path, text]) => [BASE + path, aboutOf(text, path.split('/').pop()!)])))
  return {
    prompts,
    /** Left out when the guide has no skill folder. */
    skills: catalog,
  }
}

type SkillGuide = {
  /** Every `SKILL.md`, then each skill's references while they stay few: what `resources/list` shows. */
  listed: Resource[]
  /** Every file served, with its title when known. */
  files: { uri: string; path: string; title?: string }[]
  /** Folder paths under `skill://`, `''` the root. */
  folders: Set<string>
  /** The `SKILL.md` URIs: where an agent starts. */
  starts: string[]
}

const skillNameOf = (skill: Skill) => skill.frontmatter.name
const mimeTypeOf = (uri: string) => (uri.endsWith('.md') ? 'text/markdown' : uri.endsWith('.json') ? 'application/json' : 'text/plain')

const guides = new WeakMap<readonly Skill[], SkillGuide>()
/** The listing for a catalog's current entries, made once (the factory builds a server per request). */
const guideOf = (catalog: SkillCatalog): SkillGuide => {
  const entries = catalog.entries
  const known = guides.get(entries)
  if (known) return known
  const about = ABOUT.get(catalog)
  const listed: Resource[] = []
  const files: SkillGuide['files'] = []
  const folders = new Set([''])
  for (const skill of entries) {
    const name = skillNameOf(skill)
    const folder = skill.uri.slice(0, -'SKILL.md'.length)
    const resources = skill.resources === 'dynamic' ? [] : skill.resources
    const references = resources.filter((file) => file.uri.startsWith(`${folder}references/`))
    const skillFile = resources.find((file) => file.uri === skill.uri)
    // `name` carries the words too: some clients show only it
    const start = `${name} skill: start here`
    listed.push({ uri: skill.uri, name: start, title: start, description: skill.frontmatter.description, mimeType: 'text/markdown', ...(skillFile ? { size: skillFile.size } : {}) })
    if (references.length <= LISTED_REFERENCES)
      for (const file of references) {
        const words = about?.get(file.uri) ?? { title: file.uri.slice(folder.length), description: `A reference of the ${name} skill.` }
        listed.push({ uri: file.uri, name: `${name} skill: ${words.title}`, title: `${name} skill: ${words.title}`, description: words.description, mimeType: mimeTypeOf(file.uri), size: file.size })
      }
    for (const file of resources) {
      const path = file.uri.slice(BASE.length)
      const title = file.uri === skill.uri ? `${name} skill: start here` : about?.get(file.uri)?.title
      files.push({ uri: file.uri, path, ...(title ? { title } : {}) })
      const parts = path.split('/')
      for (let end = 1; end < parts.length; end++) folders.add(parts.slice(0, end).join('/'))
    }
  }
  const guide = { listed, files, folders, starts: entries.map((skill) => skill.uri) }
  guides.set(entries, guide)
  return guide
}

/** `skill://mailroom/` → `mailroom`; `undefined` for a URI outside the skills. */
const pathOf = (uri: string) => (uri.startsWith(BASE) ? uri.slice(BASE.length).replace(/\/+$/, '') : undefined)

/** Where to start, in one sentence: names each `SKILL.md`. */
const startOf = (guide: SkillGuide) => `Start with ${guide.starts.join(' or ')}; resources/list names every skill file.`

/** A folder as Markdown: what it is, which `SKILL.md` to read first, then every file in it as a `skill://` URI. */
const skillFolderText = (catalog: SkillCatalog, uri: string): string | undefined => {
  const guide = guideOf(catalog)
  const path = pathOf(uri)
  if (path === undefined || !guide.folders.has(path)) return undefined
  const inside = guide.files.filter((file) => !path || file.path.startsWith(`${path}/`))
  // The skills in this folder, or else the skill this folder is part of (`mailroom/references`)
  const under = guide.starts.filter((start) => !path || start.startsWith(`${BASE}${path}/`))
  const first = under.length ? under : guide.starts.filter((start) => `${BASE}${path}/`.startsWith(start.slice(0, -'SKILL.md'.length)))
  return [
    `${BASE}${path ? `${path}/` : ''} is a folder, not a file. Read ${first.join(' or ')} first: it says which file to read for each job.`,
    '',
    'Files in it:',
    ...inside.map((file) => `- ${file.uri}${file.title ? ` (${file.title})` : ''}`),
  ].join('\n')
}

/**
 * A server's instructions with one more line when it serves skills: which `SKILL.md` to read first.
 *
 * @example
 * instructionsWithSkills('Mailroom: mail for agents.', skills)
 * // → 'Mailroom: mail for agents.\n\nSkills: read skill://mailroom/SKILL.md first (resources/read); it names the playbook for each job.'
 */
export const instructionsWithSkills = (instructions: string, catalog: SkillCatalog | undefined) => {
  const starts = catalog ? guideOf(catalog).starts : []
  return starts.length ? `${instructions}\n\nSkills: read ${starts.join(' or ')} first (resources/read); it names the playbook for each job.` : instructions
}

/** `skill://{+path}` that also matches `skill://` itself, so a read of the root answers its listing. */
const withRoot = (template: UriTemplate) => {
  const rooted = new UriTemplate(template.toString())
  return Object.assign(rooted, { match: (uri: string) => (uri === BASE ? { path: '' } : UriTemplate.prototype.match.call(rooted, uri)) })
}

type RegisterTemplate = (name: string, template: ResourceTemplate, config: object, read: ReadResourceTemplateCallback) => unknown

/**
 * attachSkills serves a catalog on a server through `SkillsExtension.attach` (so `skills/list`, `skills/get` and
 * directory reads work as the extension defines them) and makes the skills findable by a plain MCP client: the
 * template says where to start, `resources/list` names each `SKILL.md` and its references, a folder read answers a
 * listing, and a miss names the start URI. `mcpServerFactory` calls it.
 *
 * @example
 * attachSkills(new McpServer(info), (await guideSkills({ files: GUIDE_FILES })).skills!)
 */
export const attachSkills = (server: McpServer, catalog: SkillCatalog) => {
  const guide = guideOf(catalog)
  const register = server.registerResource.bind(server) as unknown as RegisterTemplate
  const folder = guide.starts[0]?.slice(0, -'/SKILL.md'.length) ?? BASE
  const described = { title: 'Skills', description: `Every file of this server's skills. ${startOf(guide)} Reading a folder (${folder}) lists its files.` }
  const readOrList = (read: ReadResourceTemplateCallback): ReadResourceTemplateCallback => async (uri, variables, ctx) => {
    const listing = skillFolderText(catalog, uri.href)
    if (listing !== undefined) return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: listing }] }
    try {
      return await read(uri, variables, ctx)
    } catch (error) {
      if (error instanceof ResourceNotFoundError) throw new ResourceNotFoundError(uri.href, `Resource not found: ${uri.href}. ${startOf(guide)}`)
      throw error
    }
  }
  // The SDK registers its template with no words and answers a folder with an extension method: decorate that one
  // registration, for the length of `attach`
  const decorated: RegisterTemplate = (name, template, config, read) =>
    name === SKILLS_EXTENSION_ID
      ? register(name, new ResourceTemplate(withRoot(template.uriTemplate), { list: async () => ({ resources: guide.listed }) }), { ...config, ...described }, readOrList(read))
      : register(name, template, config, read)
  server.registerResource = decorated as unknown as McpServer['registerResource']
  try {
    catalog.attach(server)
  } finally {
    delete (server as Partial<Pick<McpServer, 'registerResource'>>).registerResource
  }
}
