import { fileURLToPath } from 'node:url';
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
import { E2E_POOL_ENV } from './support/pools.ts';

/** Specs that gate on frame time (the `perf` project). */
const PERF_SPECS = '**/perf-*.spec.ts';
/** The desktop shell smoke test: needs Windows, a Rust build and the live site; it has its own config (desktop/desktop.config.ts). */
const DESKTOP_SHELL = '**/desktop/**';
/** Voice message specs (P14-17): they need Chromium's fake microphone, so only the `voice` projects run them. */
const VOICE_SPECS = '**/voice-*.spec.ts';
const VOICE_MOBILE_SPEC = '**/voice-mobile.spec.ts';
/**
 * Chromium flags for the voice projects: a fake microphone that plays the fixture on a loop, no permission prompt. The web build for the e2e run has the
 * fake speech engine on (VITE_MANYTHREADS_FAKE_ASR=1, see webServer below), so every clip "says" the same known sentence.
 */
const FAKE_MIC = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${fileURLToPath(new URL('./fixtures/speech/hello.wav', import.meta.url))}`,
];

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
    ...E2E_POOL_ENV,
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
  // The first web server builds the client: the build carries the fake speech engine (a test switch; production images never set it).
  env: { MANYTHREADS_API_ORIGIN: `http://127.0.0.1:${apiPortForWeb}`, ...(build ? { VITE_MANYTHREADS_FAKE_ASR: '1' } : {}) },
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
      testIgnore: ['**/api/**', DESKTOP_SHELL, PERF_SPECS, VOICE_SPECS],
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile-web',
      // Visual specs (plate comparison) run on desktop only.
      testIgnore: ['**/visual/**', '**/api/**', '**/identity/**', '**/teams/**', DESKTOP_SHELL, PERF_SPECS, VOICE_SPECS],
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
    {
      // Voice messages on the desktop layout and on a 390 px phone, with a fake microphone playing e2e/fixtures/speech/hello.wav.
      name: 'voice',
      testMatch: VOICE_SPECS,
      testIgnore: [VOICE_MOBILE_SPEC],
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, permissions: ['microphone'], launchOptions: { args: FAKE_MIC } },
    },
    {
      name: 'voice-mobile',
      testMatch: VOICE_MOBILE_SPEC,
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['microphone'], launchOptions: { args: FAKE_MIC } },
    },
    {
      // A frame-time budget measures the machine as much as the page: p95 under 20 ms held on a quiet box and read 33 ms (two missed
      // frames) beside four other browsers and their servers. Specs that gate on frame time run alone, after every other project.
      // Perf projects wait for api, desktop and mobile-web, so they are SKIPPED when any of those fails. `--project=desktop` no longer runs
      // the perf specs: run them with `--project=perf --project=perf-mobile --no-deps`.
      name: 'perf',
      testMatch: PERF_SPECS,
      dependencies: ['api', 'desktop', 'mobile-web'],
      use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } },
    },
    {
      // The mobile-web run of the perf specs (mobile-web itself ignores them).
      name: 'perf-mobile',
      testMatch: PERF_SPECS,
      dependencies: ['api', 'desktop', 'mobile-web'],
      use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
});
