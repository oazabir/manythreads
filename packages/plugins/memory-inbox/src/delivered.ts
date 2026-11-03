import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { MemoryDigestDeliveredEvent } from '@manythreads/shared';
import { HOLD_QUEUE } from './receive.ts';

// A digest another team delivered (PLAN P8-24). The memory-share plugin writes the inbox item in one definer function (app.deliver_inbox_item) and announces it with
// `memory.digest.delivered`; a plugin may only queue jobs in its own namespace, so the first step of the pipeline is queued here, by the plugin that owns the pipeline.
// The item is recorded as dropped (origin `share`, nobody credited) like any other, then goes through the hold check like everything else.

export function registerDelivered(ctx: PluginContext): void {
  ctx.events.subscribe('memory.digest.delivered', async (raw: PluginEvent, tx: PluginTx) => {
    const event = MemoryDigestDeliveredEvent.parse(raw);
    if (event.itemId === null) return;
    // the item may have been discarded or removed since the delivery committed: only an item that still waits at the first step is queued
    const item = (await tx.query<{ id: string }>(`SELECT id FROM app.memory_inbox_items WHERE id = $1 AND team_id = $2 AND origin = 'share' AND state = 'queued' AND stage = 'hold'`, [event.itemId, event.destTeamId])).rows[0];
    if (!item) return;
    await ctx.audit.emit(tx, {
      type: 'memory.item.dropped',
      workspaceId: event.workspaceId,
      teamId: event.destTeamId,
      itemId: event.itemId,
      origin: 'share',
      kind: 'bundle',
      size: event.bytes,
      teamOnly: false,
      duplicate: false,
      droppedBy: null,
      at: event.at,
    });
    await ctx.jobs.enqueue(tx, HOLD_QUEUE, { workspaceId: event.workspaceId, itemId: event.itemId }, { dedupeKey: `hold:${event.itemId}` });
  });
}
