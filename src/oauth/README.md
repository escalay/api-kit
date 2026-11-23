# oauth

The app as its own OAuth server, so MCP clients (Claude, ChatGPT) and agents connect without a pasted key: dynamic
client registration, authorization code with PKCE, the device authorization grant (RFC 8628) for CLIs and devices
without a browser, refresh rotation, revocation, agent registration through `/auth.md` with a 6-digit owner claim,
ES256 tokens with `read` / `write` scopes, and the metadata documents.

Needs: `core`, `db`.

```ts
import { accessOwner, createAgentApi, createOAuth, dbOAuthStore, generateOAuthKey } from './kit/index.js'

const oauth = env.OAUTH_SIGNING_KEY
  ? createOAuth({ name: 'Notes', signingKey: env.OAUTH_SIGNING_KEY, store: await dbOAuthStore(db), owner: access ? accessOwner(access) : async () => null })
  : undefined
const app = createAgentApi({ …, oauth })                   // mounts /oauth/*, the metadata, and accepts its tokens
```

## Device authorization (RFC 8628)

```
POST /oauth/register              { client_name, grant_types: ["urn:ietf:params:oauth:grant-type:device_code"] }  (no redirect_uris)
POST /oauth/device_authorization  client_id, scope → { device_code, user_code: "BDKM-QXTW", verification_uri,
                                                       verification_uri_complete, expires_in: 600, interval: 5 }
GET  /oauth/device[?user_code=]   the page where the signed-in owner types the code (HTML, like /oauth/authorize)
POST /oauth/device                user_code [, decision=allow|deny]   (same-origin only)
POST /oauth/token                 grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=…
                                  → authorization_pending | slow_down (+ interval) | expired_token | access_denied | tokens
```

Nothing to wire: `mount` adds it, and the metadata names `device_authorization_endpoint`.

## Audiences (RFC 8707)

Every grant is bound to one resource, signed as its tokens' `aud` and on the caller as `resource`:

- The resource the client sends at `/oauth/authorize` (or `/oauth/device_authorization`), when this server issues for
  it: the origin, `mcpPath` (default `/mcp`), and with `resources` set, what it approves.
- Else the **root**, the issuer's origin: a client that sends no `resource`, or (without `resources`) one the app does
  not describe. The default `accepts` takes a root token everywhere on the origin, so nothing changes for it.
- An agent registered at `/agent/identity` (auth.md) names no resource: its grant gets the root when it registers,
  and its claim, refresh and jwt-bearer tokens carry it. One registered before audiences stays without, even if
  claimed after.

The audience is fixed at the authorization request. A token request naming another resource is `invalid_target`,
checked before anything is written, so the code or refresh token still works with the right one. Refresh keeps the
audience. When the server chose the audience (the root), a `resource` the client sends later is not held against it.

A resource is compared in its canonical form: an absolute http(s) URL, scheme and host lower-cased, the default port
and one trailing slash dropped (`HTTP://Example.test:443/mcp/` is `https://example.test/mcp`). A user part, a query,
a fragment, a dot segment or an encoded dot (`%2e`) makes it no resource: `invalid_target` with `resources` set, the
root without. More than one `resource`, or one not sent as a string, is refused: a 400 page at authorize,
`invalid_target` at `/oauth/device_authorization` and the token endpoint, before anything is written. A code, device
approval, refresh token or agent registration from before audiences ignores `resource` altogether, two of them
included: it stays aud-less. Errors at authorize are pages, never redirects.

An app serving several MCP resources, one per space (`/s/alpha/mcp`), passes `resources` and `resourceOf`. The
default `accepts` then takes a token whose audience is exactly `resourceOf(c)` (RFC 8707's own rule), besides an
aud-less one and one for the root or `mcpPath`, so each space's token works at its own address and nowhere else. MCP
tools that call `/api` in-process with the same bearer lose the space's path, so a space's token is refused there
unless the app passes its own `accepts`, as here:

```ts
const SPACE = /^\/s\/[a-z0-9-]+\/mcp/
const resourceOf = (c: Context) =>
  oauth.rootOf(c) + (SPACE.exec(c.req.path)?.[0] ?? (c.req.path === oauth.mcpPath || c.req.path.startsWith(oauth.mcpPath + '/') ? oauth.mcpPath : ''))
const oauth = createOAuth({
  …,
  // A pure check of the path: the kit has checked the origin, and the metadata path asks it too
  resources: (path) => /^\/s\/[a-z0-9-]+\/mcp$/.test(path),
  resourceOf,                                                  // where a 401 points (RFC 9728 §3.3)
  accepts: async (caller, c) => {
    // The path decides at an MCP address, a space's or mcpPath. Elsewhere, as in a tool's in-process /api call, the
    // path names none: only then does the app read the space the call carries (`spaceOf`)
    const root = oauth.rootOf(c)
    const here = resourceOf(c) === root ? (spaceOf(c) ?? root) : resourceOf(c)
    // An aud-less, root or mcpPath token works everywhere, as with the default
    return !caller.resource || caller.resource === root || caller.resource === root + oauth.mcpPath || caller.resource === here || `This token is for ${caller.resource}, not ${here}: connect again there.`
  },
})
```

- With `resources` set, the kit checks the resource's origin is the issuer's, exactly (a longer host that starts with
  it is another origin), then asks `resources` for the path. Another origin or a refused path is `invalid_target`,
  and `/.well-known/oauth-protected-resource<path>` is 404 for a path it refuses. Without it, the metadata echoes any
  path, as before.
- `resources` must be a pure function of the string, with no lookup: it answers the metadata path too, so a lookup
  would tell anyone which spaces exist. Whether one exists or is open is decided when the person approves.
- `accepts` runs on every request after the token's signature and revocation checks, in-process calls included: MCP
  tools call `/api` with the same bearer, and apps rewrite paths before the kit runs. Whatever carries the space to an
  in-process call (`spaceOf`) must be something a client cannot set, such as a header the app strips from every
  outside request, and the request's own path outranks it at every MCP address, a space's or `mcpPath`: otherwise a
  client sends the carrier with one space's token and reaches another, or `mcpPath`. A sentence refuses: 401
  `invalid_token`, the sentence as `detail` (and its printable ASCII as `error_description`), `resource_metadata` at
  `resourceOf(c)`. Compare audiences with `oauth.rootOf(c)`, the root as the kit signs it (canonical: a forwarded
  host in capitals or with its default port is the same root), not the raw origin.
- Keep `mcpPath` in `resourceOf` and in `accepts`: without it, a token asked for `<origin>/mcp` (what MCP clients
  send) is refused at `/mcp`, `/api` and every space, and the 401 at `/mcp` points at the origin's metadata.
  `test/oauth.test.ts` runs this example as written.
- `listResources(origin)` names what the authorization server metadata lists (`protected_resources`, default the
  origin and `mcpPath`). Never list per-space resources there.
- `mcpPath` keeps the pointer, the metadata, the listed resources and the relay (`read` may POST there) on MCP when it
  is mounted elsewhere: pass `mountMcp`'s `path`.
- The spaces' MCP endpoints are relays too, so a `read` token may POST there: `auth: { …, relay: ['/mcp', '/a2a',
  '/s/*/mcp'] }`. `relay` takes the same patterns as `open` (`matches`): a star inside is one whole path segment, so
  `/s/*/mcp` matches `/s/alpha/mcp` and not `/s/alpha/mcp/x`. It replaces the default (`mcpPath` and `/a2a`), so list
  those too.

Three exceptions to "a token is accepted only by its audience" (MCP 2026-07-28 asks servers to reject tokens not meant
for them, or otherwise verify they are the intended recipient):

- **A token with no `aud` is accepted** by the default `accepts`: every token, code, device approval, refresh token and
  agent registration from before audiences has none, and none ever gains one. Connections made before keep working.
- **A root token is accepted at a space's resource:** the default `accepts` takes it everywhere on the origin, so a
  client that sends no `resource`, or a connection made before the app had spaces, keeps working there. The app, with
  one issuer and a row per grant, is then what verifies the token is meant for it. An app that wants a space to take
  only its own tokens refuses the root there in its own `accepts`.
- **A token whose `aud` is the origin plus `mcpPath` is accepted everywhere on the origin** by the default `accepts`:
  MCP tools call `/api` in-process with the same bearer, so the token for the single MCP must fit the whole origin,
  spaces included. An app that wants otherwise refuses it in its own `accepts`, as for the root.

## Who approves a sign-in

By default the owner approves every sign-in on the kit's own page at `/oauth/authorize`, behind the single sign-on
(`owner`). An app that decides for itself (an invite, an ask to join, a page for strangers) passes `approve`, and hears
every first token in `onGrant`:

- `approve(c, ask)` runs at `GET /oauth/authorize` once the kit has checked the client, its redirect, PKCE and the
  resource, before `owner`. A Response is the app's page; null shows the kit's page to the owner. `ask` is a
  `SignInAsk`: `ticket`, `client` (`id`, `name`, `redirectUris`), `redirectUri`, `redirectHost` (a host, or an app's
  scheme such as `sample-app:`), `onThisComputer` (a loopback or app-scheme redirect), `scopes`, `resource` (the audience
  the grant gets), `state`, and `arrival` (`site`: the first GET's `Sec-Fetch-Site`, `referrerOrigin`: its
  `Referer`'s origin, each null when not sent).
- The app's page posts the ticket to the app's own route, which reads it with `oauth.ticketOf(c, ticket)` (null when
  expired, answered, or opened in another browser; then `oauth.answeredOf(c, ticket)` says `approved`, `denied` or
  `answered` for a ticket this browser spent already, so the route can say "Already approved") and answers with `oauth.complete(c, ticket, decision)`:
  `{ approver, scopes?, data? }` or `'deny'`. `approver` becomes the token's `sub` (`caller.owner`), `scopes` may only
  narrow what was asked (a wider or empty list is a 400 page), `data` goes on the code and reaches `onGrant`. The
  resource is the ticket's; `complete` never sets one. It returns the 302 to the client (`code`, `state`, `iss`, or
  `access_denied`) or a 400/403 page. A blank `approver` is a 400 page, and the ticket stays live.
- `onGrant(grant, c)` hears the first token of every grant: `kind` (`code`, `device` or `claim`), `grant`, `client`
  (`id`, `name`), `approver`, `scopes`, `resource` (absent on a grant from before audiences) and `data`. It runs after
  the kit's own checks (client, redirect and verifier for a code; the owner's answer for a device; the collected claim
  token for a claim), once per grant however many polls race. false withdraws it: `invalid_grant` ("This sign-in was
  withdrawn: start again"), the code or device code spent, a claim's grant revoked. It is not asked on refresh or
  jwt-bearer: judge later requests in `accepts`. An app that keeps its own rows per grant makes them here and refuses
  a token whose grant has none.

An app that approves by an invite typed on its own page (`test/oauth.test.ts` runs it as written):

```ts
// The invites the owner made, each for one person (an app keeps them in its database)
const INVITES = new Map([['garden-42', 'owner@example.test']])
const invitePage = (ask: SignInAsk, note = '') => `<!doctype html><meta name="referrer" content="same-origin"><title>Join Sample</title>
<p>${escape(ask.client.name)} asks to use Sample (${escape(ask.resource)}) and returns to ${ask.onThisComputer ? 'an app on this computer' : escape(ask.redirectHost)}. ${note}</p>
<form method="post" action="/join"><input type="hidden" name="ticket" value="${ask.ticket}"><input name="invite" aria-label="Invite code"><button>Join</button></form>`

const oauth = createOAuth({
  name: 'Sample', signingKey, store, owner,
  approve: async (c, ask) => c.html(invitePage(ask)),                                          // every sign-in starts at the app's page
  onGrant: async (grant) => grant.kind !== 'code' || INVITES.delete(grant.data?.invite ?? ''),  // spent with the first token
})
const app = createAgentApi({ title: 'Sample', version: '1.0.0', description: 'A sample.', tags: [], auth: { realm: 'sample', keys: parseApiKeys(''), open: ['/join'] }, oauth })
app.post('/join', async (c) => {
  const body = await c.req.parseBody()
  const ticket = String(body.ticket ?? '')
  const ask = await oauth.ticketOf(c, ticket)
  if (!ask) return c.html((await oauth.answeredOf(c, ticket)) === 'approved' ? '<p>Already approved: return to your app.</p>' : '<p>This sign-in expired: start again from your app.</p>', 400)
  const holder = INVITES.get(String(body.invite ?? ''))
  if (!holder) return c.html(invitePage(ask, 'That invite code is not one of ours.'), 400)
  return oauth.complete(c, ask.ticket, { approver: holder, scopes: ['read'], data: { invite: String(body.invite) } })
})
```

- `escape` is the app's own HTML escaping. The app's routes are its own to open (`auth.open`) and to limit.
- **An app's own approval page carries `<meta name="referrer" content="same-origin">`** (or a proxy in
  front of the app sets that policy), as the kit's pages do. `createAgentApi` serves every page with `Referrer-Policy: no-referrer` and replaces
  one a route sets; under it a browser posts the form with `Origin: null`, and where it sends no `Sec-Fetch-Site`
  either (plain http at an address other than this machine's) the POST is refused (403).
- **Nothing is granted without a click.** There is no approve-at-once answer: a grant follows only `complete`, from a
  same-origin POST, by the browser that opened the ticket, once. A stored approval never stands in for one: the same
  client and approver signing in again see the page again.
- **The ticket is bound to the browser.** Every `GET /oauth/authorize` that stores a ticket sets an HttpOnly,
  SameSite=Lax nonce cookie, `__Host-oauth_ticket` on https (`oauth_ticket` on http; on https only the `__Host-` name is
  read), Path `/`, Max-Age 600. A live one is reused and its Max-Age renewed, so a second sign-in in the same browser
  neither breaks the first nor shortens the second. The ticket keeps only the nonce's SHA-256.
- **Same-origin, not same-site.** `complete`, the kit's consent POST, `/oauth/claim` and `/oauth/device` take a POST
  only with `Sec-Fetch-Site: same-origin`, or, with no such header, an `Origin` equal to the issuer's. A missing
  header with no matching `Origin` is refused (403), and so is `same-site`: a sibling host is same-site. `Origin: null`
  never matches; the kit's pages set their referrer policy to `same-origin` so a browser sends the real one.
- **A ticket is answered once.** It is marked used and kept, its nonce hash and the answer only, until its 10 minutes
  end. Posted again from the browser that answered it (a double click, a tab brought back), it is a page that says the
  sign-in went through ("Already approved") or was refused, with no code and no redirect; from another browser it is
  "This approval expired".
- **With `approve` set, `/oauth/authorize` never redirects before a person acts:** every error (an unknown client, a
  wrong redirect, `response_type`, PKCE, the resource) is a 400 page with no link. Without it, today's order holds:
  the owner first, then a `response_type` or PKCE error goes back to the client's redirect.
- The kit's page answers only for the owner it was shown to: a ticket the app's page holds can't be approved there.
- `/oauth/claim` and `/oauth/device` stay the owner's (`owner`, `owners`); `approve` is for `/oauth/authorize` only.
- In Access, `/oauth/authorize` may bypass the sign-in once the app passes `approve`: the app's page decides. Keep it
  gated otherwise. A ticket is stored only when a page holds it: the app's, or the kit's shown to the owner. A visit
  `approve` sends to the owner's sign-in stores nothing; one the app's page answers stores a 10-minute row, as an open
  `/oauth/register` stores a client. An app whose sign-in is reachable outside Access passes `publicOrigin` and
  `limits` (below): `oauth.mount` runs inside `createAgentApi`, before any middleware the app adds, so the app can't
  limit these endpoints itself.
- With `onGrant` set, a claimed agent's identity assertion (jwt-bearer) works only once its claim was collected and
  heard, so an anonymous agent can't skip `onGrant` with the assertion it got at registration.
- Every page the kit shows (consent, device, claim, errors) carries the app's brand when it has one
  (`createAgentApi({ brand })`, or `brand` here): its head tags, icon, title and accent. Without one, the plain look.
  A client is named by text only: a `logo_uri` it registers is never fetched or shown.
- The consent page names what is asked for, `Sample: /s/alpha/mcp` (all of Sample for the root), and where it
  returns: a host, or "an app on this computer" for a loopback or app-scheme redirect.
- Rules after cloudflare/workers-oauth-provider (the browser-bound, single-use consent ticket; never redirect before
  the redirect is checked) and oidc-provider (the grant is saved before the code exists), both MIT.

In tests, `approveSignIn(app, query, { headers })` from the `testing` part approves on the kit's page the way a
browser does: it opens the page, keeps its ticket cookie, and posts same-origin.

```ts
import { approveSignIn } from './kit/testing/index.js'

const answer = await approveSignIn(app, { response_type: 'code', client_id, redirect_uri, code_challenge, code_challenge_method: 'S256' }, { headers: { 'x-test-owner': 'owner@example.test' } })
const code = new URL(answer.headers.get('location')!).searchParams.get('code')
```

## Open endpoints: one origin, lifetimes, caps and limits

Registration, device authorization, `/agent/identity`, the token endpoint and, with `approve`, `/oauth/authorize` answer
anyone and write rows without auth. Once people other than the owner sign in, they are a public surface:

```ts
const oauth = createOAuth({
  …,
  publicOrigin: 'https://sample.example.test',                                  // the only origin it names or checks
  limits: { store: await dbGuardStore(db), address: { header: 'cf-connecting-ip' } },   // per address, never the owner
})
```

- **`publicOrigin`** is the one origin of the issuer, every token's `iss` (and `verify`'s check of it), every metadata
  document, auth.md, the 401's `resource_metadata`, the device and claim links, `rootOf` (so the resource check and
  the root audience), the same-origin rule on every approval POST and the ticket cookie's name. `createAgentApi` also
  names it in every discovery document cached publicly (`public, max-age=3600`): `api-catalog`, `robots.txt`,
  `sitemap.xml`, `poppy.json` (organization, APIs and issuer), and with their parts the Server Card, the Agent Card,
  the skills index and archives, and the AI Catalog. A forged `X-Forwarded-Host` then reaches no shared cache, and the
  metadata and auth.md are cached publicly (`public, max-age=300`). Unset, each request's own origin is used,
  forwarded host included, and the metadata and auth.md are `no-store`; the other discovery documents stay
  `public, max-age=3600` as before, so behind a proxy that passes a caller's `X-Forwarded-Host` through, they can be
  poisoned. Not covered either way: what is never cached publicly (HAL links, `/openapi.json`, the guide, problem
  `type` URLs) keeps the request's origin. It must be an origin with no path (`createOAuth` throws otherwise), and it
  must be the origin tokens were issued under: setting one that differs signs everyone out, since their tokens' `iss`
  no longer matches.
- **A registration no sign-in has used lives a week** (`/oauth/register`; long enough for an invite of a day, with
  room). Its first use (a code exchanged, a device token collected) gives it a year from then. One that lapses meets
  the page that says to remove the connection in the app and add it again (a client never hears `invalid_client` at
  `/oauth/authorize`), and `invalid_client` at `/oauth/device_authorization`. A client registered before this version
  has no `used` flag and keeps its year. An agent's `/agent/identity` registration lives a day, as before. An approval
  after the lapse is refused, but a code approved in the last minutes of the week can still be exchanged after it (a
  code lives 10 minutes), and the lapsed client is not made again: that sign-in's tokens and refresh tokens work,
  while a new sign-in with that client_id meets the "add it again" page.
- **Unused registrations are capped** (`maxUnusedClients`, default 10 000): past it, a new registration evicts the
  oldest unused one, so the table stays bounded whatever the addresses. A used client, or one from before, is never
  evicted. **Open consent tickets are capped the same way** (`maxUnusedTickets`, default 10 000): an answered ticket
  takes no place. The cap needs the store's `trim` (`dbOAuthStore` and `memoryOAuthStore` have it); a store without it
  is not capped. Both caps are whole numbers, 0 or more (`createOAuth` throws otherwise). The cap is soft under
  concurrency: each write trims before it inserts, so requests that arrive together can all pass the trim and leave
  the table over the cap by as many as were in flight, until the next write trims it back. Each capped write runs one
  trim over its kind's unused rows; with `limits` off, nothing slows a flood of them, so an app whose sign-in is
  reachable outside Access also passes `limits`.
- **`dbOAuthStore` prunes expired rows** on a write, at most once a minute, besides when it is made.
- **`limits`** (default `false`: none) counts per address, read by `addressOf` from `address` (default the app's
  `createAgentApi({ address })`). A named source counts a global IPv6 address by its /64; with none named, the
  `'headers'` read takes the address as sent, each IPv6 address on its own. Past a limit: 429 with `Retry-After` (JSON
  `too_many_requests`, a page at authorize). A request whose `owner(c)` answers (the owner signed in) is never counted.

| Endpoint | Limit per address |
|---|---|
| `POST /oauth/register`, `POST /agent/identity` and `POST /agent/identity/claim`, together | 20 an hour |
| `POST /oauth/device_authorization` | 20 an hour |
| `GET /oauth/authorize` | 60 a minute |
| `POST /oauth/token`: misses only (`invalid_grant`), counted after the lookup | 30 a minute |

- Only a miss counts at the token endpoint, and only a miss is refused, so a right code or refresh token is never
  turned away by other people's junk, and a device polling (`authorization_pending`, `slow_down`) counts nothing.
- On Workers pass `dbGuardStore(db)`, so every isolate shares the counts, and `address: { header: 'cf-connecting-ip' }`
  (`AddressTrust`, core's README; behind another proxy, the header it writes): the default read takes
  `cf-connecting-ip` or `x-forwarded-for` as sent, which a caller can set to anything, without the /64 grouping, so
  one IPv6 host gets a bucket per address. Where the named source is missing every caller shares the single `local`
  bucket, which anyone can fill.

## Callers, grants and revoking

An OAuth caller is `{ kind: 'agent', client, grant, name, scopes, owner }`:

- `client` is the client_id (a registration id for a claimed agent). Rate limits, idempotency answers and MCP's
  `authInfo.clientId` key on it, with `grant`; `name` is what the client called itself, for display only, so two
  clients that register the same name are two callers.
- `grant` is one approval: every token from one sign-in (a code, a device approval, a claim), rotated or not, carries
  it. A claimed agent's claim, refresh and jwt-bearer tokens share one, so once that grant is revoked (a replayed
  refresh token, `revokeGrant`) its identity assertion is refused too: the agent registers again. A registration is
  approved once: a second claim code typed for it gets an "Already approved" page (409), never a second grant. Tokens issued before
  grants have none and run to their hour, known by `client`; a claim from before grants uses its registration id.
- `verify` reads the issued row and both revocation markers (the client's, and the grant's when the token has one) in
  one round trip: three row reads per request with a grant, two without.

```ts
await oauth.revokeGrant(caller.grant)   // ends that sign-in at once: its access tokens fail now, its refresh tokens too
await oauth.revokeClient(clientId)      // every sign-in of the client, and drops its registration: it registers again
```

`revokeClient` also ends what was approved but not yet collected: a code exchanged, or a device approval or a claim
token polled after it, gets `invalid_grant`, and the device page refuses a code whose client is gone. A claim token
collected after `revokeGrant` ended its grant gets `invalid_grant` too: a claimed agent can learn its grant through
jwt-bearer before it collects the claim, and a refresh token issued into that grant would outlive the marker and undo
the revoke. The claim grant reads both markers after it takes the claim token, so a revoke landing during the poll
counts. Both markers (`revokeGrant`'s and `revokeClient`'s) are kept 30 days and 20 minutes, longer than a refresh
token issued from a code or device approval collected at the last moment.

`createOAuth({ …, reuseGraceSeconds: 30 })`: a used refresh token sent again inside the window (a client that lost the
answer and retried) gets the same successor, an HMAC of the used token under a secret derived from the signing key, so
none is stored. Never a second branch: once that successor is used, or the window has passed, it is reuse. The default
is 0: any replay revokes the grant. The successor is written by the first request, after it marks the used token: if
that request dies in between, a retry in the window gets a successor no row backs, and its next refresh is
`invalid_grant` (with 0 the retry would have revoked the grant instead). The retry never writes the row itself, since
a write there could reset a successor already used.

| File | What |
|---|---|
| `index.ts` | `createOAuth` (the server; `revokeClient` is the owner's kill switch; `rootOf`, `resourceOf` and `mcpPath` as it reads them; `ticketOf`, `answeredOf` and `complete` for the app's own sign-in page), `generateOAuthKey` (a new signing key) |
| `approval.ts` | `SignInAsk`, `SignInDecision`, `SignInGrant`; the ticket cookie and the same-origin rule |
| `store.ts` | `OAuthStore` (`get`, `put`, `delete`, plus `take`, `markUsed` and `trim`), `dbOAuthStore(db)` (in the app's database, node:sqlite or D1; drops expired rows at start, then on a write at most once a minute), `memoryOAuthStore` |
| `schema.ts` | the `oauth` table and `OAUTH_MIGRATIONS` |

## Rules

- The signing key lives in the app's secrets, never in the repo; rotating it signs everyone out. `createOAuth` parses
  it when called: a malformed key throws there, at start, not on the first OAuth request.
- `owner` decides who may approve on the kit's pages: behind Cloudflare Access, `accessOwner(access)` (the signed-in
  email). `approve` lets the app decide at `/oauth/authorize` instead (above).
- Refresh tokens last 30 days and rotate on each use; MCP clients and claimed agents both get one. Only their hashes
  are kept. A used token sent again revokes its grant (every refresh token of that sign-in, and its access tokens at
  once), as does revoking any one of them. Two refreshes of one token at once rotate once: the second is that replay,
  unless `reuseGraceSeconds` covers it.
- A code is used once, even by a failed exchange, and kept until its 10 minutes end. Sent again with the right client
  and verifier, it revokes the grant the first exchange got (OAuth 2.1 §4.1.3); with a wrong verifier it revokes
  nothing. The trade: someone who sees the code in the redirect (a log, a Referer, a shared history) and sends it
  first with any verifier spends it, so the real client's exchange fails and the person connects again. Nothing is
  issued or exposed. `redirect_uri` at the token endpoint is checked when sent and may be left out (PKCE binds the code).
- A device code and a claim token give tokens once, however many polls arrive together: the owner's device answer is
  marked collected, and the claim token is taken. The polls that lose hear `invalid_grant` (device) or `expired_token`
  (claim).
- An approval form posted twice at once (a double-clicked Approve) approves once: the consent page marks its ticket
  used (the other post gets "Already approved", or "Already answered" while the first is still saying so; 400, no
  code), the claim page takes the claim attempt ("This code expired", 410), and the device page takes the typed code
  (the code form again, 400), so Allow and Deny from two tabs write one answer.
- Revoking an access token (`/oauth/revoke`) ends only that token; `revokeGrant` ends the sign-in.
- The store makes single use hold under concurrent requests: `markUsed` (codes, refresh tokens) and `take` are one
  statement each in `dbOAuthStore`, honour expiry, and read a row with no `used` key (a sign-in from before) as
  unused. A store without them falls back to a read then a write, safe only one request at a time: tests.
- OAuth rows live in SQLite or D1, never Workers KV: KV is eventually consistent, so a new code reads as unknown and a
  revoke can be undone.
- `test/oauth-store-contract.ts` is what every store must pass, with the attacks on the token endpoint; it runs on
  memory, node:sqlite and D1. Rules after cloudflare/workers-oauth-provider and better-auth (both MIT).
- Device codes: 8 letters from `BCDFGHJKLMNPQRSTVWXZ` (no vowels), shown as `XXXX-XXXX`, case and dashes ignored;
  10 minutes; single use; only hashes kept. A signed-in person may type 5 wrong codes in 10 minutes, then 429. When
  `owners` is set, only they may approve. Polling sooner than `interval` answers `slow_down` and adds 5 seconds.
- In Access, `/oauth/device` stays behind the sign-in (like `/oauth/claim`, and `/oauth/authorize` unless the app
  passes `approve`);
  `/oauth/device_authorization` bypasses it. Name the path exactly: an Access path without `*` covers only itself, while
  `/oauth/device*` would also gate `/oauth/device_authorization` and break every device.
- Keep the OAuth paths open (`OAUTH_OPEN_PATHS`); `createAgentApi` does it when `oauth` is set, private mode included.
- An app whose sign-in is reachable outside Access passes `publicOrigin` and `limits`.
- Standard: `docs/STANDARD.md` §7 (audiences there too) and §11.

## Upgrading to grants

Defaults that change when an app takes this version:

- Rate limits, stored idempotency answers and A2A task ownership key an OAuth agent by `client` and `grant`, not by
  its name: same-named clients stop sharing a bucket or each other's tasks. A2A tasks stored under the old key (kept a
  day) are no longer found by their agent.
- MCP's `authInfo.clientId` is an OAuth agent's client_id (before, the name it registered). A tool that showed or
  stored the name reads `authInfo.extra.name`; the grant is `authInfo.extra.grant`.
- `verify` refuses a token whose grant was revoked at once (before, up to an hour), including after a refresh token is
  replayed. A claimed agent's identity assertion is refused once its grant is revoked: it registers again.
- A code sent twice with its verifier revokes its sign-in.
- `revokeClient` deletes the registration: a revoked client registers again. A code or a device approval collected
  after it gets `invalid_grant` (before, it was issued tokens `verify` refused), and so does a claim token (before,
  `expired_token`, or tokens when the revoke landed during the poll).
- A claim token collected after `revokeGrant` ended its grant gets `invalid_grant` (before, it was issued a refresh
  token in the revoked grant, which outlived the revoke marker).
- A second claim code typed for a registration already approved is refused with a 409 page (before, it replaced the
  registration's grant, so its jwt-bearer tokens and its claim and refresh tokens no longer shared one).
- `createOAuth` throws on a malformed signing key when called. On Node a bad key already stopped the process at start
  (an unhandled rejection); on Workers the app now fails to build instead of failing only its OAuth requests.

Tokens, codes, refresh rows and claims from before grants keep working.

## Upgrading to audiences

Defaults that change when an app takes this version:

- **New tokens carry `aud`.** Every grant made from now on is bound: the resource its client asked for (the origin or
  `/mcp`), else the root (the origin). The default `accepts` takes the root and `/mcp` everywhere on the origin, so
  tokens work where they did. Code that reads a token's claims sees `aud`, and the caller has `resource`.
- A token request naming a resource other than the authorization request's is `invalid_target` (before, ignored).
- More than one `resource` at `/oauth/authorize` is a 400 page (before, the first was kept); at
  `/oauth/device_authorization` and the token endpoint it is `invalid_target`, and so is a JSON `resource` that is not a
  string (before, ignored). A grant from before audiences still ignores it.
- `oauth.verify` may answer `{ refused }` (a valid token `accepts` turned away), which is truthy: code calling it
  directly checks for `'refused' in answer` before treating the answer as a caller. Only an app's own `accepts` or a
  token for another resource gives one; `createAgentApi` already handles it.
- With OAuth on, the 401 challenge names `scope="read write"`; a 403 `insufficient_scope` names `resource_metadata`.
  Without OAuth the challenge is unchanged.
- The 401 pointer uses `mcpPath` exactly: `/mcp` and `/mcp/…` point at `/.well-known/oauth-protected-resource/mcp`,
  `/mcpx` no longer does. `createAgentApi`'s default relay follows `mcpPath`, so an app with MCP mounted elsewhere
  that passes it stops needing `write` for every MCP POST.
- A star inside a pattern in `auth.open`, `guards.skip` and `auth.relay` now matches one whole path segment: `/a/*/b`
  matches `/a/x/b` and not `/a/x/y/b`, and `/a/**` matches `/a/x` and `/a/x/y`. Before, such a star was literal and
  matched nothing an app serves, so check those lists for an inner or doubled star before updating. Exact,
  leading-star and trailing-star patterns are unchanged in `open` and `skip`; `relay` compared paths exactly before,
  so a star anywhere in it was literal and now matches as in `open`.

Codes, device approvals, refresh tokens and agent registrations from before audiences (claimed or not) never gain one,
whatever resource the client sends: their tokens stay aud-less, accepted everywhere. A code written by the previous
version kept the query's `resource` as it came; it is never signed.

## Upgrading to approvals

New, off unless set: `approve`, `onGrant`, `ticketOf`, `answeredOf`, `complete`, and `brand` (the app's brand on the kit's pages is
on by itself once the app has one). Defaults that change when an app takes this version:

- **Breaking for tests:** a POST to `/oauth/authorize` needs the ticket cookie its page set, and is refused (403) when
  `Sec-Fetch-Site` is absent and `Origin` is not the issuer's; `/oauth/claim` and `/oauth/device` take the same origin
  rule (before, an absent header passed). Over https and on this machine's own address, browsers send
  `Sec-Fetch-Site`, so people notice nothing. Over plain http at another address they may not, and then only `Origin`
  decides: the kit's pages carry `<meta name="referrer" content="same-origin">` so it is the issuer's, and an app's own
  approval page needs the same tag (without it the browser sends `Origin: null`, refused). A test that posts an
  approval by hand breaks. Use `approveSignIn` from the `testing` part, and add `'sec-fetch-site': 'same-origin'` to
  hand-made claim and device POSTs.
- A ticket opened before the update has no nonce: it is refused once ("This approval expired") and lapses within 10
  minutes; the person starts again.
- A consent ticket posted again from the browser that answered it says "Already approved" (or "Already answered")
  instead of "This approval expired". Still 400, still no code.
- The page for an unknown or expired `client_id` says to remove the connection in the app and add it again. The
  consent page names the resource asked for and says "an app on this computer" for a loopback or app-scheme redirect;
  the device page says when the client has no page to send anyone back to.
- With `onGrant` set, a claimed agent's identity assertion (jwt-bearer) is refused until its claim token was collected
  and heard. An agent claimed before the app set `onGrant` keeps its refresh tokens; its assertion (a day at most) is
  refused, so it refreshes or registers again.

## Upgrading to open sign-in

New, off unless set: `publicOrigin`, `limits`, `maxUnusedClients` and `maxUnusedTickets` (both default 10 000), and
the store's `trim`. Defaults that change when an app takes this version:

- **Without `publicOrigin`, the metadata and auth.md are `no-store`** (before, `public, max-age=300`): a forged
  `X-Forwarded-Host` could have put another origin's documents in a shared cache. A client fetches them once more per
  connection. Set `publicOrigin` to cache them again.
- **A registration left unused for a week lapses** (before, every registration lived a year): the client registers
  again, and a person who opens its sign-in link meets the "add it again" page. Its first sign-in gives it a year.
  Registrations from before keep their year.
- **Unused registrations are capped at 10 000**, and so are open consent tickets: past it the oldest goes.
- `dbOAuthStore` prunes expired rows while it runs, at most once a minute.

Nothing else changes until the app passes `publicOrigin` or `limits`.
