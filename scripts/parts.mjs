#!/usr/bin/env node
/**
 * docs/PARTS.md, made from registry.json: every part with what it needs, where the app imports it from, its STANDARD
 * sections (`meta.standard`) and its browser layers (`meta.layerOf`), how the parts depend on each other, and which
 * parts a goal takes, in the order they go in. Also the root README's two generated tables: the parts (from
 * registry.json) and the skills (from each `skills/<name>/SKILL.md` frontmatter), each between its markers.
 * `pnpm parts` writes them; `test/parts.test.mjs` fails when one is stale.
 *
 * @example
 * node scripts/parts.mjs           // writes docs/PARTS.md and README.md's tables
 * node scripts/parts.mjs --check   // exits 1 when either is stale
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const KIT = 'escalay/api-kit/'

/**
 * What an app wants done, and the parts that do it. Without `parts`, the parts `init` copies into a new app.
 * `note` is what the parts alone don't say.
 */
export const GOALS = [
  { goal: 'Start a new API', command: 'npm create escalay@latest <name>', note: 'the starter, with an example feature and its tests' },
  { goal: 'Put an existing API on the standard', parts: ['core', 'db', 'pagination', 'guide', 'mcp', 'testing'] },
  { goal: 'Lists that page', parts: ['pagination'] },
  { goal: 'Agents and MCP clients sign in without a pasted key', parts: ['oauth'], note: 'the owner approves each one on the kit’s page' },
  { goal: 'The owner signs in with a passkey and claims a fresh deployment', parts: ['people', 'setup'] },
  { goal: 'A team: members through Cloudflare Access, with roles', parts: ['people'] },
  { goal: 'API keys made and revoked through the API, and `GET /api/me`', parts: ['keys'] },
  { goal: 'Search by words, picture and likeness', parts: ['vectors', 'vector-search', 'search-client', 'search-react', 'vector-search-ui'], note: 'the browser layers go into the frontend (`--web-dir`)' },
  { goal: 'Boards: the owner’s collections of the app’s items', parts: ['boards', 'boards-client', 'boards-react'] },
  { goal: 'Feature switches, and license keys for paid features', parts: ['switches', 'switches-client', 'switches-react', 'switches-ui'] },
  { goal: 'A daily anonymous usage report', parts: ['telemetry'] },
  { goal: 'One brand on every surface', parts: ['brand'], note: 'then `npx @escalay/kit brand` renders it' },
  { goal: 'Other agents delegate through A2A', parts: ['a2a'] },
  { goal: 'A public front page and the browser app under `/app`, on Node', parts: ['web'] },
  { goal: 'Sharing: invites to a space, the owner’s approval at it', parts: ['sharing'], note: 'then `await sharing.sweep()` in the scheduled handler (its README, Wire it)' },
]

/**
 * Every part's README: `# <folder>`, one paragraph saying what it is, then these sections in this order
 * (`test/readmes.test.mjs` checks them).
 */
export const README_SHAPE = [
  ['Use it when', 'what it is for'],
  ["Don't use it when", 'what it is not for, and what to use instead'],
  ['Add it', 'the `kit add` command and what the part needs'],
  ['Wire it', 'the block to copy into the app'],
  ['Options', 'a table: option, type, default, what it does'],
  ['Exports', 'what the part exports, and its files'],
  ['Flows', 'a Mermaid sequence or state diagram for every flow of more than two steps'],
  ['Rules', 'what holds, and the STANDARD sections'],
  ['Failure modes', 'a table: what the caller sees, and why'],
  ['Limits', 'scaling ceilings and runtimes: Node only, Workers, one writer'],
  ['Tests', 'the helpers that test it, and the kit’s own tests'],
  ['Upgrading', 'a link to its section of docs/upgrading.md, never history inline'],
]

/** A list of part names cli.mjs declares as `const <name> = [...]`. */
const listIn = (cliSource, name) => {
  const list = new RegExp(`const ${name} = \\[([^\\]]*)\\]`).exec(cliSource)?.[1]
  if (!list) throw new Error(`cli.mjs has no ${name} list`)
  return [...list.matchAll(/'([\w-]+)'/g)].map((match) => match[1])
}

/** The parts `init` copies into every new app: `APP_MODULES` in cli.mjs. */
export const starterParts = (cliSource) => listIn(cliSource, 'APP_MODULES')

const partsOf = (registry) => registry.items.filter((item) => !item.meta?.root)
const requiresOf = (item) => (item.registryDependencies ?? []).filter((name) => name.startsWith(KIT)).map((name) => name.slice(KIT.length))

/** The parts wanted and every part they need, in registry order: the order `kit add` copies them in. */
export const orderOf = (registry, wanted) => {
  const byName = new Map(partsOf(registry).map((item) => [item.name, item]))
  const all = new Set()
  const visit = (name) => {
    if (all.has(name)) return
    if (!byName.has(name)) throw new Error(`no part ${name} in registry.json`)
    for (const needed of requiresOf(byName.get(name))) visit(needed)
    all.add(name)
  }
  wanted.forEach(visit)
  return [...byName.keys()].filter((name) => all.has(name))
}

const code = (text) => `\`${text}\``
const cell = (text) => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
const packageOf = (dependency) => (dependency.lastIndexOf('@') > 0 ? dependency.slice(0, dependency.lastIndexOf('@')) : dependency)

/** Parts, npm packages (a bare name is a peer), optional packages and shadcn components, in that order. */
const needsOf = (item) => {
  const parts = requiresOf(item).map(code)
  const packages = (item.dependencies ?? []).map((dependency) => (dependency.lastIndexOf('@') > 0 ? code(packageOf(dependency)) : `${code(dependency)} (peer)`))
  const optional = Object.keys(item.meta?.optionalDependencies ?? {}).map((name) => `${code(name)} (optional)`)
  const shadcn = (item.registryDependencies ?? []).filter((name) => !name.startsWith(KIT)).map((name) => `shadcn ${code(name)}`)
  const all = [...parts, ...packages, ...optional, ...shadcn]
  return all.length ? all.join(', ') : 'nothing'
}

/** An entry part is imported from its own file; every other part through the generated `./kit/index.js`. */
const importOf = (item) => {
  if (!item.meta?.entry) return code('./kit/index.js')
  const files = item.files.map((file) => file.path).filter((path) => !path.endsWith('.md'))
  const file = files.find((path) => path.endsWith('/index.ts')) ?? files[0]
  return code(`./kit/${file.replace(/^src\//, '').replace(/\.tsx?$/, '.js')}`)
}

/** `[1, 2, 3, 12]` → `§1–3, §12`. */
export const sectionsOf = (numbers) => {
  const runs = []
  for (const number of numbers) {
    const last = runs.at(-1)
    if (last && number === last[1] + 1) last[1] = number
    else runs.push([number, number])
  }
  return runs.map(([from, to]) => (from === to ? `§${from}` : to === from + 1 ? `§${from}, §${to}` : `§${from}–${to}`)).join(', ')
}

const readmeOf = (item) => {
  const path = item.files.map((file) => file.path).find((one) => one.endsWith('README.md'))
  return `[README](../${path})`
}

const nodeOf = (name) => name.replace(/-/g, '_')

export const partsMarkdown = (registry, cliSource) => {
  const parts = partsOf(registry)
  const server = parts.filter((item) => !item.meta?.web)
  const web = parts.filter((item) => item.meta?.web)
  const layersOf = (name) => web.filter((item) => item.meta.layerOf === name).map((item) => code(item.name)).join(', ') || '—'
  const goalRow = ({ goal, parts: wanted, command, note }) => {
    const order = orderOf(registry, wanted ?? starterParts(cliSource))
    const how = command ? code(command) : code(`npx @escalay/kit add ${wanted.join(' ')}`)
    // The starter's browser side: what `--preset app` adds to web/kit/
    const preset = wanted ? '' : `; \`--preset app\` adds ${listIn(cliSource, 'WEB_APP_MODULES').map(code).join(' and ')} to \`web/kit/\``
    return `| ${cell(goal)} | ${order.map(code).join(' → ')} | ${how}${note ? `: ${cell(note)}` : ''}${preset} |`
  }
  const edges = parts.flatMap((item) => requiresOf(item).map((needed) => `  ${nodeOf(item.name)} --> ${nodeOf(needed)}`))
  return [
    '# The parts',
    '',
    '<!-- Generated by `pnpm parts` (scripts/parts.mjs) from registry.json: edit those, never this file. test/parts.test.mjs fails when it is stale. -->',
    '',
    'Every part is a folder an app copies into `src/kit/` with `npx @escalay/kit add <part>`; the parts it needs come with',
    'it. An app imports `./kit/index.js`, which re-exports every part that is not an entry of its own, and each entry part',
    'from its own file. Browser layers go into the frontend (`--web-dir`). Each part’s README says how to use it.',
    '',
    '## Which part for which goal',
    '',
    'The parts in the order they go in: each after the parts it needs. `kit add` brings the needed ones by itself.',
    '',
    '| Goal | Parts, in order | How |',
    '|---|---|---|',
    ...GOALS.map(goalRow),
    '',
    '## Server parts',
    '',
    '| Part | What it is | Needs | Import from | STANDARD | Browser layers | Docs |',
    '|---|---|---|---|---|---|---|',
    ...server.map((item) => `| ${code(item.name)} | ${cell(item.description)} | ${needsOf(item)} | ${importOf(item)} | ${sectionsOf(item.meta.standard)} | ${layersOf(item.name)} | ${readmeOf(item)} |`),
    '',
    '## Browser layers',
    '',
    'Headless clients, React hooks and optional shadcn blocks over a server part’s routes, for the app’s frontend.',
    '',
    '| Part | What it is | Needs | Import from | STANDARD | Layer of | Docs |',
    '|---|---|---|---|---|---|---|',
    ...web.map((item) => `| ${code(item.name)} | ${cell(item.description)} | ${needsOf(item)} | ${importOf(item)} | ${sectionsOf(item.meta.standard)} | ${code(item.meta.layerOf)} | ${readmeOf(item)} |`),
    '',
    '## Root items',
    '',
    'Repository setup, not parts: their files go to the repository’s root, only the shadcn CLI installs them, and `kit add`',
    'refuses them.',
    '',
    ...registry.items.filter((item) => item.meta?.root).map((item) => `- ${code(item.name)}: ${cell(item.description)}. ${code(`npx shadcn add ${KIT}${item.name}`)}`),
    '',
    '## How they depend on each other',
    '',
    'An arrow points at a part the other needs.',
    '',
    '```mermaid',
    'flowchart LR',
    ...parts.map((item) => `  ${nodeOf(item.name)}[${item.name}]`),
    ...edges,
    `  classDef layer stroke-dasharray: 4 3`,
    `  class ${web.map((item) => nodeOf(item.name)).join(',')} layer`,
    '```',
    '',
    'Dashed: browser layers.',
    '',
    '## Every README has one shape',
    '',
    'Each part’s README opens with `# <folder>` and one paragraph saying what it is, then these sections, in this order',
    '(`test/readmes.test.mjs` checks them). What changed between versions lives in [upgrading.md](upgrading.md), never in',
    'a README.',
    '',
    ...README_SHAPE.map(([heading, what], index) => `${index + 1}. **${heading}**: ${what}`),
    '',
  ].join('\n')
}

/** Each skill in `skills/`, by folder: its frontmatter's `name` and `description`. */
export const skillsIn = (root) =>
  readdirSync(join(root, 'skills'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((folder) => {
      const text = readFileSync(join(root, 'skills', folder, 'SKILL.md'), 'utf8')
      const field = (key) => new RegExp(`^${key}: (.*)$`, 'm').exec(text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '')?.[1]
      return { name: field('name') ?? folder, description: field('description') ?? '' }
    })

const partsTable = (registry) => [
  '| Part | What | README |',
  '|---|---|---|',
  ...partsOf(registry).map((item) => {
    const path = item.files.map((file) => file.path).find((one) => one.endsWith('/README.md'))
    return `| ${code(item.name)} | ${cell(item.description)} | [${path.split('/')[1]}](${path}) |`
  }),
]

/** A skill's README cell: its description's first sentence after "Use when"; the rest (what it covers) stays in the skill. */
export const useItWhen = (description) => `${description.replace(/^Use when /, '').split('. ')[0].replace(/\.$/, '')}.`

const skillsTable = (skills) => [
  '| Skill | Use it when |',
  '|---|---|',
  ...skills.map(({ name, description }) => `| [${code(name)}](skills/${name}/SKILL.md) | ${cell(useItWhen(description))} |`),
]

/** Replaces what sits between `<!-- <name>:start … -->` and `<!-- <name>:end -->` with `lines`; throws when a marker is gone. */
const between = (text, name, source, lines) => {
  const start = text.indexOf(`<!-- ${name}:start`)
  const end = text.indexOf(`<!-- ${name}:end -->`)
  if (start < 0) throw new Error(`README.md lost its <!-- ${name}:start --> marker`)
  if (end < start) throw new Error(`README.md lost its <!-- ${name}:end --> marker`)
  const block = [`<!-- ${name}:start: generated by \`pnpm parts\` from ${source}; edit that, never this table -->`, ...lines, '']
  return `${text.slice(0, start)}${block.join('\n')}${text.slice(end)}`
}

/** The root README with its parts table (from registry.json) and skills table (from each skill's frontmatter) written. */
export const withReadmeTables = (readme, registry, skills) =>
  between(between(readme, 'parts', 'registry.json', partsTable(registry)), 'skills', 'each skill’s frontmatter', skillsTable(skills))

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const root = join(fileURLToPath(import.meta.url), '..', '..')
  const registry = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))
  const outputs = [
    ['docs/PARTS.md', partsMarkdown(registry, readFileSync(join(root, 'cli.mjs'), 'utf8'))],
    ['README.md', withReadmeTables(readFileSync(join(root, 'README.md'), 'utf8'), registry, skillsIn(root))],
  ]
  if (process.argv.includes('--check')) {
    const stale = outputs.filter(([path, text]) => readFileSync(join(root, path), 'utf8') !== text).map(([path]) => path)
    console.log(stale.length ? `${stale.join(' and ')} stale: run \`pnpm parts\`` : 'docs/PARTS.md and README.md are current')
    process.exit(stale.length ? 1 : 0)
  }
  for (const [path, text] of outputs) writeFileSync(join(root, path), text)
  console.log(`Wrote ${outputs.map(([path]) => path).join(' and ')}`)
}
