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
import { endSession, isAdmin, personOf, startSession } from './session.js'

const NO_STORE = { 'cache-control': 'no-store' }
const CHALLENGE_MINUTES = 5
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

export type PeopleConfig = { db: Db; rpName: string; sessionPath: string; teamPath: string; cookie: string; fixedKeys: string[] }

export const peopleHandlers = (repo: PeopleRepo, { db, rpName, sessionPath, teamPath, cookie, fixedKeys }: PeopleConfig) => {
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
    const person = signedIn ?? (enrolled?.personId ? await repo.get(enrolled.personId) : undefined)
    if (!person) throw new ProblemError('unauthorized', { detail: enrolment ? 'This enrolment has expired or was used: claim or recover again on /setup.' : 'Sign in first, or start from /setup with an enrolment.' })
    const { rpID } = hostOf(c)
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: person.email,
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
    const { challengeId, response, enrolment, name } = c.req.valid('json')
    const challenge = await repo.takeChallenge(challengeId, 'register')
    if (!challenge?.personId) throw new ProblemError('bad_request', { detail: 'This challenge expired or was used: ask for new options.' })
    const signedIn = await personOf(c, db, cookie)
    // Not signed in: the enrolment is the proof. It is used up only once a passkey is made, so a failed try can be retried
    const byEnrolment = signedIn?.id !== challenge.personId
    if (byEnrolment) {
      const enrolled = enrolment ? await repo.peekChallenge(hashApiKey(enrolment), 'enrol') : undefined
      if (enrolled?.personId !== challenge.personId) throw new ProblemError('unauthorized', { detail: 'Sign in first, or start from /setup with an enrolment.' })
    }
    const { origin, rpID } = hostOf(c)
    const verified = await verifyRegistrationResponse({ response: response as never, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false }).catch((error: Error) => {
      throw new ProblemError('bad_request', { detail: `The passkey could not be checked: ${error.message}` })
    })
    if (!verified.verified || !verified.registrationInfo) throw new ProblemError('bad_request', { detail: 'The passkey could not be checked.' })
    const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo
    if (byEnrolment && (await repo.takeChallenge(hashApiKey(enrolment!), 'enrol'))?.personId !== challenge.personId)
      throw new ProblemError('unauthorized', { detail: 'This enrolment was just used: sign in with the passkey it made.' })
    await repo.addPasskey({
      id: credential.id,
      personId: challenge.personId,
      publicKey: b64url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      rpId: rpID,
      name: name ?? null,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    })
    await startSession(c, db, challenge.personId, cookie)
    return c.json(await sessionBody(c, (await repo.get(challenge.personId)) ?? null), 200, NO_STORE)
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
    return c.body(null, 204)
  }

  const team: RouteHandler<PeopleRoutes['team']> = async (c) => c.json(await teamBody(c), 200, NO_STORE)
  const addToTeam: RouteHandler<PeopleRoutes['addToTeam']> = async (c) => {
    const by = adminOnly(c)
    const { email, domain, role, name } = c.req.valid('json')
    if (!email === !domain) throw new ProblemError('bad_request', { detail: 'Send either an email or a domain.' })
    if (domain) await repo.addDomain(domain, by)
    if (email) {
      if (await repo.byEmail(email)) throw new ProblemError('conflict', { detail: `${email} is already on the team: change their role instead.` })
      await repo.add({ id: newId('prs'), email, role: role ?? 'member', name: name ?? null, createdAt: new Date().toISOString(), lastSeenAt: null })
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
    adminOnly(c)
    const person = await personFor(c.req.valid('param').id)
    const { role } = c.req.valid('json')
    if (role === 'member' && (await lastOwner(person))) throw new ProblemError('conflict', { detail: 'This is the last owner: make someone else an owner first.' })
    await repo.setRole(person.id, role)
    return c.json((await repo.get(person.id))!, 200, NO_STORE)
  }
  const removeFromTeam: RouteHandler<PeopleRoutes['removeFromTeam']> = async (c) => {
    adminOnly(c)
    const person = await personFor(c.req.valid('param').id)
    if (await lastOwner(person)) throw new ProblemError('conflict', { detail: 'This is the last owner: make someone else an owner first.' })
    await repo.remove(person.id)
    return c.body(null, 204)
  }
  const removeDomain: RouteHandler<PeopleRoutes['removeDomain']> = async (c) => {
    adminOnly(c)
    const { domain } = c.req.valid('param')
    if (!(await repo.hasDomain(domain))) throw new ProblemError('not_found', { detail: `${domain} is not on the team. GET ${teamPath} lists the domains.` })
    await repo.removeDomain(domain)
    return c.body(null, 204)
  }

  return { session, signOut, registerOptions, registerVerify, loginOptions, loginVerify, passkeys, removePasskey, team, addToTeam, changeRole, removeFromTeam, removeDomain }
}
