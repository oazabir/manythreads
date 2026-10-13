import { defineConfig } from 'vitest/config';

/**
 * Hooks start and stop a server on a fresh database, and every test file does it at once. `DROP DATABASE` (and `CREATE DATABASE`) force an
 * immediate checkpoint that Postgres runs one at a time, so under the full suite an `afterAll` that closes a server waited past vitest's
 * 10 s default (a checkpoint of 10,000 dirty buffers took 14 s on the devbox; 1,400 of them ran in three hours) while passing alone. Every
 * `beforeAll` that starts a server already asks for 120 s; the hook that stops it gets the same.
 */
const HOOK_TIMEOUT_MS = 120_000;

/**
 * A DB-backed test opens a real server and runs several transactions; under the full suite (three workers, one shared Postgres) a single
 * test regularly passes 5 s while passing alone in under 2 s (threads inbox paging, seed-guard, identity). Correctness assertions are
 * unchanged; the hostile-input timing tests carry their own ceilings (`expectLinear`).
 */
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: 'unit',
          include: ['**/test/**/*.test.ts'],
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            '**/test/rls/**',
            '**/test/events/**',
            '**/test/schema-compat/**',
            '**/test/cross-team/**',
          ],
          passWithNoTests: true,
          hookTimeout: HOOK_TIMEOUT_MS,
          testTimeout: TEST_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: 'rls',
          include: ['**/test/rls/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          passWithNoTests: true,
          hookTimeout: HOOK_TIMEOUT_MS,
          testTimeout: TEST_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: 'events',
          include: ['**/test/events/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          passWithNoTests: true,
          hookTimeout: HOOK_TIMEOUT_MS,
          testTimeout: TEST_TIMEOUT_MS,
        },
      },
      {
        // `pnpm test:memory-cross-team` (PLAN P5-15, SPEC 12.1): team A's bot gets nothing from team B's memory bank. Its own project so it can run
        // by name on every PR; `pnpm test` lists the other projects and leaves it out, so it runs once per PR (ci.yml).
        test: {
          name: 'memory-cross-team',
          include: ['packages/plugins/memory-hindsight/test/cross-team/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          passWithNoTests: false,
          hookTimeout: HOOK_TIMEOUT_MS,
          testTimeout: TEST_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: 'schema-compat',
          include: ['packages/shared/test/schema-compat/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          passWithNoTests: true,
          hookTimeout: HOOK_TIMEOUT_MS,
          testTimeout: TEST_TIMEOUT_MS,
        },
      },
    ],
  },
});
