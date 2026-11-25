import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const KIT = join(import.meta.dirname, '..')
const KIT_VERSION: string = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8')).version
const UPGRADING = readFileSync(join(KIT, 'docs/upgrading.md'), 'utf8')
const run = (cliPath: string, cwd: string, ...args: string[]) => spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' })
const cli = (cwd: string, ...args: string[]) => run(join(KIT, 'cli.mjs'), cwd, ...args)

/** A part folder's section of docs/upgrading.md, without its `## ` line. */
const sectionOf = (folder: string, markdown = UPGRADING) => {
  const start = markdown.indexOf(`\n## ${folder}\n`)
  const end = markdown.indexOf('\n## ', start + 1)
  return markdown.slice(start + `\n## ${folder}\n`.length, end < 0 ? undefined : end)
}

/** An app whose kit.json records `version`, with `parts` (and what they need) copied in. */
const appAt = async (version: string, ...parts: string[]) => {
  const app = await mkdtemp(join(tmpdir(), 'kit-upgrading-'))
  expect(cli(app, 'add', ...parts).status).toBe(0)
  const lockPath = join(app, 'src/kit/kit.json')
  await writeFile(lockPath, JSON.stringify({ ...JSON.parse(await readFile(lockPath, 'utf8')), version }))
  return app
}

/** A copy of the kit whose docs/upgrading.md is `markdown`: the CLI reads the docs beside itself (and the parts, linked). */
const kitWithNotes = async (markdown: string) => {
  const kit = await mkdtemp(join(tmpdir(), 'kit-copy-'))
  for (const file of ['cli.mjs', 'registry.json', 'package.json']) await copyFile(join(KIT, file), join(kit, file))
  await symlink(join(KIT, 'src'), join(kit, 'src'), 'dir')
  await mkdir(join(kit, 'docs'))
  await writeFile(join(kit, 'docs/upgrading.md'), markdown)
  return kit
}

/** Runs a `kit …` command exactly as the CLI printed it between backticks. */
const runPrinted = (app: string, printed: string) => {
  const command = /`(kit upgrading[^`]*)`/.exec(printed)?.[1]
  expect(command, printed).toBeDefined()
  return cli(app, ...command!.split(' ').slice(1))
}

describe('kit upgrading', () => {
  it('prints every note of each installed part’s section after the version kit.json records, and no other part’s', async () => {
    const app = await appAt('0.0.1', 'oauth', 'search-react')
    const printed = cli(app, 'upgrading')
    expect(printed.status, printed.stderr).toBe(0)
    expect(printed.stdout).toContain(`Upgrade notes for core, db, oauth, browser after kit 0.0.1, up to kit ${KIT_VERSION}`)
    // A browser part's notes are its README's folder: browser
    for (const folder of ['core', 'oauth']) {
      expect(printed.stdout).toContain(`\n## ${folder}\n`)
      for (const heading of sectionOf(folder).match(/^### .*$/gm) ?? []) expect(printed.stdout, `${folder}: ${heading}`).toContain(heading)
      for (const line of sectionOf(folder).split('\n').filter((one) => one.startsWith('- '))) expect(printed.stdout, line).toContain(line)
    }
    for (const folder of ['guide', 'mcp', 'switches', 'testing']) expect(printed.stdout, folder).not.toContain(`\n## ${folder}\n`)
  })

  it('leaves out what kit.json’s version already had, or --from’s', async () => {
    const app = await appAt('1.29.0', 'core')
    const since = cli(app, 'upgrading').stdout
    expect(since).toContain('### 1.30.0')
    expect(since).toContain('`tellApp`')
    expect(since).not.toContain('### 1.29.0')
    const from = cli(app, 'upgrading', '--from', '1.27.0').stdout
    expect(from).toContain('Upgrade notes for core after kit 1.27.0')
    for (const heading of ['### 1.30.0', '### 1.29.0', '### 1.27.1']) expect(from, heading).toContain(heading)
    expect(from).not.toContain('### 1.27.0')
    // Versions compare as numbers, not text
    expect(cli(app, 'upgrading', '--from', '1.9.0').stdout).toContain('### 1.27.0')
    expect(cli(app, 'upgrading', '--from', 'latest').stderr).toContain('--from is a version, like 1.29.0')
  })

  it('says so when nothing changed for the parts since', async () => {
    // Notes up to this kit only: the real docs may hold Unreleased notes for core
    const kit = await kitWithNotes(['# Upgrading', '', '## core', '', `### ${KIT_VERSION}`, '', '- a note', '', '## db', '', `### ${KIT_VERSION}`, '', '- a note', ''].join('\n'))
    const app = await appAt(KIT_VERSION, 'db')
    const printed = run(join(kit, 'cli.mjs'), app, 'upgrading')
    expect([printed.status, printed.stdout]).toEqual([0, `No upgrade notes for core, db after kit ${KIT_VERSION} (this is kit ${KIT_VERSION})\n`])
    const none = await mkdtemp(join(tmpdir(), 'kit-upgrading-'))
    expect(cli(none, 'upgrading').stderr).toContain('no kit.json in src/kit')
  })

  it('reads Unreleased notes, topics after a version, and code blocks as the notes they are in', async () => {
    const kit = await kitWithNotes(
      [
        '# Upgrading', '', '## Taking a new version', '', '### 9.9.9', '', '- not a part', '',
        '## core', '', 'Read these first.', '',
        '### Unreleased (after 1.30.0)', '', '- an unreleased note', '',
        '### 1.30.0: approvals', '', '- a topic note', '', '```md', '## not a section', '### not a note', '```', '',
        '### 1.30.0', '', '- a plain note', '',
        '### 1.29.0', '', '- an old note', '',
        '## browser', '', '### 1.30.0', '', '- a browser note', '',
        '## mcp', '', '### 1.30.0', '', '- an mcp note', '',
      ].join('\n'),
    )
    const app = await appAt('1.29.0', 'core', 'search-client')
    const printed = run(join(kit, 'cli.mjs'), app, 'upgrading')
    expect(printed.stdout).toBe(
      [
        `Upgrade notes for core, browser after kit 1.29.0, up to kit ${KIT_VERSION} (the kit's docs/upgrading.md):`, '',
        '## core', '',
        '### Unreleased (after 1.30.0)', '', '- an unreleased note', '',
        '### 1.30.0: approvals', '', '- a topic note', '', '```md', '## not a section', '### not a note', '```', '',
        '### 1.30.0', '', '- a plain note', '',
        '## browser', '',
        '### 1.30.0', '', '- a browser note', '',
      ].join('\n'),
    )
  })

  it('names each edit the kit changed too in a part whose notes name a fix, with the command that takes it', async () => {
    const kit = await kitWithNotes(
      ['# Upgrading', '', '## core', '', '### Unreleased (after 0.0.1)', '', '- **Fixed: a retry was answered twice.** Take core.', '', '## pagination', '', '### Unreleased (after 0.0.1)', '', '- A new option.', ''].join('\n'),
    )
    const app = await appAt('0.0.1', 'pagination')
    // Each edited here, and the kit changed each since 0.0.1; only core's notes name a fix
    await writeFile(join(app, 'src/kit/core/hal.ts'), '// mine\n')
    await writeFile(join(app, 'src/kit/pagination/index.ts'), '// mine\n')
    // The generated index.ts too, which no part's notes cover
    await writeFile(join(app, 'src/kit/index.ts'), '// mine\n')
    const lockPath = join(app, 'src/kit/kit.json')
    const lock = JSON.parse(await readFile(lockPath, 'utf8'))
    await writeFile(lockPath, JSON.stringify({ ...lock, files: { ...lock.files, 'core/hal.ts': 'older', 'pagination/index.ts': 'older', 'index.ts': 'older' } }))
    const printed = run(join(kit, 'cli.mjs'), app, 'upgrading')
    expect(printed.status, printed.stderr).toBe(0)
    expect(printed.stdout.split('\n').filter((line) => line.startsWith('fix '))).toEqual([
      "fix      core/hal.ts: your edit, and the kit changed it since; core's notes below name a fix: `kit diff --dir src/kit --patch` shows both; `kit update core --dir src/kit --force` takes the kit's, then make your edits again",
    ])
    // Before the notes, so it is read first
    expect(printed.stdout.indexOf('fix      ')).toBeLessThan(printed.stdout.indexOf('## core'))
    // A part a later kit added, which this one doesn't know, changes nothing
    await writeFile(lockPath, JSON.stringify({ ...JSON.parse(await readFile(lockPath, 'utf8')), modules: [...lock.modules, 'from-a-later-kit'] }))
    expect(run(join(kit, 'cli.mjs'), app, 'upgrading').stdout).toContain('fix      core/hal.ts')
    await writeFile(lockPath, JSON.stringify({ ...JSON.parse(await readFile(lockPath, 'utf8')), modules: lock.modules }))
    // Taken from the kit: nothing to say
    expect(run(join(kit, 'cli.mjs'), app, 'update', 'core', '--force').status).toBe(1)
    expect(run(join(kit, 'cli.mjs'), app, 'upgrading', '--from', '0.0.1').stdout).not.toContain('fix      ')
  })

  it('prints nothing newer than the kit it runs as', async () => {
    const [major, minor, patch] = KIT_VERSION.split('.').map(Number) as [number, number, number]
    const newer = `${major}.${minor}.${patch + 1}`
    const kit = await kitWithNotes(
      ['# Upgrading', '', '## core', '', `### Unreleased (after ${newer})`, '', '- after the next', '', `### ${newer}`, '', '- the next', '', `### Unreleased (after ${KIT_VERSION})`, '', '- unreleased here', '', `### ${KIT_VERSION}`, '', '- this one', ''].join('\n'),
    )
    const printed = run(join(kit, 'cli.mjs'), await appAt('1.0.0', 'core'), 'upgrading').stdout
    expect(printed).toContain('- this one')
    expect(printed).toContain('- unreleased here')
    for (const later of ['- the next', '- after the next']) expect(printed, later).not.toContain(later)
  })

  it('links the changelog where an app can open it: the npm package ships docs/ without CHANGELOG.md', () => {
    const links = [...UPGRADING.matchAll(/\]\(([^)#]*CHANGELOG[^)]*)\)/g)].map(([, link]) => link)
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(link).toMatch(/^https:\/\/github\.com\/escalay\/api-kit\//)
  })

  it('is what doctor and update tell an app behind the kit to run, and what they print gives the notes', async () => {
    const app = await appAt('1.29.0', 'core')
    const doctor = cli(app, 'doctor')
    const note = 'note     kit.json says kit 1.29.0: `kit upgrading --dir src/kit` prints what changed for its parts since, and what to do'
    expect(doctor.stdout.split('\n')).toContain(note)
    // The note is not a finding, as docs/upgrading.md says: the one to fix is the `behind` line doctor printed before
    expect(doctor.stdout.split('\n').filter((line) => /^\w+ {2,}/.test(line)).map((line) => line.split(' ')[0])).toEqual(['note', 'behind'])
    expect([doctor.status, doctor.stdout.split('\n').at(-2)]).toEqual([1, '1 to fix in src/kit'])
    expect(UPGRADING).toContain('neither changes the exit code or `doctor`\'s count to fix')
    expect(runPrinted(app, note).stdout).toContain('### 1.30.0')
    const updated = cli(app, 'update')
    expect(updated.status).toBe(0)
    const told = updated.stdout.split('\n').find((line) => line.includes('kit upgrading'))!
    expect(told).toBe('What changed for these parts since kit 1.29.0: `kit upgrading --dir src/kit --from 1.29.0`')
    // kit.json now records this kit, so the printed --from is what still finds the notes: plain `upgrading` prints no
    // released version's notes, only Unreleased ones when the docs have them
    const current = cli(app, 'upgrading')
    expect(current.status, current.stderr).toBe(0)
    expect(current.stdout).not.toMatch(/^### \d/m)
    expect(runPrinted(app, told).stdout).toContain('### 1.30.0')
    // An app at this kit's version is told nothing
    expect(cli(app, 'doctor').stdout).not.toContain('kit upgrading')
    expect(cli(app, 'update').stdout).not.toContain('kit upgrading')
  })

  it('reads the docs the npm package ships', async () => {
    expect(JSON.parse(await readFile(join(KIT, 'package.json'), 'utf8')).files).toContain('docs')
  })

  it('is how the kit’s skill and a new app’s AGENTS.md take a newer kit', async () => {
    for (const path of ['skills/api-kit-build/SKILL.md', 'templates/app/AGENTS.md']) expect(await readFile(join(KIT, path), 'utf8'), path).toContain('npx @escalay/kit upgrading')
  })
})
