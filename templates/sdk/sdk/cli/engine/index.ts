/**
 * The app's command line, derived from its MCP tools: noun-then-verb commands with help and examples, `--json`,
 * stable exit codes, sign-in with profiles, and the app's own jobs. Every command is a `tools/call` or a
 * `resources/read` against the deployment's `/mcp`. Copied into the app by `kit sdk` / `kit cli`: this folder is the
 * kit's (take a newer one with `kit cli --update`); `bin.ts`, `jobs/` and `commands.json` are the app's.
 *
 * @example
 * import snapshot from '../commands.json' with { type: 'json' }
 * const cli = createCli({ name: 'mailroom', envPrefix: 'MAILROOM', version: '0.3.0', snapshot, jobs })
 * process.exitCode = await cli.run(process.argv.slice(2))
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { completeArguments, GLOBAL_FLAGS, parseArguments, splitLeadingFlags, type Globals } from './args.js'
import { configDirOf, deviceLogin, profileNameOf, profileStore, refreshProfile, revokeProfile, type Profile } from './auth.js'
import { commandsFromListing, expandTemplate, jobCommand, kebab, selectFields, type Command, type ListedTool, type Snapshot } from './commands.js'
import { agentsHelp, commandHelp, completion, nounHelp, nounsOf, overview, paintFor } from './help.js'
import type { CallResult, Job, JobContext, Problem, ReadResult } from './job.js'
import { CliError, EXIT, exitFor, mcpClient, PENDING_META, problemLine, problemOfResult, type ToolResult } from './mcp.js'

export { defineJob, type Job, type JobContext } from './job.js'
export { CliError, EXIT } from './mcp.js'

type Out = { write: (text: string) => unknown; isTTY?: boolean }
type In = NodeJS.ReadableStream & { isTTY?: boolean }

export type CliOptions = {
  /** The command's name, as people type it: `mailroom`. */
  name: string
  /** Of the environment overrides: `MAILROOM` reads `MAILROOM_URL`, `MAILROOM_API_KEY`, `MAILROOM_PROFILE`. */
  envPrefix: string
  version: string
  /** `commands.json`: the commands before sign-in. */
  snapshot: { app?: string; version?: string; commands: unknown[] }
  jobs?: Job[]
  fetch?: typeof fetch
  /** For tests: the streams, environment, config folder and clock the CLI uses instead of the process's. */
  io?: { stdout?: Out; stderr?: Out; stdin?: In; env?: Record<string, string | undefined>; configDir?: string; interactive?: boolean; sleep?: (ms: number) => Promise<void>; now?: () => number }
}

const usage = (message: string) => new CliError(message, EXIT.usage)
const builtIn = (name: string, positional: string[], flags: Command['flags'] = []): Command => ({ name, summary: '', description: '', positional, flags: [...positional.map((key) => ({ name: key, key, type: 'string' as const, description: '', required: false, multiple: false })), ...flags], examples: [], readOnly: true, destructive: false })
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const createCli = (options: CliOptions) => {
  const { name: app, envPrefix: prefix, version, jobs = [] } = options
  const send = options.fetch ?? globalThis.fetch.bind(globalThis)
  const io = options.io ?? {}
  const stdout: Out = io.stdout ?? process.stdout
  const stderr: Out = io.stderr ?? process.stderr
  const stdin: In = io.stdin ?? process.stdin
  const env = io.env ?? process.env
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = io.now ?? Date.now
  const interactive = io.interactive ?? Boolean(stdin.isTTY && stderr.isTTY)
  const colour = !env.NO_COLOR && env.TERM !== 'dumb'
  const paint = paintFor(colour && Boolean(stdout.isTTY))
  const errPaint = paintFor(colour && Boolean(stderr.isTTY))
  const configDir = io.configDir ?? configDirOf(app, env)
  const store = profileStore(configDir)
  const snapshot = options.snapshot as Snapshot
  const jobCommands = jobs.map(jobCommand)
  const signInHint = `run \`${app} auth login <url>\`, or set ${prefix}_URL and ${prefix}_API_KEY`

  const print = (text: string) => stdout.write(text.endsWith('\n') ? text : `${text}\n`)
  const tell = (text: string) => stderr.write(text.endsWith('\n') ? text : `${text}\n`)
  const printJson = (value: unknown) => print(JSON.stringify(value, null, 2))

  // ---- Where to, and as whom ----

  type Target = { url?: string; profileName?: string; profile?: Profile; apiKey?: string; from: string }
  const targetOf = (profileFlag?: string): Target => {
    const profiles = store.read()
    const chosen = profileFlag ?? env[`${prefix}_PROFILE`]
    if (chosen && !profiles.profiles[chosen]) throw new CliError(`No profile "${chosen}"; \`${app} auth status\` lists them`, EXIT.signIn)
    const profileName = chosen ?? profiles.current
    const profile = profileName ? profiles.profiles[profileName] : undefined
    const url = (env[`${prefix}_URL`] ?? profile?.url)?.replace(/\/+$/, '')
    const apiKey = env[`${prefix}_API_KEY`] ?? (env[`${prefix}_URL`] ? undefined : profile?.apiKey)
    const from = env[`${prefix}_URL`] ? `${prefix}_URL${env[`${prefix}_API_KEY`] ? ` and ${prefix}_API_KEY` : ''}` : profileName ? `profile ${profileName}` : 'nothing'
    return { url, profileName: env[`${prefix}_URL`] ? undefined : profileName, profile: env[`${prefix}_URL`] ? undefined : profile, apiKey, from }
  }
  const signedIn = (target: Target) => Boolean(target.url && (target.apiKey || target.profile?.accessToken))

  const bearerOf = async (target: Target) => {
    if (target.apiKey) return target.apiKey
    if (!target.profile?.accessToken || !target.profileName) return undefined
    if (target.profile.expiresAt && target.profile.expiresAt - 60_000 <= now()) target.profile = await refreshProfile({ store, name: target.profileName, send, sleep, now })
    return target.profile.accessToken
  }

  const clientFor = (target: Target) => {
    if (!target.url) throw new CliError(`Not signed in: ${signInHint}`, EXIT.signIn)
    return mcpClient({
      url: target.url,
      fetch: send,
      signIn: signInHint,
      bearer: () => bearerOf(target),
      refresh: async () => {
        if (target.apiKey || !target.profileName || !target.profile?.refreshToken) return false
        target.profile = await refreshProfile({ store, name: target.profileName, send, sleep, now, stale: target.profile.accessToken })
        return true
      },
    })
  }

  // ---- The commands: live from the deployment (cached per profile until its ttl), else the snapshot ----

  const cacheFile = (target: Target) => join(configDir, 'cache', `${(target.profileName ?? `env-${target.url}`).replace(/[^\w.-]+/g, '_')}.json`)
  type Live = { url: string; until: number; tools: ListedTool[]; templates: any[] }
  const liveOf = async (target: Target, signal?: AbortSignal): Promise<Live | null> => {
    if (!signedIn(target)) return null
    const file = cacheFile(target)
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as Live
      if (cached.url === target.url && cached.until > now()) return cached
    } catch {
      // No cache yet
    }
    const client = clientFor(target)
    const tools = await client.listTools(signal)
    const templates = await client.listTemplates(signal).catch(() => ({ resourceTemplates: [], ttlMs: undefined }))
    const live: Live = { url: target.url!, until: now() + Math.min(tools.ttlMs ?? 3_600_000, templates.ttlMs ?? 3_600_000), tools: tools.tools, templates: templates.resourceTemplates }
    try {
      mkdirSync(join(configDir, 'cache'), { recursive: true, mode: 0o700 })
      writeFileSync(file, JSON.stringify(live), { mode: 0o600 })
    } catch {
      // A cache that can't be written only costs a request next time
    }
    return live
  }
  const snapshotCommands = () => snapshot.commands.filter((command) => !command.job)
  const commandsOf = async (target: Target, signal?: AbortSignal) => {
    const live = await liveOf(target, signal).catch(() => null)
    return { commands: [...jobCommands, ...(live ? commandsFromListing(live.tools, live.templates) : snapshotCommands())], live }
  }

  /** The command some words name: a job, `<noun> <verb>`, or a tool's MCP name (snake or kebab case). */
  const resolve = (words: string[], commands: Command[]) => {
    const [first = '', second] = words
    const job = commands.find((command) => command.job === first)
    if (job) return { command: job, used: 1 }
    const nouns = nounsOf(commands)
    const verbs = nouns.get(first)
    if (verbs) {
      const command = second ? verbs.find((one) => one.name === `${first} ${second}`) : undefined
      if (command) return { command, used: 2 }
      if (second && !second.startsWith('-')) throw usage(`"${first}" has no verb "${second}"; it has ${verbs.map((one) => one.name.split(' ')[1]).join(', ')}`)
      return { noun: first, verbs }
    }
    const alias = commands.find((command) => command.tool && (command.tool === first || kebab(command.tool) === first))
    if (alias) return { command: alias, used: 1 }
    const near = [...nouns.keys(), ...jobCommands.map((command) => command.name)].filter((name) => name.startsWith(first.slice(0, 3)))
    throw usage(`unknown command "${first}"${near.length ? `; did you mean ${near.join(', ')}?` : ''}. Run \`${app}\` for the list`)
  }

  // ---- Input, prompts, waiting ----

  const readStdin = async () => {
    let text = ''
    for await (const chunk of stdin) text += String(chunk)
    return text
  }
  const readInput = async (from: string) => {
    const text = from === '-' ? await readStdin() : readFileSync(from, 'utf8')
    const value = (() => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw usage(`--input ${from} is not JSON`)
      }
    })()
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw usage(`--input ${from} must be one JSON object of arguments`)
    return value as Record<string, unknown>
  }
  const ask = async (question: string) => {
    const reader = createInterface({ input: stdin, output: stderr as NodeJS.WritableStream, terminal: false })
    try {
      return await new Promise<string>((done) => reader.question(question, done))
    } finally {
      reader.close()
    }
  }
  const confirm = async (what: string, globals: Globals) => {
    if (globals.yes) return
    if (!interactive) throw usage(`${what} changes or deletes things for good: add --yes to go ahead`)
    if (!/^y(es)?$/i.test((await ask(`${what}: go ahead? [y/N] `)).trim())) throw new CliError('Not done.', EXIT.usage)
  }
  const waiting = async <T>(label: string, work: Promise<T>) => {
    if (!stderr.isTTY) return work
    let frame = 0
    const timer = setInterval(() => stderr.write(`\r${SPIN[frame++ % SPIN.length]} ${label}`), 120)
    try {
      return await work
    } finally {
      clearInterval(timer)
      if (frame) stderr.write('\r\x1b[K')
    }
  }

  // ---- Answers ----

  const textOf = (result: ToolResult) => (result.content ?? []).map((part) => (part.type === 'text' ? (part.text ?? '') : part.type === 'resource_link' ? `${part.title ?? part.name ?? 'link'}: ${part.uri}` : `(${part.type})`)).join('\n')
  const callResultOf = (result: ToolResult): CallResult => ({ text: textOf(result), json: result.structuredContent ?? null, isError: Boolean(result.isError), problem: result.isError ? problemOfResult(result) : null })
  const readResultOf = (contents: ReadResult['contents']): ReadResult => {
    const text = contents.flatMap((part) => (part.text === undefined ? [] : [part.text])).join('\n')
    const json = (() => {
      try {
        return contents[0]?.text !== undefined && /json/.test(contents[0].mimeType ?? '') ? JSON.parse(contents[0].text) : null
      } catch {
        return null
      }
    })()
    return { text, json, contents }
  }
  const failWith = (problem: Problem): never => {
    throw new CliError(problemLine(problem), exitFor(problem.status), problem)
  }

  const deadline = (globals: Globals, command: Command | undefined, outer: AbortSignal) => {
    const controller = new AbortController()
    const stop = () => controller.abort(outer.reason)
    outer.addEventListener('abort', stop)
    // A tool that waits itself gets the time it asked for, and a little to answer in
    const seconds = globals.timeout === undefined ? undefined : globals.timeout + (command?.flags.some((flag) => flag.key === 'timeout') ? 15 : 0)
    const timer = seconds === undefined ? undefined : setTimeout(() => controller.abort(new CliError(`Timed out after ${seconds} seconds`, EXIT.timeout)), seconds * 1000)
    return { signal: controller.signal, done: () => (clearTimeout(timer), outer.removeEventListener('abort', stop)) }
  }

  const answerTool = (result: ToolResult, globals: Globals) => {
    if (result.isError) failWith(problemOfResult(result))
    const pending = result._meta?.[PENDING_META] as { run?: string } | undefined
    if (globals.json) printJson(selectFields(result.structuredContent ?? { text: textOf(result), ...(pending ? { pending } : {}) }, globals.json === true ? undefined : globals.json))
    else if (textOf(result)) print(textOf(result))
    if (pending) throw new CliError(`Still working (run ${pending.run}): run the same command again to get the answer`, EXIT.timeout)
    return EXIT.ok
  }

  // ---- Running a command ----

  const execute = async (command: Command, tokens: string[], outer: AbortSignal) => {
    const isResource = Boolean(command.resource)
    const parsing = isResource ? { ...command, flags: [...command.flags, { name: 'out', key: 'out', type: 'string' as const, description: 'Write the file here', required: false, multiple: false }] } : command
    const { values, globals } = parseArguments(parsing, tokens)
    if (globals.help) return print(commandHelp(app, command, paint)), EXIT.ok
    const input = globals.input ? await readInput(globals.input) : {}
    const args = completeArguments(command, values, input)
    for (const flag of command.flags) if (args[flag.key] === undefined && flag.default !== undefined && command.job) args[flag.key] = flag.default
    const target = targetOf(globals.profile)
    if (command.job) return runJob(command, args, globals, target, outer)
    const { out, ...given } = args as Record<string, unknown> & { out?: string }
    const uri = isResource ? expandTemplate(command.uriTemplate!, given) : undefined
    if (globals.dryRun) return printJson(isResource ? { method: 'resources/read', uri } : { method: 'tools/call', name: command.tool, arguments: given }), EXIT.ok
    if (command.destructive) await confirm(`${app} ${command.name} ${command.positional.map((key) => String(given[key] ?? '')).join(' ')}`.trim(), globals)
    const { signal, done } = deadline(globals, command, outer)
    try {
      const client = clientFor(target)
      if (!isResource) return answerTool(await waiting(command.summary, client.callTool(command.tool!, given, signal)), globals)
      const read = readResultOf((await waiting(command.summary, client.readResource(uri!, signal))).contents)
      const blobs = read.contents.filter((part) => part.blob !== undefined)
      if (out && blobs.length) {
        writeFileSync(out, Buffer.from(blobs[0]!.blob!, 'base64'))
        tell(`Wrote ${out} (${blobs[0]!.mimeType ?? 'a file'})`)
      } else if (blobs.length) tell(`${blobs.length} file part${blobs.length > 1 ? 's' : ''} (${blobs.map((part) => part.mimeType).join(', ')}) left out: add --out <file> to save it`)
      if (globals.json) printJson(selectFields(read.json ?? read.contents, globals.json === true ? undefined : globals.json))
      else if (read.text) print(read.text)
      return EXIT.ok
    } finally {
      done()
    }
  }

  const runJob = async (command: Command, args: Record<string, unknown>, globals: Globals, target: Target, outer: AbortSignal) => {
    const job = jobs.find((one) => one.name === command.job)!
    if (globals.dryRun) throw usage(`a job's calls depend on each other's answers, so it has no --dry-run; \`${app} help ${job.name}\` says what it calls`)
    if (job.destructive) await confirm(`${app} ${job.name}`, globals)
    const { signal, done } = deadline(globals, command, outer)
    let client: ReturnType<typeof clientFor> | undefined
    const connected = () => (client ??= clientFor(target))
    const ctx: JobContext = {
      call: async (tool, callArgs = {}) => callResultOf(await connected().callTool(tool, callArgs, signal)),
      read: async (uri) => readResultOf((await connected().readResource(uri, signal)).contents),
      print: (text) => void print(text),
      json: (value) => void printJson(selectFields(value, Array.isArray(globals.json) ? globals.json : undefined)),
      progress: (text) => void tell(text),
      fail: (reason) => {
        if (typeof reason === 'string') return failWith({ title: reason, status: 422 })
        if (typeof reason.isError === 'boolean' && 'text' in reason) {
          const call = reason as CallResult
          return failWith(call.problem ?? { title: call.text, status: 500 })
        }
        return failWith(reason as Problem)
      },
      signal,
      interactive,
      jsonMode: Boolean(globals.json),
    }
    try {
      await waiting(job.summary, job.run(ctx, args as never))
      return EXIT.ok
    } finally {
      done()
    }
  }

  // ---- Built-ins ----

  const helpFor = async (words: string[], globals: Globals) => {
    if (words[0] === 'agents') return print(agentsHelp(app, prefix)), EXIT.ok
    const { commands } = await commandsOf(targetOf(globals.profile))
    if (!words.length) return print(overview(app, version, commands, paint)), EXIT.ok
    if (words[0] === 'auth') return print(AUTH_HELP(app)), EXIT.ok
    const found = resolve(words, commands)
    if ('noun' in found) return print(nounHelp(app, found.noun!, found.verbs!, paint)), EXIT.ok
    return print(commandHelp(app, found.command, paint)), EXIT.ok
  }

  const AUTH_HELP = (name: string) =>
    [
      `${paint.bold(`${name} auth`)}: sign in to a deployment`,
      '',
      `  login <url>            a code to approve in a browser (any device); --with-token reads an API key from stdin`,
      `  status                 the profiles, and who you are on the current one`,
      `  token                  the current bearer token, on stdout`,
      `  switch <profile>       use another signed-in deployment`,
      `  logout [profile]       sign out and forget the profile`,
      '',
      `Profiles live in ${store.file} (mode 0600). ${prefix}_URL and ${prefix}_API_KEY (or ${prefix}_PROFILE) override them.`,
    ].join('\n')

  const auth = async (tokens: string[], outer: AbortSignal) => {
    const at = tokens.findIndex((token) => !token.startsWith('-'))
    const verb = at < 0 ? undefined : tokens[at]
    const rest = tokens.filter((_, index) => index !== at)
    const spec = builtIn(`auth ${verb ?? ''}`.trim(), verb === 'login' ? ['url'] : verb === 'switch' || verb === 'logout' ? ['profile'] : [], verb === 'login' ? [{ name: 'with-token', key: 'withToken', type: 'boolean', description: '', required: false, multiple: false }] : [])
    const { values, globals } = parseArguments(spec, rest)
    if (globals.help || !verb) return print(AUTH_HELP(app)), EXIT.ok
    const profiles = store.read()
    switch (verb) {
      case 'login': {
        const given = String(values.url ?? '')
        if (!given) throw usage(`\`${app} auth login <url>\`: the deployment's address`)
        const url = (/^https?:\/\//.test(given) ? given : `${/^(localhost|127\.0\.0\.1)(:|$)/.test(given) ? 'http' : 'https'}://${given}`).replace(/\/+$/, '')
        const name = globals.profile ?? profileNameOf(url)
        let profile: Profile
        if (values.withToken) {
          const apiKey = (await readStdin()).trim()
          if (!apiKey) throw usage('--with-token reads the API key from stdin, and it was empty')
          profile = { url, apiKey }
          await clientFor({ url, apiKey, from: 'stdin' }).listTools(outer)
        } else profile = await deviceLogin({ url, app, send, tell, sleep, signal: outer, now })
        store.write({ current: name, profiles: { ...profiles.profiles, [name]: profile } })
        print(`Signed in to ${url} as profile ${name}`)
        return EXIT.ok
      }
      case 'status': {
        const target = targetOf(globals.profile)
        const rows = Object.entries(profiles.profiles).map(([name, profile]) => ({ name, url: profile.url, current: name === profiles.current, kind: profile.apiKey ? 'API key' : 'OAuth', expiresAt: profile.expiresAt ? new Date(profile.expiresAt).toISOString() : null }))
        if (!signedIn(target)) {
          if (globals.json) printJson({ signedIn: false, from: target.from, profiles: rows })
          else rows.forEach((row) => print(`${row.current ? '*' : ' '} ${row.name}  ${row.url}  ${row.kind}`))
          throw new CliError(`Not signed in: ${signInHint}`, EXIT.signIn)
        }
        const live = await liveOf(target, outer)
        const whoAmI = live?.tools.find((tool) => tool.name === 'who_am_i' || /^GET \S*\/me$/.test(String(tool._meta?.['api-kit/route'] ?? '')))
        const who = whoAmI ? callResultOf(await clientFor(target).callTool(whoAmI.name, {}, outer)) : null
        if (who?.isError) failWith(who.problem!)
        if (globals.json) return printJson({ signedIn: true, url: target.url, from: target.from, caller: who?.json ?? null, profiles: rows }), EXIT.ok
        rows.forEach((row) => print(`${row.current ? '*' : ' '} ${row.name}  ${row.url}  ${row.kind}${row.expiresAt ? ` (token until ${row.expiresAt})` : ''}`))
        print(`Using ${target.url} from ${target.from}.${who ? ` ${who.text}` : ''}`)
        return EXIT.ok
      }
      case 'token': {
        const target = targetOf(globals.profile)
        const token = signedIn(target) ? await bearerOf(target) : undefined
        if (!token) throw new CliError(`Not signed in: ${signInHint}`, EXIT.signIn)
        print(token)
        return EXIT.ok
      }
      case 'switch': {
        const name = String(values.profile ?? '')
        if (!profiles.profiles[name]) throw usage(`no profile "${name}"; ${Object.keys(profiles.profiles).length ? `there are ${Object.keys(profiles.profiles).join(', ')}` : `sign in first: \`${app} auth login <url>\``}`)
        store.write({ ...profiles, current: name })
        print(`Using ${name} (${profiles.profiles[name]!.url})`)
        return EXIT.ok
      }
      case 'logout': {
        const name = String(values.profile ?? globals.profile ?? profiles.current ?? '')
        const profile = profiles.profiles[name]
        if (!profile) throw usage(`no profile "${name}" to sign out of`)
        await revokeProfile(profile, send)
        const { [name]: _gone, ...others } = profiles.profiles
        store.write({ current: profiles.current === name ? Object.keys(others)[0] : profiles.current, profiles: others })
        print(`Signed out of ${profile.url} (profile ${name})`)
        return EXIT.ok
      }
    }
    throw usage(`\`${app} auth\` has login, status, token, switch and logout, not "${verb}"`)
  }

  const doctor = async (globals: Globals, outer: AbortSignal) => {
    const checks: { check: string; ok: boolean | 'warn'; detail: string; exit?: number }[] = []
    checks.push({ check: 'cli', ok: true, detail: `${app} ${version}, commands packaged from ${snapshot.app || app} ${snapshot.version || '?'}` })
    const target = targetOf(globals.profile)
    if (!target.url) checks.push({ check: 'target', ok: false, detail: `no deployment: ${signInHint}`, exit: EXIT.signIn })
    else {
      checks.push({ check: 'target', ok: true, detail: `${target.url} from ${target.from}` })
      const health = await send(`${target.url}/api/health`, { headers: { accept: 'application/json' }, signal: outer }).catch((error: unknown) => error as Error)
      if (health instanceof Error || !health.ok) checks.push({ check: 'reachable', ok: false, detail: `${target.url}/api/health: ${health instanceof Error ? health.message : health.status}`, exit: EXIT.server })
      else checks.push({ check: 'reachable', ok: true, detail: `${target.url}/api/health answered ${health.status}` })
      if (!signedIn(target)) checks.push({ check: 'sign-in', ok: false, detail: `no key or token: ${signInHint}`, exit: EXIT.signIn })
      else {
        try {
          const client = clientFor(target)
          const listed = await client.listTools(outer)
          checks.push({ check: 'sign-in', ok: true, detail: `${listed.tools.length} tools listed with ${target.apiKey ? 'an API key' : 'an OAuth token'}` })
          const server = (await client.discover(outer).catch(() => ({ serverInfo: undefined }))).serverInfo ?? (listed._meta?.['io.modelcontextprotocol/serverInfo'] as { version?: string } | undefined)
          if (server?.version && snapshot.version) checks.push({ check: 'version', ok: server.version === snapshot.version ? true : 'warn', detail: server.version === snapshot.version ? `server and CLI both ${server.version}` : `server ${server.version}, commands packaged from ${snapshot.version}: the server's own list is used` })
          const packaged = new Set(snapshotCommands().flatMap((command) => (command.tool ? [command.tool] : [])))
          const listedNames = new Set(listed.tools.map((tool: { name: string }) => tool.name))
          const added = [...listedNames].filter((tool) => !packaged.has(tool))
          const gone = [...packaged].filter((tool) => !listedNames.has(tool))
          checks.push({ check: 'drift', ok: added.length || gone.length ? 'warn' : true, detail: added.length || gone.length ? `${added.length ? `new on the server: ${added.join(', ')}` : ''}${added.length && gone.length ? '; ' : ''}${gone.length ? `not on the server: ${gone.join(', ')}` : ''}` : 'the packaged commands match the server' })
        } catch (error) {
          checks.push({ check: 'sign-in', ok: false, detail: error instanceof Error ? error.message : String(error), exit: error instanceof CliError ? error.exitCode : EXIT.server })
        }
      }
    }
    if (globals.json) printJson({ checks: checks.map(({ exit: _exit, ...check }) => check) })
    else for (const { check, ok, detail } of checks) print(`${ok === true ? 'ok  ' : ok === 'warn' ? 'warn' : 'fail'}  ${check.padEnd(9)} ${detail}`)
    return checks.find((check) => check.ok === false)?.exit ?? EXIT.ok
  }

  const api = async (words: string[], tokens: string[], outer: AbortSignal) => {
    const { values, globals } = parseArguments(builtIn('api', ['method', 'path']), [...words, ...tokens])
    const method = String(values.method ?? '').toUpperCase()
    const path = String(values.path ?? '')
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method) || !path.startsWith('/')) throw usage(`\`${app} api <METHOD> <path> [--input -]\`, e.g. \`${app} api GET /api/health\``)
    const target = targetOf(globals.profile)
    if (!target.url) throw new CliError(`Not signed in: ${signInHint}`, EXIT.signIn)
    const body = globals.input ? JSON.stringify(await readInput(globals.input)) : undefined
    if (globals.dryRun) return printJson({ method, url: `${target.url}${path}`, body: body ? JSON.parse(body) : undefined }), EXIT.ok
    const { signal, done } = deadline(globals, undefined, outer)
    try {
      const token = signedIn(target) ? await bearerOf(target) : undefined
      const response = await send(`${target.url}${path}`, { method, signal, headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body })
      const text = await response.text()
      const json = (() => {
        try {
          return JSON.parse(text) as unknown
        } catch {
          return undefined
        }
      })()
      if (!response.ok) failWith(json && typeof json === 'object' && 'title' in json ? { ...(json as Problem), status: response.status } : { title: text.slice(0, 200) || `HTTP ${response.status}`, status: response.status })
      if (json !== undefined) printJson(selectFields(json, Array.isArray(globals.json) ? globals.json : undefined))
      else if (text) print(text)
      return EXIT.ok
    } finally {
      done()
    }
  }

  const tool = async (words: string[], tokens: string[], outer: AbortSignal) => {
    const { values, globals } = parseArguments(builtIn('tool', ['name', 'arguments']), [...words, ...tokens])
    const target = targetOf(globals.profile)
    if (!values.name) {
      const { commands } = await commandsOf(target, outer)
      for (const command of commands.filter((one) => one.tool)) print(`${command.tool!.padEnd(28)} ${app} ${command.name}`)
      return EXIT.ok
    }
    const given = (() => {
      try {
        return values.arguments ? (JSON.parse(String(values.arguments)) as Record<string, unknown>) : {}
      } catch {
        throw usage(`the arguments to \`${app} tool ${String(values.name)}\` are one JSON object, in single quotes: '{"id":"…"}'`)
      }
    })()
    const args = { ...(globals.input ? await readInput(globals.input) : {}), ...given }
    if (globals.dryRun) return printJson({ method: 'tools/call', name: values.name, arguments: args }), EXIT.ok
    const { signal, done } = deadline(globals, undefined, outer)
    try {
      return answerTool(await waiting(String(values.name), clientFor(target).callTool(String(values.name), args, signal)), globals)
    } finally {
      done()
    }
  }

  const manifest = (commands: Command[]) => ({ app: snapshot.app || app, version: snapshot.version || version, commands })

  // ---- The entry ----

  const dispatch = async (argv: string[], outer: AbortSignal): Promise<number> => {
    const { leading, words } = splitLeadingFlags(argv)
    const [first, ...more] = words
    const firstFlags = parseArguments(builtIn('', []), leading).globals
    if (!first || first === '--help' || first === '-h') {
      if (firstFlags.json) return printJson(manifest((await commandsOf(targetOf(firstFlags.profile), outer)).commands)), EXIT.ok
      return helpFor([], firstFlags)
    }
    if (first === '--version' || first === '-v') return print(`${app} ${version}`), EXIT.ok
    const bare = (tokens: string[]) => tokens.filter((token, index) => !token.startsWith('-') && !(index > 0 && GLOBAL_FLAGS[tokens[index - 1]!.replace(/^--/, '')]?.value))
    switch (first) {
      case 'help':
        return helpFor(bare(more), parseArguments(builtIn('help', [], []), more.filter((token) => token.startsWith('-'))).globals)
      case 'version': {
        const { globals } = parseArguments(builtIn('version', []), [...leading, ...more])
        return globals.json ? printJson({ name: app, version, commands: snapshot.version || null }) : print(`${app} ${version}`), EXIT.ok
      }
      case 'commands': {
        const { globals } = parseArguments(builtIn('commands', []), [...leading, ...more])
        const { commands } = await commandsOf(targetOf(globals.profile), outer)
        if (globals.json) return printJson(manifest(commands)), EXIT.ok
        for (const command of commands) print(`${command.name.padEnd(28)} ${command.summary}`)
        return EXIT.ok
      }
      case 'completion': {
        const { values, globals } = parseArguments(builtIn('completion', ['shell']), [...leading, ...more])
        const script = completion(app, String(values.shell ?? ''), (await commandsOf(targetOf(globals.profile), outer)).commands)
        if (!script) throw usage(`\`${app} completion bash|zsh|fish\`, e.g. \`${app} completion zsh > ~/.zfunc/_${app}\``)
        return print(script), EXIT.ok
      }
      case 'auth':
        return auth([...more, ...leading], outer)
      case 'doctor':
        return doctor(parseArguments(builtIn('doctor', []), [...leading, ...more]).globals, outer)
      case 'api':
        return api(more, leading, outer)
      case 'tool':
        return tool(more, leading, outer)
    }
    const target = targetOf(firstFlags.profile)
    const { commands } = await commandsOf(target, outer)
    const found = resolve(words, commands)
    if ('noun' in found) {
      if (leading.includes('--json') || more.includes('--json')) return printJson(manifest(found.verbs!)), EXIT.ok
      return print(nounHelp(app, found.noun!, found.verbs!, paint)), EXIT.ok
    }
    return execute(found.command, [...words.slice(found.used), ...leading], outer)
  }

  /** Runs one command line and resolves its exit code; never exits the process itself. */
  const run = async (argv: string[]): Promise<number> => {
    const controller = new AbortController()
    const interrupt = () => controller.abort(new CliError('Stopped.', EXIT.interrupted))
    process.once('SIGINT', interrupt)
    const jsonErrors = argv.some((token) => token === '--json' || token.startsWith('--json='))
    try {
      return await dispatch(argv, controller.signal)
    } catch (error) {
      const failure = error instanceof CliError ? error : controller.signal.aborted && controller.signal.reason instanceof CliError ? controller.signal.reason : new CliError(error instanceof Error ? error.message : String(error), EXIT.usage)
      if (jsonErrors) tell(JSON.stringify({ ...(failure.problem ?? { title: failure.message, status: 0 }), detail: failure.problem?.detail ?? failure.message, exitCode: failure.exitCode }))
      else if (failure.exitCode === EXIT.usage && !failure.problem) {
        const named = argv.filter((token) => !token.startsWith('-')).slice(0, 2).join(' ')
        tell(`${app}: ${failure.message}`)
        tell(errPaint.dim(`Run \`${app} help${named ? ` ${named}` : ''}\` for the arguments.`))
      } else tell(failure.message)
      return failure.exitCode
    } finally {
      process.removeListener('SIGINT', interrupt)
    }
  }

  return { run }
}

export type { Command, Snapshot } from './commands.js'
