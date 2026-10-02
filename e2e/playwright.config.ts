import { defineConfig } from '@playwright/test';
import {
  API_EMPTY_PORT,
  API_IDLE_PORT,
  API_PORT,
  IDLE_SECONDS,
  WEB_EMPTY_PORT,
  WEB_IDLE_PORT,
  WEB_PORT,
} from './support/ports.ts';

const external = process.env.MANYTHREADS_URL;
const baseURL = external ?? `http://localhost:${WEB_PORT}`;

// The `api` project needs only the manythreads server; skip building the web client when only it is selected.
const argv = process.argv;
const projectArgs = argv.flatMap((a, i) => (a === '--project' ? [argv[i + 1]] : a.startsWith('--project=') ? [a.slice(10)] : []));
const apiOnly = projectArgs.length > 0 && projectArgs.every((p) => p === 'api');
// Free ports picked when the config loads (support/ports.ts), so parallel runs never meet on a fixed number.
const apiPort = API_PORT;
const apiURL = process.env.MANYTHREADS_API_URL ?? `http://127.0.0.1:${apiPort}`;

if (apiOnly) process.env['MANYTHREADS_E2E_API_ONLY'] = '1';

// Test API servers (fresh database each, dropped on exit). `idle` has short-lived sessions for the expiry spec.
const testServer = (port: number, script: string, env: Record<string, string> = {}) => ({
  command: `pnpm exec tsx ${script}`,
  cwd: '.',
  url: `http://127.0.0.1:${port}/healthz`,
  reuseExistingServer: false,
  timeout: 120_000,
  gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 10_000 },
  env: {
    MANYTHREADS_TEST_PLUGINS: '1',
    MANYTHREADS_API_PORT: String(port),
    NODE_ENV: 'test',
    MANYTHREADS_TEST_AUTH_TOKEN: process.env.MANYTHREADS_TEST_AUTH_TOKEN ?? 'e2e-test-auth-token',
    ...env,
  },
});
// A web origin: the built client served by `vite preview`, proxying /api to one test server (same-origin cookies).
const webServer = (port: number, apiPortForWeb: number, build: boolean) => ({
  command: `${build ? 'pnpm --filter @manythreads/web build && ' : ''}pnpm --filter @manythreads/web preview --port ${port} --strictPort`,
  url: `http://localhost:${port}`,
  reuseExistingServer: false,
  timeout: 180_000,
  env: { MANYTHREADS_API_ORIGIN: `http://127.0.0.1:${apiPortForWeb}` },
});

export default defineConfig({
  testDir: '.',
  globalSetup: './support/global-setup.ts',
  testMatch: '**/*.spec.ts',
  // Two runs side by side keep their own results: MANYTHREADS_E2E_OUTPUT_DIR (and PLAYWRIGHT_HTML_REPORT for the report).
  outputDir: process.env['MANYTHREADS_E2E_OUTPUT_DIR'] ?? 'test-results',
  snapshotPathTemplate: '{testDir}/__baselines__/{testFilePath}/{arg}{ext}',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { baseURL, browserName: 'chromium' },
  webServer: [
    // The manythreads server with the test plugins on a database created fresh for this run (dropped on exit).
    ...(process.env.MANYTHREADS_API_URL ? [] : [testServer(apiPort, 'api/support/start-server.ts')]),
    ...(external || apiOnly
      ? []
      : [
          testServer(API_EMPTY_PORT, 'support/start-empty-server.ts'),
          testServer(API_IDLE_PORT, 'api/support/start-server.ts', { MANYTHREADS_SESSION_IDLE_MINUTES: String(IDLE_SECONDS / 60) }),
          // The first web server builds the client; the others reuse its output (servers start one after the other).
          webServer(WEB_PORT, apiPort, true),
          webServer(WEB_EMPTY_PORT, API_EMPTY_PORT, false),
          webServer(WEB_IDLE_PORT, API_IDLE_PORT, false),
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
      testIgnore: ['**/visual/**', '**/api/**', '**/identity/**', '**/teams/**'],
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
