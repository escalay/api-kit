# sharing

Invites to a **space** (the part of an app that is shared: a shelf, a board, a project), asks to join, and the owner's approval, built on the oauth part's hooks. A **member** is one grant into one space: one app, signed in once, by invite, by ask or by the owner's approval. Built in steps: the owner's approval at a space, members, the remembered link and asking to join come next.

## Use it when

- People other than the owner, and their agents, should reach one part of the app (one space) and nothing else.
- The owner hands out single-use invites (a link and a typed code), or lets people ask to join and decides later.

## Don't use it when

- Only the owner and their own agents sign in: the oauth part alone does that (`src/kit/oauth/README.md`).
- A whole team reaches the whole app: the people part (members through Cloudflare Access, with roles).

## Add it

```bash
npx @escalay/kit add sharing
```

Needs `db`, `oauth`, `mcp` and `pagination` (and through them `core`). Imported from `./kit/sharing/index.js`. Runs on
Node and Workers.

## Wire it

```ts
import { createSharing, registerSharing, sharingTools, SHARING_OPEN_PATHS, SHARING_TAG } from './kit/sharing/index.js'

const sharing = await createSharing({
  db,
  // 32+ random bytes, its own entry in the app's secret store: never the OAuth signing key
  secret: env.SHARING_SECRET,
  spaces: { byName: (name) => shelves.byName(name), byId: (id) => shelves.byId(id) },
  spaceOfPath: (path) => /^\/api\/shelves\/([^/]+)(\/|$)/.exec(path)?.[1] ?? null,
  owner,
  fixedKeys: [...parseApiKeys(env.API_KEYS).values()],
  knownReturns: [{ name: 'Client A', callback: 'https://client-a.example.test/callback' }],
  askToJoin: true,
})
const oauth = createOAuth({ name: 'Sample', signingKey, store, owner, publicOrigin, limits, ...sharing.oauth })   // publicOrigin: required
const app = createAgentApi({
  …,
  tags: [...FEATURE_TAGS, SHARING_TAG],
  auth: { realm, keys, open: [...SHARING_OPEN_PATHS], relay: ['/mcp', '/a2a', sharing.relay] },
  guards: { …, skip: sharing.neverKept },
  oauth,
})
await registerSharing(app, sharing, { oauth })   // migrates, binds the hooks to oauth, then POST /sharing/join and the owner routes
mcpServerFactory({ tools: [...FEATURE_TOOLS, ...sharingTools({ noun: 'shelf' })], … })   // the owner's MCP only
```

An app with hooks of its own chains them, its veto first so a refusal never spends an invite. Behind Cloudflare Access
it lets exactly `sharingSignInPaths(sharing)` through.

```ts
approve: async (c, ask) => (sharing.handles(ask) ? sharing.oauth.approve(c, ask) : mine.approve(c, ask)),
onGrant: async (grant, c) => (await mine.onGrant(grant, c)) && (await sharing.oauth.onGrant(grant, c)),
onRevoke: async (revoked) => { await sharing.oauth.onRevoke(revoked); await mine.onRevoke(revoked) },
accepts: async (caller, c) => { const judged = await sharing.oauth.accepts(caller, c); return judged === true ? mine.accepts(caller, c) : judged },
```

## Options

`createSharing(options)`; `sharingTools({ path, noun })` takes the same `path` and the word for a space.

| Option | Type | Default | What it does |
|---|---|---|---|
| `db` | `Db` | required | the app's database, its OAuth state's too; `registerSharing` migrates `SHARING_MIGRATIONS` into it |
| `secret` | string | required | the app's sharing secret, 32 bytes or more; four keys are derived from it (HKDF-SHA256). Rotating it voids open invites; members keep working |
| `spaces` | `{ byName(name), byId(id) }` | required | the app's space by the name in its address, and by id: `{ id, name, title }` (`Space`), or null. Ids are never reused |
| `spaceOfPath` | `(path) => string \| null` | none | the space an `/api` request is about (an MCP tool's in-process call), from its path alone. Without it a space token reaches no `/api` route |
| `owner` | `(c) => Promise<string \| null>` | required | the signed-in owner's email, or null: the same function the app gives `createOAuth` |
| `fixedKeys` | string[] | `[]` | names of keys from `API_KEYS` that may share |
| `resourcePath` | string | `'/s/{space}/mcp'` | the space's MCP address: one whole `{space}` segment with a segment after it; `relay` and `mcpPath` come from it |
| `spaceName` | RegExp | `/^[a-z0-9][a-z0-9-]{0,62}$/` | what a space's name looks like, checked before any lookup |
| `path` | string | `'/api/spaces'` | where the owner routes live: `{path}/{space}/…` |
| `askToJoin` | boolean | `false` | whether asking to join exists at all; each space still switches it on |
| `knownReturns` | `{ name, callback }[]` | `[]` | the apps it expects, by exact callback (https, or a custom scheme it trusts): named, not warned of. A loopback http redirect is always known |
| `limits` | `{ store?, address? }` | `{ store: await dbGuardStore(db) }` | where typed codes are counted, and how the address is read; always on (`false` throws) |
| `tag` | string | `'Sharing'` | the routes' OpenAPI tag (`SHARING_TAG` declares it) |

`registerSharing(app, sharing, { oauth })` binds the hooks to the app's `createOAuth` and brand (`bind`, `boundOf`), and
throws when it has no `publicOrigin`.

## Exports

| File | What |
|---|---|
| `index.ts` | `createSharing` (the options checked: `relay`, `mcpPath`, `neverKept`, `config`; the hooks `oauth`; `bind`, `handles`, `memberOf`), `registerSharing`, `SHARING_TAG`, `SHARING_OPEN_PATHS` (`/sharing/*`, for `auth.open`), `sharingSignInPaths`, and re-exports the files below |
| `grants.ts` | the hooks but `approve` (Rules); `boundOf`, `appNameOf`, `isRootAudience`, `spaceNameIn`, `ONLY_ITS_SPACE`, `MemberView` |
| `signin.ts` | `approve`, `signInStepOf` (the ladder) and `POST /sharing/join` |
| `pages.ts`, `limits.ts` | the sign-in pages; the typed code's limits |
| `routes.ts` | `sharingRoutes`: the owner routes as OpenAPI contracts (below); `PLAIN_TEXT`, the label rule (no control, bidi or zero-width characters) |
| `handlers.ts` | the handlers; `sharerOf`, who may share (`Sharer`) |
| `tools.ts` | `sharingTools`: the MCP tools for the owner routes |
| `schema.ts` | the Drizzle tables `sharingSpaces`, `sharingInvites`, `sharingRequests`, `sharingMembers`, and `SHARING_MIGRATIONS` (step 1: the four tables and ten indexes); what each column means is in its JSDoc |
| `repo.ts` | `sharingRepo(db)`: every statement over the tables, each named in its JSDoc, nothing about HTTP |
| `states.ts` | the named states: `inviteStateOf`, `requestStateOf`, `memberStateOf`, `memberListingOf`, `askingStateOf`; the times `redeemByOf`, `memberExpiresAtOf`, `REDEEM_WITHIN` (a day), `UNSEEN_FOR` (30 days), `UNANSWERED_PAUSE` (10), `MAX_OPEN_INVITES` (100) |
| `secrets.ts` | `sharingKeys`, `newLinkToken` (192 bits), `newInviteCode` (`BDKM-QXTW`, from `CODE_ALPHABET`), `normalisedCode`, `newShownCode` (6 digits), and what the tables keep instead: `linkHashOf`, `codeHashOf`, `addressKeyOf` (HMACs), `ticketHashOf` (SHA-256) |

The owner routes (`{path}` default `/api/spaces`) and their tools:

| Route | operationId | Tool, command | Answers |
|---|---|---|---|
| `GET {path}/{space}/sharing` | `getSharing` | `get_sharing`, `sharing view` | 200; 404 |
| `PATCH {path}/{space}/sharing` `{ askToJoin }` | `updateSharing` | `set_ask_to_join`, `sharing edit` | 200 (off refuses everyone waiting); 409 |
| `POST {path}/{space}/invites` `{ label, scope = 'read', lifetime = '30d' }` | `createInvite` | `create_invite`, `invite create` | 201 `link`, `code`, `message`, shown once; 400; 409 |
| `GET {path}/{space}/invites?limit&cursor` | `listInvites` | `list_invites`, `invite list` | 200, newest first, paged, never a link or code |
| `GET {path}/{space}/invites/{id}` | `getInvite` | none | 200, the card its `self` names; 404 |
| `DELETE {path}/{space}/invites/{id}` | `revokeInvite` | `revoke_invite`, `invite revoke` | 204; 409 once used |

## Flows

Making an invite.

```mermaid
sequenceDiagram
  participant O as Owner (or their agent)
  participant R as POST {path}/soups/invites
  participant D as sharing_invites
  O->>R: { label: 'Sam' }, Idempotency-Key
  R->>R: sharerOf, then spaces.byName (else the same 404), an agent 7 or 30 days only
  R->>D: addInvite, HMACs of a new link and code, while under 100 open (a taken code retries)
  R-->>O: 201 link, code, message, shown once (showOnce)
```

Joining with a code. The invite is spent at the token exchange, never at the click.

```mermaid
sequenceDiagram
  participant A as App (the person's agent)
  participant P as /oauth/authorize, approve
  participant J as POST /sharing/join
  participant G as /oauth/token, onGrant
  A->>P: resource, the space's address (or none)
  P->>P: signInStepOf (Rules), then the code page
  P->>J: ticket and code, same-origin, from the browser that opened it
  J->>J: the step again, the limits, the code's open invite (else the page again)
  J->>A: complete with invite:id, the scopes asked that it gives, its space's address
  A->>G: the code
  G->>G: claimInvite, one statement (null: spent, revoked, late, another space: withdrawn)
  G-->>A: tokens, unless ended meanwhile (a replayed code): nothing, onRevoke told again
```

An invite (`inviteStateOf`). Redeemed is not a column: a member row holding its `invite_id` is.

```mermaid
stateDiagram-v2
  [*] --> open: made, its link and code shown once
  open --> redeemed: claimInvite writes the member row
  open --> revoked: the owner revokes it, or Invite again is used again
  open --> expired: redeem_by passes
  redeemed --> open: the grant was withdrawn and its row deleted
  redeemed --> revoked: withdrawn after a revoke
  redeemed --> [*]
  revoked --> [*]
  expired --> [*]: deleted 7 days later
```

An ask to join (`requestStateOf`). Joined is a member row holding its `request_id`.

```mermaid
stateDiagram-v2
  [*] --> waiting: asked, the ticket held
  waiting --> approved: the owner approves a scope and a lifetime
  waiting --> refused: the owner refuses, or switches asking off
  approved --> refused: the owner changes their mind before Continue
  approved --> joined: claimRequest writes the member row
  waiting --> lapsed: the held ticket ends
  approved --> lapsed: the held ticket ends before Continue
  joined --> [*]
  refused --> [*]: deleted a day later
  lapsed --> [*]: deleted a day later
```

A member (`memberStateOf`). Past its lifetime or unseen for 30 days it reads as ended before aging writes it.

```mermaid
stateDiagram-v2
  [*] --> active: a claim, or the owner's approval
  active --> ended: its grant revoked or replayed, its lifetime, 30 days unseen, removed, replaced, its space gone
  active --> [*]: withdrawn (a veto, or a failed exchange), so deleted and its invite open again
  ended --> [*]: 90 days
```

## Rules

- **Which tokens the part judges** (`onGrant`, `accepts`):

  | Token | `onGrant` | `accepts` |
  |---|---|---|
  | no audience, the root, the root's MCP (`isRootAudience`) | yes, untouched; no if a sharing page made it | everywhere |
  | a space, from the part's pages (`data.sharing`) | the claim writes the member, or no | its member's space only, while it lives |
  | any other audience (a space by a device grant or the kit's page, a resource of the app's own) | no: withdrawn | refused: no member |

- **The ladder** (`signInStepOf`), for a sign-in the part `handles`:

  | It asks for | The owner signed in | Step |
  |---|---|---|
  | the root or its MCP, named by the client | yes | `kit`: the kit's consent page |
  | the root or its MCP, named by the client | no | `wrong-address`: no form |
  | nothing (the root, chosen by the server) | yes | `kit` |
  | nothing | no | `code`: the code's invite binds its space |
  | a space | either | `code` |

- **The code page names the return**: an app on this computer (a loopback http redirect), a `knownReturns` name (an
  exact callback), or else "This app returns to <host>" (a custom scheme by its scheme). Every page carries "This
  connects the app signed in in this browser.", is escaped, `no-store`, `noindex`, unframed, script-free, its
  `form-action` only here and the return.
- **`POST /sharing/join`** works the step out again from the ticket this browser holds, never a hidden field, and
  completes only with an open invite of the asked space (any space, for a client that named none): never a root grant.
- **A member is its row.** `accepts` finds it by the token's grant, its space by `byId`, and compares that space's
  name now with the one the request is about (its path at a space address, else `spaceOfPath`). A renamed space keeps
  its members; its old name opens nothing to them, even once another space takes it. A live member out of place gets
  one sentence (`ONLY_ITS_SPACE`), whether or not the asked space exists. Past its lifetime or 30 days unused, it is
  refused anywhere, saying why; a use is noted at most once an hour.
- **A grant never holds more than was given:** an invite's approver `invite:<id>` and scopes within the invite's; the
  owner's `owner:<email>` (never the bare email: never the owner's token), the resource's space id, a lifetime the part
  has.
- **`onRevoke` mirrors the kit**: `withdrawn` (a veto, or anything failing after `onGrant`'s yes) deletes its row, so
  its invite opens again; `client_revoked` ends the client's rows, any other end the grant's. Then, unless withdrawn,
  an agent's open invites under that grant or client are revoked; its joiners keep access. Told twice, nothing moves.
- **Before `bind`** (`registerSharing`), `approve` shows a 503 page, `onGrant` says no and `accepts` takes only a token
  with no audience.
- **`resources` is a pure check of the path** (`spaceNameIn`): cased, encoded and dotted names are no space.
  `handles(ask)`: whether a sign-in is the part's (a space, the root or its MCP). A client's name is its own claim,
  kept after `appNameOf` (no control, bidi or zero-width character, 80 at most).
- **Who may share** (`sharerOf`): the owner signed in (never a team `member`), a key in `fixedKeys`, or an agent with
  a root token (`isRootAudience`) from a known grant. A key made through the API, a space's token and anyone else may not.
- **Nothing says whether a space exists.** Anyone who may not share, a name `spaceName` refuses (cased, dotted,
  encoded) and a space `byName` doesn't find all get the same 404 with the same body. An invite id from another space
  is the same 404 as a made-up one (every by-id statement takes the space). The code page never names the space,
  and a wrong code reads the same at both.
- **Shown once means never kept.** `createInvite` answers the link and code once, `no-store`, and calls `showOnce`:
  a retry with the same Idempotency-Key is a 409 `shown_once`. `neverKept` (`/sharing/*`) keeps the sign-in pages'
  answers out of the guard store too.
- **Agents invite for a while, on the record.** An agent may give 7 or 30 days, never until revoked; each invite it
  makes records its client and grant.
- **The root is the pinned origin.** `publicOrigin`, never a request's host, judges which tokens are root tokens and
  names links (`<publicOrigin>/sharing/join/<token>`): a forged host never makes a space token a root one.
- **Never through A2A.** `sharingTools` go to the owner's MCP only: a delegating agent must not mint invites. Each
  tool acts only on the user's word, and `create_invite` returns the message to send, never sends it.
- **The claim is the insert**: `claimInvite` and `claimRequest` are one `insert … select … where` each, with unique
  `invite_id`, `request_id` and `grant_id`, so a racing second claim answers null; `addInvite` holds the cap the same
  way. No transaction, on node:sqlite, libSQL and D1.
- **A revoke is always recorded**, as is `refuseRequest`, whatever member holds it (who keeps access), and an ended
  member's row stays until aging deletes it: a revoked invite or refused ask never opens again.
- **States are named only through `states.ts`**, and checked again in SQL. The owner's list hides removed and
  replaced members and shows other ended ones as signed out.
- **No secret at rest.** The link token and the typed code are kept only as HMACs under their own derived keys, the
  asker's address only as an HMAC, the consent ticket only as a SHA-256.
- The migration's SQL holds no comment and no quote: a step is split on `;` outside quotes.
- Standard: `docs/STANDARD.md` §7, §23

## Failure modes

| The caller sees | Why |
|---|---|
| `createSharing` throws "the secret holds N bytes" | the sharing secret is shorter than 32 bytes: make 32 random bytes |
| `registerSharing` throws "needs publicOrigin" | the app's `createOAuth` has none: pass it |
| `createSharing` throws "needs exactly one {space} segment" | `resourcePath` has no `{space}`, two, one inside a segment, or none after it |
| `createSharing` throws "limits are always on" | `limits: false` |
| the page "Use the address in your invite" | a client named the owner's whole app: no invite binds it |
| the code page again, "not one of ours" (400) | no open invite of the asked space (or, for a client that named none, of a space the app has) |
| `access_denied` at the app | the fifth wrong code on one sign-in: start again |
| 429 page "Too many codes" | 10 a minute from an address, or 60 in 10 minutes at one space |
| 403 page "Not allowed" | a post from another site, or of a sign-in these pages don't approve |
| 400 page "expired", "refused", "already joined" | the ticket ran out or is another browser's, the fifth wrong code, or a double click |
| the code page, "asks only to make changes" | a client asking only `write`, at a read invite |
| 503 page "not ready" | `approve` before `registerSharing` |
| 404 "No space … here that you may share" | the caller may not share, or the name is not a space (always the same body) |
| 400 on `createInvite` | a label empty, over 80 or not plain text (`PLAIN_TEXT`); an agent asking for `until_revoked` |
| 409 on `createInvite` | 100 open at the space, or `shown_once` (a retry with the same Idempotency-Key) |
| 409 on `updateSharing` | the app's `askToJoin` option is off |
| 409 on `revokeInvite` | the invite was used already: revoked all the same, its member keeps access |
| 400 `invalid_grant` "withdrawn" | `onGrant` said no: a space grant not from the part's pages, an invite not open at its space, more than it gives, or a sharing approval at the root |
| 401 "works only at its own space" | a live space token anywhere but its space's name now (`spaceOfPath` for `/api`), or a space `byId` misses |
| 401 "ended on …", "lapsed", "not ready" | the member's lifetime passed; 30 days unused; a token with an audience before `bind` |
| 500 at `/oauth/token`, the invite open again | a throw after the claim (a hook after the part's, a store): the kit withdraws the grant, so the row goes |
| a member who never got in, its code spent | the withdraw could not land (the store and `onRevoke` both failed, or the process died after the claim): no token; the row lapses; send a new invite |

## Limits

- 100 open invites per space; lists 50 a page by default, 100 at most.
- An invite's code: 8 letters from 20 (about 34.6 bits), redeemable for a day. Typed codes: 10 a minute per address,
  then 60 per 10 minutes per space (`any` for a client that named none), 5 wrong per sign-in.

## Tests

- `test/sharing.test.ts`: the migration, the named states, the secrets, the claims and the cap under a race, every
  by-id statement at another space, no secret at rest.
- `test/sharing-owner.test.ts`: who may share; invites made, listed, read and revoked; the same 404; agents' invites;
  probe T5; `lintOpenApi`, `toolRoutes`, `toolsRun`, `cliGaps`.
- `test/sharing-grants.test.ts`: the addresses (probe T6); `bind`; `onGrant` (probe T7, `race.mts`); `accepts`;
  `onRevoke`; `memberOf`. Its contract (`test/sharing-grants-contract.ts`) runs on node:sqlite.
- `test/sharing-signin.test.ts`: the ladder; the pages (probes T1, T4; returns, names, headers, the brand, a missing space alike);
  joining (scopes, the code's space, hidden fields, codes not ours, another site); the fifth wrong code; the limits;
  `sharingSignInPaths`.
- `test/workers/sharing.test.ts`: the migration, both claims, the cap and the grants contract on D1, the keys in workerd.

## Upgrading

What changed between kit versions, and what to do: [docs/upgrading.md#sharing](https://github.com/escalay/api-kit/blob/main/docs/upgrading.md#sharing).
