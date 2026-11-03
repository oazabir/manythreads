import type { PluginTx } from '@manythreads/sdk';

/** The workspace's model-guard preset, when the model gateway keeps one (`standard` otherwise). It is the preset a digest leaving a team is judged by too. */
export async function egressPreset(tx: PluginTx, workspaceId: string): Promise<{ preset: string; allowlist: string[] }> {
  const present = (await tx.query<{ ok: boolean }>(`SELECT to_regclass('app.llm_settings') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!present) return { preset: 'standard', allowlist: [] };
  const row = (await tx.query<{ preset: string; egress_allowlist: string[] }>('SELECT preset, egress_allowlist FROM app.llm_settings WHERE workspace_id = $1::uuid', [workspaceId])).rows[0];
  return { preset: row?.preset ?? 'standard', allowlist: row?.egress_allowlist ?? [] };
}

/** Runs `fn` so that a failure leaves the transaction usable (a savepoint around it). */
export async function attempt<T>(tx: PluginTx, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  await tx.query('SAVEPOINT memory_share_attempt');
  try {
    const value = await fn();
    await tx.query('RELEASE SAVEPOINT memory_share_attempt');
    return { ok: true, value };
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT memory_share_attempt');
    await tx.query('RELEASE SAVEPOINT memory_share_attempt');
    return { ok: false, error };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** The payload of a build job: checked, because it is whatever was enqueued. */
export function runPayload(payload: Record<string, unknown>): { workspaceId: string; runId: string } | null {
  return isUuid(payload['workspaceId']) && isUuid(payload['runId']) ? { workspaceId: payload['workspaceId'], runId: payload['runId'] } : null;
}

export const BUILD_QUEUE = 'memory-share.build';
export const TICK_QUEUE = 'memory-share.tick';
export const EXPIRE_QUEUE = 'memory-share.expire';

/**
 * Whether a person actor is, now, a person who may switch a review off or send to any team: an active person who is a lead of `teamId`, or a workspace owner or admin.
 * Null (nobody on record), a bot and a suspended person are never. The loader asks it when the file is read and the build asks it again, so a lead who has since left or been
 * suspended does not keep an `auto` share running.
 */
export async function mayAutoApprove(tx: PluginTx, teamId: string, actorId: string | null): Promise<boolean> {
  if (actorId === null) return false;
  const row = (
    await tx.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM app.actors a JOIN app.people p ON p.id = a.ref_id AND p.status = 'active'
          WHERE a.id = $1 AND a.kind = 'person'
            AND (
              EXISTS (SELECT 1 FROM app.team_members tm WHERE tm.team_id = $2 AND tm.actor_id = a.id AND tm.role = 'lead')
              OR EXISTS (SELECT 1 FROM app.workspace_members wm WHERE wm.person_id = a.ref_id AND wm.workspace_id = a.workspace_id AND wm.role IN ('owner', 'admin'))
            )
       ) AS ok`,
      [actorId, teamId],
    )
  ).rows[0];
  return row?.ok === true;
}

/** Whether a person actor is an active workspace owner or admin. */
export async function isWorkspaceAdmin(tx: PluginTx, actorId: string | null): Promise<boolean> {
  if (actorId === null) return false;
  const row = (
    await tx.query<{ ok: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM app.actors a JOIN app.people p ON p.id = a.ref_id AND p.status = 'active'
                JOIN app.workspace_members wm ON wm.person_id = a.ref_id AND wm.workspace_id = a.workspace_id AND wm.role IN ('owner', 'admin')
          WHERE a.id = $1 AND a.kind = 'person'
       ) AS ok`,
      [actorId],
    )
  ).rows[0];
  return row?.ok === true;
}
