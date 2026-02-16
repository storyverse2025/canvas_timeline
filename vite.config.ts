import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/anthropic/, ''),
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
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
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
