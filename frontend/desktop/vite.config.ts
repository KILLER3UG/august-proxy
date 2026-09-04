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
  base: '/',
  build: {
    outDir: '../../web-dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    // Code-split stable vendor chunks so the main bundle stays lean and
    // the Tauri shell loads faster on cold start (kills the 3.3MB index
    // chunk warning). React + UI libs get their own cached chunks.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // Part 26 7.4: specific vendor matches FIRST — the broad 'react'
          // substring also hits lucide-react / @tanstack/react-*, which
          // defeated their dedicated buckets.
          if (id.includes('lucide-react')) return 'icons';
          if (id.includes('@tanstack')) return 'query';
          if (id.includes('react') || id.includes('react-dom') || id.includes('react-router')) return 'react';
          if (id.includes('framer-motion')) return 'motion';
          if (id.includes('sonner') || id.includes('cmdk') || id.includes('recharts')) return 'ui';
          // Heavy single-purpose libs get their own cached chunks so the
          // main entry (chat thread) doesn't carry them: xlsx (~1 MB),
          // katex (~300 KB), xterm, and the code highlighter.
          if (id.includes('katex')) return 'katex';
          if (id.includes('xlsx')) return 'xlsx';
          if (id.includes('xterm')) return 'xterm';
          if (id.includes('highlight.js')) return 'highlight';
          if (id.includes('marked') || id.includes('mammoth')) return 'markdown';
          if (id.includes('zod') || id.includes('zustand')) return 'state';
          return undefined;
        },
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
	    proxy: {
	      '/api': {
	        target: process.env.AUGUST_PROXY_URL || 'http://127.0.0.1:8085',
	        ws: true,
	        changeOrigin: true,
	      },
	      '/v1': {
	        target: process.env.AUGUST_PROXY_URL || 'http://127.0.0.1:8085',
	        changeOrigin: true,
	      },
	    },
  },
});
