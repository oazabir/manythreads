import type { PluginContext, PluginEvent } from '@manythreads/sdk';
import { TeamTemplateAppliedEvent } from '@manythreads/shared';
import { syncTemplateChannels } from './routes-channels.ts';

/**
 * `team.template.applied` -> the template's channel group and channels, exactly once per team: `app.channels_sync_template` is a
 * get-or-create on (team_id, name) behind a marker row, so a redelivered event, a second apply and the directory's own catch-up
 * (a team seeded without the event) all create nothing new. Runs as the system actor from the outbox consumer.
 */
export function registerTemplateConsumer(ctx: PluginContext): void {
  ctx.events.subscribe('team.template.applied', async (raw: PluginEvent, tx) => {
    const event = TeamTemplateAppliedEvent.parse(raw);
    await syncTemplateChannels({ ctx }, tx, event.teamId);
  });
}
