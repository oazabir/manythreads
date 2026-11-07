import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { TeamMemberAddedEvent, TeamMemberRemovedEvent } from '@manythreads/shared';

// A person's conversation with the workspace Brain lives in the team they had when it was made. When they leave that team (or, having had no team, join one) the channel,
// its index rows and its files move to their oldest remaining team, so they can read and post in it again (migration 0005, `app.conversations_rehome`). The step needs the
// real system role: it runs in the outbox consumer's transaction on the two team events, and as a sweep every ten minutes for a notice that never came. Each channel moved is
// announced once, with ids only; a second pass finds nothing to move and announces nothing.

export const REHOME_SWEEP_QUEUE = 'conversations.rehome-sweep';

interface Moved {
  moved_channel_id: string;
  moved_workspace_id: string;
  moved_bot_id: string;
  moved_person_id: string;
  from_team_id: string;
  to_team_id: string;
  [key: string]: unknown;
}

/** Move the stranded Brain conversations of one person (or of everybody, with null) to their current team. Returns how many channels moved. `tx` must be a system transaction. */
export async function rehomeConversations(ctx: PluginContext, tx: PluginTx, personId: string | null): Promise<number> {
  const moved = (await tx.query<Moved>('SELECT * FROM app.conversations_rehome($1::uuid)', [personId])).rows;
  for (const m of moved) {
    await ctx.audit.emit(tx, {
      type: 'conversations.conversation.moved',
      workspaceId: m.moved_workspace_id,
      botId: m.moved_bot_id,
      personId: m.moved_person_id,
      channelId: m.moved_channel_id,
      fromTeamId: m.from_team_id,
      toTeamId: m.to_team_id,
    });
  }
  return moved.length;
}

export function registerRehome(ctx: PluginContext): void {
  ctx.events.subscribe('team.member.removed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = TeamMemberRemovedEvent.parse(raw);
    await rehomeConversations(ctx, tx, event.personId);
  });
  // a person who had no team joins one: the conversation they kept from before is theirs again there
  ctx.events.subscribe('team.member.added', async (raw: PluginEvent, tx: PluginTx) => {
    const event = TeamMemberAddedEvent.parse(raw);
    await rehomeConversations(ctx, tx, event.personId);
  });
  ctx.jobs.register(
    REHOME_SWEEP_QUEUE,
    async (_payload, tx) => {
      await rehomeConversations(ctx, tx, null);
    },
    { cron: '*/10 * * * *', maxAttempts: 1, concurrency: 1 },
  );
}
