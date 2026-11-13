import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = join(import.meta.dirname, '..', 'cli.mjs')
const FAKE = join(import.meta.dirname, 'fixtures/fake-gh.mjs')
const TEMPLATE_CI = readFileSync(join(import.meta.dirname, '..', 'templates/app/github/workflows/ci.yml'), 'utf8')
const SHARED = join(import.meta.dirname, 'fixtures/shared-workflows')

type State = { name: string; repo: Record<string, unknown>; workflow: Record<string, unknown>; alerts: boolean; fixes: boolean; rulesets: unknown[] | 'forbidden'; contents: Record<string, string> }

/** What GitHub serves for each escalay/.github workflow the CI calls, at the ref it pins: the stand-ins in fixtures/shared-workflows. */
const sharedContentsOf = (ci: string) =>
  Object.fromEntries(
    [...ci.matchAll(/uses: (escalay\/\.github\/\.github\/workflows\/([\w-]+\.yml)@\S+)/g)]
      .filter(([, , file]) => existsSync(join(SHARED, file!)))
      .map(([, called, file]) => [called!, readFileSync(join(SHARED, file!), 'utf8')]),
  )

const folders: string[] = []
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })))

/** An app folder with the template's CI (and a release workflow when asked), and `gh` on the PATH answering from `state`. */
const setUp = (state: Partial<State>, { release = false, ci = TEMPLATE_CI } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'kit-repo-'))
  folders.push(root)
  const app = join(root, 'app')
  mkdirSync(join(app, '.github/workflows'), { recursive: true })
  writeFileSync(join(app, '.github/workflows/ci.yml'), ci)
  if (release) writeFileSync(join(app, '.github/workflows/release.yml'), 'name: Release\n')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  const statePath = join(root, 'state.json')
  const log = join(root, 'calls.log')
  writeFileSync(log, '')
  writeFileSync(statePath, JSON.stringify({ name: 'acme/notes', repo: { private: false, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true }, workflow: { default_workflow_permissions: 'write', can_approve_pull_request_reviews: true }, alerts: false, fixes: false, rulesets: [], contents: sharedContentsOf(ci), ...state }))
  const kit = (...args: string[]) => spawnSync(process.execPath, [CLI, 'repo', ...args], { cwd: app, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: statePath, FAKE_GH_LOG: log } })
  const read = () => JSON.parse(readFileSync(statePath, 'utf8')) as State
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter((line) => !line.startsWith('GET'))
  return { kit, read, calls, app, log }
}

describe('kit repo', () => {
  it('finds every difference from the standard, and apply sets them so check is clean', () => {
    const { kit, read, calls } = setUp({})
    const checked = kit('check')
    expect(checked.status).toBe(1)
    for (const line of ['differs  setting allow_merge_commit: has true, wants false', 'differs  setting allow_auto_merge', 'differs  actions default_workflow_permissions: has "write", wants "read"', 'differs  vulnerability alerts', 'differs  Dependabot security updates', 'differs  ruleset "main": has "missing", wants "present"']) expect(checked.stdout).toContain(line)
    expect(checked.stdout).toContain('to fix on acme/notes: `kit repo apply`')
    expect(calls()).toEqual([])

    const applied = kit('apply')
    expect(applied.status, applied.stdout + applied.stderr).toBe(0)
    expect(calls()).toEqual(['PATCH repos/acme/notes', 'PUT repos/acme/notes/actions/permissions/workflow', 'PUT repos/acme/notes/vulnerability-alerts', 'PUT repos/acme/notes/automated-security-fixes', 'POST repos/acme/notes/rulesets'])
    const state = read()
    expect(state.repo).toMatchObject({ allow_squash_merge: true, allow_rebase_merge: false, allow_merge_commit: false, squash_merge_commit_title: 'PR_TITLE', allow_auto_merge: true, delete_branch_on_merge: true })
    // No release workflow: Actions may not approve pull requests
    expect(state.workflow).toEqual({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false })
    const main = (state.rulesets as { name: string; rules: { type: string; parameters?: Record<string, unknown> }[] }[])[0]!
    expect(main.name).toBe('main')
    expect(main.rules.find((rule) => rule.type === 'required_status_checks')?.parameters?.required_status_checks).toEqual(['checks', 'test', 'workflows', 'secrets'].map((context) => ({ context })))

    const again = kit('check')
    expect(again.status).toBe(0)
    expect(again.stdout).toContain('acme/notes is set up as the standard says (squash merges; required: checks, test, workflows, secrets)')
  })

  it('keeps release-please able to open its pull request, and guards the release tags', () => {
    const { kit, read } = setUp({}, { release: true })
    expect(kit('apply').status).toBe(0)
    const state = read()
    expect(state.workflow.can_approve_pull_request_reviews).toBe(true)
    expect((state.rulesets as { name: string }[]).map((ruleset) => ruleset.name)).toEqual(['main', 'release tags'])
  })

  it('on a private repository without a paid plan sets what it can and says the rules are out of reach', () => {
    const { kit } = setUp({ repo: { private: true }, rulesets: 'forbidden' })
    expect(kit('apply').status).toBe(0)
    const checked = kit('check')
    expect(checked.status).toBe(0)
    expect(checked.stdout).toContain('note     rules for main and auto-merge: GitHub offers them on a private repository only with a paid plan')
    expect(checked.stdout).not.toContain('allow_auto_merge')
  })

  it('takes rebase merges, named checks, and changes a ruleset that drifted', () => {
    const { kit, read, calls } = setUp({})
    expect(kit('apply', '--merge', 'rebase', '--checks', 'lint,unit').status).toBe(0)
    expect(read().repo).toMatchObject({ allow_rebase_merge: true, allow_squash_merge: false })
    expect(kit('check', '--merge', 'rebase', '--checks', 'lint,unit').status).toBe(0)
    // Requiring another check later updates the ruleset in place
    expect(kit('apply', '--merge', 'rebase', '--checks', 'lint,unit,e2e').status).toBe(0)
    expect(calls().at(-1)).toBe('PUT repos/acme/notes/rulesets/100')
    const drifted = kit('check', '--merge', 'rebase', '--checks', 'lint,unit')
    expect(drifted.stdout).toContain('differs  ruleset "main" checks: has ["e2e","lint","unit"], wants ["lint","unit"]')
    expect(drifted.stdout).toContain('`kit repo apply --merge rebase --checks "lint,unit"`')
  })

  it('asks for the checks when a matrix names them', () => {
    const matrix = `${TEMPLATE_CI.replace('  test:\n', '  test:\n    name: test (\${{ matrix.shard }} of 2)\n')}`
    const { kit } = setUp({}, { ci: matrix })
    const refused = kit('check')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('names its checks from a matrix')
  })

  it('requires each always-running job of a called workflow by the name its check reports, read at the ref the CI pins', () => {
    const ci = `name: CI
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm test
  workflows:
    uses: escalay/.github/.github/workflows/workflows.yml@0123abc # v1.0.0
    with:
      also: templates
  secrets:
    name: leaks
    uses: escalay/.github/.github/workflows/secrets.yml@0123abc # v1.0.0
  local:
    uses: ./.github/workflows/local.yml
  self:
    uses: $/.github/workflows/local.yml
  title:
    if: github.event_name == 'pull_request'
    uses: escalay/.github/.github/workflows/title.yml@0123abc # v1.0.0
`
    const { kit, read, app, log } = setUp({}, { ci })
    writeFileSync(join(app, '.github/workflows/local.yml'), readFileSync(join(SHARED, 'workflows.yml'), 'utf8').replace('lint:', 'build:'))
    expect(kit('apply').status).toBe(0)
    const main = (read().rulesets as { rules: { type: string; parameters?: { required_status_checks?: unknown } }[] }[])[0]!
    // The called workflow's conditional job, and the caller's conditional job, are left out
    expect(main.rules.find((rule) => rule.type === 'required_status_checks')?.parameters?.required_status_checks).toEqual(['test', 'workflows / lint', 'leaks / gitleaks', 'local / build', 'self / build'].map((context) => ({ context })))
    expect(readFileSync(log, 'utf8')).toContain('GET repos/escalay/.github/contents/.github/workflows/workflows.yml?ref=0123abc')
  })

  it('asks for the checks when a called workflow can\'t be read', () => {
    const ci = `jobs:\n  workflows:\n    uses: escalay/.github/.github/workflows/gone.yml@0123abc\n`
    const refused = setUp({}, { ci }).kit('check')
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain("can't read escalay/.github/.github/workflows/gone.yml@0123abc to name its checks")
    expect(refused.stderr).toContain('--checks')
  })

  it('takes named checks with spaces in them', () => {
    const { kit, read } = setUp({})
    expect(kit('apply', '--checks', 'gate, workflows / lint').status).toBe(0)
    const main = (read().rulesets as { rules: { type: string; parameters?: { required_status_checks?: unknown } }[] }[])[0]!
    expect(main.rules.find((rule) => rule.type === 'required_status_checks')?.parameters?.required_status_checks).toEqual([{ context: 'gate' }, { context: 'workflows / lint' }])
  })
})
