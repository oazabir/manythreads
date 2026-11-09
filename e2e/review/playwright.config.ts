// Runs the screenshot review specs on their own, with no stack and no web server (PLAN P13-02):
//   cd e2e && MANYTHREADS_JOURNEY_SET=example npx playwright test -c review/playwright.config.ts
// The pictures and the pre-check report come from an earlier persona run that had the pre-check hook on
// (MANYTHREADS_PERSONAS_ONSHOT=<repo>/tools/review/hook.ts); this run only reads them.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  outputDir: process.env['MANYTHREADS_E2E_OUTPUT_DIR'] ?? '../test-results/review',
  reporter: [['list']],
  use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
  projects: [{ name: 'review' }],
});
