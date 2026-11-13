---
name: api-kit-cli
description: Use when giving an API built on the Escalay api-kit its command line, naming its MCP tools as commands, writing a job (one command for a playbook step), or fixing what cliGaps reports. Covers kit sdk / kit cli, names, examples, jobs, the snapshot and sign-in.
---

# The app's command line

Every kit app gets a CLI derived from its MCP tools: `<app> <noun> <verb>`, help with examples, `--json`, stable
exit codes, device-code sign-in. The engine is the kit's; the app names its tools and writes its jobs. Standard:
`docs/STANDARD.md` §19, design: `docs/decisions/0003-the-command-line.md`.

## Add it

1. An app without `sdk/`: `npx @escalay/kit sdk` (the client and the CLI together). An app with `sdk/`:
   `npx @escalay/kit cli [--bin <name>]`, then paste the lines it prints into `scripts/openapi.ts`.
2. `pnpm sdk:types` writes `sdk/cli/commands.json` (the commands before sign-in).
3. `pnpm test`: `sdk/test/cli.test.ts` checks the names (`cliGaps`), that `commands.json` is current, and that the
   live commands match it. Done when it passes.

What is whose: `sdk/cli/engine/` is the kit's (take a newer one with `npx @escalay/kit cli --update`, never edit
it); `sdk/cli/bin.ts`, `sdk/cli/jobs/` and `sdk/cli/commands.json` are the app's.

## Name every tool

Each `mcpTool` (and `mcpResource`) gets `cli`, with at least one example run without the bin:

```ts
mcpTool({
  name: 'wait_for_message',
  cli: { name: 'mail wait', examples: [{ run: 'mail wait adr_123 --timeout 30', about: 'The next mail to an address' }] },
  …
})
```

Rules:

- `<noun> <verb>`, lowercase kebab-case, as `gh` writes them. The noun is singular (`address`, `mail`, `webhook`).
- Verbs are `gh`'s where one fits: `list`, `view`, `create`, `edit`, `delete`. Otherwise the task's own word:
  `wait`, `reply`, `mark-read`, `set-role`.
- Never a built-in as a noun (`auth`, `help`, `commands`, `api`, `tool`, `doctor`, `completion`, `version`), and
  never a job's name.
- Path parameters are positional, in the route's order; every other argument is a `--kebab-case` flag. So name
  input properties for flags people type (`--timeout`, not `--timeout-seconds-max`), and describe every one.
- An example uses only flags the tool takes and a plausible id (`adr_123`). `about` says what it does.

| Good | Bad | Why |
|---|---|---|
| `mail wait` | `messages wait-for-message` | singular noun; the verb is the task, not the tool name again |
| `address delete` | `address remove-address` | `gh`'s verb fits |
| `team set-role` | `team-role change` | the noun is the thing; the verb is the change |

The MCP names stay hidden aliases (`<app> wait_for_message …` works), so agents that know them are never stuck.

## Write a job

A job is earned when the agent test shows agents making the same few calls for one playbook step (make an address,
wait, read the code). Not before: a job nobody repeats is a second name for the same tools.

```ts
// sdk/cli/jobs/signup.ts
import { defineJob } from '../engine/job.js'

export const signup = defineJob({
  name: 'signup',
  summary: 'Make an address, wait for its code, print the code',
  args: { label: { type: 'string', description: 'What the address is for.', default: 'signup' }, timeout: { type: 'number', description: 'Seconds to wait.', default: 120 } },
  examples: [{ run: 'signup --label shop', about: 'An address for a shop, then its code' }],
  run: async (ctx, { label, timeout }) => {
    const made = await ctx.call('create_address', { label })
    if (made.isError) ctx.fail(made)
    ctx.progress(`Waiting for mail to ${made.json.address}`)
    const code = await ctx.call('get_verification', { address: made.json.id, timeout })
    if (code.isError) ctx.fail(code)
    if (ctx.jsonMode) ctx.json(code.json)
    else ctx.print(code.json.code)
  },
})
```

List it in `sdk/cli/jobs/index.ts`, run `pnpm sdk:types`, then name the job in the playbook it replaces.

- One task per job, one lowercase word. Jobs are listed first by `<app>` alone.
- `ctx.print` / `ctx.json` write the answer (stdout); `ctx.progress` writes everything else (stderr).
- `ctx.call` never throws for a failed call: check `isError` and `ctx.fail(result)` (its status picks the exit code).
- No prompts: `ctx.interactive` is false for agents. Mark a job `destructive: true` when it deletes things.

## Checks

| Rule | Verified by |
|---|---|
| Every tool and resource is named well, every argument described, every tool has an example | `cliGaps({ tools, resources, jobs })` returns `[]` in `sdk/test/cli.test.ts` |
| `commands.json` is current | the byte compare in `sdk/test/cli.test.ts`; fix with `pnpm sdk:types` |
| The live commands match the package | `<app> doctor` prints `ok drift` |
| The copied engine is current | `npx @escalay/kit cli --update`, then `pnpm test` |

`npx @escalay/kit doctor` also runs `cliGaps` when the app's dependencies are installed.

## Try it

```sh
pnpm dev
export APP_URL=http://localhost:8787 APP_API_KEY=…   # the bin's prefix: MAILROOM_URL for mailroom
pnpm exec tsx sdk/cli/bin.ts                          # jobs, then nouns
pnpm exec tsx sdk/cli/bin.ts help agents
```

## Done when

`pnpm test` passes with `cliGaps` empty, `commands.json` current, and each playbook names its command beside its
tools.
