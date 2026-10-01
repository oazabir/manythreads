import { defineConfig } from '@playwright/test';

const external = process.env.MAJLIS_URL;
const baseURL = external ?? 'http://localhost:4173';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/__baselines__/{testFilePath}/{arg}{ext}',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { baseURL, browserName: 'chromium' },
  webServer: external
    ? undefined
    : {
        command:
          'pnpm --filter @majlis/web build && pnpm --filter @majlis/web preview --port 4173 --strictPort',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    {
      name: 'mobile-web',
      // Visual specs (plate comparison) run on desktop only.
      testIgnore: '**/visual/**',
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
