import { defineConfig } from '@playwright/test';

// The fresh-install journey (task P38-05b) against a site that is already up. Run it with
//   JOURNEY_URL=... JOURNEY_ADMIN_EMAIL=... JOURNEY_ADMIN_PASSWORD=... JOURNEY_NEW_PASSWORD=... \
//     pnpm -C e2e exec playwright test -c onboarding/journey.config.ts
// (docs/guide/fresh-install/README.md lists every variable). No web server and no global setup: the site is up. The file is `fresh-install.journey.ts`,
// not `*.spec.ts`, so the normal `pnpm e2e` never picks it up. One test, serial, no retries (a second try would meet a password that was already changed
// and a wizard that is partly done), and no overall time limit: each step has its own bound and the run writes its report after every step.
export default defineConfig({
  testDir: '.',
  testMatch: '**/fresh-install.journey.ts',
  outputDir: '../test-results/journey',
  reporter: [['list']],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 0,
  expect: { timeout: 30_000 },
  use: { browserName: 'chromium', ignoreHTTPSErrors: true, actionTimeout: 60_000, navigationTimeout: 60_000, trace: 'off', video: 'off', screenshot: 'off' },
});
