import { dbOAuthStore, testDb } from '../../src/index.js'
import { oauthStoreContract } from '../oauth-store-contract.js'

oauthStoreContract('database (D1)', async () => dbOAuthStore(await testDb()))
