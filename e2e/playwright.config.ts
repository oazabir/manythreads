import { defineConfig } from '@playwright/test';

const external = process.env.MAJLIS_URL;
const baseURL = external ?? 'http://localhost:4173';

// The `api` project needs only the Majlis server; skip building the web client when only it is selected.
const argv = process.argv;
const projectArgs = argv.flatMap((a, i) => (a === '--project' ? [argv[i + 1]] : a.startsWith('--project=') ? [a.slice(10)] : []));
const apiOnly = projectArgs.length > 0 && projectArgs.every((p) => p === 'api');
const apiPort = Number(process.env.MAJLIS_API_PORT ?? 3100);
const apiURL = process.env.MAJLIS_API_URL ?? `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/__baselines__/{testFilePath}/{arg}{ext}',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { baseURL, browserName: 'chromium' },
  webServer: [
    // API project: the Majlis server with the test plugins, on a database created fresh for this run (dropped on exit).
    ...(process.env.MAJLIS_API_URL
      ? []
      : [
          {
            command: 'pnpm exec tsx api/support/start-server.ts',
            cwd: '.',
            url: `${apiURL}/healthz`,
            reuseExistingServer: false,
            timeout: 120_000,
            gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
            env: { MAJLIS_TEST_PLUGINS: '1', MAJLIS_API_PORT: String(apiPort), NODE_ENV: 'test' },
          },
        ]),
    ...(external || apiOnly
      ? []
      : [
          {
            command:
              'pnpm --filter @majlis/web build && pnpm --filter @majlis/web preview --port 4173 --strictPort',
            url: baseURL,
            reuseExistingServer: !process.env.CI,
            timeout: 180_000,
          },
        ]),
  ],
  projects: [
    {
      name: 'api',
      testDir: './api',
      use: { baseURL: apiURL },
    },
    {
      name: 'desktop',
      testIgnore: '**/api/**',
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-web',
      // Visual specs (plate comparison) run on desktop only.
      testIgnore: ['**/visual/**', '**/api/**'],
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
