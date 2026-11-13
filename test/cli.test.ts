import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { boardTools } from '../src/boards/index.js'
import { vectorSearchTools } from '../src/vector-search/index.js'
import { cliMarkdown, createAgentApi, createOAuth, fallbackCliName, hintsOf, keyTools, teamTools, telemetryTools, generateOAuthKey, HAL_JSON, linksOf, memoryOAuthStore, mintApiKey, originOf, pageOf, pageSchema, parseApiKeys, problemResponses, ProblemError, LinksSchema } from '../src/index.js'
import { cliOf, inProcess, mcpResource, mcpServerFactory, mcpTool, mountMcp } from '../src/mcp/index.js'
import { pathKeysOf } from '../src/core/cli.js'
import { cliGaps, cliSnapshot, guideGaps } from '../src/testing/index.js'
import { createCli } from '../templates/sdk/sdk/cli/engine/index.js'
import { configDirOf } from '../templates/sdk/sdk/cli/engine/auth.js'
import { defineJob } from '../templates/sdk/sdk/cli/engine/job.js'

const { key, hash } = mintApiKey('test')
const OWNER = 'owner@example.test'
const base = { title: 'T', description: 'D', summarize: () => '' }

const first = defineJob({
  name: 'first',
  summary: 'The first app, opened',
  args: { verbose: { type: 'boolean', description: 'Say what it does on stderr.', default: false } },
  examples: [{ run: 'first --verbose', about: 'The first app, saying each step' }],
  run: async (ctx, { verbose }) => {
    const list = await ctx.call('list_apps', {})
    if (list.isError) ctx.fail(list)
    if (verbose) ctx.progress(`Opening ${list.json._embedded.apps[0].id}`)
    const one = await ctx.call('get_app', { id: list.json._embedded.apps[0].id })
    if (ctx.jsonMode) ctx.json(one.json)
    else ctx.print(one.text)
  },
})

const late = defineJob({
  name: 'late',
  summary: 'Fails the way jobs fail',
  args: { how: { type: 'string', description: 'timeout, plain or problem.', positional: true, required: true } },
  examples: [{ run: 'late timeout', about: 'Gives up waiting' }],
  run: async (ctx, { how }) => {
    if (how === 'timeout') throw Object.assign(new Error('Nothing came in 120 seconds.'), { exitCode: 6 })
    if (how === 'problem') ctx.fail(await ctx.call('get_app', { id: 'a9' }))
    throw new Error('Something broke.')
  },
})

/** Two apps behind the standard, with OAuth, tools that name their commands, a resource and a slow route. */
const sampleCli = async () => {
  const apps = new Map([
    ['a1', { id: 'a1', name: 'Alpha', tags: [] as string[], pinned: false }],
    ['a2', { id: 'a2', name: 'Bravo', tags: [] as string[], pinned: false }],
  ])
  const oauth = createOAuth({ name: 'Sample', signingKey: await generateOAuthKey(), store: memoryOAuthStore(), owner: async (c) => c.req.header('x-test-owner') ?? null, owners: [OWNER] })
  const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [{ name: 'Apps', description: 'The apps.' }], auth: { realm: 'sample', keys: parseApiKeys(`tester:${hash}`) }, oauth })
  const AppSchema = z.object({ id: z.string(), name: z.string(), tags: z.array(z.string()), pinned: z.boolean(), _links: LinksSchema }).openapi('App', { description: 'An app.' })
  const card = (c: Parameters<typeof originOf>[0], one: { id: string; name: string; tags: string[]; pinned: boolean }) => ({ ...one, _links: linksOf(originOf(c), { self: `/api/v1/apps/${one.id}` }) })
  const found = (id: string) => apps.get(id) ?? (() => { throw new ProblemError('not_found', { detail: 'No such app.' }) })()
  const id = z.string().openapi({ description: 'The app id.', example: 'a1' })
  app.openapi(createRoute({ method: 'get', path: '/api/v1/apps', operationId: 'listApps', summary: 'List apps', description: 'Every app, one page at a time.', tags: ['Apps'], request: { query: z.object({ limit: z.coerce.number().int().optional().openapi({ description: 'Per page.' }) }) }, responses: { 200: { description: 'A page.', content: { [HAL_JSON]: { schema: pageSchema('AppPage', 'apps', AppSchema, 'Apps.') } } }, ...problemResponses(400, 401) } }), (c) =>
    c.json(pageOf({ origin: originOf(c), path: '/api/v1/apps', query: {}, name: 'apps', items: [...apps.values()].slice(0, c.req.valid('query').limit ?? 10).map((one) => card(c, one)), next: null }), 200),
  )
  app.openapi(createRoute({ method: 'get', path: '/api/v1/apps/{id}', operationId: 'getApp', summary: 'One app', description: 'An app by its id.', tags: ['Apps'], request: { params: z.object({ id }) }, responses: { 200: { description: 'The app.', content: { [HAL_JSON]: { schema: AppSchema } } }, ...problemResponses(401, 404) } }), (c) => c.json(card(c, found(c.req.valid('param').id)), 200))
  app.openapi(createRoute({ method: 'delete', path: '/api/v1/apps/{id}', operationId: 'deleteApp', summary: 'Delete an app', description: 'Deletes an app for good.', tags: ['Apps'], request: { params: z.object({ id }) }, responses: { 204: { description: 'Gone.' }, ...problemResponses(401, 404) } }), (c) => {
    found(c.req.valid('param').id)
    apps.delete(c.req.valid('param').id)
    return c.body(null, 204)
  })
  const TagsSchema = z.object({ tags: z.array(z.string()), pinned: z.boolean().optional() }).openapi('Tags', { description: 'Tags.' })
  app.openapi(createRoute({ method: 'post', path: '/api/v1/apps/{id}/tags', operationId: 'tagApp', summary: 'Tag an app', description: 'Sets an app’s tags and pin.', tags: ['Apps'], request: { params: z.object({ id }), body: { required: true, content: { 'application/json': { schema: TagsSchema } } } }, responses: { 200: { description: 'The app.', content: { [HAL_JSON]: { schema: AppSchema } } }, ...problemResponses(400, 401, 404) } }), (c) => {
    const one = found(c.req.valid('param').id)
    const body = c.req.valid('json')
    Object.assign(one, { tags: body.tags, pinned: body.pinned ?? one.pinned })
    return c.json(card(c, one), 200)
  })
  app.get('/api/v1/me', (c) => c.json({ caller: (c.get('caller' as never) as { kind: string; name?: string; email?: string }).kind }))
  app.get('/api/v1/slow', async (c) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    return c.json({ done: true })
  })
  const tools = [
    mcpTool({ name: 'list_apps', title: 'List apps', description: 'Every app with its id.', input: z.object({ limit: z.number().int().min(1).optional().describe('At most this many.') }), cli: { name: 'app list', examples: [{ run: 'app list --limit 1', about: 'The first app' }, { run: 'app list --json id,name', about: 'Ids and names as JSON' }] }, call: (args) => ({ path: '/api/v1/apps', query: args }), summarize: (json) => json._embedded.apps.map((one: { id: string; name: string }) => `${one.name} (${one.id})`).join('\n') }),
    mcpTool({ name: 'get_app', title: 'Get an app', description: 'One app by id.', input: z.object({ id: z.string().describe('The app id.') }), cli: { name: 'app view', examples: [{ run: 'app view a1', about: 'Alpha' }] }, call: ({ id }) => ({ path: `/api/v1/apps/${id}` }), summarize: (json) => `${json.name} (${json.id})` }),
    mcpTool({ name: 'delete_app', title: 'Delete an app', description: 'Deletes an app for good.', input: z.object({ id: z.string().describe('The app id.') }), annotations: { readOnlyHint: false, destructiveHint: true }, cli: { name: 'app delete', examples: [{ run: 'app delete a2 --yes', about: 'Bravo, gone' }] }, call: ({ id }) => ({ method: 'DELETE', path: `/api/v1/apps/${id}` }), summarize: (_json, { id }) => `Deleted ${id}.` }),
    mcpTool({ name: 'tag_app', title: 'Tag an app', description: 'Sets an app’s tags.', input: z.object({ id: z.string().describe('The app id.'), tags: z.array(z.string()).describe('A tag; repeat for more.'), pinned: z.boolean().optional().describe('Pin it.') }), annotations: { readOnlyHint: false }, cli: { name: 'app tag', examples: [{ run: 'app tag a1 --tags new --tags fast --pinned', about: 'Two tags, pinned' }] }, call: ({ id, ...body }) => ({ method: 'POST', path: `/api/v1/apps/${id}/tags`, body }), summarize: (json) => `${json.name}: ${json.tags.join(', ')}${json.pinned ? ' (pinned)' : ''}` }),
    mcpTool({ name: 'who_am_i', title: 'Who am I', description: 'Who is calling.', input: z.object({}), cli: { name: 'auth status', examples: [{ run: 'auth status', about: 'The caller' }] }, call: () => ({ path: '/api/v1/me' }), summarize: (json) => `Calling as ${json.caller}.` }),
    mcpTool({ name: 'wait_for_app', title: 'Wait for an app', description: 'An app, once it is there.', input: z.object({ app: z.string().describe('The app id.'), timeout: z.number().optional().describe('Seconds to wait.') }), route: 'GET /api/v1/apps/{id}', cli: { name: 'app wait', examples: [{ run: 'app wait a1 --timeout 5', about: 'Alpha, once it is there' }] }, call: ({ app }) => ({ path: `/api/v1/apps/${app}` }), summarize: (json) => `${json.name} is there.` }),
    mcpTool({ name: 'slow_thing', title: 'Something slow', description: 'Takes a while.', input: z.object({ timeout: z.number().optional().describe('Seconds to wait.') }), cli: { name: 'thing wait', examples: [{ run: 'thing wait --timeout 5', about: 'Waits' }] }, call: () => ({ path: '/api/v1/slow' }), summarize: () => 'Done.' }),
  ]
  const resources = [mcpResource({ name: 'app_card', title: 'An app’s card', description: 'The app as JSON.', uriTemplate: 'sample://apps/{id}/card{?format}', cli: 'app card', read: ({ id }) => [{ path: `/api/v1/apps/${id}` }] })]
  mountMcp(app, { factory: mcpServerFactory({ info: { name: 'sample', version: '1.0.0' }, instructions: 'Find apps.', tools, resources, callApi: inProcess(app) }), allowedHostnames: ['localhost'] })
  const snapshot = cliSnapshot({ app: 'sample', version: '1.0.0', tools, resources, jobs: [first, late] })
  const configDir = await mkdtemp(join(tmpdir(), 'cli-'))

  /** The CLI in this process: its fetch is the app's own `request`, aborted like a real one. */
  const run = async (argv: string[], { env = { SAMPLE_URL: 'http://localhost', SAMPLE_API_KEY: key }, stdin = '', interactive = false, sleep, now, tty = false }: { env?: Record<string, string>; stdin?: string; interactive?: boolean; sleep?: (ms: number) => Promise<void>; now?: () => number; tty?: boolean } = {}) => {
    let out = ''
    let err = ''
    const cli = createCli({
      name: 'sample',
      envPrefix: 'SAMPLE',
      version: '1.0.0',
      snapshot,
      jobs: [first, late],
      fetch: (input, init) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
          Promise.resolve(app.request(String(input), init)).then(resolve, reject)
        }),
      io: { stdout: { write: (text: string) => (out += text), isTTY: tty }, stderr: { write: (text: string) => (err += text), isTTY: false }, stdin: Readable.from([stdin]) as never, env, configDir, interactive, sleep, now },
    })
    const code = await cli.run(argv)
    return { code, out, err }
  }
  return { app, apps, tools, resources, snapshot, run, configDir }
}

describe('the command line', () => {
  it('gives the same commands from the snapshot and from the live tools/list', async () => {
    const { run, snapshot } = await sampleCli()
    const live = JSON.parse((await run(['commands', '--json'])).out)
    const packaged = JSON.parse((await run(['commands', '--json'], { env: {} })).out)
    expect(live).toEqual(snapshot)
    expect(packaged).toEqual(snapshot)
    expect(snapshot.commands.map((command) => command.name)).toEqual(['first', 'late', 'app card', 'app delete', 'app list', 'app tag', 'app view', 'app wait', 'auth status', 'thing wait'])
    expect(snapshot.commands.find((command) => command.name === 'app tag')).toMatchObject({ tool: 'tag_app', positional: ['id'], readOnly: false, destructive: false, flags: [{ name: 'id', required: true }, { name: 'tags', type: 'string', multiple: true, required: true }, { name: 'pinned', type: 'boolean', required: false }] })
    expect(snapshot.commands.find((command) => command.name === 'app card')).toMatchObject({ resource: 'app_card', uriTemplate: 'sample://apps/{id}/card{?format}', positional: ['id'] })
  })

  it('lists jobs first, then nouns; a noun lists its verbs; help shows arguments and examples', async () => {
    const { run } = await sampleCli()
    const top = await run([])
    expect(top.code).toBe(0)
    expect(top.out.indexOf('Jobs')).toBeLessThan(top.out.indexOf('Commands'))
    expect(top.out).toContain('first')
    expect(top.out).toMatch(/app\s+card, delete, list, tag, view, wait/)
    expect(top.out).not.toContain('\x1b[')
    // Colour on a terminal, never with NO_COLOR
    expect((await run([], { tty: true })).out).toContain('\x1b[1m')
    expect((await run([], { tty: true, env: { NO_COLOR: '1' } })).out).not.toContain('\x1b[')
    expect((await run(['app'])).out).toMatch(/delete\s+Delete an app \(asks for --yes\)/)
    const help = (await run(['help', 'app', 'view'])).out
    expect(help).toContain('sample app view <id>')
    expect(help).toContain('<id>')
    expect(help).toContain('$ sample app view a1')
    expect((await run(['app', 'view', '--help'])).out).toBe(help)
    expect((await run(['help', 'agents'])).out).toContain('Exit codes: 0 done, 1 usage')
    expect((await run(['version'])).out).toBe('sample 1.0.0\n')
  })

  it('answers with the tool’s text, or its JSON with --json and chosen fields', async () => {
    const { run } = await sampleCli()
    expect(await run(['app', 'list'])).toEqual({ code: 0, out: 'Alpha (a1)\nBravo (a2)\n', err: '' })
    expect(JSON.parse((await run(['app', 'list', '--json', 'id,name'])).out)).toEqual([{ id: 'a1', name: 'Alpha' }, { id: 'a2', name: 'Bravo' }])
    expect(JSON.parse((await run(['app', 'view', 'a2', '--json'])).out)).toMatchObject({ id: 'a2', name: 'Bravo', _links: { self: { href: 'http://localhost/api/v1/apps/a2' } } })
    // --json before the bare argument the command still needs leaves it bare; --json= is always fields
    expect(JSON.parse((await run(['app', 'view', '--json', 'a2'])).out)).toMatchObject({ id: 'a2' })
    expect(JSON.parse((await run(['app', 'view', '--json=name', 'a2'])).out)).toEqual({ name: 'Bravo' })
    expect((await run(['app', 'view', '--id', 'a1'])).out).toBe('Alpha (a1)\n')
    // The MCP names work too, snake or kebab
    expect((await run(['get_app', 'a1'])).out).toBe('Alpha (a1)\n')
    expect((await run(['get-app', 'a1'])).out).toBe('Alpha (a1)\n')
    expect((await run(['tool', 'get_app', '{"id":"a2"}'])).out).toBe('Bravo (a2)\n')
    expect((await run(['app', 'list', '--limit', '1'])).out).toBe('Alpha (a1)\n')
  })

  it('reads flags by the schema: arrays repeat, booleans negate, --input merges under the flags', async () => {
    const { run, apps } = await sampleCli()
    expect((await run(['app', 'tag', 'a1', '--tags', 'new', '--tags', 'fast', '--pinned'])).out).toBe('Alpha: new, fast (pinned)\n')
    expect((await run(['app', 'tag', 'a1', '--tags', 'old', '--no-pinned'])).out).toBe('Alpha: old\n')
    expect((await run(['app', 'tag', 'a1', '--input', '-', '--pinned'], { stdin: '{"tags":["from-stdin"],"pinned":false}' })).out).toBe('Alpha: from-stdin (pinned)\n')
    expect(apps.get('a1')).toMatchObject({ tags: ['from-stdin'], pinned: true })
    expect(JSON.parse((await run(['app', 'tag', 'a2', '--tags', 'x', '--dry-run'])).out)).toEqual({ method: 'tools/call', name: 'tag_app', arguments: { id: 'a2', tags: ['x'] } })
  })

  it('stops a usage mistake with exit 1 and a line that names the argument', async () => {
    const { run } = await sampleCli()
    const missing = await run(['app', 'view'])
    expect(missing).toMatchObject({ code: 1, out: '' })
    expect(missing.err).toContain('"app view" needs <id>: The app id.')
    expect((await run(['app', 'tag', 'a1'])).err).toContain('needs --tags')
    expect((await run(['app', 'list', '--limit', 'many'])).err).toContain('--limit is a whole number, not "many"')
    expect((await run(['app', 'list', '--colour'])).err).toContain('unknown flag --colour for "app list"; it takes --limit')
    expect((await run(['app', 'view', 'a1', 'a2'])).code).toBe(1)
    expect((await run(['app', 'fly'])).err).toContain('"app" has no verb "fly"')
    expect((await run(['apps'])).err).toContain('did you mean app')
    expect((await run(['app', 'list', '--limit', '0'])).code).toBe(1)
  })

  it('maps problems to exit codes, one line on stderr, JSON on stderr with --json', async () => {
    const { run } = await sampleCli()
    expect(await run(['app', 'view', 'a9'])).toEqual({ code: 3, out: '', err: '404 not_found Not found: No such app.\n' })
    const json = await run(['app', 'view', 'a9', '--json'])
    expect(json.code).toBe(3)
    expect(json.out).toBe('')
    expect(JSON.parse(json.err)).toMatchObject({ status: 404, code: 'not_found', detail: 'No such app.', exitCode: 3 })
    expect((await run(['app', 'card', 'a9'])).code).toBe(3)
    expect((await run(['app', 'list'], { env: {} })).code).toBe(2)
    expect((await run(['app', 'list'], { env: { SAMPLE_URL: 'http://localhost', SAMPLE_API_KEY: 'test_wrong' } })).code).toBe(2)
    // A tool that waits gets the user's --timeout; anything else is stopped by it
    expect(JSON.parse((await run(['thing', 'wait', '--timeout', '30', '--dry-run'])).out)).toEqual({ method: 'tools/call', name: 'slow_thing', arguments: { timeout: 30 } })
    expect((await run(['thing', 'wait', '--timeout', '1'])).out).toBe('Done.\n')
    const slow = await run(['api', 'GET', '/api/v1/slow', '--timeout', '0.05'])
    expect(slow).toMatchObject({ code: 6, err: 'Timed out after 0.05 seconds\n' })
  })

  it('asks before a destructive tool: --yes without a terminal, y/N in one, and --dry-run prints the call', async () => {
    const { run, apps } = await sampleCli()
    const refused = await run(['app', 'delete', 'a2'])
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('add --yes')
    expect(apps.has('a2')).toBe(true)
    expect(JSON.parse((await run(['app', 'delete', 'a2', '--dry-run'])).out)).toEqual({ method: 'tools/call', name: 'delete_app', arguments: { id: 'a2' } })
    expect((await run(['app', 'delete', 'a2'], { interactive: true, stdin: 'n\n' })).code).toBe(1)
    expect(apps.has('a2')).toBe(true)
    expect((await run(['app', 'delete', 'a2'], { interactive: true, stdin: 'y\n' })).out).toBe('Deleted a2.\n')
    expect(apps.has('a2')).toBe(false)
    expect((await run(['app', 'delete', 'a1', '--yes'])).code).toBe(0)
  })

  it('maps what a job throws: its exitCode, else its problem’s status, else 1', async () => {
    const { run } = await sampleCli()
    expect(await run(['late', 'timeout'])).toEqual({ code: 6, out: '', err: 'Nothing came in 120 seconds.\n' })
    expect(await run(['late', 'problem'])).toEqual({ code: 3, out: '', err: '404 not_found Not found: No such app.\n' })
    expect(await run(['late', 'plain'])).toEqual({ code: 1, out: '', err: 'Something broke.\n' })
    expect(JSON.parse((await run(['late', 'timeout', '--json'])).err)).toMatchObject({ title: 'Nothing came in 120 seconds.', detail: 'Nothing came in 120 seconds.', exitCode: 6 })
  })

  it('takes positional arguments from where the call puts them, not from the route’s names', () => {
    const tool = (cli?: { name: string; positional?: string[] }) => mcpTool({ ...base, name: 'wait_for_message', input: z.object({ address: z.string(), index: z.number().optional(), timeout: z.number().optional() }), route: 'GET /api/addresses/{id}/messages/next', ...(cli ? { cli } : {}), call: ({ address, index }) => ({ path: `/api/addresses/${address}/messages/next`, query: { index } }) })
    expect(cliOf(tool()).positional).toEqual(['address'])
    expect(cliOf(tool({ name: 'mail attachment', positional: ['address', 'index'] })).positional).toEqual(['address', 'index'])
    expect(pathKeysOf(mcpTool({ ...base, name: 'two', input: z.object({ ref: z.string(), id: z.string() }), call: ({ id, ref }) => ({ path: `/api/boards/${id}/items/${encodeURIComponent(ref)}` }) }))).toEqual(['id', 'ref'])
  })

  it('reads resources, fills the template’s query from flags, and runs jobs', async () => {
    const { run } = await sampleCli()
    expect(JSON.parse((await run(['app', 'card', 'a1'])).out)).toMatchObject({ id: 'a1' })
    expect(JSON.parse((await run(['app', 'card', 'a1', '--format', 'short', '--dry-run'])).out)).toEqual({ method: 'resources/read', uri: 'sample://apps/a1/card?format=short' })
    expect(JSON.parse((await run(['app', 'card', 'a1', '--format', 'short'])).out)).toMatchObject({ id: 'a1' })
    const job = await run(['first', '--verbose'])
    expect(job).toEqual({ code: 0, out: 'Alpha (a1)\n', err: 'Opening a1\n' })
    expect(JSON.parse((await run(['first', '--json', 'name'])).out)).toEqual({ name: 'Alpha' })
    expect((await run(['first', '--dry-run'])).code).toBe(1)
  })

  it('makes raw API calls, lists tools by MCP name, completes shells and checks itself', async () => {
    const { run } = await sampleCli()
    expect(JSON.parse((await run(['api', 'GET', '/api/v1/apps/a1'])).out)).toMatchObject({ name: 'Alpha' })
    expect((await run(['api', 'GET', '/api/v1/apps/a9'])).code).toBe(3)
    expect((await run(['tool'])).out).toContain('get_app')
    const bash = (await run(['completion', 'bash'])).out
    expect(bash).toContain('complete -F _sample sample')
    expect(bash).toContain('app) COMPREPLY=($(compgen -W "card delete list tag view wait"')
    expect((await run(['completion', 'fish'])).out).toContain("__fish_seen_subcommand_from app")
    expect((await run(['completion', 'tcsh'])).code).toBe(1)
    const doctor = await run(['doctor'])
    expect(doctor.code).toBe(0)
    expect(doctor.out).toMatch(/^ok {4}reachable/m)
    expect(doctor.out).toMatch(/^ok {4}drift +the packaged commands match the server/m)
    expect((await run(['doctor'], { env: {} })).code).toBe(2)
  })

  it('signs in with a device code, keeps the profile at 0600, renews the token and signs out', async () => {
    const { app, run, configDir } = await sampleCli()
    const err = { text: '' }
    const sleep = async () => {
      const code = err.text.match(/check that it shows ([A-Z]{4}-[A-Z]{4})/)?.[1]
      if (code) await app.request('/oauth/device', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-test-owner': OWNER, 'sec-fetch-site': 'same-origin' }, body: new URLSearchParams({ user_code: code.replace('-', ''), decision: 'allow' }).toString() })
    }
    // The code shows on stderr as soon as it is asked for; the test approves it as the owner, then the CLI polls
    let out = ''
    const login = createCliFor(app, configDir, (text) => (err.text += text), (text) => (out += text), sleep)
    expect(await login.run(['auth', 'login', 'localhost'])).toBe(0)
    expect(out).toBe('Signed in to http://localhost as profile localhost\n')
    const file = join(configDir, 'profiles.json')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const saved = JSON.parse(await readFile(file, 'utf8'))
    expect(saved).toMatchObject({ current: 'localhost', profiles: { localhost: { url: 'http://localhost', clientId: expect.any(String), refreshToken: expect.stringMatching(/^rt_/) } } })
    // `auth status` is the app's who_am_i tool, filling a free verb of the built-in auth
    const status = await run(['auth', 'status'], { env: {} })
    expect(status).toEqual({ code: 0, out: 'Calling as agent.\n', err: 'Using http://localhost from profile localhost\n' })
    expect((await run(['auth', 'switch'], { env: {} })).out).toBe('* localhost  http://localhost  OAuth\n')
    expect((await run(['app', 'view', 'a1'], { env: {} })).out).toBe('Alpha (a1)\n')
    // Two hours on, the token has expired for the CLI: it renews it with the refresh token and goes on
    const later = await run(['app', 'view', 'a2'], { env: {}, now: () => Date.now() + 2 * 3_600_000 })
    expect(later.out).toBe('Bravo (a2)\n')
    const renewed = JSON.parse(await readFile(file, 'utf8')).profiles.localhost
    expect(renewed.refreshToken).not.toBe(saved.profiles.localhost.refreshToken)
    expect((await run(['auth', 'token'], { env: {} })).out.trim()).toBe(renewed.accessToken)
    expect((await run(['auth', 'switch', 'elsewhere'], { env: {} })).code).toBe(1)
    expect((await run(['auth', 'logout'], { env: {} })).out).toBe('Signed out of http://localhost (profile localhost)\n')
    expect((await run(['app', 'list'], { env: {} })).code).toBe(2)
  })

  it('keeps profiles in the user’s config folder', () => {
    expect(configDirOf('sample', { XDG_CONFIG_HOME: '/xdg' }, 'linux')).toBe('/xdg/sample')
    expect(configDirOf('sample', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toBe(join('C:\\Users\\a\\AppData\\Roaming', 'sample'))
    expect(configDirOf('sample', {}, 'darwin')).toBe(join(homedir(), '.config', 'sample'))
  })

  it('signs in with a key read from stdin, and refuses one the server refuses', async () => {
    const { run } = await sampleCli()
    expect((await run(['auth', 'login', 'http://localhost', '--with-token', '--profile', 'ci'], { env: {}, stdin: `${key}\n` })).code).toBe(0)
    expect((await run(['app', 'view', 'a1'], { env: {} })).out).toBe('Alpha (a1)\n')
    expect((await run(['auth', 'login', 'http://localhost', '--with-token', '--profile', 'bad'], { env: {}, stdin: 'test_nope\n' })).code).toBe(2)
    expect((await run(['app', 'view', 'a1'], { env: { SAMPLE_PROFILE: 'bad' } })).code).toBe(2)
  })
})

/** A CLI with its own stderr, for watching what it shows while it runs. */
const createCliFor = (app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, configDir: string, onErr: (text: string) => void, onOut: (text: string) => void, sleep: () => Promise<void>) =>
  createCli({ name: 'sample', envPrefix: 'SAMPLE', version: '1.0.0', snapshot: { commands: [] }, fetch: async (input, init) => app.request(String(input), init), io: { stdout: { write: onOut }, stderr: { write: onErr }, stdin: Readable.from(['']) as never, env: {}, configDir, sleep } })

describe('naming commands', () => {
  it('falls back to the route rule for a tool that names none', () => {
    expect(fallbackCliName('GET /api/addresses/{id}', 'get_address')).toBe('address view')
    expect(fallbackCliName('GET /api/v1/addresses', 'list_addresses')).toBe('address list')
    expect(fallbackCliName('POST /api/messages/{id}/reply', 'reply')).toBe('message reply')
    expect(fallbackCliName('PUT /api/boards/{id}/items/{ref}', 'save_to_board')).toBe('item edit')
    expect(fallbackCliName(undefined, 'search_recipes')).toBe('recipe search')
  })

  it('hints a tool that writes as not read-only, and one that deletes as destructive', () => {
    const tool = (method: 'GET' | 'POST', annotations?: { destructiveHint?: boolean }) => mcpTool({ ...base, name: 'x', input: z.object({}), annotations, call: () => ({ method, path: '/x' }) })
    expect(hintsOf(tool('GET'))).toMatchObject({ readOnlyHint: true, destructiveHint: false })
    expect(hintsOf(tool('POST'))).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(hintsOf(tool('GET', { destructiveHint: true }))).toMatchObject({ readOnlyHint: false, destructiveHint: true })
    // A call whose path can't be read keeps the old default
    expect(hintsOf(mcpTool({ ...base, name: 'odd', input: z.object({ n: z.number() }), call: ({ n }) => ({ method: 'POST', path: `/x/${n.toFixed(0)}` }) }))).toMatchObject({ readOnlyHint: true })
  })

  it('lists the commands for the guide as {{cli.commands}}', async () => {
    const { app, tools, resources } = await sampleCli()
    const lines = cliMarkdown({ tools, resources, jobs: [first] }).split('\n')
    expect(lines[0]).toBe('- `first` — The first app, opened (job)')
    expect(lines).toContain('- `app view <id>` — Get an app (`get_app`)')
    expect(lines).toContain('- `app wait <app>` — Wait for an app (`wait_for_app`)')
    // From the snapshot, the same lines
    expect(cliMarkdown({ commands: cliSnapshot({ tools, resources, jobs: [first] }).commands })).toBe(lines.join('\n'))
    expect(lines).toContain('- `app card <id>` — An app’s card (`sample://apps/{id}/card{?format}`)')
    const doc = await (await app.request('/openapi.json', { headers: { authorization: `Bearer ${key}` } })).json()
    expect(guideGaps(new Map([['llms.txt', 'Commands:\n\n{{cli.commands}}\n']]), {}, { doc, tools, resources })).toEqual([])
  })

  it('finds what keeps commands from being usable', async () => {
    const { tools, resources } = await sampleCli()
    expect(cliGaps({ tools, resources, jobs: [first, late] })).toEqual([])
    const bad = [
      mcpTool({ ...base, name: 'list_things', input: z.object({ q: z.string() }), call: () => ({ path: '/api/things' }) }),
      mcpTool({ ...base, name: 'get_thing', input: z.object({ id: z.string().describe('Id.') }), cli: 'things view', call: ({ id }) => ({ path: `/api/things/${id}` }) }),
      mcpTool({ ...base, name: 'other', input: z.object({ id: z.string().describe('Id.') }), cli: { name: 'thing list', examples: [{ run: 'thing list --nope', about: 'Wrong' }, { run: 'thing ls', about: 'Typo' }] }, call: () => ({ path: '/x' }) }),
      mcpTool({ ...base, name: 'login', input: z.object({}), cli: { name: 'auth login', examples: [{ run: 'auth login', about: 'x' }] }, call: () => ({ path: '/y' }) }),
      mcpTool({ ...base, name: 'first_thing', input: z.object({}), cli: { name: 'first thing', examples: [{ run: 'first thing', about: 'x' }] }, call: () => ({ path: '/z' }) }),
      mcpTool({ ...base, name: 'Odd', input: z.object({}), cli: { name: 'Odd', examples: [] }, call: () => ({ path: '/o' }) }),
      mcpTool({ ...base, name: 'clash', input: z.object({ json: z.boolean().describe('Raw.') }), cli: { name: 'clash view', examples: [{ run: 'clash view', about: 'x' }] }, call: () => ({ path: '/c' }) }),
    ]
    expect(cliGaps({ tools: bad, resources: [mcpResource({ name: 'r', title: 'R', description: 'R', uriTemplate: 's://things/{id}', read: () => [] })], jobs: [first, late] })).toEqual([
      'tool list_things: no cli name (the route rule would call it "thing list"); add cli: \'<noun> <verb>\'',
      'tool list_things: the argument q has no description',
      'tool list_things: no example; add cli: { name, examples: [{ run, about }] }',
      'tool get_thing: the noun "things" looks plural; nouns are singular (or pass it in singular)',
      'tool get_thing: no example; add cli: { name, examples: [{ run, about }] }',
      'tool other: "thing list" is also the name of tool list_things',
      'tool other: the example "thing list --nope" uses --nope, which it doesn\'t take',
      'tool other: the example "thing ls" doesn\'t start with "thing list"',
      'tool login: "auth login" is a built-in command',
      'tool first_thing: the noun "first" is the job first',
      'tool Odd: "Odd" is not "<noun> <verb>" in lowercase kebab-case',
      'tool clash: the argument json is --json, a flag every command already has; rename it',
      'resource r: no cli name (the route rule would call it "thing r"); add cli: \'<noun> <verb>\'',
    ])
    // The kit's own parts name their tools, so an app that adds them stays clean
    const parts = [...keyTools(), ...teamTools(), ...telemetryTools(), ...boardTools({ noun: 'recipes', label: () => '', suggestions: true }), ...vectorSearchTools({ path: '/api/search', similarPath: '/api/recipes/{slug}/similar', noun: 'recipes', label: () => '' })]
    expect(cliGaps({ tools: parts })).toEqual([])
    expect(cliSnapshot({ tools: parts }).commands.map((command) => command.name)).toContain('recipe search-by-image')
    expect(cliGaps({ tools: [mcpTool({ ...base, name: 'status', input: z.object({}), cli: { name: 'news view', examples: [{ run: 'news view', about: 'x' }] }, call: () => ({ path: '/n' }) })] })).toEqual([])
    expect(cliGaps({ tools: [mcpTool({ ...base, name: 'x', input: z.object({}), cli: { name: 'widgets view', examples: [{ run: 'widgets view', about: 'x' }] }, call: () => ({ path: '/n' }) })] }, { singular: ['widgets'] })).toEqual([])
  })
})
