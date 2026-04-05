import build from '@hono/vite-build/cloudflare-pages'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'
import { writeFileSync } from 'fs'
import { resolve } from 'path'

// Plugin: write _routes.json after every build
// include: ALL routes go through the Worker (Hono handles everything)
// exclude: static files are served directly by Cloudflare CDN (faster, no Worker cost)
function routesPlugin() {
  return {
    name: 'cloudflare-routes',
    closeBundle() {
      const routes = {
        version: 1,
        include: ['/*'],
        exclude: [
          '/static/*',   // CDN-served: images, JS, CSS — no Worker invocation needed
          '/favicon.ico',
          '/robots.txt',
          '/sitemap.xml',
        ]
      }
      writeFileSync(resolve('dist/_routes.json'), JSON.stringify(routes, null, 2))
      console.log('✓ _routes.json written')
    }
  }
}

export default defineConfig({
  plugins: [
    build(),
    devServer({
      adapter,
      entry: 'src/index.tsx'
    }),
    routesPlugin(),
  ],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: 'src/index.tsx'
    }
  }
})
