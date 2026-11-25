---
name: api-kit-cli
description: Use when giving an API built on the Escalay api-kit its command line, naming its MCP tools as commands, writing a job (one command for a playbook step), or fixing what cliGaps reports. Covers kit sdk / kit cli, names, examples, jobs, the snapshot and sign-in; and every command of the kit's own CLI (npx @escalay/kit - init and its presets, add, update, upgrading, doctor, feature, guide, repo, button, brand, license), what each does and when to run it.
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
- Never a built-in as a noun (`help`, `commands`, `api`, `tool`, `doctor`, `completion`, `version`), never a job's
  name. `auth` is shared: `auth login|logout|token|switch` are built in, and a tool may fill another verb (the
  kit's `who_am_i` is `auth status`).
- The input keys the call puts in its path are positional, in path order (`cli.positional` overrides, rarely); every
  argument is also a `--kebab-case` flag. Name inputs for flags people type (`--timeout`), describe every one, and
  never name one `json`, `yes`, `input`, `profile`, `help` or `dry-run` (the CLI's own flags).
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
  Anything else a job throws exits with its numeric `exitCode` (`6` when nothing came in time), else its
  `problem.status`'s code, else 1; its message is the one line on stderr.
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
export APP_URL=http://localhost:8787 APP_API_KEY=…   # the bin's prefix: POSTBOX_URL for postbox
pnpm exec tsx sdk/cli/bin.ts                          # jobs, then nouns
pnpm exec tsx sdk/cli/bin.ts help agents
```

## The kit's own commands

`npx @escalay/kit <command>` (`npx @escalay/kit help` prints the flags). `--dir` is the kit's folder, `src/kit` by
default; `--app` is the app's folder, `.` by default.

| Command | What it does |
|---|---|
| `kit init <dir>` | a new app (`npm create escalay@latest <dir>` runs it): `--preset`, `--runtime both\|cloudflare\|node`, `--title`, `--bare` (no `notes`), `--no-git`; then `pnpm install`, `format` and `migrations` (`--no-install` leaves them out) |
| `kit add <part…>` | copies parts and the parts they need; `--install`, `--web-dir` for browser parts; `--wire` also wires `people`, `setup`, `boards` (`--items <feature>`) and `sharing` (`--spaces <feature>`) into an app made by `init` (twice changes nothing; an older app is told the edits) |
| `kit list` | every part, what it needs, which are installed |
| `kit diff [--patch]` | per file: unchanged, you edited, the kit changed, both; `--patch` shows only the changed ones, from the app's (`app/`, -) to the kit's (`kit/`, +) |
| `kit update [part…]` | takes the kit's changes, keeps your edits (`--force` takes the kit's in the parts named, `kit` for the generated `index.ts`, and names each edit it overwrites; naming no part it refuses while an edit would go, and `--force --all` takes every part's) |
| `kit upgrading` | what changed for the parts in `kit.json` since its version (or `--from`) and what to do: their notes from the kit's `docs/upgrading.md`; `doctor` and `update` print it when the app is behind |
| `kit doctor` | missing, edited and behind files, `cliGaps`, notes (exits 1 with a fix per line); `--keep <file…>` records edits the team keeps, so they no longer fail it |
| `kit adopt` | writes `kit.json` for parts the shadcn CLI copied |
| `kit feature <plural-name>` | a feature folder with a paged list; `--fields "name:string minutes:int status:enum(open|done)"` gives its own fields, `--singular shelf` names one, `--no-remove` leaves out delete, `--under shelves` nests its list and making under a shelf, `--switch` lists it in the catalog so the owner can switch it off; `--remove <name>` takes one out (folder, lines, catalog entry) |
| `kit guide` | `guide/` as `src/guide.gen.ts`, for Workers (an app made by `init` runs `pnpm guide`, which writes the same) |
| `kit sdk`, `kit cli` | the client and the command line (above) |
| `kit repo check\|apply` | the GitHub repository's settings and rules for `main` (§20), through `gh` |
| `kit button` | the Deploy to Cloudflare button: `--check` what would stop a stranger's deploy, `--write` into the README, `--smoke` a real deploy |
| `kit brand` | `brand/` rendered into `src/brand.gen.ts` (needs `@resvg/resvg-js`); `--check` when it is stale |
| `kit key [name]` | a key to try the app with and its `API_KEYS=` line (`API_KEYS=… pnpm dev`, or `.dev.vars`); kept nowhere, so keep both from one run |
| `kit license keys\|mint\|verify` | a product's signing pair and the license keys `licenseOf` accepts for paid features |

Presets (`kit init --preset`): `--preset api` (the default: an API on Node and Workers, or `--runtime`),
`--preset app` (that API with a browser app in `web/`; Cloudflare only, so `--runtime node` is refused), and
`--preset selfhosted`, which is not available yet (it arrives with escalay/selfhost-kit; `init` refuses it).

## Done when

`pnpm test` passes with `cliGaps` empty, `commands.json` current, and each playbook names its command beside its
tools.
