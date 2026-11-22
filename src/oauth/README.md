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
| `index.ts` | `createOAuth` (the server; `revokeClient` is the owner's kill switch), `generateOAuthKey` (a new signing key) |
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
- Standard: `docs/STANDARD.md` §7.

## Upgrading to grants

Defaults that change when an app takes this version:

- Rate limits, stored idempotency answers and A2A task ownership key an OAuth agent by `client` and `grant`, not by
  its name: same-named clients stop sharing a bucket or each other's tasks. A2A tasks stored under the old key (kept a
  day) are no longer found by their agent.
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
