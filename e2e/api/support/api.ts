import { randomUUID } from 'node:crypto';

export const KAHF_WORKSPACE_ID = '00000000-0000-7000-8000-00000000a001';

/** Test-only dev-auth header (server runs with devAuth). A fresh actor per call gives an isolated rate-limit key. */
export function devActor(id: string = randomUUID()): Record<string, string> {
  return {
    'x-majlis-dev-actor': JSON.stringify({ kind: 'person', id, workspaceId: KAHF_WORKSPACE_ID }),
  };
}

export const TEST = '/api/test';
