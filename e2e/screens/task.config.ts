import { defineConfig } from '@playwright/test';

// Feature screenshots of each task on a deployed site (the owner's standing instruction, STATUS): run
// MANYTHREADS_LIVE_PASSWORD=... pnpm -C e2e exec playwright test -c screens/task.config.ts
// No web server and no global setup: the site is already up. Files are `task.*.shots.ts`, not `*.spec.ts`,
// so the normal `pnpm e2e` never picks them up. Each task shots file appends its `afterAll` gallery rebuild over
// the whole output folder, so `temp/screenshots/index.html` always shows every task's screenshots.
export default defineConfig({
  testDir: '.',
  testMatch: '**/task.*.shots.ts',
  outputDir: '../test-results/task',
  reporter: [['list']],
  retries: 1,
  timeout: 120_000,
  use: { browserName: 'chromium', ignoreHTTPSErrors: true },
});
