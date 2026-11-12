/**
 * Writes the API's OpenAPI document as the SDK reads it: built in-process over an empty database, with no origin in
 * it, so the same code always gives the same bytes. `pnpm sdk:types` then turns it into the SDK's types.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from '../src/app.js'
import { testDb } from '../src/kit/index.js'

const out = fileURLToPath(new URL('../sdk/openapi.json', import.meta.url))
const app = await createApp({ db: await testDb(), env: {} })
const doc = (await (await app.request('/openapi.json')).json()) as Record<string, unknown>
// Servers name whoever asked; the SDK takes its base address from its caller instead
delete doc.servers
delete doc.externalDocs
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`)
console.log(`Wrote ${Object.keys(doc.paths as object).length} paths to sdk/openapi.json`)
