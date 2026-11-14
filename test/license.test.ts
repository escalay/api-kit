import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRoute, z } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'
import { createAgentApi, databaseProvider, defineFeatures, hashApiKey, HAL_JSON, licenseOf, parseApiKeys, problemResponses, SWITCHES_TAG, switches, testDb, verifyLicense } from '../src/index.js'

const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, '..', 'cli.mjs'), ...args], { cwd, encoding: 'utf8' })
const DAY = 86_400_000

/** A product's key pair made by `kit license keys`, and a way to mint with it, as its maker would. */
const product = () => {
  const folder = mkdtempSync(join(tmpdir(), 'license-'))
  const made = cli(folder, 'license', 'keys', '--out', 'keys')
  const publicKey = JSON.parse(made.stdout.trim().split('\n').at(-1)!)
  writeFileSync(join(folder, 'public.jwk'), JSON.stringify(publicKey))
  const mint = (...args: string[]) => cli(folder, 'license', 'mint', '--private', 'keys/license-private.jwk', '--product', 'notes', '--licensee', 'Acme', ...args).stdout.trim()
  return { folder, made, publicKey, mint }
}

describe('license keys', () => {
  it('are made by the command line and checked by the app, offline', async () => {
    const { folder, made, publicKey, mint } = product()
    expect(made.stdout).not.toContain('"d"')
    expect(statSync(join(folder, 'keys/license-private.jwk')).mode & 0o777).toBe(0o600)
    expect(cli(folder, 'license', 'keys', '--out', 'keys').stderr).toContain('already exists')

    const key = mint('--plan', 'enterprise', '--grants', 'audit-export,sso', '--days', '30')
    const state = await verifyLicense({ key, publicKey, product: 'notes' })
    expect(state).toMatchObject({ status: 'valid', why: 'Licensed to Acme (enterprise).', plan: 'enterprise', licensee: 'Acme', grants: ['enterprise', 'audit-export', 'sso'] })
    expect(Date.parse(state.expiresAt!) - Date.now()).toBeGreaterThan(29 * DAY)
    expect(cli(folder, 'license', 'verify', key, '--public', 'public.jwk', '--product', 'notes').stdout).toMatch(/^valid: licensed to Acme \(enterprise\), until .*; grants enterprise, audit-export, sso/)
  })

  it('refuses a missing, tampered, expired, foreign or misplaced key, and says which', async () => {
    const { folder, publicKey, mint } = product()
    const key = mint('--plan', 'enterprise', '--days', '1')
    const [header, payload, signature] = key.split('.')
    const richer = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), plan: 'everything' })).toString('base64url')
    const check = (given: string | undefined, more: { product?: string; instance?: string } = {}, now?: Date) => verifyLicense({ key: given, publicKey, product: more.product ?? 'notes', instance: more.instance }, now)
    expect(await check(undefined)).toMatchObject({ status: 'missing', grants: [] })
    expect(await check('not a key')).toMatchObject({ status: 'invalid' })
    expect(await check(`${header}.${richer}.${signature}`)).toMatchObject({ status: 'invalid', why: 'The license key is not signed by this product.', grants: [] })
    expect(await check(key, {}, new Date(Date.now() + 2 * DAY))).toMatchObject({ status: 'expired', grants: [] })
    expect(await check(key, { product: 'other' })).toMatchObject({ status: 'invalid', why: 'The license key is not for other.' })
    const bound = mint('--plan', 'enterprise', '--instance', 'dep-1')
    expect(await check(bound, { instance: 'dep-2' })).toMatchObject({ status: 'invalid', why: 'The license key is for another deployment.' })
    expect(await check(bound, { instance: 'dep-1' })).toMatchObject({ status: 'valid' })
    const refused = cli(folder, 'license', 'verify', key, '--public', 'public.jwk', '--product', 'other')
    expect([refused.status, refused.stdout.trim()]).toEqual([1, 'refused: for notes, not other'])
  })
})

describe('paid features', () => {
  const CATALOG = defineFeatures({
    sending: { title: 'Sending', description: 'Mail out.' },
    audit: { title: 'Audit export', description: 'Every change as a file.', requires: 'enterprise' },
    archive: { title: 'Archive', description: 'Old mail kept.', needs: ['audit'] },
  })

  const setup = async (key?: string) => {
    const { publicKey, mint } = product()
    const db = await testDb()
    const flags = switches({ catalog: CATALOG, providers: [databaseProvider(db)], license: licenseOf({ key: key === 'valid' ? mint('--plan', 'enterprise') : key, publicKey, product: 'notes', upgrade: 'https://example.com/pricing' }) })
    const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [SWITCHES_TAG, { name: 'Work', description: 'Work.' }], auth: { realm: 'sample', keys: parseApiKeys(`owner:${hashApiKey('owner-key')}`) } })
    await flags.register(app, { isOwner: () => true })
    const route = createRoute({ method: 'get', path: '/api/audit', operationId: 'runAudit', tags: ['Work'], summary: 'Audit', description: 'Runs the audit, for the tests.', responses: { 200: { content: { [HAL_JSON]: { schema: z.object({ ran: z.boolean() }).openapi('Ran', { description: 'Ran.' }) } }, description: 'Ran.' }, ...problemResponses(401) } })
    flags.gated(app, 'audit').openapi(route, (c) => c.json({ ran: true }, 200))
    const call = (path: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { authorization: 'Bearer owner-key', 'content-type': 'application/json' } })
    return { flags, call }
  }

  it('keeps a paid feature off without a license, says where to get one, and refuses to switch it on', async () => {
    const { call, flags } = await setup()
    const refused = await call('/api/audit')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({
      code: 'feature_disabled',
      reason: 'LICENSE',
      requires: 'enterprise',
      upgrade: 'https://example.com/pricing',
      detail: 'This feature is disabled. Audit export (`audit`) needs a license granting enterprise: no license key is set. A license is available at https://example.com/pricing; an owner sets it as the deployment’s license key.',
    })
    expect(await flags.stateOf()).toMatchObject({ audit: { on: false, source: 'license' }, archive: { on: false, blockedBy: ['audit'] }, sending: { on: true } })
    const switched = await call('/api/features/audit', { method: 'PATCH', body: JSON.stringify({ on: true }) })
    expect([switched.status, (await switched.json()).detail]).toEqual([409, '"audit" needs a license granting enterprise, which this deployment does not have: https://example.com/pricing.'])
    const list = await (await call('/api/features')).json()
    expect(list.license).toMatchObject({ status: 'missing', grants: [], upgrade: 'https://example.com/pricing' })
    expect(list._embedded.features.find((feature: { key: string }) => feature.key === 'audit')).toMatchObject({ requires: 'enterprise', licensed: false, on: false })
  })

  it('opens a paid feature with a valid key, and the owner’s switch still decides', async () => {
    const { call } = await setup('valid')
    expect((await call('/api/audit')).status).toBe(200)
    const list = await (await call('/api/features')).json()
    expect(list.license).toMatchObject({ status: 'valid', plan: 'enterprise', licensee: 'Acme' })
    expect(list._embedded.features.find((feature: { key: string }) => feature.key === 'audit')).toMatchObject({ licensed: true, on: true })
    await call('/api/features/audit', { method: 'PATCH', body: JSON.stringify({ on: false }) })
    expect((await call('/api/audit')).status).toBe(403)
  })

  it('refuses a requirement that is not a key-shaped name', () => {
    expect(() => defineFeatures({ a: { title: 'A', description: 'A.', requires: 'Enterprise Plan' } })).toThrow(/requires "Enterprise Plan"/)
  })
})
