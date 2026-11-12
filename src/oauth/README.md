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

| File | What |
|---|---|
| `index.ts` | `createOAuth` (the server; `revokeClient` is the owner's kill switch), `generateOAuthKey` (a new signing key) |
| `store.ts` | `dbOAuthStore(db)` (in the app's database; drops expired rows at start), `memoryOAuthStore` |
| `schema.ts` | the `oauth` table and `OAUTH_MIGRATIONS` |

## Rules

- The signing key lives in the app's secrets, never in the repo; rotating it signs everyone out.
- `owner` decides who may approve: behind Cloudflare Access, `accessOwner(access)` (the signed-in email).
- Refresh tokens last 30 days and rotate on each use; MCP clients and claimed agents both get one. Only their hashes
  are kept. A used token sent again revokes every refresh token of that sign-in (its family), as does revoking any
  one of them; access tokens already out run to their hour.
- Device codes: 8 letters from `BCDFGHJKLMNPQRSTVWXZ` (no vowels), shown as `XXXX-XXXX`, case and dashes ignored;
  10 minutes; single use; only hashes kept. A signed-in person may type 5 wrong codes in 10 minutes, then 429. When
  `owners` is set, only they may approve. Polling sooner than `interval` answers `slow_down` and adds 5 seconds.
- In Access, `/oauth/device` stays behind the sign-in (like `/oauth/authorize` and `/oauth/claim`);
  `/oauth/device_authorization` bypasses it.
- Keep the OAuth paths open (`OAUTH_OPEN_PATHS`); `createAgentApi` does it when `oauth` is set, private mode included.
- Standard: `docs/STANDARD.md` §7.
