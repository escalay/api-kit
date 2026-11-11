import { dbGuardStore, memoryGuardStore, testDb } from '../src/index.js'
import { guardStoreContract } from './guard-store-contract.js'
import { describe, expect, it } from 'vitest'
import * as dbModule from '../src/db/index.js'

guardStoreContract('memory', async () => memoryGuardStore())
guardStoreContract('database (node:sqlite)', async () => dbGuardStore(await testDb()))

describe('the db module entry', () => {
  // An app's generated kit index re-exports only db/index.ts
  it('exports the guard store', () => expect(typeof dbModule.dbGuardStore).toBe('function'))
})
