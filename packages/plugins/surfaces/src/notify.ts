import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { SurfaceChangedPush, WS_SURFACE_CHANGED } from '@manythreads/shared';

// What the plugin tells others when a surface changes: the live push that makes an open page read the surface again, and the team a history event may be
// attributed to. Neither carries the text of a screen.

/** The team an event about this channel may carry. A private channel, a direct message and a conversation with a bot belong to their people, not to the team. */
export async function eventTeamId(tx: PluginTx, channelId: string): Promise<string | null> {
  const row = (await tx.query<{ team_id: string | null; kind: string; private: boolean }>('SELECT team_id, kind, private FROM app.channels WHERE id = $1::uuid', [channelId])).rows[0];
  return row !== undefined && row.kind === 'channel' && !row.private ? row.team_id : null;
}

/**
 * Tells everyone who can read the channel to read this surface again. Sent in the change's own transaction, so a viewer is told only about a change that was kept.
 * `reason: 'data'` (the plan card, PLAN P22-03) says the screen is the same and only what its bound parts read may have changed.
 */
export async function pushChanged(ctx: PluginContext, tx: PluginTx, s: { channelId: string; surfaceId: string; version: number }, reason?: 'data'): Promise<void> {
  const people = (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [s.channelId])).rows.map((r) => r.person_id);
  if (people.length === 0) return;
  await ctx.realtime.pushToPeople(tx, people, WS_SURFACE_CHANGED, SurfaceChangedPush.parse({ channelId: s.channelId, surfaceId: s.surfaceId, version: s.version, ...(reason ? { reason } : {}) }));
}
