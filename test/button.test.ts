import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const CLI = join(import.meta.dirname, '..', 'cli.mjs')
const folders: string[] = []
afterEach(() => folders.splice(0).forEach((folder) => rmSync(folder, { recursive: true, force: true })))

const READY_CONFIG = `{
  // a comment, as wrangler.jsonc allows
  "name": "notes",
  "main": "src/worker.ts",
  "compatibility_date": "2026-11-12",
  "vars": { "MAIL_DOMAINS": "" },
  "d1_databases": [{ "binding": "DB", "database_name": "notes", "migrations_dir": "migrations" }],
}
`
const READY_PACKAGE = {
  scripts: { deploy: 'pnpm migrations && wrangler d1 migrations apply DB --remote && wrangler deploy' },
  cloudflare: { bindings: { API_KEYS: { description: 'Keys as name:sha256 pairs.' }, MAIL_DOMAINS: { description: 'The domains whose mail it takes.' } } },
}

/** An app folder with the given files, and a `gh` on the PATH that knows no repository (no network in tests). */
const appWith = (files: Record<string, string | object>) => {
  const root = mkdtempSync(join(tmpdir(), 'kit-button-'))
  folders.push(root)
  const app = join(root, 'notes')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(app, path, '..'), { recursive: true })
    writeFileSync(join(app, path), typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin/gh'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(root, 'bin/gh'), 0o755)
  const kit = (...args: string[]) => spawnSync(process.execPath, [CLI, 'button', ...args], { cwd: app, encoding: 'utf8', env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` } })
  return { app, kit }
}
const ready = () => ({ 'wrangler.jsonc': READY_CONFIG, 'package.json': READY_PACKAGE, '.dev.vars.example': 'API_KEYS=""\n', 'migrations/0000_kit.sql': '-- step\n' })

describe('kit button', () => {
  it('prints the link, Markdown and HTML, with a branch and a folder in the repository URL', () => {
    const { kit } = appWith(ready())
    const plain = kit('--repo', 'acme/notes')
    expect(plain.status).toBe(0)
    expect(plain.stdout).toContain('Link:     https://deploy.workers.cloudflare.com/?url=https://github.com/acme/notes\n')
    expect(plain.stdout).toContain('Markdown: [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acme/notes)')
    expect(plain.stdout).toContain('HTML:     <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/acme/notes"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"/></a>')
    expect(kit('--repo', 'acme/notes', '--branch', 'next', '--subdir', '/apps/api/').stdout).toContain('?url=https://github.com/acme/notes/tree/next/apps/api\n')
    expect(kit('--repo', 'acme/notes', '--subdir', 'apps/api').stderr).toContain('--dir needs --branch')
    expect(kit('--repo', 'not a repo').stderr).toContain('--repo is owner/name')
  })

  it('passes an app a stranger can deploy, and names each thing that would stop one', () => {
    expect(appWith(ready()).kit('--check').stdout).toContain('notes is ready for the Deploy to Cloudflare button')
    const { kit } = appWith({
      'wrangler.jsonc': `{
        "name": "notes", "main": "src/worker.ts", "account_id": "0123456789abcdef",
        "assets": { "directory": "dist" },
        "vars": { "MAIL_DOMAINS": "", "MODE": "live" },
        "d1_databases": [{ "binding": "DB", "database_name": "notes", "database_id": "11111111-2222", "migrations_dir": "migrations" }],
        "kv_namespaces": [{ "binding": "CACHE", "id": "abc" }],
        "services": [{ "binding": "AUTH", "service": "auth" }]
      }`,
      'package.json': { scripts: { deploy: 'wrangler deploy' } },
      '.dev.vars.example': '# a comment\nAPI_KEYS=""\nSETUP_CODE="x"\n',
      'migrations/0000_kit.sql': '-- step\n',
    })
    const checked = kit('--check')
    expect(checked.status).toBe(1)
    for (const line of [
      'fix   wrangler.jsonc pins account_id',
      'fix   wrangler.jsonc has no compatibility_date',
      'fix   d1_databases DB sets database_id',
      'fix   kv_namespaces CACHE sets id',
      'fix   API_KEYS has no description for the deploy form',
      'fix   SETUP_CODE has no description for the deploy form',
      'fix   MAIL_DOMAINS has no description for the deploy form',
      "fix   the deploy script never applies DB's migrations",
      'fix   the app serves built files but has no build script',
      'note  services in wrangler.jsonc: the button makes none',
      '9 to fix before the button can deploy this app',
    ])
      expect(checked.stdout).toContain(line)
    // A variable with a value needs no description: the form shows it filled in
    expect(checked.stdout).not.toContain('MODE')
  })

  it('writes the button into the README, after the title or in its block, and checks the block stays current', () => {
    const { app, kit } = appWith({ ...ready(), 'README.md': '# Notes\n\nAn API for notes.\n' })
    expect(kit('--write', '--repo', 'acme/notes').stdout).toContain('README.md: the button now deploys https://github.com/acme/notes')
    const markdown = '[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acme/notes)'
    expect(readFileSync(join(app, 'README.md'), 'utf8')).toBe(`# Notes\n\n<!-- deploy-button -->\n${markdown}\n<!-- /deploy-button -->\n\nAn API for notes.\n`)
    expect(kit('--write', '--repo', 'acme/notes').stdout).toContain('README.md already has this button')
    // Moved to another repository: check says so, and write puts the block right in place
    const moved = kit('--check', '--repo', 'acme/notes-two')
    expect(moved.status).toBe(1)
    expect(moved.stdout).toContain("fix   README.md's button deploys something else")
    kit('--write', '--repo', 'acme/notes-two')
    const readme = readFileSync(join(app, 'README.md'), 'utf8')
    expect(readme.match(/deploy-button -->/g)).toHaveLength(2)
    expect(readme).toContain('?url=https://github.com/acme/notes-two)')
    expect(kit('--check', '--repo', 'acme/notes-two').status).toBe(0)
  })

  it('turns a button pasted by hand into the block, never a second button', () => {
    const pasted = '[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acme/old)'
    const { app, kit } = appWith({ ...ready(), 'README.md': `# Notes\n\nIntro.\n\n${pasted}\n\nMore.\n` })
    kit('--write', '--repo', 'acme/notes')
    const readme = readFileSync(join(app, 'README.md'), 'utf8')
    expect(readme.match(/deploy\.workers\.cloudflare\.com\/button/g)).toHaveLength(1)
    expect(readme).toContain('Intro.\n\n<!-- deploy-button -->\n[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acme/notes)\n<!-- /deploy-button -->\n\nMore.')
  })

  it('refuses an app that is not a Worker, and a smoke deploy without credentials', () => {
    const { kit } = appWith({ 'package.json': {} })
    expect(kit('--check').stdout).toContain('fix   no wrangler.jsonc')
    const smoke = appWith(ready()).kit('--smoke')
    expect(smoke.status).toBe(1)
    expect(smoke.stderr).toContain('--smoke needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID')
  })
})
