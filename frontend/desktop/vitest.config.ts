/// <reference types="vitest" />
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // e2e/ belongs to Playwright, not vitest. vitest's default include glob is
    // `**/*.{test,spec}.?(c|m)[jt]s?(x)`, which collects the axe smoke spec
    // and fails the run on `test.describe.configure` — a Playwright API that
    // does not exist in vitest's runner. Spreading configDefaults first
    // matters: setting `exclude` REPLACES the default list, it does not add.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
