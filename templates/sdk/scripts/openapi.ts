/**
 * Writes the API's OpenAPI document as the SDK reads it, and the commands the CLI packages (`sdk/cli/commands.json`):
 * both built in-process over an empty database, with no origin in them, so the same code always gives the same bytes.
 * `pnpm sdk:types` then turns the document into the SDK's types.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { jobs } from '../sdk/cli/jobs/index.js'
import { createApp, VERSION } from '../src/app.js'
import { testDb } from '../src/kit/index.js'
import { mountedMcp } from '../src/kit/mcp/index.js'
import { cliSnapshot } from '../src/kit/testing/index.js'

const out = fileURLToPath(new URL('../sdk/openapi.json', import.meta.url))
const app = await createApp({ db: await testDb(), env: {} })
const doc = (await (await app.request('/openapi.json')).json()) as Record<string, unknown>
// Servers name whoever asked; the SDK takes its base address from its caller instead
delete doc.servers
delete doc.externalDocs
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`)
console.log(`Wrote ${Object.keys(doc.paths as object).length} paths to sdk/openapi.json`)

const { tools, resources } = mountedMcp(app)
const snapshot = cliSnapshot({ app: '__bin__', version: VERSION, tools, resources, jobs })
writeFileSync(fileURLToPath(new URL('../sdk/cli/commands.json', import.meta.url)), `${JSON.stringify(snapshot, null, 2)}\n`)
console.log(`Wrote ${snapshot.commands.length} commands to sdk/cli/commands.json`)
