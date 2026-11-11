import { fileURLToPath } from 'node:url'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// The shadcn block imports the app's own components; tests give it stand-ins
const alias = [
  { find: /^@\/components\/ui\/(.*)$/, replacement: fileURLToPath(new URL('./test/shadcn/$1.tsx', import.meta.url)) },
  { find: '@/lib/utils', replacement: fileURLToPath(new URL('./test/shadcn/utils.ts', import.meta.url)) },
]

// Two projects, one suite: `node` runs every test as before; `workers` runs test/workers inside workerd, so a module
// that only works on Node fails there
export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          // Templates and the apps the generator test makes run their own tests, inside the generated app
          exclude: ['**/node_modules/**', 'test/.generated/**', 'templates/**', 'test/workers/**'],
        },
      },
      {
        plugins: [cloudflareTest({ wrangler: { configPath: './test/workers/wrangler.jsonc' } })],
        test: { name: 'workers', include: ['test/workers/**/*.test.ts'] },
      },
    ],
  },
})
