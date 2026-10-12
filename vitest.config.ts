import { defineConfig } from 'vitest/config';

/**
 * Hooks start and stop a server on a fresh database, and every test file does it at once. `DROP DATABASE` (and `CREATE DATABASE`) force an
 * immediate checkpoint that Postgres runs one at a time, so under the full suite an `afterAll` that closes a server waited past vitest's
 * 10 s default (a checkpoint of 10,000 dirty buffers took 14 s on the devbox; 1,400 of them ran in three hours) while passing alone. Every
 * `beforeAll` that starts a server already asks for 120 s; the hook that stops it gets the same.
 */
const HOOK_TIMEOUT_MS = 120_000;

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
          ],
          passWithNoTests: true,
          hookTimeout: HOOK_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: 'rls',
          include: ['**/test/rls/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          passWithNoTests: true,
          hookTimeout: HOOK_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: 'events',
          include: ['**/test/events/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          passWithNoTests: true,
          hookTimeout: HOOK_TIMEOUT_MS,
        },
      },
      {
        test: {
          name: 'schema-compat',
          include: ['packages/shared/test/schema-compat/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          passWithNoTests: true,
          hookTimeout: HOOK_TIMEOUT_MS,
        },
      },
    ],
  },
});
