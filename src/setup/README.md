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
await registerPeople(app, { db, rpName: 'Mailroom', fixedKeys })
await registerSetup(app, { db, code: env.SETUP_CODE, guards: await dbGuardStore(db), fixedKeys, steps: [
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
- Attempts are limited: 5 an hour per address, 20 a day in all (429). A wrong code is 403.
- A claimed deployment answers its own code with 409. A **different** code (the secret was rotated) opens recovery
  for an existing owner's email, once: it becomes the code on record.
- Each step's check runs on every look, with a 5 second limit; a throw or a timeout shows as not ok, never as a 500.
- Standard: `docs/STANDARD.md` §7 (auth).
