import { createHash } from 'node:crypto'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import { TEST_KEY } from './test/workers/key.js'

// Two projects, one app: `node` runs every test on Node; `workers` runs test/workers inside workerd, over D1 brought
// up by the files in migrations/ (`pnpm migrations` writes them)
export default defineConfig(async () => ({
  test: {
    projects: [
      { test: { name: 'node', include: ['src/**/*.test.ts', 'test/**/*.test.ts'], exclude: ['test/workers/**', '**/node_modules/**'] } },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: { bindings: { API_KEYS: `tester:${createHash('sha256').update(TEST_KEY).digest('hex')}`, TEST_MIGRATIONS: await readD1Migrations('./migrations') } },
          }),
        ],
        test: { name: 'workers', include: ['test/workers/**/*.test.ts'], setupFiles: ['./test/workers/apply-migrations.ts'] },
      },
    ],
  },
}))
