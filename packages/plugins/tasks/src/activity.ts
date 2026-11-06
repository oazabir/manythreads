import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { json, requireTeam, route } from '@manythreads/sdk';
import { BotsRunClosedEvent, BotsRunOpenedEvent, CardActivityChangedPush, CardActivityResponse, cardActivityChangedPushType, cardActivityRoute } from '@manythreads/shared';

/**
 * Which bots work on which cards (the animated bot icon on a board card). The read is `app.tasks_card_activity`, which only shows cards the caller
 * can read; names are not sent, the client takes them from the team roster it already has.
 */
export function registerActivityRoute(ctx: PluginContext): void {
  ctx.http.route({
    ...cardActivityRoute,
    readOnly: true,
    schema: { response: CardActivityResponse },
    handler: route(async (req, tx) => {
      const { slug } = req.params as { slug: string };
      const team = await requireTeam(tx, slug);
      const rows = (
        await tx.query<{ task_id: string; bot_actor_id: string; phase: 'running' | 'queued' }>('SELECT task_id, bot_actor_id, phase FROM app.tasks_card_activity($1::uuid)', [team.id])
      ).rows;
      const byTask = new Map<string, Array<{ actorId: string; phase: 'running' | 'queued' }>>();
      for (const r of rows) {
        const list = byTask.get(r.task_id) ?? [];
        list.push({ actorId: r.bot_actor_id, phase: r.phase });
        byTask.set(r.task_id, list);
      }
      return json(CardActivityResponse.parse({ items: [...byTask].map(([taskId, bots]) => ({ taskId, bots })) }));
    }),
  });
}

/** Tell the open tabs of a team's people to read the activity again. A hint only: it carries the team and nothing about a card or a bot. */
async function pushActivityChanged(ctx: PluginContext, tx: PluginTx, teamId: string): Promise<void> {
  const people = (
    await tx.query<{ actor_id: string }>(
      `SELECT m.actor_id FROM app.team_members m JOIN app.actors a ON a.id = m.actor_id AND a.kind = 'person' WHERE m.team_id = $1::uuid`,
      [teamId],
    )
  ).rows.map((r) => r.actor_id);
  if (people.length === 0) return;
  await ctx.realtime.pushToPeople(tx, people, cardActivityChangedPushType, CardActivityChangedPush.parse({ teamId }));
}

/** A run on a card began or ended: push the hint. Runs with no card trigger nothing (a run closing is only looked at when it had one). */
export function registerActivitySubscribers(ctx: PluginContext): void {
  ctx.events.subscribe('bots.run.opened', async (raw: PluginEvent, tx: PluginTx) => {
    const event = BotsRunOpenedEvent.parse(raw);
    await pushActivityChanged(ctx, tx, event.teamId);
  });
  ctx.events.subscribe('bots.run.closed', async (raw: PluginEvent, tx: PluginTx) => {
    const event = BotsRunClosedEvent.parse(raw);
    const had = await tx.query('SELECT 1 FROM app.bot_runs WHERE id = $1::uuid AND task_id IS NOT NULL', [event.runId]);
    if (had.rows.length === 0) return;
    await pushActivityChanged(ctx, tx, event.teamId);
  });
}
