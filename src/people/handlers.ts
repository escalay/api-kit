/** The people routes' handlers: passkeys through @simplewebauthn/server, sessions as cookies, the team in the repo. */
import type { RouteHandler } from '@hono/zod-openapi'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import type { Context } from 'hono'
import { hashApiKey, type Caller } from '../core/auth.js'
import { linksOf, originOf } from '../core/hal.js'
import { newId } from '../core/ids.js'
import { ProblemError } from '../core/problem.js'
import type { Db } from '../db/index.js'
import type { PeopleRepo } from './repo.js'
import type { PeopleRoutes } from './routes.js'
import type { PersonRow } from './schema.js'
import { distinctName, passkeyBaseName } from './names.js'
import { endSession, enrolmentPurposeOf, isAdmin, personOf, startSession, tellApp, type EnrolmentPurpose, type RecoveryListener } from './session.js'

const NO_STORE = { 'cache-control': 'no-store' }
const CHALLENGE_MINUTES = 5
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

/**
 * One change to the team, for the app's log: `who` is an email, or `@domain` for everyone there; `from` and `to` are the
 * role before and after, null when not on the team. @example { who: 'ana@example.com', from: null, to: 'member', by: 'owner@example.com' }
 */
export type TeamChange = {
  who: string
  from: 'owner' | 'member' | null
  to: 'owner' | 'member' | null
  by: string
  /** For a person just added: whether to let them know (an invite, if the app sends one); false when the caller said not to. */
  notify?: boolean
}

/**
 * One passkey added or removed, for the app's log and any alert: `who` is the email it belongs to, `name` the one it
 * shows (the device and browser it was made in, unless its person named it), `by` who did it. For a passkey added,
 * `via` says how its maker got in: signed in, or with an enrolment from claiming or recovering the deployment.
 * @example { action: 'added', who: 'owner@example.com', id: 'cred-1', name: 'iPhone · Safari', by: 'owner@example.com', via: 'session' }
 */
export type PasskeyChange = {
  action: 'added' | 'removed'
  who: string
  id: string
  name: string
  by: string
  via?: 'session' | EnrolmentPurpose
}

export type PeopleConfig = {
  db: Db
  rpName: string
  sessionPath: string
  teamPath: string
  cookie: string
  fixedKeys: string[]
  onTeamChange?: (change: TeamChange, c: Context) => void | Promise<void>
  onPasskeyChange?: (change: PasskeyChange, c: Context) => void | Promise<void>
  /** Told when a recovery's enrolment made its passkey (`setup` listens through `recoveryListeners`). */
  onRecovered?: () => RecoveryListener | undefined
}

export const peopleHandlers = (repo: PeopleRepo, { db, rpName, sessionPath, teamPath, cookie, fixedKeys, onTeamChange, onPasskeyChange, onRecovered }: PeopleConfig) => {
  /** The host a passkey is made for and used on: the page's own (`rpID`), and the origin the browser reports. */
  const hostOf = (c: Context) => {
    const origin = originOf(c)
    return { origin, rpID: new URL(origin).hostname }
  }
  const sessionBody = async (c: Context, person: PersonRow | null) => ({
    signedIn: Boolean(person),
    person,
    passkeys: person ? (await repo.passkeysOf(person.id)).length : 0,
    _links: linksOf(originOf(c), { self: sessionPath, team: teamPath }),
  })
  const callerOf = (c: Context) => c.get('caller' as never) as Caller | undefined
  const adminOnly = (c: Context) => {
    if (!isAdmin(callerOf(c), fixedKeys)) throw new ProblemError('forbidden', { detail: 'Only the owner (or a key from API_KEYS) can change the team.' })
    const caller = callerOf(c)!
    return caller.kind === 'person' ? caller.email : caller.name
  }
  const teamBody = async (c: Context) => ({ people: await repo.list(), domains: await repo.domains(), _links: linksOf(originOf(c), { self: teamPath }) })

  const session: RouteHandler<PeopleRoutes['session']> = async (c) => {
    const person = await personOf(c, db, cookie)
    if (person) await repo.seen(person.id)
    return c.json(await sessionBody(c, person), 200, NO_STORE)
  }
  const signOut: RouteHandler<PeopleRoutes['signOut']> = async (c) => {
    await endSession(c, db, cookie)
    return c.body(null, 204)
  }

  const registerOptions: RouteHandler<PeopleRoutes['registerOptions']> = async (c) => {
    const { enrolment } = c.req.valid('json')
    const signedIn = await personOf(c, db, cookie)
    const enrolled = enrolment ? await repo.peekChallenge(hashApiKey(enrolment), 'enrol') : undefined
    // An enrolment names its person, signed in or not; without one, the passkey is for whoever is signed in
    const person = (enrolled?.personId ? await repo.get(enrolled.personId) : undefined) ?? signedIn
    if (!person) throw new ProblemError('unauthorized', { detail: enrolment ? 'This enrolment has expired or was used: claim or recover again on /setup.' : 'Sign in first, or start from /setup with an enrolment.' })
    const { rpID } = hostOf(c)
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: person.email,
      // What a password manager titles the saved passkey with
      userDisplayName: person.name ?? person.email,
      userID: new TextEncoder().encode(person.id),
      attestationType: 'none',
      excludeCredentials: (await repo.passkeysOf(person.id)).filter((key) => key.rpId === rpID).map((key) => ({ id: key.id, transports: key.transports as never })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      supportedAlgorithmIDs: [-7, -257],
    })
    const challengeId = newId('wch')
    await repo.addChallenge({ id: challengeId, kind: 'register', challenge: options.challenge, personId: person.id, expiresAt: inMinutes(CHALLENGE_MINUTES) })
    return c.json({ challengeId, options: options as unknown as Record<string, unknown> }, 200, NO_STORE)
  }

  const registerVerify: RouteHandler<PeopleRoutes['registerVerify']> = async (c) => {
    const { challengeId, response, enrolment, name: asked } = c.req.valid('json')
    const challenge = await repo.takeChallenge(challengeId, 'register')
    if (!challenge?.personId) throw new ProblemError('bad_request', { detail: 'This challenge expired or was used: ask for new options.' })
    const signedIn = (await personOf(c, db, cookie))?.id === challenge.personId
    // A valid enrolment for this person is the proof, and is used, whether or not they are signed in too: a recovery
    // made in a browser that still holds a session completes like any other. It is used up only once a passkey is
    // made, so a failed try can be retried
    const enrolled = enrolment ? await repo.peekChallenge(hashApiKey(enrolment), 'enrol') : undefined
    const byEnrolment = enrolled?.personId === challenge.personId
    if (!signedIn && !byEnrolment) throw new ProblemError('unauthorized', { detail: 'Sign in first, or start from /setup with an enrolment.' })
    const { origin, rpID } = hostOf(c)
    const verified = await verifyRegistrationResponse({ response: response as never, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false }).catch((error: Error) => {
      throw new ProblemError('bad_request', { detail: `The passkey could not be checked: ${error.message}` })
    })
    if (!verified.verified || !verified.registrationInfo) throw new ProblemError('bad_request', { detail: 'The passkey could not be checked.' })
    const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo
    const taken = byEnrolment ? await repo.takeChallenge(hashApiKey(enrolment!), 'enrol') : undefined
    const usedEnrolment = taken?.personId === challenge.personId
    if (!signedIn && !usedEnrolment) throw new ProblemError('unauthorized', { detail: 'This enrolment was just used: sign in with the passkey it made.' })
    // The device and browser unless the person chose a name; numbered so two never read the same
    const name = distinctName(passkeyBaseName(asked, c.req.header('user-agent')), (await repo.passkeysOf(challenge.personId)).map((passkey) => passkey.name))
    await repo.addPasskey({
      id: credential.id,
      personId: challenge.personId,
      publicKey: b64url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      rpId: rpID,
      name,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    })
    await startSession(c, db, challenge.personId, cookie)
    const person = (await repo.get(challenge.personId)) ?? null
    // Told once the passkey and the session exist, and a hook that throws is only logged: the passkey stays made
    if (person) {
      const via = usedEnrolment ? enrolmentPurposeOf(taken!) : 'session'
      await tellApp('onPasskeyChange', () => onPasskeyChange?.({ action: 'added', who: person.email, id: credential.id, name, by: person.email, via }, c))
      if (via === 'recovery') await tellApp('onRecovery', () => onRecovered?.()?.({ who: person.email, passkey: { id: credential.id, name } }, c))
    }
    return c.json(await sessionBody(c, person), 200, NO_STORE)
  }

  const loginOptions: RouteHandler<PeopleRoutes['loginOptions']> = async (c) => {
    const { rpID } = hostOf(c)
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred', allowCredentials: [] })
    const challengeId = newId('wch')
    await repo.addChallenge({ id: challengeId, kind: 'login', challenge: options.challenge, personId: null, expiresAt: inMinutes(CHALLENGE_MINUTES) })
    return c.json({ challengeId, options: options as unknown as Record<string, unknown> }, 200, NO_STORE)
  }

  const loginVerify: RouteHandler<PeopleRoutes['loginVerify']> = async (c) => {
    const { challengeId, response } = c.req.valid('json')
    const challenge = await repo.takeChallenge(challengeId, 'login')
    if (!challenge) throw new ProblemError('bad_request', { detail: 'This challenge expired or was used: ask for new options.' })
    const passkey = typeof response.id === 'string' ? await repo.passkey(response.id) : undefined
    const refused = new ProblemError('unauthorized', { detail: 'This passkey is not known here. It works only on the host it was made on; recover on /setup if you lost access.' })
    if (!passkey) throw refused
    const { origin, rpID } = hostOf(c)
    const verified = await verifyAuthenticationResponse({
      response: response as never,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: { id: passkey.id, publicKey: fromB64url(passkey.publicKey), counter: passkey.counter, transports: passkey.transports as never },
      requireUserVerification: false,
    }).catch(() => {
      throw refused
    })
    if (!verified.verified) throw refused
    await repo.usedPasskey(passkey.id, verified.authenticationInfo.newCounter)
    await startSession(c, db, passkey.personId, cookie)
    await repo.seen(passkey.personId)
    return c.json(await sessionBody(c, (await repo.get(passkey.personId)) ?? null), 200, NO_STORE)
  }

  const meOf = async (c: Context) => {
    const caller = callerOf(c)
    const person = caller?.kind === 'person' ? await repo.byEmail(caller.email) : undefined
    if (!person) throw new ProblemError('forbidden', { detail: 'Passkeys belong to a person: sign in in a browser.' })
    return person
  }
  const passkeys: RouteHandler<PeopleRoutes['passkeys']> = async (c) => {
    const person = await meOf(c)
    const rows = (await repo.passkeysOf(person.id)).map(({ publicKey: _key, counter: _counter, transports: _transports, personId: _person, ...row }) => row)
    return c.json({ _embedded: { passkeys: rows }, _links: linksOf(originOf(c), { self: `${sessionPath}/passkeys` }) }, 200, NO_STORE)
  }
  const removePasskey: RouteHandler<PeopleRoutes['removePasskey']> = async (c) => {
    const person = await meOf(c)
    const { id } = c.req.valid('param')
    const own = await repo.passkeysOf(person.id)
    if (!own.some((key) => key.id === id)) throw new ProblemError('not_found', { detail: `No passkey ${id} of yours. GET ${sessionPath}/passkeys lists them.` })
    if (own.length === 1 && person.role === 'owner') throw new ProblemError('conflict', { detail: 'This is your last passkey: add another first, or you can only get back in by recovering on /setup.' })
    await repo.removePasskey(id)
    await tellApp('onPasskeyChange', () => onPasskeyChange?.({ action: 'removed', who: person.email, id, name: own.find((key) => key.id === id)?.name ?? '', by: person.email }, c))
    return c.body(null, 204)
  }

  const team: RouteHandler<PeopleRoutes['team']> = async (c) => c.json(await teamBody(c), 200, NO_STORE)
  const addToTeam: RouteHandler<PeopleRoutes['addToTeam']> = async (c) => {
    const by = adminOnly(c)
    const { email, domain, role, name, notify } = c.req.valid('json')
    if (!email === !domain) throw new ProblemError('bad_request', { detail: 'Send either an email or a domain.' })
    if (domain && !(await repo.hasDomain(domain))) {
      await repo.addDomain(domain, by)
      await onTeamChange?.({ who: `@${domain}`, from: null, to: 'member', by }, c)
    }
    if (email) {
      if (await repo.byEmail(email)) throw new ProblemError('conflict', { detail: `${email} is already on the team: change their role instead.` })
      await repo.add({ id: newId('prs'), email, role: role ?? 'member', name: name ?? null, createdAt: new Date().toISOString(), lastSeenAt: null })
      await onTeamChange?.({ who: email, from: null, to: role ?? 'member', by, notify: notify ?? true }, c)
    }
    return c.json(await teamBody(c), 201, NO_STORE)
  }
  const personFor = async (id: string) => {
    const person = await repo.get(id)
    if (!person) throw new ProblemError('not_found', { detail: `No person ${id} on the team. GET ${teamPath} lists them.` })
    return person
  }
  const lastOwner = async (person: PersonRow) => person.role === 'owner' && (await repo.owners()) === 1
  const changeRole: RouteHandler<PeopleRoutes['changeRole']> = async (c) => {
    const by = adminOnly(c)
    const person = await personFor(c.req.valid('param').id)
    const { role } = c.req.valid('json')
    if (role === 'member' && (await lastOwner(person))) throw new ProblemError('conflict', { detail: 'This is the last owner: make someone else an owner first.' })
    await repo.setRole(person.id, role)
    if (person.role !== role) await onTeamChange?.({ who: person.email, from: person.role, to: role, by }, c)
    return c.json((await repo.get(person.id))!, 200, NO_STORE)
  }
  const removeFromTeam: RouteHandler<PeopleRoutes['removeFromTeam']> = async (c) => {
    const by = adminOnly(c)
    const person = await personFor(c.req.valid('param').id)
    if (await lastOwner(person)) throw new ProblemError('conflict', { detail: 'This is the last owner: make someone else an owner first.' })
    await repo.remove(person.id)
    await onTeamChange?.({ who: person.email, from: person.role, to: null, by }, c)
    return c.body(null, 204)
  }
  const removeDomain: RouteHandler<PeopleRoutes['removeDomain']> = async (c) => {
    const by = adminOnly(c)
    const { domain } = c.req.valid('param')
    if (!(await repo.hasDomain(domain))) throw new ProblemError('not_found', { detail: `${domain} is not on the team. GET ${teamPath} lists the domains.` })
    await repo.removeDomain(domain)
    await onTeamChange?.({ who: `@${domain}`, from: 'member', to: null, by }, c)
    return c.body(null, 204)
  }

  return { session, signOut, registerOptions, registerVerify, loginOptions, loginVerify, passkeys, removePasskey, team, addToTeam, changeRole, removeFromTeam, removeDomain }
}
