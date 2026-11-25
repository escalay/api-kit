/**
 * The container's env allowlist (container/entrypoint.sh) and the settings the app reads, held in step: a setting Env
 * gains reaches the container only once the entrypoint passes it, and the entrypoint passes nothing the app ignores.
 * `kit doctor` reads by the same rule: Env's members with comments taken out, and process.env in every file under src/.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const app = read('src/app.ts')
const start = /export type Env = \{/.exec(app)!
const body = app.slice(start.index + start[0].length).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').split('}')[0]!
const env = body.split(/[;,\n]/).flatMap((member) => /^\s*(\w+)\??\s*:/.exec(member)?.[1] ?? [])
const sources = readdirSync(new URL('../src', import.meta.url), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
const readBySource = sources.flatMap((entry) => [...readFileSync(join(entry.parentPath, entry.name), 'utf8').matchAll(/process\.env(?:\.(\w+)|\[\s*['"](\w+)['"]\s*\])/g)].map(([, dotted, quoted]) => (dotted ?? quoted)!))
const passed = [...read('container/entrypoint.sh').matchAll(/\$\{(\w+):\+/g)].map(([, key]) => key!)

it('passes every setting Env in src/app.ts reads through container/entrypoint.sh, and nothing else', () => {
  // notPassed: add ${NAME:+NAME="$NAME"} to container/entrypoint.sh; neverRead: take it out there, or add it to Env
  const notPassed = env.filter((key) => !passed.includes(key))
  const neverRead = passed.filter((key) => !env.includes(key) && !readBySource.includes(key))
  expect({ notPassed, neverRead }).toEqual({ notPassed: [], neverRead: [] })
})
