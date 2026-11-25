# sharing

Invites to a **space** (the part of an app that is shared: a shelf, a board, a project), and the owner's approval at a space, built on the oauth part's hooks. A **member** is one grant into one space: one app, signed in once, by invite or by the owner's approval. An invite joins by its code: the person's app connects at the space's address, and they type it on the page that opens. Not built yet: a page for an invite's link, and asking to join.

## Use it when

- People other than the owner, and their agents, should reach one part of the app (one space) and nothing else.
- The owner hands out single-use invites (a typed code), or approves an app at a space themselves.

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
  signInPath: '/sign-in',
})
const oauth = createOAuth({ name: 'Sample', signingKey, store, owner, publicOrigin, limits, ...sharing.oauth })   // publicOrigin: required, the root (never a request's host)
const app = createAgentApi({
  …,
  tags: [...FEATURE_TAGS, SHARING_TAG],
  auth: { realm, keys, open: [...SHARING_OPEN_PATHS], relay: ['/mcp', '/a2a', sharing.relay] },
  guards: { …, skip: sharing.neverKept },
  oauth,
})
await registerSharing(app, sharing, { oauth })   // migrates, binds the hooks to oauth and brand, then /sharing/* and the owner routes
mcpServerFactory({ tools: [...FEATURE_TOOLS, ...sharingTools({ noun: 'shelf' })], … })   // the owner's MCP only
mountMcp(app, { path: sharing.mcpPath, factory: shelfMcp, allowedHostnames })   // its tools read at.params.space
// the scheduled handler: await sharing.sweep(); deleting a shelf: await sharing.forget(shelf.id)
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
| `secret` | string | required | 32 bytes or more, three keys derived from it (HKDF-SHA256). Rotating it voids open invites, not members |
| `spaces` | `{ byName(name), byId(id) }` | required | the app's space by the name in its address, and by id: `{ id, name, title }` (`Space`), or null. Ids are never reused |
| `spaceOfPath` | `(path) => string \| null` | none | the space an `/api` request is about (an MCP tool's in-process call), from its path alone. Without it a space token reaches no `/api` route |
| `owner` | `(c) => Promise<string \| null>` | required | the signed-in owner's email, or null: the same function the app gives `createOAuth` |
| `fixedKeys` | string[] | `[]` | names of keys from `API_KEYS` that may share |
| `resourcePath` | string | `'/s/{space}/mcp'` | the space's MCP address: one whole `{space}` segment with a segment after it; `relay` and `mcpPath` come from it |
| `spaceName` | RegExp | `/^[a-z0-9][a-z0-9-]{0,62}$/` | what a space's name looks like, checked before any lookup |
| `path` | string | `'/api/spaces'` | where the owner routes live: `{path}/{space}/…` |
| `knownReturns` | `{ name, callback }[]` | `[]` | the apps it expects, by exact callback (https, or a custom scheme it trusts): named, not warned of. A loopback http redirect is always known |
| `limits` | `{ store?, address? }` | `{ store: await dbGuardStore(db) }` | where typed codes are counted, and how the address is read; always on (`false` throws) |
| `signInPath` | string | none | where the owner signs in, linked from "Sign in first" |
| `tag` | string | `'Sharing'` | the routes' OpenAPI tag (`SHARING_TAG` declares it) |

## Exports

| File | What |
|---|---|
| `index.ts` | `createSharing` (`relay`, `mcpPath`, `neverKept`, `config`; the hooks `oauth`; `bind`, `handles`, `memberOf`, `sweep`, `forget`), `registerSharing`, `SHARING_TAG`, `SHARING_OPEN_PATHS`, `sharingSignInPaths`, and re-exports the files below |
| `grants.ts` | the hooks but `approve` (Rules); `boundOf`, `appNameOf`, `isRootAudience`, `spaceNameIn`, `ONLY_ITS_SPACE`, `MemberView` |
| `signin.ts`, `owner.ts` | `approve`, `signInStepOf` (the ladder), `POST /sharing/join`; the owner's `POST /sharing/as-owner` and `/sharing/owner` |
| `pages.ts`, `limits.ts`, `sweep.ts` | the pages; the code's limits; `sweep`, `forget` |
| `routes.ts`, `handlers.ts`, `tools.ts` | `sharingRoutes` (below), `PLAIN_TEXT` (the label rule); `sharerOf` (`Sharer`); `sharingTools` |
| `schema.ts` | the tables `sharingInvites`, `sharingMembers`, and `SHARING_MIGRATIONS` (step 1: two tables, seven indexes); each column's meaning in its JSDoc |
| `repo.ts` | `sharingRepo(db)`: every statement over the tables, nothing about HTTP |
| `states.ts` | `inviteStateOf`, `memberStateOf`, `memberListingOf`; `redeemByOf`, `memberExpiresAtOf`, `REDEEM_WITHIN` (a day), `UNSEEN_FOR` (30 days), `MAX_OPEN_INVITES` (100) |
| `secrets.ts` | `sharingKeys`, `newLinkToken` (192 bits), `newInviteCode` (`BDKM-QXTW`, from `CODE_ALPHABET`), `normalisedCode`; what the tables keep instead: `linkHashOf`, `codeHashOf`; what the limits count by: `addressKeyOf` (an HMAC), `ticketHashOf` (SHA-256) |

The owner routes (`{path}` default `/api/spaces`), paged lists newest first (`?limit&cursor`), and their tools:

| Route | operationId | Tool, command | Answers |
|---|---|---|---|
| `GET {path}/{space}/sharing` | `getSharing` | `get_sharing`, `sharing view` | 200; 404 |
| `POST {path}/{space}/invites` `{ label, scope = 'read', lifetime = '30d' }` | `createInvite` | `create_invite`, `invite create` | 201 `code` shown once, with `address` and `message`; 400; 409 |
| `GET {path}/{space}/invites` | `listInvites` | `list_invites`, `invite list` | 200, never a code |
| `GET {path}/{space}/invites/{id}` | `getInvite` | none | 200, the card its `self` names; 404 |
| `DELETE {path}/{space}/invites/{id}` | `revokeInvite` | `revoke_invite`, `invite revoke` | 204; 409 once used |
| `GET {path}/{space}/members` | `listMembers` | `list_members`, `member list` | 200, `active` or `signed_out` |
| `GET {path}/{space}/members/{id}` | `getMember` | none | 200; 404 |
| `DELETE {path}/{space}/members/{id}` | `removeMember` | `remove_member`, `member remove` | 204, again 204; 404 |
| `POST {path}/{space}/members/{id}/invite-again` | `inviteAgain` | `invite_again`, `member reinvite` | 201 as `createInvite`; 400; 409 |

## Flows

Joining with a code: the invite is spent at the token exchange, never at the click.

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

The owner approves an app at a space.

```mermaid
sequenceDiagram
  participant A as App
  participant P as /oauth/authorize, approve
  participant H as POST /sharing/as-owner
  participant O as POST /sharing/owner
  A->>P: resource, the space's address
  P->>P: owner(c), then byName: the owner page, or no such space (404)
  P-->>H: no owner cookie (cross-site): Continue as the owner, on the code page
  H->>H: owner(c) again (else Sign in first), then the owner page
  P->>O: Approve or Refuse, the boxes ticked
  O->>O: same-origin, the ticket, owner(c), byName, again
  O->>A: complete as owner:email, asked scopes the ticks give, 30 days or until revoked
```

Invite again: the old sign-in ends once the fresh invite is used. A withdrawn join reopens it; the old stays replaced.

```mermaid
sequenceDiagram
  participant O as Owner
  participant R as POST {path}/soups/members/{id}/invite-again
  participant G as onGrant
  O->>R: Idempotency-Key
  R->>R: its earlier ones revoked, a new one with its label, scope, lifetime
  R-->>O: 201 code, address, message, shown once
  G->>G: claimInvite, then closeMember replaced (live or signed out), then revokeGrant
```

An invite (`inviteStateOf`). Redeemed is not a column: a member row holding its `invite_id` is.

```mermaid
stateDiagram-v2
  [*] --> open: made, its code shown once
  open --> redeemed: claimInvite writes the member row
  open --> revoked: the owner revokes it, or Invite again is used again
  open --> expired: redeem_by passes
  redeemed --> open: the grant was withdrawn and its row deleted
  redeemed --> revoked: withdrawn after a revoke
  redeemed --> [*]
  revoked --> [*]
  expired --> [*]: deleted 7 days later
```

A member (`memberStateOf`). Past its lifetime or unseen for 30 days it reads as ended before `sweep` writes it.

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
  | any other (a space by a device grant or the kit's page, the app's own resource) | no: withdrawn | refused |

- **The ladder** (`signInStepOf`), for a sign-in the part `handles`:

  | It asks for | The owner signed in | Step |
  |---|---|---|
  | the root or its MCP, named by the client | yes | `kit`: the kit's consent page |
  | the root or its MCP, named by the client | no | `wrong-address`: no form |
  | nothing (the root, chosen by the server) | yes | `kit` |
  | nothing | no | `code`: the code's invite binds its space |
  | a space `byName` finds | yes | `owner` |
  | a space `byName` misses | yes | `no-such-space` (404, to the owner only) |
  | a space | no | `code`, with Continue as the owner |

- **The pages name the return**: an app on this computer (loopback http), a `knownReturns` name (exact), or else
  "This app returns to <host>" (a custom scheme by its scheme). Each that approves says "This connects the app signed
  in in this browser."; all are escaped, `no-store`, `noindex`, unframed, script-free, `form-action` here and the return.
- **Every post works the step out again** from the ticket this browser holds (same-origin first), never a hidden field.
  `POST /sharing/join` completes only with an open invite of the asked space (any space, for a client that named
  none); the owner's posts ask `owner(c)`, then `byName`. None ever completes a root grant.
- **The owner's one click names its grant**: scopes always explicit, what was asked that the ticks give (Allow changes
  only narrows), and 30 days unless Until revoked is ticked. At a known return both boxes start ticked (what was asked,
  until revoked); at any other, unticked (read, 30 days).
- **A member is its row.** `accepts` finds it by the token's grant, its space by `byId`, and compares that space's
  name now with the request's (its path at a space address, else `spaceOfPath`): a renamed space keeps its members,
  its old name opens nothing. Out of place: `ONLY_ITS_SPACE`, whether or not the asked space exists. Past its
  lifetime or 30 days unused, refused anywhere, saying why; a use is noted at most once an hour.
- **A grant never holds more than was given:** an invite's approver `invite:<id>` and scopes within the invite's; the
  owner's `owner:<email>` (never the bare email: never the owner's token), the resource's space id, a lifetime the part
  has.
- **`onRevoke` mirrors the kit**: `withdrawn` (a veto, or anything failing after `onGrant`'s yes) deletes its row, so
  its invite opens again; `client_revoked` ends the client's rows, any other end the grant's. Then, unless withdrawn,
  an agent's open invites under that grant or client are revoked; its joiners keep access. Told twice, nothing moves.
- **The owner's reason is closed first**: Remove, Invite again joining, `sweep` and `forget` end the row (`removed`,
  `replaced`, `expired`, `lapsed`, `space_gone`), then `revokeGrant`; Remove first revokes its invites, Invite again's
  too. The list hides removed and replaced members and shows other ended ones as signed out.
- **`resources` is a pure check of the path** (`spaceNameIn`): cased, encoded and dotted names are no space.
  `handles(ask)`: whether a sign-in is the part's (a space, the root or its MCP). A client's name is its own claim,
  kept after `appNameOf` (no control, bidi or zero-width character, 80 at most).
- **Who may share** (`sharerOf`): the owner signed in (never a team `member`), a key in `fixedKeys`, or an agent with
  a root token from a known grant: 7 or 30 days only, its client and grant on the record.
- **Nothing says whether a space exists.** Anyone who may not share, a name `spaceName` refuses and a space `byName`
  doesn't find all get the same 404 with the same body; an id from another space is the same 404 as a made-up one
  (every by-id statement takes the space). The code page never names the space.
- **Shown once means never kept.** `createInvite` and `inviteAgain` answer through `showOnce`, `no-store` (a retry
  with the same Idempotency-Key: 409 `shown_once`); `neverKept` (`/sharing/*`) keeps the pages' answers out too.
- **Never through A2A.** `sharingTools` go to the owner's MCP only. Each acts only on the user's word, and
  `create_invite` and `invite_again` return the message to send, never send it.
- **The claim is the insert**: `claimInvite` is one `insert … select … where` (unique `invite_id`, `grant_id`), as
  `addInvite` holds the cap. No transaction.
- **A revoke is always recorded**, whatever member holds it: a revoked invite never reopens.
- **No secret at rest**: codes, link tokens and addresses as HMACs, tickets as SHA-256. The migration's SQL holds no comment
  or quote.
- Standard: `docs/STANDARD.md` §7, §23

## Failure modes

| The caller sees | Why |
|---|---|
| `createSharing` throws | a secret under 32 bytes; a `resourcePath` without one whole `{space}` segment before another; `limits: false` |
| `registerSharing` throws "needs publicOrigin" | the app's `createOAuth` has none |
| `sweep` or `forget` throws "call registerSharing first" | called before the part is bound |
| the page "Use the address in your invite" | a client named the owner's whole app: no invite binds it |
| the code page again, "not one of ours" (400) | no open invite of the asked space (or, for a client that named none, of a space the app has) |
| `access_denied` at the app | the fifth wrong code on one sign-in, or the owner's Refuse |
| 429 page "Too many codes" | a typed-code limit (Limits) |
| 403 page "Not allowed" | a post from another site, of a sign-in these pages don't approve, or Approve without the owner |
| 400 page "expired", "refused", "already joined" | the ticket ran out, is another browser's, or was answered |
| the code page, "asks only to make changes" | a client asking only `write`, at a read invite |
| the owner page again (400) | Allow changes for an app that asked to read, or a write-only app without it |
| 404 page "No space … here" | the owner at a name `byName` misses |
| 401 page "Sign in first" | Continue as the owner without the owner signed in |
| 503 page "not ready" | `approve` before `registerSharing` |
| 404 "No space … here that you may share" | the caller may not share, or the name is not a space (always the same body) |
| 404 "No member …" | removed, replaced, another space's, or made up |
| 400 on `createInvite`, `inviteAgain` | a label empty, over 80 or not plain text (`PLAIN_TEXT`); an agent giving `until_revoked` |
| 409 on `createInvite`, `inviteAgain` | 100 open at the space, or `shown_once` |
| 409 on `revokeInvite` | the invite was used already: revoked all the same, its member keeps access |
| 400 `invalid_grant` "withdrawn" | `onGrant` said no: a space grant not from the part's pages, an invite not open at its space, more than it gives, a sharing approval at the root, or before `bind` |
| 401 "works only at its own space" | a live space token anywhere but its space's name now, or a space `byId` misses |
| 401 "ended on …", "lapsed", "not ready" | its lifetime passed; 30 days unused; a token with an audience before `bind` |
| 500 at `/oauth/token`, the invite open again | a throw after the claim: the kit withdraws the grant, so the row goes |
| a member who never got in, its code spent | the withdraw could not land (`onRevoke` failed, or a crash): the row lapses |

## Limits

- 100 open invites per space; lists 50 a page by default, 100 at most.
- An invite's code: 8 letters from 20 (about 34.6 bits), redeemable for a day. Typed codes: 10 a minute per address,
  then 60 per 10 minutes per space (`any` for a client that named none), 5 wrong per sign-in; never the owner's.
  Strangers' codes spend the space's 60 too, locking its invitees out for the window; set the app's `address`, or
  each post names its own.
- `sweep` deletes members 90 days ended, invites 7 days closed.

## Tests

- `test/sharing.test.ts`: the tables, states, secrets, races, every by-id statement at another space.
- `test/sharing-owner.test.ts`: who may share; invites; the same 404; probe T5; the lint and every tool run.
- `test/sharing-grants.test.ts`: probes T6, T7, `race.mts`; `onGrant`, `accepts`, `onRevoke`. Its contract
  (`test/sharing-grants-contract.ts`, `sweep` twice at once too) runs on node:sqlite and, in
  `test/workers/sharing.test.ts`, on D1.
- `test/sharing-signin.test.ts`: the ladder; the pages (probes T1, T2, T4); codes, limits; the owner's page and hop.
- `test/sharing-members.test.ts`: members listed, removed, invited again; `sweep`; `forget`.
- `test/sharing-app.test.ts`: §23 end to end over `test/sharing-fixture.ts`.

## Upgrading

What changed between kit versions, and what to do: [docs/upgrading.md#sharing](https://github.com/escalay/api-kit/blob/main/docs/upgrading.md#sharing).
