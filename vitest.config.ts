import { defineConfig } from 'vitest/config';

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
        },
      },
      {
        test: {
          name: 'rls',
          include: ['**/test/rls/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'events',
          include: ['**/test/events/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          passWithNoTests: true,
        },
      },
      {
        test: {
          name: 'schema-compat',
          include: ['packages/shared/test/schema-compat/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          passWithNoTests: true,
        },
      },
    ],
  },
});
