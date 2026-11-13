// A stand-in for the GitHub CLI in `kit repo` tests: answers from a JSON state file, applies writes to it, logs each call
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const statePath = process.env.FAKE_GH_STATE
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const args = process.argv.slice(2)
const save = () => writeFileSync(statePath, JSON.stringify(state))
const answer = (body) => (body === undefined ? process.exit(0) : (process.stdout.write(JSON.stringify(body)), process.exit(0)))
const refuse = (status, message) => {
  process.stdout.write(JSON.stringify({ message, status: String(status) }))
  process.stderr.write(`gh: ${message} (HTTP ${status})\n`)
  process.exit(1)
}

if (args[0] === 'repo' && args[1] === 'view') process.stdout.write(state.name), process.exit(0) // -q prints the text
const method = args[args.indexOf('--method') + 1]
const path = args.find((arg) => arg.startsWith('repos/'))
const body = args.includes('--input') ? JSON.parse(readFileSync(0, 'utf8')) : undefined
appendFileSync(process.env.FAKE_GH_LOG, `${method} ${path}\n`)
const base = `repos/${state.name}`
const rulesetId = path.match(/\/rulesets\/(\d+)$/)?.[1]

// A file of any repository, as `contents` holds it under `owner/repo/path@ref`
const file = path.match(/^repos\/([^/]+\/[^/]+)\/contents\/([^?]+)\?ref=(.+)$/)
if (file) {
  const text = state.contents?.[`${file[1]}/${file[2]}@${decodeURIComponent(file[3])}`]
  if (text === undefined) refuse(404, 'Not Found')
  answer({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') })
}

if (path === base) {
  // Like GitHub, a repository that can't have rules keeps auto-merge off whatever it is sent
  if (method === 'PATCH') Object.assign(state.repo, body, state.rulesets === 'forbidden' ? { allow_auto_merge: false } : {}), save()
  answer(state.repo)
}
if (path === `${base}/actions/permissions/workflow`) {
  if (method === 'PUT') Object.assign(state.workflow, body), save()
  answer(method === 'PUT' ? undefined : state.workflow)
}
if (path === `${base}/vulnerability-alerts`) {
  if (method === 'PUT') (state.alerts = true), save()
  if (!state.alerts) refuse(404, 'Not Found')
  answer()
}
if (path === `${base}/automated-security-fixes`) {
  if (method === 'PUT') (state.fixes = true), save()
  answer(method === 'PUT' ? undefined : { enabled: state.fixes, paused: false })
}
if (path.startsWith(`${base}/rulesets`)) {
  if (state.rulesets === 'forbidden') refuse(403, 'Upgrade to GitHub Pro or make this repository public to enable this feature.')
  if (method === 'POST') state.rulesets.push({ ...body, id: 100 + state.rulesets.length }), save()
  if (method === 'PUT') state.rulesets = state.rulesets.map((ruleset) => (String(ruleset.id) === rulesetId ? { ...body, id: ruleset.id } : ruleset)), save()
  if (rulesetId) answer(state.rulesets.find((ruleset) => String(ruleset.id) === rulesetId))
  answer(method === 'GET' ? state.rulesets.map(({ id, name }) => ({ id, name })) : {})
}
refuse(404, `fake gh knows no ${method} ${path}`)
