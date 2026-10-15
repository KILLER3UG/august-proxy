import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  // Measured, not assumed: at the default (half the cores — 6 here) the 22-spec
  // suite failed nondeterministically across three identical runs, three
  // different specs each time, with page.goto 30s timeouts mixed into
  // visibility assertions, while --workers=1 passed 22/22. One vite dev server
  // is the bottleneck, so the parallel run's green meant nothing on a busy
  // machine. Two workers keep it useful and still quick.
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm run dev:vite -- --host 127.0.0.1',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
