import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Beamhop',
        short_name: 'Beamhop',
        description: 'Your people. Their agents. One room.',
        start_url: './',
        scope: './',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#f7f7f5',
        theme_color: '#5b6cff',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
        navigateFallback: 'index.html',
        runtimeCaching: [
          { urlPattern: /\.wasm$/, handler: 'CacheFirst', options: { cacheName: 'wasm', expiration: { maxEntries: 8 } } },
          { urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/pyodide\//, handler: 'CacheFirst', options: { cacheName: 'pyodide', expiration: { maxEntries: 80 } } },
        ],
      },
    }),
  ],
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC') },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, rolldownOptions: { experimental: { lazyBarrel: true } } as any },
  worker: { format: 'es' },
  server: { host: true },
})
