// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createFeaturesClient, isFeatureDisabled, whyOff, type FeatureDisabledProblem } from '../src/browser/switches-client.js'
import { FeatureDisabledNotice, FeatureSwitches } from '../src/browser/switches-block.js'
import { Feature, featureHooks, FeaturesProvider, useFeature, useFeatureDisabled } from '../src/browser/switches-react.js'
import { createAgentApi, databaseProvider, defineFeatures, hashApiKey, parseApiKeys, SWITCHES_TAG, switches, testDb } from '../src/index.js'

const CATALOG = defineFeatures({
  sending: { title: 'Sending', description: 'Mail out from the app.' },
  digest: { title: 'Daily digest', description: 'One mail a day.', needs: ['sending'] },
  beta: { title: 'Beta', description: 'Something new.', default: false },
})
type Key = keyof typeof CATALOG

/** A real switches API in-process, and a browser fetch that carries one key's sign-in. */
const server = async () => {
  const db = await testDb()
  const flags = switches({ catalog: CATALOG, providers: [databaseProvider(db, { cacheMs: 0 })] })
  const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [SWITCHES_TAG], auth: { realm: 'sample', keys: parseApiKeys(`owner:${hashApiKey('owner-key')},member:${hashApiKey('member-key')}`) } })
  await flags.register(app, { isOwner: (c) => (c.get('caller' as never) as { name?: string }).name === 'owner' })
  flags.gated(app, 'digest').get('/api/digest', (c) => c.json({ digest: true }))
  const calls: string[] = []
  const fetchAs = (key: string): typeof fetch => async (input, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`)
    return app.request(String(input), { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${key}` } })
  }
  return { flags, calls, owner: fetchAs('owner-key'), member: fetchAs('member-key') }
}

const providerFor = (client: ReturnType<typeof createFeaturesClient<Key>>) => ({ children }: { children: ReactNode }) => <FeaturesProvider client={client}>{children}</FeaturesProvider>

afterEach(cleanup)

describe('the features client', () => {
  it('loads the list, says why a feature is off, and notices a 403 met elsewhere', async () => {
    const { owner, calls } = await server()
    const features = createFeaturesClient<Key>({ fetch: owner, refreshOnFocus: false })
    expect(features.isOn('digest')).toBeUndefined()
    await features.refresh()
    expect([features.isOn('sending'), features.isOn('digest'), features.isOn('beta')]).toEqual([true, true, false])
    const preview = await features.switch('sending', { on: false }, { dryRun: true })
    expect(preview.changes.map((change) => change.key)).toEqual(['sending', 'digest'])
    expect(features.isOn('digest')).toBe(true)
    await features.switch('sending', { on: false })
    expect(features.isOn('digest')).toBe(false)
    expect(whyOff(features.getState().features.digest, features.getState().features)).toBe('Daily digest needs Sending, which is off for everyone.')

    const heard: FeatureDisabledProblem[] = []
    features.onDisabled((problem) => heard.push(problem))
    const api = features.watchFetch(owner)
    const before = calls.length
    const answer = await api('/api/digest')
    expect(answer.status).toBe(403)
    await waitFor(() => expect(heard.map((problem) => problem.feature)).toEqual(['digest']))
    expect(isFeatureDisabled(heard[0])).toBe(true)
    // The 403 made it read the list again
    await waitFor(() => expect(calls.slice(before)).toContain('GET /api/features'))
    features.dispose()
  })

  it('keeps the last good list when a refresh fails, and says why', async () => {
    const { owner } = await server()
    let down = false
    const features = createFeaturesClient<Key>({ fetch: (input, init) => (down ? Promise.reject(new Error('offline')) : owner(input, init)), refreshOnFocus: false })
    await features.refresh()
    down = true
    await features.refresh()
    expect(features.getState()).toMatchObject({ status: 'ready', error: { code: 'network' } })
    expect(features.isOn('sending')).toBe(true)
  })
})

describe('the React side', () => {
  it('shows a feature’s screen only while it is on, and its notice once off', async () => {
    const { owner } = await server()
    const features = createFeaturesClient<Key>({ fetch: owner, refreshOnFocus: false })
    render(
      <FeaturesProvider client={features}>
        <Feature name="digest" loading={<p>Loading</p>} off={<FeatureDisabledNotice name="digest" action={<button>Ask the owner</button>} />}>
          <p>The digest</p>
        </Feature>
      </FeaturesProvider>,
    )
    expect(screen.getByText('Loading')).toBeTruthy()
    expect(await screen.findByText('The digest')).toBeTruthy()
    await act(() => features.switch('sending', { on: false }))
    expect(await screen.findByText('This feature is disabled.')).toBeTruthy()
    expect(screen.getByText('Daily digest needs Sending, which is off for everyone.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ask the owner' })).toBeTruthy()
  })

  it('types the hooks by the app’s keys and hears every 403', async () => {
    const { owner } = await server()
    const features = createFeaturesClient<Key>({ fetch: owner, refreshOnFocus: false })
    const typed = featureHooks<Key>()
    const heard: string[] = []
    const { result } = renderHook(
      () => {
        useFeatureDisabled((problem) => heard.push(problem.feature))
        return { beta: typed.useFeature('beta'), sending: useFeature<Key>('sending') }
      },
      { wrapper: providerFor(features) },
    )
    await waitFor(() => expect(result.current.sending.ready).toBe(true))
    expect([result.current.sending.on, result.current.beta.on, result.current.beta.why]).toEqual([true, false, 'Beta is off unless switched on.'])
    await act(() => features.switch('sending', { on: false }))
    await features.watchFetch(owner)('/api/digest')
    await waitFor(() => expect(heard).toEqual(['digest']))
  })

  it('lets an owner switch a feature off after saying what else stops, and a member only look', async () => {
    const { owner, member } = await server()
    const features = createFeaturesClient<Key>({ fetch: owner, refreshOnFocus: false })
    render(
      <FeaturesProvider client={features}>
        <FeatureSwitches canSwitch />
      </FeaturesProvider>,
    )
    fireEvent.click(await screen.findByRole('switch', { name: 'Sending: on' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Switching off Sending also stops Daily digest.Keep it onSwitch off')
    expect(features.isOn('sending')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Switch off' }))
    await waitFor(() => expect(features.isOn('sending')).toBe(false))
    expect(await screen.findByText('Needs Sending')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Beta: off' }))
    await waitFor(() => expect(features.isOn('beta')).toBe(true))
    cleanup()

    const looking = createFeaturesClient<Key>({ fetch: member, refreshOnFocus: false })
    render(
      <FeaturesProvider client={looking}>
        <FeatureSwitches />
      </FeaturesProvider>,
    )
    expect(((await screen.findByRole('switch', { name: 'Sending: off' })) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Only an owner can switch features.')).toBeTruthy()
  })
})
