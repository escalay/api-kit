# sharing

Invites to a **space** (the part of an app that is shared: a shelf, a board, a project), asks to join, and the owner's approval, built on the oauth part's hooks. A **member** is one grant into one space: one app, signed in once, by invite, by ask or by the owner's approval. Built in steps (Exports says what is here): the sign-in pages (`approve`, where an invite's link points) come next; until then an app's own page completes the ticket as they will (Flows), keeping `docs/STANDARD.md` §23.

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
import { createSharing, registerSharing, sharingTools, SHARING_TAG } from './kit/sharing/index.js'

const sharing = await createSharing({
  db,
  // 32+ random bytes, its own entry in the app's secret store: never the OAuth signing key
  secret: env.SHARING_SECRET,
  spaces: { byName: (name) => shelves.byName(name), byId: (id) => shelves.byId(id) },   // → { id, name, title } or null; ids never reused
  spaceOfPath: (path) => /^\/api\/shelves\/([^/]+)(\/|$)/.exec(path)?.[1] ?? null,       // the space an in-process /api call is about
  owner,                                                // the same function the app gives createOAuth
  fixedKeys: [...parseApiKeys(env.API_KEYS).values()],
  askToJoin: true,
})
const oauth = createOAuth({ name: 'Sample', signingKey, store, owner, publicOrigin, limits, ...sharing.oauth })   // publicOrigin: required
const app = createAgentApi({
  …,
  tags: [...FEATURE_TAGS, SHARING_TAG],
  auth: { realm, keys, relay: ['/mcp', '/a2a', sharing.relay] },
  guards: { …, skip: sharing.neverKept },
  oauth,
})
await registerSharing(app, sharing, { oauth })   // migrates, binds the hooks to oauth, then the owner routes
mcpServerFactory({ tools: [...FEATURE_TOOLS, ...sharingTools({ noun: 'shelf' })], … })   // the owner's MCP only
```

An app with hooks of its own chains them, its veto first so a refusal never spends an invite (after the claim, a
veto or a failed exchange is undone: Failure modes).

```ts
onGrant: async (grant, c) => (await mine.onGrant(grant, c)) && (await sharing.oauth.onGrant(grant, c)),
onRevoke: async (revoked) => { await sharing.oauth.onRevoke(revoked); await mine.onRevoke(revoked) },
accepts: async (caller, c) => { const judged = await sharing.oauth.accepts(caller, c); return judged === true ? mine.accepts(caller, c) : judged },
```

## Options

`createSharing(options)`; `sharingTools({ path, noun })` takes the same `path` and the word for a space.

| Option | Type | Default | What it does |
|---|---|---|---|
| `db` | `Db` | required | the app's database (`openDb`), the same one as its OAuth state; `registerSharing` migrates `SHARING_MIGRATIONS` into it |
| `secret` | string | required | the app's sharing secret, 32 bytes or more; four keys are derived from it (HKDF-SHA256). Rotating it voids open invites; members keep working |
| `spaces` | `{ byName(name), byId(id) }` | required | the app's space by the name in its address, and by id: `{ id, name, title }` (`Space`), or null. Ids are never reused: a member keeps its space by id |
| `spaceOfPath` | `(path) => string \| null` | none | the space an `/api` request is about, from its path alone (an MCP tool's in-process call has lost the space's address); never a header. Without it a space token reaches no `/api` route |
| `owner` | `(c) => Promise<string \| null>` | required | the signed-in owner's email, or null: the same function the app gives `createOAuth` |
| `fixedKeys` | string[] | `[]` | names of keys from `API_KEYS` that may share |
| `resourcePath` | string | `'/s/{space}/mcp'` | the space's MCP address: one whole `{space}` segment with a segment after it; `relay` and `mcpPath` come from it |
| `spaceName` | RegExp | `/^[a-z0-9][a-z0-9-]{0,62}$/` | what a space's name looks like, checked before any lookup |
| `path` | string | `'/api/spaces'` | where the owner routes live: `{path}/{space}/…` |
| `askToJoin` | boolean | `false` | whether asking to join exists at all; each space still switches it on |
| `tag` | string | `'Sharing'` | the routes' OpenAPI tag (`SHARING_TAG` declares it) |

`registerSharing(app, sharing, { oauth })` binds the hooks to the app's `createOAuth` server (`bind`, `boundOf`), and
throws when it has no `publicOrigin`: that origin and its MCP path say which tokens are root tokens and who may share.

## Exports

| File | What |
|---|---|
| `index.ts` | `createSharing` (the options checked: `relay`, `mcpPath`, `neverKept`, `config`; the hooks `oauth`; `bind`, `handles`, `memberOf`), `registerSharing`, `SHARING_TAG`, and re-exports the files below |
| `grants.ts` | the hooks (Rules); `boundOf`, `appNameOf`, `isRootAudience`, `spaceNameIn`, `ONLY_ITS_SPACE`, `MemberView` |
| `routes.ts` | `sharingRoutes`: the owner routes as OpenAPI contracts (below); `PLAIN_TEXT`, the label rule (no control, bidi or zero-width characters) |
| `handlers.ts` | the handlers; `sharerOf`, who may share (`Sharer`) |
| `tools.ts` | `sharingTools`: the MCP tools for the owner routes |
| `schema.ts` | the Drizzle tables `sharingSpaces`, `sharingInvites`, `sharingRequests`, `sharingMembers`, and `SHARING_MIGRATIONS` (step 1: the four tables and ten indexes); what each column means is in its JSDoc |
| `repo.ts` | `sharingRepo(db)`: every statement over the tables, nothing about HTTP (below) |
| `states.ts` | the named states: `inviteStateOf`, `requestStateOf`, `memberStateOf`, `memberListingOf`, `askingStateOf`; the times `redeemByOf`, `memberExpiresAtOf`, `REDEEM_WITHIN` (a day), `FIRST_USE_WITHIN` (an hour), `UNSEEN_FOR` (30 days), `UNANSWERED_PAUSE` (10), `MAX_OPEN_INVITES` (100) |
| `secrets.ts` | `sharingKeys`, `newLinkToken` (192 bits), `newInviteCode` (`BDKM-QXTW`, from `CODE_ALPHABET`), `normalisedCode`, `newShownCode` (6 digits), and what the tables keep instead: `linkHashOf`, `codeHashOf`, `addressKeyOf` (HMACs), `ticketHashOf` (SHA-256) |

The owner routes (`{path}` default `/api/spaces`) and their tools:

| Route | operationId | Tool, command | Answers |
|---|---|---|---|
| `GET {path}/{space}/sharing` | `getSharing` | `get_sharing`, `sharing view` | 200 `askToJoin` (`off`, `on`, `paused`), `askToJoinOffered`, `openInvites`; 404 |
| `PATCH {path}/{space}/sharing` `{ askToJoin }` | `updateSharing` | `set_ask_to_join`, `sharing edit` | 200; 409 when `askToJoin` is off in the options; off refuses everyone waiting |
| `POST {path}/{space}/invites` `{ label, scope = 'read', lifetime = '30d' }` | `createInvite` | `create_invite`, `invite create` | 201 with `link`, `code` and `message`, shown once, and `Location`; 400; 409 at 100 open, or `shown_once` on a retry |
| `GET {path}/{space}/invites?limit&cursor` | `listInvites` | `list_invites`, `invite list` | 200, newest first, a page at a time (the tool's text gives the next cursor), never a link or code |
| `GET {path}/{space}/invites/{id}` | `getInvite` | none: `list_invites` holds the same | 200, the card its `self` names; 404 |
| `DELETE {path}/{space}/invites/{id}` | `revokeInvite` | `revoke_invite`, `invite revoke` | 204, again 204; 409 once used |

`sharingRepo(db)`, by table:

| Table | Statements |
|---|---|
| `sharing_spaces` | `spaceAt`, `setAskToJoin` (clears a pause), `noteUnanswered`, `noteAnswered`, `forgetSpace` |
| `sharing_invites` | `addInvite` (null at 100 open, or on a link or code hash already taken), `inviteAt`, `inviteByLink`, `inviteByCodeAt`, `inviteByCodeAnywhere` (only for a client that named no space), `listInvites`, `countOpenInvites`, `revokeInvite`, `revokeInvitesReplacing`, `revokeInvitesMadeByGrant`, `revokeInvitesMadeByClient`, `revokeInvitesOf` |
| `sharing_requests` | `addRequest` (null on a ticket that already asked), `requestAt`, `requestByTicket`, `listRequests`, `countWaitingAt`, `countWaitingFrom` (an address), `approveRequest`, `refuseRequest`, `refuseWaitingAt` |
| `sharing_members` | `claimInvite`, `claimRequest`, `addOwnerMember`, `memberByGrant`, `memberAt`, `listMembers`, `noteFirstUse`, `noteSeen`, `endMember`, `endMemberOfGrant`, `endMembersOfClient`, `endMembersOf`, `deleteMemberOfGrant`, `deletePendingMemberOfGrant` |
| aging | `deleteUnusedMembers`, `endExpiredMembers`, `endLapsedMembers`, `deleteEndedMembers`, `deleteClosedInvites`, `deleteClosedRequests` |

## Flows

Making an invite. Every owner route starts the same way: who is asking, then the space.

```mermaid
sequenceDiagram
  participant O as Owner (or their agent)
  participant R as POST {path}/soups/invites
  participant D as sharing_invites
  O->>R: { label: 'Sam' }, Idempotency-Key
  R->>R: sharerOf(caller): the owner, a fixed key, or a root token (else 404)
  R->>R: spaceName, then spaces.byName('soups') (null: the same 404)
  R->>R: an agent gives 7 or 30 days only (else 400)
  R->>D: addInvite with HMACs of a new link and code, only while under 100 open
  D-->>R: null: 100 open is a 409, else a taken code gets new ones (3 tries)
  R->>R: showOnce: Idempotency-Key keeps only "made invite inv_…"
  R-->>O: 201 link, code, message (shown once, no-store)
```

An invite is spent at the token exchange, never at the click. Until the sign-in pages come, the app's page completes
the ticket as they will: `{ approver: 'invite:<id>', scopes: <asked ∩ the invite's>, resource: <the space's address>,
data: { sharing: 'invite', invite, returnsTo } }`; the owner's, `approver: 'owner:<email>'`, `data: { sharing:
'owner', space: <its id>, lifetime, returnsTo }`.

```mermaid
sequenceDiagram
  participant K as /oauth/token
  participant G as onGrant
  participant D as sharing_members
  K->>G: the grant (resource, scopes, approver, data)
  G->>G: a code at a space byName finds, its approver and scopes within the invite (else withdrawn)
  G->>D: claimInvite, one statement (null: spent, revoked, late, another space: withdrawn)
  K->>K: ended meanwhile (a replayed code)? nothing issued, onRevoke told again
  K-->>G: later requests: accepts, by the member's grant and its space byId
```

An invite (`inviteStateOf`). Redeemed is not a column: a member row holding its `invite_id` is.

```mermaid
stateDiagram-v2
  [*] --> open: made, its link and code shown once
  open --> redeemed: claimInvite writes the member row
  open --> revoked: the owner revokes it, or Invite again is used again
  open --> expired: redeem_by passes
  redeemed --> open: the grant was withdrawn and its row deleted
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
  [*] --> pending: a claim, or the owner's approval
  pending --> active: accepts sees its first token
  pending --> [*]: withdrawn, replayed, or unused an hour, so deleted and its invite open again
  active --> ended: its grant revoked or replayed, its lifetime, 30 days unseen, removed, replaced, its space gone
  ended --> [*]: 90 days
```

## Rules

- **Which tokens the part judges** (`onGrant`, `accepts`):

  | Token | `onGrant` | `accepts` |
  |---|---|---|
  | no audience, the root, the root's MCP (`isRootAudience`) | yes, untouched; no if a sharing page made it | everywhere |
  | a space, from the part's pages (`data.sharing`) | the claim writes the member, or no | its member's space only, while it lives |
  | any other audience (a space by a device grant or the kit's page, a resource of the app's own) | no: withdrawn | refused: no member |

- **A member is its row.** `accepts` finds it by the token's grant, its space by `byId`, and compares that space's
  name now with the one the request is about (its path at a space address, else `spaceOfPath`). A renamed space keeps
  its members; its old name opens nothing to them, even once another space takes it. A live member out of place gets
  one sentence (`ONLY_ITS_SPACE`), whether or not the asked space exists. A row past its lifetime or unused for 30
  days is refused, anywhere, saying why (that request is not a use); a use is noted at most once an hour.
- **A grant never holds more than was given:** an invite's approver `invite:<id>` and scopes within the invite's; the
  owner's `owner:<email>` (never the bare email: never the owner's token), the resource's space id, a lifetime the part
  has. A sharing approval never makes a root grant.
- **`onRevoke` mirrors the kit**: `withdrawn`, and `replayed` while the row is pending (no token used: the client's
  retry after a failed exchange), delete it, so its invite opens again; `client_revoked` ends the client's rows, any
  other end the grant's. Then, unless withdrawn, the open invites an agent made under that
  grant or client are revoked; people who joined through them keep access. Told twice, nothing moves.
- **Before `bind`** (`registerSharing`), `onGrant` says no and `accepts` takes only a token with no audience.
- **`resources` is a pure check of the path** (`spaceNameIn`): cased, encoded and dotted names are no space.
  `handles(ask)`: whether a sign-in is the part's (a space, the root or its MCP). A client's name is its own claim,
  kept after `appNameOf` (no control, bidi or zero-width character, 80 at most).
- **Who may share** (`sharerOf`): the owner signed in (never a team `member`), a key in `fixedKeys`, or an agent with
  a root token (`isRootAudience`) from a known grant. A key made through the API, a space's token and anyone else may not.
- **Nothing says whether a space exists.** Anyone who may not share, a name `spaceName` refuses (cased, dotted,
  encoded) and a space `byName` doesn't find all get the same 404 with the same body. An invite id from another space
  is the same 404 as a made-up one.
- **Shown once means never kept.** An invite's link and code are kept only as HMACs and answered once, `no-store`;
  `createInvite` calls `showOnce`, so a retry with the same Idempotency-Key is a 409 `shown_once`, never the secrets,
  and only one invite exists. `neverKept` (`/sharing/*`) keeps the sign-in pages' answers out
  of the guard store too.
- **Agents invite for a while, on the record.** An agent may give 7 or 30 days, never until revoked; each invite it
  makes records its client and grant.
- **The root is the pinned origin.** `publicOrigin`, never a request's host, judges which tokens are root tokens and
  names links (`<publicOrigin>/sharing/join/<token>`): a forged host never makes a space token a root one.
- **Never through A2A.** `sharingTools` go to the owner's MCP only: a delegating agent must not mint invites. Each
  tool acts only on the user's word, and `create_invite` returns the message to send, never sends it.
- **The claim is the insert.** `claimInvite` and `claimRequest` are one `insert … select … where` each (the invite of
  the member's space, unrevoked, in time, unredeemed; the ask approved, in time, unused); `invite_id`, `request_id` and
  `grant_id` are unique, so a racing second claim answers null, never throws. `addInvite` holds the 100-open cap the
  same way. No transaction: each holds on node:sqlite, libSQL and D1.
- **An id never crosses spaces.** Every statement taking an id a route names also takes the space
  (`and space_id = ?`).
- **Ending is not deleting.** An ended member's row stays until aging deletes it, so its invite never reopens.
- **States are named only through `states.ts`**, one rule per function, and checked again in SQL by the once-only
  statements. The owner's list hides removed and replaced members and shows other ended ones as signed out.
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
| 404 "No space … here that you may share" | the caller may not share, or the name is not a space (always the same body) |
| 400 on `createInvite` | a label that is empty, over 80 or holds control, bidi or zero-width characters; an agent asking for `until_revoked` |
| 409 on `createInvite` | 100 open invites at the space; or `shown_once`: a retry with the same Idempotency-Key (the invite was made) |
| 409 on `updateSharing` | the app's `askToJoin` option is off |
| 409 on `revokeInvite` | the invite was used already |
| a once-only statement answers null or false | it lost or found nothing: the row is spent, revoked, late, decided or another space's, the grant has a member, or the space holds 100 open invites (`addInvite`) |
| 400 `invalid_grant` "withdrawn" | `onGrant` said no: a space grant not from the part's pages; an invite spent, revoked, late or another space's; more scope, or another approver; a sharing approval at the root |
| 401 "works only at its own space" | a live space token at another space (or an old name), `/mcp`, an `/api` route `spaceOfPath` doesn't name, or a space `byId` misses |
| 401 "ended on …", "lapsed", "not ready" | the member's lifetime passed; 30 days unused; a token with an audience before `bind` |
| 500 at `/oauth/token`, the invite redeemed | a throw after the claim (a hook chained after the part's, a store): no token. The client's retry, or aging after an hour unused (`deleteUnusedMembers`; sweep revokes its grant), opens it again |

## Limits

- 100 open invites per space; lists 50 a page by default, 100 at most.
- An invite's code: 8 letters from 20 (about 34.6 bits), redeemable for a day.
- Node and Workers, on any database `openDb` opens (node:sqlite, libSQL, D1).

## Tests

- `test/sharing.test.ts`: the migration's tables and indexes, every named state as a table, the secrets, both claims
  and the 100-open cap under a race, an id from one space at another for every by-id statement, and no table holding a secret.
- `test/sharing-owner.test.ts`: who may share; invites made, listed, paged, read and revoked; the same 404 everywhere; the cap at once; agents' lifetimes and makers; an
  Idempotency-Key retry keeping no link or code (memory and database guards, MCP); `lintOpenApi`, `toolRoutes`,
  `toolsRun`, `cliGaps`.
- `test/sharing-grants.test.ts`: the addresses (probe T6); `bind`; a forged host; `onGrant` (once, in time, at its space; grants around the
  part; no root grant; no more than given; the owner's; probe T7; a failed exchange undone; `race.mts`; races); `accepts`; `onRevoke`;
  `memberOf`; before `bind`. Its contract (`test/sharing-grants-contract.ts`) runs on node:sqlite and D1.
- `test/workers/sharing.test.ts`: the migration, both claims, the cap and the grants contract on D1, the keys in workerd.

## Upgrading

What changed between kit versions, and what to do: [docs/upgrading.md#sharing](https://github.com/escalay/api-kit/blob/main/docs/upgrading.md#sharing).
