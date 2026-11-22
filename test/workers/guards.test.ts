import { dbGuardStore, testDb } from '../../src/index.js'
import { countedDbStore, guardStoreContract } from '../guard-store-contract.js'

guardStoreContract('database (D1)', async () => dbGuardStore(await testDb()), async () => countedDbStore(await testDb()))
