/**
 * Jobs: one task, one command (`mailroom signup`). A job makes the few calls a playbook makes every time, through the
 * same MCP tools an agent would call, and prints only the answer. Written by the app in `cli/jobs/`; this file is the
 * kit's and imports nothing from Node, so scripts can load the jobs cheaply.
 *
 * @example
 * export const signup = defineJob({
 *   name: 'signup', summary: 'Make an address and wait for its code',
 *   args: { label: { type: 'string', description: 'What the address is for.', default: 'signup' } },
 *   examples: [{ run: 'signup --label shop', about: 'An address for a shop, then its code' }],
 *   run: async (ctx, { label }) => {
 *     const made = await ctx.call('create_address', { label })
 *     if (made.isError) ctx.fail(made)
 *     ctx.progress(`Waiting for mail to ${made.json.address}`)
 *     ctx.print(made.text)
 *   },
 * })
 */

/** An RFC 9457 problem, always with its `status`. */
export type Problem = { type?: string; code?: string; title: string; status: number; detail?: string; [field: string]: unknown }

/** A tool call's answer: the text summary, the route's JSON, and the problem when it failed. Never throws for a failed call. */
export type CallResult = { text: string; json: any; isError: boolean; problem: Problem | null }
/** A resource's parts: text (JSON parsed into `json` when it is JSON) and blobs as base64. */
export type ReadResult = { text: string; json: any; contents: { uri: string; mimeType?: string; text?: string; blob?: string }[] }

export type JobArg = { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean; positional?: boolean; multiple?: boolean; default?: unknown }

type ValueOf<Arg extends JobArg> = Arg['type'] extends 'number' ? number : Arg['type'] extends 'boolean' ? boolean : string
type Given<Arg extends JobArg> = Arg['multiple'] extends true ? ValueOf<Arg>[] : ValueOf<Arg>
/** A job's arguments as `run` gets them: required ones and ones with a default are always there. */
export type JobArgs<Args extends Record<string, JobArg>> = { [Key in keyof Args as Args[Key]['required'] extends true ? Key : Args[Key] extends { default: unknown } ? Key : never]: Given<Args[Key]> } & {
  [Key in keyof Args as Args[Key]['required'] extends true ? never : Args[Key] extends { default: unknown } ? never : Key]?: Given<Args[Key]>
}

export type JobContext = {
  /** Calls an MCP tool by its MCP name. */
  call: (tool: string, args?: Record<string, unknown>) => Promise<CallResult>
  /** Reads an MCP resource by its URI. */
  read: (uri: string) => Promise<ReadResult>
  /** A line of the answer, on stdout. */
  print: (text: string) => void
  /** The answer as JSON on stdout, with `--json <fields>` applied. */
  json: (value: unknown) => void
  /** What is happening, on stderr; never part of the answer. */
  progress: (text: string) => void
  /** Stops the job with a problem (or a failed call's): its status picks the exit code. */
  fail: (problem: Problem | CallResult | string) => never
  /** Aborted on Ctrl-C and when `--timeout` passes. */
  signal: AbortSignal
  /** A person at a terminal: prompts are allowed. */
  interactive: boolean
  /** `--json` was given: answer with `json`, not `print`. */
  jsonMode: boolean
}

export type Job<Args extends Record<string, JobArg> = Record<string, JobArg>> = {
  /** One lowercase kebab-case word, the command itself: `signup`. */
  name: string
  summary: string
  description?: string
  args: Args
  examples: { run: string; about: string }[]
  /** Asks for `--yes` without a terminal, and y/N in one. */
  destructive?: boolean
  run: (ctx: JobContext, args: JobArgs<Args>) => Promise<void>
}

/** Keeps a job's argument types for its `run`. */
export const defineJob = <const Args extends Record<string, JobArg>>(job: Job<Args>) => job as unknown as Job
