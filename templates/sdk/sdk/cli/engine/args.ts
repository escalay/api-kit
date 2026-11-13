/**
 * The command line in two passes: first the command words (and global flags before them), then that command's own
 * arguments. Flags are the input schema's properties in `--kebab-case` (the property's own name works too); booleans
 * take `--x` / `--no-x`; an array repeats its flag; numbers are checked; nested objects come only through `--input -`.
 * `--json` takes the next word as its fields when every bare argument the command needs is already given (else write
 * `--json=id,name`).
 */
import type { Command, Flag } from './commands.js'
import { CliError, EXIT } from './mcp.js'

export type Globals = { json?: string[] | true; yes: boolean; dryRun: boolean; input?: string; timeout?: number; profile?: string; help: boolean }

/** Flags every command takes, with whether they take a value (the kit's `CLI_GLOBAL_FLAGS`; a kit test keeps them equal). */
export const GLOBAL_FLAGS: Record<string, { value: boolean; about: string }> = {
  json: { value: false, about: 'Print the JSON answer; `--json id,name` keeps those fields' },
  yes: { value: false, about: 'Confirm a destructive command without asking' },
  'dry-run': { value: false, about: 'Print the call it would make, and stop' },
  input: { value: true, about: 'Read the arguments as a JSON object: `-` for stdin, or a file' },
  timeout: { value: true, about: 'Seconds to wait; passed to the tool when it takes a timeout' },
  profile: { value: true, about: 'The signed-in deployment to use' },
  help: { value: false, about: 'Show the arguments and examples' },
}

/** What a resource's command takes besides its template variables (the kit's `CLI_RESOURCE_FLAGS`). */
export const RESOURCE_FLAGS: Record<string, { value: boolean; about: string }> = {
  out: { value: true, about: 'Write the file part here' },
}

const FIELDS = /^[A-Za-z_$][\w$.-]*(,[A-Za-z_$][\w$.-]*)*$/

/** Global flags written before the command (`--profile work mail list`) set apart, so the command's words come first. */
export const splitLeadingFlags = (argv: string[]) => {
  const leading: string[] = []
  let index = 0
  for (; index < argv.length; index++) {
    const token = argv[index]!
    const name = token.replace(/^--?/, '').split('=')[0]!
    if (!token.startsWith('-') || !(GLOBAL_FLAGS[name] || token === '-h' || token === '-y')) break
    leading.push(token)
    if (GLOBAL_FLAGS[name]?.value && !token.includes('=')) leading.push(argv[++index] ?? '')
  }
  return { leading, words: argv.slice(index) }
}

const usage = (message: string) => new CliError(message, EXIT.usage)

const coerce = (flag: Flag, raw: string, label: string): unknown => {
  if (flag.type === 'object') throw usage(`${label} is an object: give it inside the JSON of \`--input -\``)
  if (flag.type === 'boolean') {
    if (/^(true|yes|1)$/i.test(raw)) return true
    if (/^(false|no|0)$/i.test(raw)) return false
    throw usage(`${label} is true or false, not "${raw}"`)
  }
  if (flag.type === 'number' || flag.type === 'integer') {
    const value = Number(raw)
    if (raw.trim() === '' || Number.isNaN(value) || (flag.type === 'integer' && !Number.isInteger(value))) throw usage(`${label} is ${flag.type === 'integer' ? 'a whole number' : 'a number'}, not "${raw}"`)
    return value
  }
  if (flag.enum && !flag.enum.includes(raw)) throw usage(`${label} is one of ${flag.enum.join(', ')}, not "${raw}"`)
  return raw
}

/** A command's arguments and the global flags, from the words after the command. */
export const parseArguments = (command: Command, tokens: string[]) => {
  const byName = new Map<string, Flag>()
  for (const flag of command.flags) {
    byName.set(flag.name, flag)
    byName.set(flag.key, flag)
  }
  const globals: Globals = { yes: false, dryRun: false, help: false }
  const values: Record<string, unknown> = {}
  const bare: string[] = []
  const set = (flag: Flag, value: unknown) => {
    values[flag.key] = flag.multiple ? [...((values[flag.key] as unknown[] | undefined) ?? []), value] : value
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === '--') {
      bare.push(...tokens.slice(index + 1))
      break
    }
    if (token === '-h') {
      globals.help = true
      continue
    }
    if (token === '-y') {
      globals.yes = true
      continue
    }
    if (!token.startsWith('--') || token === '-') {
      bare.push(token)
      continue
    }
    const [name = '', inline] = token.slice(2).split(/=(.*)/s)
    const next = () => {
      if (inline !== undefined) return inline
      const value = tokens[index + 1]
      if (value === undefined) throw usage(`--${name} needs a value`)
      index++
      return value
    }
    const flag = byName.get(name)
    if (flag) {
      if (flag.type === 'boolean' && inline === undefined) set(flag, true)
      else set(flag, coerce(flag, next(), `--${flag.name}`))
      if (name === 'timeout') globals.timeout = Number(values[flag.key])
      continue
    }
    const negated = name.startsWith('no-') ? byName.get(name.slice(3)) : undefined
    if (negated?.type === 'boolean') {
      set(negated, false)
      continue
    }
    switch (name) {
      case 'json': {
        const following = tokens[index + 1]
        const needsBare = bare.length < command.positional.length
        if (inline !== undefined) globals.json = inline ? inline.split(',') : true
        else if (following && FIELDS.test(following) && !needsBare) {
          globals.json = following.split(',')
          index++
        } else globals.json = true
        continue
      }
      case 'yes':
        globals.yes = true
        continue
      case 'dry-run':
        globals.dryRun = true
        continue
      case 'help':
        globals.help = true
        continue
      case 'input':
        globals.input = next()
        continue
      case 'profile':
        globals.profile = next()
        continue
      case 'timeout': {
        const seconds = Number(next())
        if (!(seconds > 0)) throw usage('--timeout is a number of seconds')
        globals.timeout = seconds
        continue
      }
    }
    const known = command.flags.map((one) => `--${one.name}`).join(', ')
    throw usage(`unknown flag --${name} for "${command.name}"${known ? `; it takes ${known}` : '; it takes no flags'}`)
  }
  if (bare.length > command.positional.length) throw usage(`"${command.name}" takes ${command.positional.length ? command.positional.map((name) => `<${name}>`).join(' ') : 'no bare arguments'}, and got ${bare.map((word) => `"${word}"`).join(' ')}`)
  bare.forEach((word, index) => {
    const key = command.positional[index]!
    const flag = byName.get(key) ?? { name: key, key, type: 'string', description: '', required: true, multiple: false }
    if (values[key] !== undefined) throw usage(`<${key}> was given twice: bare and as --${flag.name}`)
    set(flag, coerce(flag, word, `<${key}>`))
  })
  return { values, globals }
}

/** The arguments `--input` gave under the flags, then a usage error naming the first required one still missing. */
export const completeArguments = (command: Command, values: Record<string, unknown>, input: Record<string, unknown> = {}) => {
  const merged = { ...input, ...values }
  for (const flag of command.flags) {
    if (!flag.required || merged[flag.key] !== undefined) continue
    const named = command.positional.includes(flag.key) ? `<${flag.key}>` : `--${flag.name}`
    throw usage(`"${command.name}" needs ${named}${flag.description ? `: ${flag.description}` : ''}`)
  }
  return merged
}
