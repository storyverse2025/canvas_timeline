import './load-env.mjs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import basicSsl from '@vitejs/plugin-basic-ssl'
import path from 'path'
import { libtvPlugin } from './vite-libtv-plugin'
import { providersPlugin } from './vite-providers-plugin'
import { capabilitiesPlugin } from './vite-capabilities-plugin'
import { sessionSnapshotPlugin } from './vite-session-snapshot-plugin'
import { assetProxyPlugin } from './vite-asset-proxy-plugin'
import { timelineExportPlugin } from './vite-timeline-export-plugin'
import { avatarsPlugin } from './vite-avatars-plugin'

// HTTPS toggle: opt-out by setting DEV_HTTPS=0 (e.g. when port-forwarding to localhost).
// Otherwise the dev server serves a self-signed cert so getUserMedia works over LAN/public IPs.
const useHttps = process.env.DEV_HTTPS !== '0'

export default defineConfig({
  plugins: [react(), ...(useHttps ? [basicSsl()] : []), libtvPlugin(), providersPlugin(), capabilitiesPlugin(), sessionSnapshotPlugin(), assetProxyPlugin(), timelineExportPlugin(), avatarsPlugin()],
  server: {
    host: '0.0.0.0',
    port: 8080,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/anthropic': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/anthropic/, ''),
      },
      // IMPORTANT: /fal-queue and /fal-storage MUST come before /fal
      // to avoid prefix collision (/fal matches /fal-queue/...)
      '/fal-queue': {
        target: 'https://queue.fal.run',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/fal-queue/, ''),
        headers: {
          'Authorization': `Key ${process.env.FAL_KEY || ''}`,
        },
      },
      '/fal-storage': {
        target: 'https://rest.alpha.fal.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/fal-storage/, ''),
        headers: {
          'Authorization': `Key ${process.env.FAL_KEY || ''}`,
        },
      },
      '/fal': {
        target: 'https://fal.run',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/fal/, ''),
        headers: {
          'Authorization': `Key ${process.env.FAL_KEY || ''}`,
        },
      },
      '/elevenlabs': {
        target: 'https://api.elevenlabs.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/elevenlabs/, ''),
        headers: {
          'xi-api-key': process.env.ELEVENLABS_API_KEY || '',
        },
      },
      // BytePlus Ark digital-asset / 开白 registration endpoint used by the
      // privacy-block fallback chain in useStoryboardGenerate. The bearer
      // token (BYTEPLUS_ARK_API_KEY, ARK_API_KEY as legacy fallback) is
      // injected server-side so the browser never sees the key.
      // Note: BytePlus may require AK/SK signing for the asset CRUD endpoints
      // even though chat/contents use Bearer; if Bearer 401s, the fallback
      // chain catches and degrades to 2D stylization. See PR for unknowns.
      '/byteplus-asset': {
        target: 'https://ark.ap-southeast.bytepluses.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/byteplus-asset/, '/api/v3'),
        headers: {
          'Authorization': `Bearer ${process.env.BYTEPLUS_ARK_API_KEY || process.env.ARK_API_KEY || ''}`,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
