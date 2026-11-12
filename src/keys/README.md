# keys

API keys the app makes and revokes through its own API, beside the ones it is started with (`API_KEYS`), and a
"who am I" route. Kept in the app's database as SHA-256 hashes, with each key's first characters, maker and last use.

| File | What |
|---|---|
| `schema.ts` | the `api_keys` table and `KEYS_MIGRATIONS` |
| `repo.ts` | `keysRepo`: list, get, make, revoke, and `nameOf(hash)`, which notes a use at most once an hour |
| `routes.ts` | `keyRoutes`: `GET/POST {path}`, `GET/DELETE {path}/{id}`, `GET {mePath}` |
| `handlers.ts` | `keyHandlers`, and `holderOf`: who may make or revoke keys |
| `tools.ts` | `keyTools`: `who_am_i`, `list_keys`, `get_key`, `create_key`, `delete_key` |
| `index.ts` | `registerKeys`, `storedKeysOf` (for `auth.storedKeys`), `KEYS_TAG` |

## Wiring

```ts
const fixedKeys = [...parseApiKeys(env.API_KEYS).values()]
const app = createAgentApi({ …, tags: [...tags, KEYS_TAG], auth: { realm, keys: parseApiKeys(env.API_KEYS), storedKeys: storedKeysOf(db) } })
await registerKeys(app, { db, fixedKeys, keyPrefix: 'mr' })
// MCP: tools: [...featureTools, ...keyTools()]; toolsRun samples: who_am_i, list_keys, get_key, create_key, delete_key
```

## Rules

- Every key sees and changes what any key does: this is not a permission system. Give each app, machine or person its
  own key so one can be revoked alone.
- Only a key from `API_KEYS` or a signed-in person may make or revoke keys. A key made through the API cannot make
  another, and neither can an OAuth token, so a token's expiry still bounds what an approved agent can do.
- A key is shown once, in the answer that makes it. Names are unique, and a deployment key's name is taken.
- Standard: `docs/STANDARD.md` §7 (auth).
