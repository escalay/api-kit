/**
 * Deploys this repository with settings taken from the environment, so a real deployment's account, database ids and
 * domains never enter the repository (a public repo can't hold them). It writes `wrangler.deploy.jsonc`
 * (git-ignored) from `wrangler.jsonc` plus:
 *
 *   CLOUDFLARE_ACCOUNT_ID     the account to deploy to (CLOUDFLARE_API_TOKEN is read by wrangler itself)
 *   D1_<BINDING>_ID           each D1 database's id, e.g. D1_DB_ID (D1_DATABASE_ID also fills the first)
 *   <VAR>                     every `vars` entry left "" in wrangler.jsonc must be set; any other is replaced when set
 *   PUBLIC_HOST               optional: a custom domain the Worker answers on, e.g. api.example.com
 *
 * then writes the guide and migrations, builds (with Vite when the app has a vite.config.ts), applies the migrations,
 * makes any queue the config names that does not exist yet, and deploys.
 *
 *   infisical run … -- pnpm run deploy:env
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const OUT = 'wrangler.deploy.jsonc'
const fail = (why: string): never => {
  console.error(`deploy:env: ${why}. See scripts/deploy-env.ts for what it needs.`)
  process.exit(1)
}
const env = (name: string) => process.env[name]?.trim() || undefined
const need = (name: string) => env(name) ?? fail(`${name} is not set`)

/** wrangler.jsonc as data: comments and trailing commas removed, never inside a string. */
const parseJsonc = (text: string) => {
  let out = ''
  for (let i = 0, inString = false; i < text.length; i++) {
    const char = text[i]!
    if (inString) {
      out += char
      if (char === '\\') out += text[++i] ?? ''
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
      out += char
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else out += char
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, any>
}

const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'))
config.account_id = need('CLOUDFLARE_ACCOUNT_ID')
for (const [index, database] of (config.d1_databases ?? []).entries())
  database.database_id = env(`D1_${database.binding}_ID`) ?? (index === 0 ? env('D1_DATABASE_ID') : undefined) ?? fail(`D1_${database.binding}_ID is not set`)
config.vars = Object.fromEntries(Object.entries(config.vars ?? {}).map(([name, value]) => [name, env(name) ?? (value === '' ? need(name) : value)]))
const host = env('PUBLIC_HOST')
if (host) {
  config.vars.PUBLIC_HOST = host
  config.routes = [{ pattern: host, custom_domain: true }]
}
writeFileSync(OUT, `// Written by scripts/deploy-env.ts from wrangler.jsonc and the environment. Not committed.\n${JSON.stringify(config, null, 2)}\n`)

const run = (command: string, args: string[], extra: Record<string, string> = {}) => {
  console.log(`$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { stdio: 'inherit', env: { ...process.env, ...extra } })
}
const vite = existsSync('vite.config.ts')
run('pnpm', ['guide'])
run('pnpm', ['migrations'])
if (vite) run('pnpm', ['exec', 'vite', 'build'], { WRANGLER_CONFIG: OUT })
if (config.d1_databases?.length) for (const { binding } of config.d1_databases) run('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', binding, '--remote', '-c', OUT])
// Every queue the config names must exist before the deploy that binds it; a queue is made once per account
const queues = new Set<string>((config.queues?.producers ?? []).map((producer: { queue: string }) => producer.queue))
if (queues.size) {
  const known = execFileSync('pnpm', ['exec', 'wrangler', 'queues', 'list', '-c', OUT], { encoding: 'utf8', env: process.env })
  for (const queue of queues) if (!known.includes(queue)) run('pnpm', ['exec', 'wrangler', 'queues', 'create', queue, '-c', OUT])
}
// With Vite, the build wrote the deploy config next to itself and wrangler finds it; without, wrangler reads ours
run('pnpm', ['exec', 'wrangler', 'deploy', ...(vite ? [] : ['-c', OUT])])
