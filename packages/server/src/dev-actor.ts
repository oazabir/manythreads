import type { Actor } from '@manythreads/kernel';
import { ActorId, RunId, WorkspaceId } from '@manythreads/shared';
import { z } from 'zod';

/**
 * DEV AUTH, test-only. Phase 2 replaces this with real sessions and bearer tokens and this file is deleted.
 *
 * When enabled (NODE_ENV=test or MANYTHREADS_DEV_AUTH=1) a request may carry
 *   x-manythreads-dev-actor: {"kind":"person"|"bot","id":"<actors.id uuid>","workspaceId":"<uuid>"}
 * and is then treated as that actor. With neither switch set the header is ignored, so a production server
 * can never be impersonated this way.
 */
export const DEV_ACTOR_HEADER = 'x-manythreads-dev-actor';

const DevActorHeader = z.strictObject({
  // Never 'system': the system actor is the manythreads_system login, not something a header can claim.
  kind: z.enum(['person', 'bot']),
  id: ActorId,
  workspaceId: WorkspaceId,
  runId: RunId.optional(),
  trigger: z.string().optional(),
});

export function devAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NODE_ENV'] === 'test' || env['MANYTHREADS_DEV_AUTH'] === '1';
}

/** Parses the dev header; returns null when absent or malformed (the request is then anonymous). */
export function parseDevActor(header: string | string[] | undefined): Actor | null {
  if (typeof header !== 'string') return null;
  try {
    const parsed = DevActorHeader.safeParse(JSON.parse(header));
    return parsed.success ? (parsed.data as Actor) : null;
  } catch {
    return null;
  }
}
