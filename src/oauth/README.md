# oauth

The app as its own OAuth server, so MCP clients (Claude, ChatGPT) and agents connect without a pasted key: dynamic
client registration, authorization code with PKCE, refresh rotation, revocation, agent registration through
`/auth.md` with a 6-digit owner claim, ES256 tokens with `read` / `write` scopes, and the metadata documents.

Needs: `core`, `db`.

```ts
import { accessOwner, createAgentApi, createOAuth, dbOAuthStore, generateOAuthKey } from './kit/index.js'

const oauth = env.OAUTH_SIGNING_KEY
  ? createOAuth({ name: 'Notes', signingKey: env.OAUTH_SIGNING_KEY, store: await dbOAuthStore(db), owner: access ? accessOwner(access) : async () => null })
  : undefined
const app = createAgentApi({ …, oauth })                   // mounts /oauth/*, the metadata, and accepts its tokens
```

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
- Keep the OAuth paths open (`OAUTH_OPEN_PATHS`); `createAgentApi` does it when `oauth` is set, private mode included.
- Standard: `docs/STANDARD.md` §7.
