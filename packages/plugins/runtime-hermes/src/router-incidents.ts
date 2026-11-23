import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { ChannelIncidentChangedEvent } from '@manythreads/shared';
import { buildPrompt } from './match.ts';
import { RUN_QUEUE, type RunPayload } from './run-job.ts';

/*
 * Incidents (P35-07). An incident's own event wakes the team's alert-triage bot in the incident's thread, as a mention by the person who opened it (or
 * resolved it) would: once when it opens (gather logs and a timeline), on its rhythm (a status update), and when it is resolved (read the post-mortem
 * draft and post what it is missing: impact, root cause, action items as cards). A team without that bot gets no run; the incident works without it.
 */

const INCIDENT_BOT = 'alert-triage';

const ASK: Record<ChannelIncidentChangedEvent['change'], (path: string | null) => string> = {
  opened: () =>
    'An incident was just opened in this channel (the message above). Start the triage in this thread: say what you can find about it now (recent alerts, deploys and errors with `messages.search`, what the team decided about the same thing before with `memory.recall` and `knowledge.search`), list what is not known yet, and start a short timeline of what happened when. Do not guess a cause you have no evidence for.',
  update_due: () =>
    'A status update for this incident is due. Read this channel and its thread since the last update and post one short update in this thread: current state, what changed since the last update, who is on it, and the next step. If nothing changed, say so in one line.',
  resolved: (path) =>
    `This incident was just resolved.${path ? ` The post-mortem draft is the page \`${path}\` in the team's files, with the timeline from this channel.` : ''} Post, in this thread, what the post-mortem still needs from what you saw: the impact, the likely root cause (with the evidence, or say it is not known), and the action items. Create a card with \`tasks.create\` for each action item a person agreed to, and list them.`,
};

export function registerIncidentRouter(ctx: PluginContext): void {
  ctx.events.subscribe('channel.incident.changed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ChannelIncidentChangedEvent.parse(raw);
    const bot = (
      await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE team_id = $1::uuid AND slug = $2 AND status = 'active'`, [event.teamId, INCIDENT_BOT])
    ).rows[0];
    if (!bot) return;
    const root = (
      await tx.query<{ body: string; channel_name: string }>(
        `SELECT m.body, c.name AS channel_name FROM app.messages m JOIN app.channels c ON c.id = m.channel_id WHERE m.id = $1::uuid AND m.deleted_at IS NULL`,
        [event.rootMessageId],
      )
    ).rows[0];
    if (!root) return;
    const ask = `${root.body}\n\n${ASK[event.change](event.postmortemPath)}`;
    const payload: RunPayload = {
      workspaceId: event.workspaceId,
      botId: bot.id,
      teamId: event.teamId,
      channelId: event.channelId,
      trigger: 'mention',
      askerActorId: event.actorId,
      replyRootId: event.rootMessageId,
      runThreadId: null,
      prompt: buildPrompt({ authorName: 'manythreads', channelName: root.channel_name.replace(/^#/, ''), body: ask, project: null }),
      text: root.body.slice(0, 40_000),
      messageId: event.rootMessageId,
    };
    // one run per incident and change (the rhythm's change carries the time it was due, so each update is its own run)
    const key = event.change === 'update_due' ? `update:${Math.floor(Date.now() / 60_000)}` : event.change;
    await ctx.jobs.enqueue(tx, RUN_QUEUE, payload, { dedupeKey: `runtime-hermes:${bot.id}:incident:${event.incidentId}:${key}` });
  });
}
