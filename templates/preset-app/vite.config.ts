import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// One project, two sides: the browser app in web/ and the Worker in src/. Everything the browser loads sits under
// /app, the one prefix the Worker leaves to files (wrangler.jsonc). The dev server gets there with `base`; the build
// writes into app/ instead, because the built folder is served from the root.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'serve' && !isPreview ? '/app/' : '/',
  publicDir: false,
  environments: { client: { build: { assetsDir: 'app/assets' } } },
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: 'web/routes',
      generatedRouteTree: 'web/routeTree.gen.ts',
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
    cloudflare(),
  ],
}))
