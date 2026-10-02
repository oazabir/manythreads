import { defineConfig } from '@playwright/test';

// Screenshots of a deployed site (the screenshots workflow; locally: MANYTHREADS_LIVE_URL=... MANYTHREADS_LIVE_PASSWORD=...
// pnpm -C e2e exec playwright test -c screens/live.config.ts). No web server and no global setup: the site is already up.
// The file is `live.shots.ts`, not `*.spec.ts`, so the normal `pnpm e2e` never picks it up.
export default defineConfig({
  testDir: '.',
  testMatch: '**/live.shots.ts',
  outputDir: '../test-results/live',
  reporter: [['list']],
  retries: 1,
  timeout: 90_000,
  use: { browserName: 'chromium', ignoreHTTPSErrors: true },
});
