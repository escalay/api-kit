# people

The owner and the members of a deployment, how each signs in, and the team. The owner signs in with a **passkey**
(made after claiming the deployment through the `setup` part); members come through **Cloudflare Access**, which
proves their email, and this part decides whether that email is on the team and with which role. A signed-in browser
holds a random token in an HttpOnly cookie; only its SHA-256 is stored.

Needs: `db`, `mcp` (for the tools), and `@simplewebauthn/server` 14 (runs on Node and workerd; the kit's workers test
proves it).

| File | What |
|---|---|
| `schema.ts` | `people`, `team_domains`, `passkeys`, `sessions`, `webauthn_challenges`, and `PEOPLE_MIGRATIONS` |
| `repo.ts` | `peopleRepo`: the only queries (people, domains, passkeys, sessions, challenges, `sweep`) |
| `session.ts` | `startSession`, `endSession`, `personOf`, `sessionOf` (for `auth.session`), `roleOf` (for `access.roleOf`), `isAdmin`, `startEnrolment` (with its purpose: `claim` or `recovery`) |
| `routes.ts` | `peopleRoutes`: the session, the passkey ceremonies, your passkeys, the team |
| `handlers.ts` | `peopleHandlers`: request → repo → HAL; the WebAuthn checks |
| `tools.ts` | `teamTools`: `list_team`, `add_to_team`, `change_team_role`, `remove_from_team` |
| `index.ts` | `registerPeople`, `PEOPLE_TAG`, `PEOPLE_OPEN_PATHS` |

## Routes

```
GET    /api/session                                   who this browser is signed in as (never needs a key)
DELETE /api/session                                   sign out
POST   /api/session/passkeys/register/options|verify  add a passkey: signed in, or with an enrolment from setup
POST   /api/session/passkeys/login/options|verify     sign in with a passkey, for 30 days
GET    /api/session/passkeys · DELETE …/{id}          your passkeys
GET    /api/team · POST · PATCH|DELETE …/people/{id} · DELETE …/domains/{domain}   the team (writes: admin only)
```

## Wiring

```ts
const fixedKeys = [...parseApiKeys(env.API_KEYS).values()]
const app = createAgentApi({ …, tags: [...tags, PEOPLE_TAG, SETUP_TAG], auth: {
  realm, keys, open: [...PEOPLE_OPEN_PATHS, ...SETUP_OPEN_PATHS], session: sessionOf(db),
  access: access && { ...access, roleOf: roleOf(db) },
} })
await registerPeople(app, { db, rpName: 'Postbox', fixedKeys, onTeamChange: (change, c) => log('team', change), onPasskeyChange: (change, c) => log('passkey', change) })
await registerSetup(app, { db, code: env.SETUP_CODE, guards: await dbGuardStore(db), fixedKeys, steps })
// MCP: tools: [...featureTools, ...teamTools()]
// The browser: @simplewebauthn/browser's startRegistration / startAuthentication with `options`, then post the answer
```

In tests, `softAuthenticator()` (testing part) answers the ceremonies the way a phone would, so the whole flow runs in
CI: claim → `register(options, origin)` → verify → `login(options, origin)` → verify.

## Rules

- Passkeys are bound to the host (`rpID` = the request's hostname). A new domain means new passkeys: recover through
  setup, or sign in through Access and add one.
- A cookie write must come from the same site (`Sec-Fetch-Site`, else `Origin`); other sites can't post through it.
- Each challenge is used once and expires in 5 minutes; an enrolment (from setup) in 15. A valid enrolment is used
  for its person even in a browser that is still signed in, so a recovery made there completes and is told as one.
- A new passkey is named after the device and browser it was made in (`Mac · Chrome`, from the user agent) unless the
  person posts a name of their own; a bare device word (`Mac`, `This device`) counts as none. Two of a person's passkeys
  never share a name: the later one is numbered (`Mac · Chrome (2)`).
- Team writes are admin only (`isAdmin`: the owner, or a key from `API_KEYS`). The last owner stays an owner, and an
  owner keeps at least one passkey.
- Registering the part changes Access for the app only when `access.roleOf` is passed: then emails off the team get 403.
- `onTeamChange` hears each change to the team (`{ who, from, to, by, notify }`: an email or `@domain`, the role before and
  after, null when off the team; `notify`, for a person just added, is false when the caller asked that they not be told);
  an unchanged role or a domain already listed is not a change. Log it with the app's events, and send any invite from it.
- `onPasskeyChange` hears each passkey added or removed (`{ action, who, id, name, by, via }`: `who` is the email it
  belongs to, `name` the device and browser it was made in unless its person named it, `via`, for one added, how its
  maker got in: `session`, or an enrolment from `claim` or `recovery`). It is told once the passkey and the session
  exist, and a hook that throws is logged, never answered: the passkey stays made. Passkeys removed with their person are a team
  change, not told here. Log it, and alert the person from it: a passkey they did not add is someone else's way in.
- Standard: `docs/STANDARD.md` §7 (auth).
