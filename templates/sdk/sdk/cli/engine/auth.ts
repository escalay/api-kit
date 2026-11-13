/**
 * Sign-in: profiles per deployment in the user's config folder (file mode 0600), the device code flow (RFC 8628)
 * against the kit's OAuth server, and tokens that refresh themselves. `<PREFIX>_URL`, `<PREFIX>_API_KEY` and
 * `<PREFIX>_PROFILE` override the file, for CI and agents without a browser.
 */
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import { CliError, EXIT } from './mcp.js'

export type Profile = { url: string; apiKey?: string; clientId?: string; accessToken?: string; refreshToken?: string; expiresAt?: number }
export type Profiles = { current?: string; profiles: Record<string, Profile> }

/** Where the app keeps its profiles: `$XDG_CONFIG_HOME/<app>`, `%APPDATA%\<app>` on Windows, else `~/.config/<app>`. */
export const configDirOf = (app: string, env: Record<string, string | undefined>, platform = process.platform) =>
  env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, app) : platform === 'win32' && env.APPDATA ? join(env.APPDATA, app) : join(homedir(), '.config', app)

/** A profile's default name: the deployment's host. */
export const profileNameOf = (url: string) => new URL(url).host

export const profileStore = (dir: string) => {
  const file = join(dir, 'profiles.json')
  const lock = join(dir, 'profiles.lock')
  const read = (): Profiles => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Profiles
    } catch {
      return { profiles: {} }
    }
  }
  const write = (profiles: Profiles) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(file, `${JSON.stringify(profiles, null, 2)}\n`, { mode: 0o600 })
    // The mode only applies when the file is made; keep it 0600 when it already was there
    chmodSync(file, 0o600)
  }
  /** Runs `work` holding the lock, so two processes never send the same refresh token (that revokes the sign-in). */
  const locked = async <T>(work: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (let tries = 0; ; tries++) {
      try {
        closeSync(openSync(lock, 'wx'))
        break
      } catch {
        // A lock older than half a minute was left by a process that died
        if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true })
        else if (tries > 100) throw new CliError(`Another process holds ${lock}; delete it if none is running`, EXIT.signIn)
        else await sleep(100)
      }
    }
    try {
      return await work()
    } finally {
      rmSync(lock, { force: true })
    }
  }
  return { file, read, write, locked }
}

export type ProfileStore = ReturnType<typeof profileStore>

type Metadata = { token_endpoint: string; registration_endpoint?: string; device_authorization_endpoint?: string; revocation_endpoint?: string }
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

const form = (fields: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(fields).toString() })

/** What to run to sign in to `url` again, as a command: `mailroom auth login https://mail.example.com`. */
const loginAgain = (app: string, url: string) => `run \`${app} auth login ${url}\` again`

export const metadataOf = async (url: string, send: typeof fetch, app: string): Promise<Metadata> => {
  const response = await send(`${url}/.well-known/oauth-authorization-server`, { headers: { accept: 'application/json' } }).catch(() => null)
  if (!response?.ok) throw new CliError(`${url} offers no OAuth sign-in (no /.well-known/oauth-authorization-server): sign in with a key instead, \`${app} auth login ${url} --with-token\` with the key on stdin`, EXIT.signIn)
  return (await response.json()) as Metadata
}

type Tokens = { access_token: string; refresh_token?: string; expires_in?: number }
const withTokens = (profile: Profile, tokens: Tokens, now: number): Profile => ({ ...profile, accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? profile.refreshToken, expiresAt: now + (tokens.expires_in ?? 3600) * 1000 })

/**
 * The device code flow: registers this CLI as a public client, asks for a code, shows it on stderr, and polls until
 * the owner approves it (or says no, or the code expires).
 */
export const deviceLogin = async ({ url, app, send, tell, sleep, signal, now }: { url: string; app: string; send: typeof fetch; tell: (text: string) => void; sleep: (ms: number) => Promise<void>; signal: AbortSignal; now: () => number }): Promise<Profile> => {
  const metadata = await metadataOf(url, send, app)
  if (!metadata.device_authorization_endpoint || !metadata.registration_endpoint) throw new CliError(`${url} has no device sign-in: sign in with a key instead (\`${app} auth login ${url} --with-token\`)`, EXIT.signIn)
  const registered = await send(metadata.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ client_name: `${app} CLI on ${hostname()}`, grant_types: [DEVICE_GRANT, 'refresh_token'] }) })
  if (!registered.ok) throw new CliError(`Could not register this CLI at ${url} (${registered.status})`, EXIT.signIn)
  const { client_id: clientId } = (await registered.json()) as { client_id: string }
  const started = await send(metadata.device_authorization_endpoint, form({ client_id: clientId, scope: 'read write' }))
  if (!started.ok) throw new CliError(`Could not start the sign-in at ${url} (${started.status})`, EXIT.signIn)
  const device = (await started.json()) as { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number }
  const code = device.user_code.length === 8 ? `${device.user_code.slice(0, 4)}-${device.user_code.slice(4)}` : device.user_code
  tell(`Open ${device.verification_uri_complete ?? device.verification_uri} and check that it shows ${code}, or type the code at ${device.verification_uri}.`)
  let interval = (device.interval ?? 5) * 1000
  const until = now() + device.expires_in * 1000
  while (now() < until) {
    await sleep(interval)
    if (signal.aborted) throw signal.reason instanceof CliError ? signal.reason : new CliError('Stopped.', EXIT.interrupted)
    const polled = await send(metadata.token_endpoint, form({ grant_type: DEVICE_GRANT, device_code: device.device_code, client_id: clientId }))
    const body = (await polled.json().catch(() => ({}))) as Tokens & { error?: string; error_description?: string; interval?: number }
    if (polled.ok) return withTokens({ url, clientId }, body, now())
    if (body.error === 'authorization_pending') continue
    if (body.error === 'slow_down') {
      interval = (body.interval ?? interval / 1000 + 5) * 1000
      continue
    }
    // The server's own words name its endpoints, for raw OAuth clients; a person here needs the command instead
    if (body.error === 'access_denied') throw new CliError('The owner said no.', EXIT.signIn)
    if (body.error === 'expired_token') throw new CliError(`The code expired before it was approved: ${loginAgain(app, url)}.`, EXIT.signIn)
    if (body.error === 'invalid_grant') throw new CliError(`The server no longer knows this code: ${loginAgain(app, url)}.`, EXIT.signIn)
    throw new CliError(`Sign-in failed (${body.error ?? polled.status}): ${loginAgain(app, url)}.`, EXIT.signIn)
  }
  throw new CliError(`The code expired before it was approved: ${loginAgain(app, url)}.`, EXIT.signIn)
}

/**
 * A new access token from the profile's refresh token, under the lock. A token another process refreshed meanwhile is
 * taken as it is; `stale` is the token a server just refused, renewed even before it expires.
 */
export const refreshProfile = async ({ app, store, name, send, sleep, now, stale }: { app: string; store: ProfileStore; name: string; send: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => number; stale?: string }): Promise<Profile> =>
  store.locked(async () => {
    const profiles = store.read()
    const profile = profiles.profiles[name]
    if (!profile?.refreshToken || !profile.clientId) throw new CliError(`The sign-in for ${name} can't be renewed: ${loginAgain(app, profile?.url ?? '<url>')}`, EXIT.signIn)
    const refused = stale !== undefined && profile.accessToken === stale
    if (!refused && profile.accessToken && profile.expiresAt && profile.expiresAt - 60_000 > now()) return profile
    const metadata = await metadataOf(profile.url, send, app)
    const response = await send(metadata.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: profile.refreshToken, client_id: profile.clientId }))
    const body = (await response.json().catch(() => ({}))) as Tokens & { error?: string }
    if (!response.ok) throw new CliError(`The sign-in for ${name} has ended (${body.error ?? response.status}): ${loginAgain(app, profile.url)}`, EXIT.signIn)
    const renewed = withTokens(profile, body, now())
    store.write({ ...profiles, profiles: { ...profiles.profiles, [name]: renewed } })
    return renewed
  }, sleep)

/** Revokes a profile's refresh token, as far as the server lets it; signing out never fails on it. */
export const revokeProfile = async (profile: Profile, send: typeof fetch, app: string) => {
  if (!profile.refreshToken) return
  try {
    const metadata = await metadataOf(profile.url, send, app)
    if (metadata.revocation_endpoint) await send(metadata.revocation_endpoint, form({ token: profile.refreshToken, ...(profile.clientId ? { client_id: profile.clientId } : {}) }))
  } catch {
    // Offline or gone: the local sign-out still happens
  }
}
