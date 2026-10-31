import { defineConfig } from '@playwright/test';

// The desktop shell smoke test (PLAN P10-11): drives the built debug exe of clients/desktop over CDP against the live site.
//   pnpm -C clients/desktop bundle:debug
//   pnpm e2e:desktop
// Kept apart from playwright.config.ts (see the testIgnore of its projects) because it needs Windows, a Rust build and the internet;
// the Linux devbox CI has none of them. No web server and no global setup.
export default defineConfig({
  testDir: '.',
  testMatch: 'tauri-smoke.spec.ts', // the signed-in spec has its own config (signin.config.ts)
  outputDir: '../test-results/desktop',
  reporter: [['list']],
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
});
