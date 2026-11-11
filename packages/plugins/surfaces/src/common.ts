import type { PluginTx } from '@manythreads/sdk';
import { SURFACE_NODE_ID_MAX } from '@manythreads/shared';

// What the surface tools and the plan card share: how a refusal looks, where the run draws, and a line of a surface's history.

export type Refusal = { ok: false; code: string; message: string; [k: string]: unknown };
export const refuse = (code: string, message: string, extra: Record<string, unknown> = {}): Refusal => ({ ok: false, code, message, ...extra });

export type RunContext = {
  run_id: string;
  bot_id: string;
  workspace_id: string;
  team_id: string;
  channel_id: string | null;
  reply_root_id: string | null;
  /** `channel`, `dm` or `bot_conversation`; null when the run has no channel. */
  channel_kind: string | null;
}

/** The live run of the calling bot and where it answers: the platform's own record, never an argument. */
export const runContext = async (tx: PluginTx): Promise<RunContext | null> =>
  (await tx.query<RunContext>('SELECT run_id, bot_id, workspace_id, team_id, channel_id, reply_root_id, channel_kind FROM app.surface_run_context()')).rows[0] ?? null;

export const NOT_A_RUN = 'The screen tools work only inside a bot run.';

export async function addLine(
  tx: PluginTx,
  s: { id: string; workspace_id: string; channel_id: string },
  kind: 'render' | 'update' | 'rejected',
  version: number,
  nodeId: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO app.surface_events (surface_id, workspace_id, channel_id, actor_id, kind, version, node_id, payload)
     VALUES ($1::uuid, $2::uuid, $3::uuid, app.actor(), $4, $5, $6, $7::jsonb)`,
    [s.id, s.workspace_id, s.channel_id, kind, version, nodeId !== null ? nodeId.slice(0, SURFACE_NODE_ID_MAX) : null, JSON.stringify(payload)],
  );
}
