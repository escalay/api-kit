import { testDb } from '../../src/index.js'
import { guardTableUpgrade } from '../guard-store-contract.js'

// A file of its own: D1 keeps one database per test file, and the store contract would already have run every step
guardTableUpgrade('D1', testDb)
