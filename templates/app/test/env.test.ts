/**
 * The container's env allowlist (container/entrypoint.sh) and the settings the app reads, held in step: a setting Env
 * gains reaches the container only once the entrypoint passes it, and the entrypoint passes nothing the app ignores.
 */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const env = [.../export type Env = \{([^}]*)\}/.exec(read('src/app.ts'))![1]!.matchAll(/(\w+)\??\s*:/g)].map(([, key]) => key!)
const server = [...read('src/server.ts').matchAll(/process\.env\.(\w+)/g)].map(([, key]) => key!)
const passed = [...read('container/entrypoint.sh').matchAll(/\$\{(\w+):\+/g)].map(([, key]) => key!)

it('passes every setting Env in src/app.ts reads through container/entrypoint.sh, and nothing else', () => {
  // notPassed: add ${NAME:+NAME="$NAME"} to container/entrypoint.sh; neverRead: take it out there, or add it to Env
  const notPassed = env.filter((key) => !passed.includes(key))
  const neverRead = passed.filter((key) => !env.includes(key) && !server.includes(key))
  expect({ notPassed, neverRead }).toEqual({ notPassed: [], neverRead: [] })
})
