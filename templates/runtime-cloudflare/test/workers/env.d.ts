declare namespace Cloudflare {
  // Types `exports.default` in the tests as this app's worker
  interface GlobalProps {
    mainModule: typeof import('../../src/worker.js')
  }
  interface Env {
    DB: D1Database
    API_KEYS: string
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
}
