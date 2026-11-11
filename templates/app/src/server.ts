/** Starts __title__: opens the database, builds the app, listens on PORT. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { openDb } from './kit/index.js'

const stateDir = process.env.STATE_DIR ?? '.state'
mkdirSync(stateDir, { recursive: true })
// A node:sqlite file by default; to move to Turso or D1, open its Drizzle database here and pass it in
const db = await openDb(process.env.DATABASE_FILE ?? `file:${join(stateDir, 'state.sqlite')}`)
const app = await createApp({ db, env: process.env })
const port = Number(process.env.PORT ?? 4400)
serve({ fetch: app.fetch, hostname: '0.0.0.0', port }, (info) => console.log(`__name__ → http://localhost:${info.port} (/docs, /llms.txt, /mcp)`))
