# setup

Claiming a fresh deployment, getting back into it, and the checklist of what the deploy could not do by itself. The
setup code is a secret typed into the deploy form (`SETUP_CODE`); the first person to send it becomes the owner and
gets an enrolment to make their passkey (`people` part).

Needs: `people` (and through it `db`), a `GuardStore` for the attempt counts (`dbGuardStore(db)`).

| File | What |
|---|---|
| `schema.ts` | `setup_state` (one row once claimed: when, by whom, the hash of the code used) and `SETUP_MIGRATIONS` |
| `routes.ts` | `setupRoutes`: status, claim, checklist |
| `index.ts` | `registerSetup`, `SetupStep`, `SETUP_TAG`, `SETUP_OPEN_PATHS` |

## Routes

```
GET  /api/setup            claimed? code set? recovery open? (never needs a key)
POST /api/setup/claim      { code, email } → { mode: claim|recover, enrolment }
GET  /api/setup/checklist  every step, checked now (admin only)
```

## Wiring

```ts
await registerPeople(app, { db, rpName: 'Postbox', fixedKeys })
await registerSetup(app, { db, code: env.SETUP_CODE, guards: await dbGuardStore(db), fixedKeys, onRecovery: (recovery, c) => log('recovery', recovery), steps: [
  { id: 'domain', title: 'Choose the mail domain', why: 'Addresses are made on it.', minutes: 1,
    check: async () => ({ ok: domains.length > 0, detail: domains.join(', ') || 'None set.', fixUrl: '…' }) },
] })
```

Then post the enrolment to `/api/session/passkeys/register/options` and `/verify` (see `people`).

## A step for a feature that can be switched off

A step that sets up a switchable feature (sending, a model) answers `switchedOff: true` while that feature is off:
it is listed, says so, and is counted neither as done nor as left.

```ts
check: async () => ((await flags.isOn('sending')) ? checkSending() : { ok: false, detail: 'Switched off under Features.', switchedOff: true })
```

## Rules

- **Fails closed:** with no code set, every claim is refused (503, naming the secret to set).
- Attempts are limited: every attempt counts at its address, 5 an hour (429, even for the right code); wrong codes
  count in all, 20 a day (past it a wrong code is 429, not 403). A wrong code is 403. The address is read from the
  source the app names with `createAgentApi({ address })` (`addressOf`, core README); without one, as sent.
- **The right code always gets through the day's count**: only wrong codes fill it, so nobody can spend it and lock
  the owner out of claiming (through 1.29.0 every attempt counted, and 20 junk posts did). The threat that leaves: a
  guesser spread over many addresses is held back only by the per-address limit and the code's length, so the code
  is long and random (the deploy form's is). What can still refuse the right code is its own address's 5 an hour:
  where every caller shares one address (no named source, so the `local` bucket), anyone can fill it, so name the
  source (`address: { header: 'cf-connecting-ip' }` behind Cloudflare).
- A claimed deployment answers its own code with 409. A **different** code (the secret was rotated) opens recovery
  for an existing owner's email, once: it becomes the code on record.
- `onRecovery` hears an owner getting back in, in two stages (`{ stage, who, passkey }`): `started` when a rotated code
  is accepted for their email, `completed` when the enrolment it gave makes a passkey (named). Log both, and alert the
  owner on `started`: only someone holding the deployment's secrets can start one, and it may not be them. A hook
  that throws is logged, never answered: the rotated code is spent by then, so the owner still gets the enrolment.
  Why one hook named after the act: recovery is the word this part already uses (`recovery` in the status, `mode:
  recover`), and one hook with a `stage` keeps a started recovery and its end in one place, as `onKeyChange` does with
  its `action`. A recovery is not a change of state the app could ask for later, so it is not `onRecoveryChange`; and
  claiming is not covered, since the first owner is the one who reads the log.
- Each step's check runs on every look, with a 5 second limit; a throw or a timeout shows as not ok, never as a 500.
- Standard: `docs/STANDARD.md` §7 (auth).
