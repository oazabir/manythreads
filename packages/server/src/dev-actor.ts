import type { Actor } from '@manythreads/kernel';
import { ActorId, RunId, WorkspaceId } from '@manythreads/shared';
import { z } from 'zod';

/**
 * DEV AUTH, NODE_ENV=test only. Real requests authenticate with a session cookie (see ./session). This stays for
 * unit and API tests that need an arbitrary actor (a bot, a person without a password) without a sign-in.
 *
 * When NODE_ENV=test a request may carry
 *   x-manythreads-dev-actor: {"kind":"person"|"bot","id":"<actors.id uuid>","workspaceId":"<uuid>"}
 * and is then treated as that actor. In any other environment the header is ignored, whatever else is configured, so
 * a production server can never be impersonated this way. (For e2e runs and screenshots against a running server use
 * the session test endpoint, docs/testing.md.)
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
  return env['NODE_ENV'] === 'test';
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
