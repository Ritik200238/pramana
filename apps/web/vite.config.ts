import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * PWA, not a native app.
 *
 * App-store install friction is the single largest drop-off for Indian
 * consumer health apps, and the camera, notifications, offline storage and
 * home-screen install we need are all available to a web app. The tradeoff is
 * real and documented in the PRD: iOS PWA push and install UX are materially
 * worse than Android's, which is why the first cohort's device split is an
 * open question rather than an assumption.
 */
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'It Asks',
        short_name: 'It Asks',
        description: 'Logs what you actually ate, by asking instead of guessing.',
        theme_color: '#14181c',
        background_color: '#14181c',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // The shell is precached so the camera screen opens instantly on a bad
        // connection. Target is under two seconds cold to camera-ready.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            /*
             * Reads may serve stale briefly; a day's totals a few seconds old
             * beats a spinner on a train.
             *
             * The pattern is an explicit list rather than /api/users, which
             * matched far more than intended — including /users/me/export, the
             * entire health record and, when asked for, the key to it. A
             * response cached here sits in the browser for a day.
             *
             * Nothing here is scoped to a person, because the cache is keyed by
             * URL and every user reads the same paths. That is only safe
             * because the client empties this cache on sign-out and whenever a
             * session ends — see clearCachedReads in lib/api.ts. On a shared
             * phone, which is the normal case in this market, the alternative
             * is one person's records answering another person's request while
             * the network is slow.
             */
            urlPattern:
              /\/api\/(users\/me\/(today|usuals|streak|foods|markers)|chat\/history)(\?|$)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-reads',
              networkTimeoutSeconds: 3,
              // A day of staleness is fine for totals. It is not fine for a
              // device that has changed hands, which is why the cache is
              // cleared rather than merely expired.
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    // Indian mid-range Android is the target device. Keep the bundle honest.
    chunkSizeWarningLimit: 300,
    target: 'es2020',
  },
})
