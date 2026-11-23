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
POST /oauth/device                user_code [, decision=allow|deny]   (same-site only)
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
const resourceOf = (c: Context) => oauth.rootOf(c) + (SPACE.exec(c.req.path)?.[0] ?? '')
const oauth = createOAuth({
  …,
  // A pure check of the path: the kit has checked the origin, and the metadata path asks it too
  resources: (path) => /^\/s\/[a-z0-9-]+\/mcp$/.test(path),
  resourceOf,                                                  // where a 401 points (RFC 9728 §3.3)
  accepts: async (caller, c) => {
    // A tool's in-process /api call has the space's path no more: the app knows its space another way (`spaceOf`)
    const here = spaceOf(c) ?? resourceOf(c)
    return !caller.resource || caller.resource === oauth.rootOf(c) || caller.resource === here || `This token is for ${caller.resource}: connect again at ${here}.`
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
  tools call `/api` with the same bearer, and apps rewrite paths before the kit runs. A sentence refuses: 401
  `invalid_token`, the sentence as `detail` (and its printable ASCII as `error_description`), `resource_metadata` at
  `resourceOf(c)`. Compare audiences with `oauth.rootOf(c)`, the root as the kit signs it (canonical: a forwarded
  host in capitals or with its default port is the same root), not the raw origin.
- `listResources(origin)` names what the authorization server metadata lists (`protected_resources`, default the
  origin and `mcpPath`). Never list per-space resources there.
- `mcpPath` keeps the pointer, the metadata, the listed resources and the relay (`read` may POST there) on MCP when it
  is mounted elsewhere: pass `mountMcp`'s `path`.

Two exceptions to "a token is accepted only by its audience" (MCP 2026-07-28 asks servers to reject tokens not meant
for them, or otherwise verify they are the intended recipient):

- **A token with no `aud` is accepted** by the default `accepts`: every token, code, device approval, refresh token and
  agent registration from before audiences has none, and none ever gains one. Connections made before keep working.
- **A root token is accepted at a space's resource** by the default `accepts`, which takes it everywhere on the
  origin: a client that sends no `resource`, or a connection made before the app had spaces, keeps working there. The
  app, with one issuer and a row per grant, is then what verifies the token is meant for it. An app that wants a space
  to take only its own tokens refuses the root there in its `accepts`.

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
| `index.ts` | `createOAuth` (the server; `revokeClient` is the owner's kill switch; `rootOf`, `resourceOf` and `mcpPath` as it reads them), `generateOAuthKey` (a new signing key) |
| `store.ts` | `OAuthStore` (`get`, `put`, `delete`, plus `take` and `markUsed`), `dbOAuthStore(db)` (in the app's database, node:sqlite or D1; drops expired rows at start), `memoryOAuthStore` |
| `schema.ts` | the `oauth` table and `OAUTH_MIGRATIONS` |

## Rules

- The signing key lives in the app's secrets, never in the repo; rotating it signs everyone out. `createOAuth` parses
  it when called: a malformed key throws there, at start, not on the first OAuth request.
- `owner` decides who may approve: behind Cloudflare Access, `accessOwner(access)` (the signed-in email).
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
- An approval form posted twice at once (a double-clicked Approve) approves once: the consent page takes its ticket
  (the other post gets "This approval expired", 400), the claim page takes the claim attempt ("This code expired",
  410), and the device page takes the typed code (the code form again, 400), so Allow and Deny from two tabs write one
  answer.
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
- In Access, `/oauth/device` stays behind the sign-in (like `/oauth/authorize` and `/oauth/claim`);
  `/oauth/device_authorization` bypasses it. Name the path exactly: an Access path without `*` covers only itself, while
  `/oauth/device*` would also gate `/oauth/device_authorization` and break every device.
- Keep the OAuth paths open (`OAUTH_OPEN_PATHS`); `createAgentApi` does it when `oauth` is set, private mode included.
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

Codes, device approvals, refresh tokens and agent registrations from before audiences (claimed or not) never gain one,
whatever resource the client sends: their tokens stay aud-less, accepted everywhere. A code written by the previous
version kept the query's `resource` as it came; it is never signed.
