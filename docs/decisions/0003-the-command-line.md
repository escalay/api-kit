# 0003 The command line: every app's MCP tools as a CLI, for agents first and people too

Status: accepted, 13 November 2026. What building it changed is folded in below.

## Context

A kit app already describes every task an agent can do: each MCP tool has a description that says when to use it,
an input schema with every argument described, read-only and destructive hints, the route it calls, a short text
summary written for agents, and the route's JSON as `structuredContent`. A command line built by hand repeats all of
that and drifts from it. Agents in a terminal (and people) still want one: a shell needs no MCP client, a command
composes with pipes, and `--help` is where an agent looks first.

So the command line is not written per app. The kit derives it from the tools, the app names its commands and adds a
few task-sized jobs, and the kit checks the result like it checks the guide and the OpenAPI document.

## Decisions

1. **The CLI is an MCP client.** Every command is a `tools/call` (or `resources/read`) against the app's `/mcp`, with
   the caller's key or OAuth token. Human output is the tool's summary; `--json` is its `structuredContent`. One code
   path for all apps, the same words agents already read over MCP, and no route the CLI can get wrong.

2. **Names are noun then verb, as `gh` writes them**, and each tool declares its own: `cli: 'mail wait'`. Nouns are
   singular (`address`, `mail`, `webhook`); verbs are `gh`'s where one fits (`list`, `view`, `create`, `edit`,
   `delete`) and the task's own word otherwise (`wait`, `reply`, `mark-read`). A rule from the route
   (`GET /api/addresses/{id}` → `address view`) is only the fallback for a tool without a name: tried on Mailroom's 54
   tools it collided on 10 and misnamed every wait. The tool's MCP name stays a hidden alias
   (`mailroom wait-for-message` and `mailroom tool wait_for_message '{…}'` both work), so an agent that learnt the
   MCP names is never stuck.

3. **Arguments come from the input schema.** The input keys the call puts in its path are positional, in path order
   (found by running `call` on placeholders, not read from `route`, whose names may differ: Mailroom's
   `wait_for_message` takes `address` for `{id}`; `cli.positional` overrides it, and the route's names are used only
   when `call` can't run on placeholders), as in `mailroom mail view msg_123`, and work as flags too; every
   property is a `--kebab-case` flag with its description as help; booleans take `--flag` / `--no-flag`; arrays repeat the flag; numbers and enums are checked
   before the call; nested objects come only through `--input -`, which reads the input as a JSON object from stdin
   (or a file), **under** the flags: a flag wins over the same field in the JSON. Examples come from the tool
   (`cli: { name, examples }`); `cliGaps` checks each against its command (the name, the flags it takes, how many
   bare arguments) without running it; the kit's tests run a sample app's commands end to end.

4. **Resources are commands too** (`mail_headers` → `mail headers <id>`, an attachment → `mail attachment <id> <n>
   --out file`), named the same way on `mcpResource`. The template's path variables are positional and its query
   variables (`{?format}`) are flags; `mountMcp` accepts a URI that leaves query variables out (the SDK's own match
   needed every one). Templates a protocol extension serves (`io.modelcontextprotocol/skills`) are not commands.

5. **Jobs: one task, one command.** Where a playbook makes the same few calls every time (make an address, wait,
   read the code), the app writes a job: a file in `sdk/cli/jobs/<name>.ts` with `defineJob({ name, summary,
   args, examples, run })`, listed in `sdk/cli/jobs/index.ts`. Its `run` gets `call(tool, args)` (which never throws
   for a failed call: it answers `{ text, json, isError, problem }`), `read(uri)`, `print`, `json`, `progress`,
   `fail(problem)`, an abort signal, and whether it is `interactive` or in `jsonMode`. A job has no `--dry-run`: its
   calls depend on each other's answers.
   Jobs sit at the top level (`mailroom signup`), are listed first by `mailroom` alone, and each does one task. The
   growth loop: a playbook step the agent test shows agents doing in three calls becomes a job, and the playbook then
   names the job.

6. **Agents are the first users.** Rules every app gets from the engine:
   - stdout holds only the answer; progress, warnings and prompts go to stderr;
   - nothing waits for a keypress without a terminal: a missing argument is an error that names the flag;
   - errors are the problem (RFC 9457) as one line on stderr, and with `--json` as JSON on stderr, with stable exit
     codes: 0 done, 1 usage, 2 sign-in, 3 not found, 4 refused or a limit, 5 the server, 6 timed out (or the tool is
     still working on a run), 130 stopped with Ctrl-C;
   - a destructive tool (its `destructiveHint`) needs `--yes` without a terminal and asks in one;
   - `--json [fields]` selects top-level fields (`--json id,address`), like `gh`, of each item for a list; the next
     word is taken as fields only once every bare argument is given (`--json=id` always is);
   - `--dry-run` prints the tool call it would make;
   - text a stranger wrote stays marked as the server marks it;
   - `<app> commands --json` prints every command, argument, example and hint as one manifest, and
     `<app> help agents` teaches these rules on one screen.

7. **People get the rest:** colour only on a terminal and never with `NO_COLOR`; `help <command>` with arguments and
   examples; `doctor` (connection, sign-in, server and CLI versions); shell completion from the manifest; a spinner
   on stderr for waits.

8. **Sign-in works anywhere.** `<app> auth login <url>` uses the device code flow (RFC 8628, the kit's `oauth`): the
   CLI registers itself as a public client (RFC 7591 with the device grant, which the kit already accepted, so the
   kit needed no change), keeps the `client_id`, and polls. `--with-token` takes an API key on stdin instead. A
   profile per deployment lives in the user's config directory (`$XDG_CONFIG_HOME`, `~/.config`, `%APPDATA%`), file
   mode 0600, and the token is renewed under a lock file, because a refresh token sent twice (two processes at once)
   revokes the whole sign-in. `auth status` calls `who_am_i` when the server has it. `<APP>_URL`, `<APP>_API_KEY` and `<APP>_PROFILE` override it for CI and
   agents without a browser. `auth status`, `auth logout`, `auth token`, `auth switch` as in `gh`.

9. **Commands come from the deployment, with a snapshot for before it.** The package carries `commands.json`, made
   from the app's tools, resources and jobs at build time (`cliSnapshot`, written to `sdk/cli/commands.json` by
   `scripts/openapi.ts`, which `pnpm sdk:types` runs; a test compares the file byte for byte, another that the live
   commands equal it, which caught the next point). After sign-in the deployment's own `tools/list` wins, cached per profile until its `ttlMs`, because a
   self-hosted deployment can be older or newer than the package. Each tool publishes its CLI name, positional
   arguments and examples in `_meta["api-kit/cli"]`, beside `_meta["api-kit/route"]`, so a CLI can build itself from
   any kit server; a failed tool call carries its problem in `_meta["api-kit/problem"]`, and a call still working
   names its run in `_meta["api-kit/pending"]`. Building it showed that `mcpServerFactory` hinted every tool
   read-only unless it said otherwise, a `POST` and a delete included: read-only is now the default only for a `GET`,
   and a destructive tool is never read-only.

10. **Where it lives.** The engine is copied into each app's `sdk/cli/engine/` by `kit sdk` (or `kit cli` for an app
    that has `sdk/`; `kit cli --update` takes a newer engine and leaves the rest), as the `<app>` bin of the app's own
    npm package (`dist/cli/bin.js`): Node 20.10 and up (for the JSON import of `commands.json`), built-ins only, no
    dependencies, so `npx @scope/app` runs it. It parses arguments itself rather than with `parseArgs`, which has no
    optional values (`--json [fields]`) and no `--no-x` before Node 22. It has its own `sdk/cli/tsconfig.json` (Node
    types), because the library's is DOM and `types: []`; the library entry stays fetch-only. The app owns
    `sdk/cli/bin.ts`, `jobs/` and `commands.json`. The kit keeps the rest: `cli` on `McpTool` and `McpResource`, the
    `_meta` it publishes, `mountedMcp`, the snapshot writer, and the audit. The naming rules live in `core/cli.ts`,
    so `testing` audits names without the `mcp` part.

11. **Audited like the rest.** `cliGaps({ tools, resources, jobs })` in `testing` returns `[]` when every tool and
    resource has a name, names are unique and never shadow a job or a built-in (`help`, `commands`, `api`, `tool`,
    `doctor`, `completion`, `version` as nouns, and `auth login`, `auth logout`, `auth token`, `auth switch`: a tool
    may fill another `auth` verb, as the kit's `who_am_i` is `auth status`), no argument hides a global flag, nouns
    are singular (a heuristic with an allowlist, extendable with
    `singular`), every argument has a description, every tool and job has an example, and each example fits its
    command. Verbs are not checked against a list: the task's own word is allowed. `kit doctor` runs it when the kit
    folder sits in an app with its dependencies installed, and the guide gets `{{cli.commands}}` so `llms.txt` lists
    the commands as it lists the tools, jobs first (from the snapshot when `serveGuide` gets `commands`).

## Consequences

- A new feature gets its commands, help, examples and completion by naming its tools; nothing in the CLI changes.
- `McpTool` gains an optional `cli` (a string, or `{ name, examples }`); apps without it still work by the route rule
  and `cliGaps` tells them what to name.
- The kit ships a skill, `api-kit-cli`, that adds the CLI to an app, names its tools and writes its jobs;
  `api-kit-feature` asks for a `cli` name per new tool and `api-kit-review` runs `cliGaps`.
- Mailroom is the first app (its decision 0003), the way it was for `people`, `setup` and `telemetry`: it uses the
  kit from a local checkout, goes live, then the kit is released.
