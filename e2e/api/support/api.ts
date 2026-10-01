import { randomUUID } from 'node:crypto';

export const KAHF_WORKSPACE_ID = '00000000-0000-7000-8000-00000000a001';

/** Test-only dev-auth header (server runs with NODE_ENV=test). A fresh actor per call gives an isolated rate-limit key. */
export function devActor(id: string = randomUUID()): Record<string, string> {
  return {
    'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id, workspaceId: KAHF_WORKSPACE_ID }),
  };
}

export const TEST = '/api/test';

/**
 * The value the api test server was started with (`MANYTHREADS_TEST_AUTH_TOKEN`, see playwright.config.ts). Sessions for
 * seeded personas come from POST /api/test/session with `x-test-auth: <this>` (docs/testing.md).
 */
export const TEST_AUTH_TOKEN = process.env['MANYTHREADS_TEST_AUTH_TOKEN'] ?? 'e2e-test-auth-token';

/** The seeded personas (createPersonas): emails, all with the same password. */
export const PERSONA_EMAILS = {
  omar: 'omar@kahf.example',
  nadia: 'nadia@kahf.example',
  sameera: 'sameera@kahf.example',
  lena: 'lena@kahf.example',
} as const;
