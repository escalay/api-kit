import { dbGuardStore, testDb } from '../../src/index.js'
import { guardStoreContract } from '../guard-store-contract.js'

guardStoreContract('database (D1)', async () => dbGuardStore(await testDb()))
