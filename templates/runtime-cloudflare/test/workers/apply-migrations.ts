import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// The same files a deploy applies; applying them twice is a no-op
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
