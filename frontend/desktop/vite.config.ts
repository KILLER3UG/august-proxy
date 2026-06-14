import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  publicDir: false,
  // Match the URL where the SPA is served (/v2/). All asset URLs in
  // index.html will be prefixed with /v2/ so they resolve correctly
  // when the SPA is mounted under /v2/.
  base: '/v2/',
  build: {
    outDir: '../../web-dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.AUGUST_PROXY_URL || 'http://localhost:8085',
      '/v1':  process.env.AUGUST_PROXY_URL || 'http://localhost:8085',
      '/ui':  process.env.AUGUST_PROXY_URL || 'http://localhost:8085',
    },
  },
});
