import { describe, expect, it } from 'vitest'
import { exitCodeOf, looksPrivate, publisherLine, publishersOf, render, repoOf, tarballLines, treeLines, versionLines } from '../scripts/release-check.mjs'

describe('the release check', () => {
  it('calls env files, keys and npm credentials private, and nothing else', () => {
    for (const path of ['.env', 'config/.env.production', 'certs/server.pem', 'id_rsa', 'keys/id_rsa.pub', '.npmrc', 'packages/a/.npmrc']) expect(looksPrivate(path), path).toBe(true)
    for (const path of ['.env.example', 'src/env.ts', 'docs/environment.md', 'src/pem.ts', 'README.md', 'templates/app/dev.vars.example']) expect(looksPrivate(path), path).toBe(false)
  })

  it('reads owner/repo from every way a GitHub repository is written', () => {
    expect(repoOf({ type: 'git', url: 'git+https://github.com/escalay/api-kit.git' })).toBe('escalay/api-kit')
    expect(repoOf('git@github.com:escalay/api-kit.git')).toBe('escalay/api-kit')
    expect(repoOf('https://github.com/escalay/api-kit')).toBe('escalay/api-kit')
    expect(repoOf('https://gitlab.com/escalay/api-kit.git')).toBe(null)
    expect(repoOf(undefined)).toBe(null)
  })

  it('wants a clean tree on main, and says how to get there', () => {
    expect(treeLines('', 'main').map((line) => line.mark)).toEqual(['✓', '✓'])
    const [dirty, branch] = treeLines(' M cli.mjs\n?? notes.md\n', 'feat/x')
    expect(dirty).toMatchObject({ mark: '✗', text: '2 uncommitted change(s)' })
    expect(branch).toMatchObject({ mark: '✗', text: 'on feat/x, not main', fix: expect.stringContaining('git switch main') })
    expect(treeLines(null, '')[0]).toEqual({ mark: '?', text: 'could not check the tree: not a git repository' })
  })

  it('wants every public package at the manifest version', () => {
    const packages = [{ name: 'a', version: '1.2.0' }, { name: 'create-a', version: '1.1.0' }]
    const [same, behind] = versionLines(packages, '1.2.0')
    expect(same.mark).toBe('✓')
    expect(behind).toMatchObject({ mark: '✗', text: 'create-a is at 1.1.0, .release-please-manifest.json says 1.2.0', fix: expect.stringContaining('extra-files') })
    expect(versionLines(packages, undefined)).toEqual([expect.objectContaining({ mark: '✗' })])
  })

  it('reports what a tarball holds and every private path in it', () => {
    const packed = { size: 2048, unpackedSize: 5 * 1024 ** 2, files: [{ path: 'index.js' }, { path: '.env' }, { path: 'deploy/key.pem' }] }
    const lines = tarballLines('a', packed)
    expect(lines[0]).toEqual({ mark: '✓', text: 'a packs 3 files, 2.0 kB (5.0 MB unpacked)' })
    expect(lines.slice(1).map((line) => [line.mark, line.text])).toEqual([['✗', 'a would publish .env'], ['✗', 'a would publish deploy/key.pem']])
  })

  it('finds this repo’s release workflow among the trusted publishers', () => {
    const publisher = { id: '1', type: 'github', file: 'release.yml', repository: 'escalay/api-kit', environment: 'npm' }
    // npm prints one object per publisher, one after another
    const printed = `${JSON.stringify(publisher, null, 2)}\n${JSON.stringify({ ...publisher, id: '2', repository: 'escalay/other' }, null, 2)}\n`
    expect(publishersOf(printed)).toHaveLength(2)
    expect(publishersOf(JSON.stringify([publisher]))).toEqual([publisher])
    expect(publishersOf('')).toEqual([])
    expect(() => publishersOf(JSON.stringify({ error: { code: 'EOTP', summary: 'This operation requires a one-time password.' } }))).toThrow('one-time password')
    expect(publisherLine('a', publishersOf(printed), 'Escalay/api-kit')).toEqual({ mark: '✓', text: 'a trusts Escalay/api-kit release.yml (environment npm)' })
    expect(publisherLine('a', [{ ...publisher, file: 'publish.yml' }], 'escalay/api-kit')).toMatchObject({
      mark: '✗',
      text: 'a has no trusted publisher for escalay/api-kit release.yml (it trusts escalay/api-kit publish.yml)',
      fix: '`npm trust github a --file release.yml --repo escalay/api-kit --env npm --allow-publish`',
    })
    expect(publisherLine('a', [{ ...publisher, file: '.github/workflows/release.yml' }], 'escalay/api-kit').mark).toBe('✓')
    expect(publisherLine('a', [], 'escalay/api-kit').text).toBe('a has no trusted publisher for escalay/api-kit release.yml')
  })

  it('exits 1 only when something needs fixing, never for what it could not check', () => {
    expect(exitCodeOf([{ mark: '✓', text: 'fine' }, { mark: '?', text: 'could not check' }])).toBe(0)
    expect(exitCodeOf([{ mark: '✓', text: 'fine' }, { mark: '✗', text: 'broken', fix: 'mend it' }])).toBe(1)
    expect(render({ mark: '✗', text: 'broken', fix: 'mend it' })).toBe('✗ broken\n  fix: mend it')
    expect(render({ mark: '✓', text: 'fine' })).toBe('✓ fine')
  })
})
