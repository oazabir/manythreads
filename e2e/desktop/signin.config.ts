import { defineConfig } from '@playwright/test';

// The signed-in desktop shell test (tauri-signin.spec.ts): signs in to a live server with credentials taken from the environment.
//   set -a; source <(ssh devbox cat '~/manythreads.passwords.env'); set +a; pnpm e2e:desktop:signin
// Traces, videos and screenshots stay off on purpose: a trace records the typed text, and the password is typed here. The spec takes
// no screenshots.
export default defineConfig({
  testDir: '.',
  testMatch: 'tauri-signin.spec.ts',
  outputDir: '../test-results/desktop-signin',
  reporter: [['list']],
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  use: { trace: 'off', video: 'off', screenshot: 'off' },
});
