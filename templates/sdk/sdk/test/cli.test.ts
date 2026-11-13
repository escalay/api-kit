import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createApp, VERSION } from '../../src/app.js'
import { hashApiKey, testDb } from '../../src/kit/index.js'
import { mountedMcp } from '../../src/kit/mcp/index.js'
import { cliGaps, cliSnapshot } from '../../src/kit/testing/index.js'
import { createCli } from '../cli/engine/index.js'
import { jobs } from '../cli/jobs/index.js'

const KEY = 'test-key'
const packaged = readFileSync(new URL('../cli/commands.json', import.meta.url), 'utf8')
const app = await createApp({ db: await testDb(), env: { API_KEYS: `tester:${hashApiKey(KEY)}` } })
// The tools and resources the app mounted at /mcp
const { tools, resources } = mountedMcp(app)

/** The `__bin__` command in this process, against the whole app, signed in with a key. */
const run = async (argv: string[]) => {
  let out = ''
  let err = ''
  const cli = createCli({
    name: '__bin__',
    envPrefix: '__PREFIX__',
    version: VERSION,
    snapshot: JSON.parse(packaged),
    jobs,
    fetch: async (input, init) => app.request(String(input), init),
    io: { stdout: { write: (text: string) => (out += text) }, stderr: { write: (text: string) => (err += text) }, stdin: Readable.from(['']) as never, env: { __PREFIX___URL: 'http://localhost', __PREFIX___API_KEY: KEY }, configDir: mkdtempSync(join(tmpdir(), 'cli-')) },
  })
  return { code: await cli.run(argv), out, err }
}

describe('the command line', () => {
  it('names every tool, resource and job well', () => {
    expect(cliGaps({ tools, resources, jobs })).toEqual([])
  })

  it('packages the commands as they are now (run `pnpm sdk:types` after changing a tool or a job)', () => {
    expect(packaged).toBe(`${JSON.stringify(cliSnapshot({ app: '__bin__', version: VERSION, tools, resources, jobs }), null, 2)}\n`)
  })

  it('offers the same commands from the deployment as it packages, and runs them', async () => {
    const listed = await run(['commands', '--json'])
    expect(listed.code, listed.err).toBe(0)
    expect(JSON.parse(listed.out)).toEqual(JSON.parse(packaged))
    expect((await run(['doctor'])).out).toMatch(/^ok {4}drift/m)
  })
})
