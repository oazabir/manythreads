import type { PluginTx } from '@manythreads/sdk';
import { isUuid, metadataOf, renderRun, tagOf } from '../render.ts';
import { forget, iso, skip, type Provenance, type Resolution, type VerdictRow } from './common.ts';

// Run -----------------------------------------------------------------------------------------------------------------------

interface RunRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  trigger_type: string;
  status: string;
  started_at: Date;
  ended_at: Date | null;
  channel_id: string | null;
  thread_id: string | null;
  asker_id: string | null;
  bot_slug: string;
  bot_name: string;
  team_slug: string;
  channel_name: string | null;
  channel_kind: string | null;
  channel_private: boolean | null;
  channel_team_id: string | null;
  /** The run's thread is in a public channel of its team; null when it has no thread. */
  thread_public: boolean | null;
  bot_actor_id: string | null;
  asker_name: string | null;
}

export async function resolveRun(tx: PluginTx, runId: string): Promise<Resolution> {
  if (!isUuid(runId)) return forget('gone');
  const r = (
    await tx.query<RunRow>(
      `SELECT r.id, r.workspace_id, r.team_id, r.trigger_type, r.status, r.started_at, r.ended_at, r.channel_id, r.thread_id, r.asker_id,
              b.slug AS bot_slug, coalesce(nullif(b.name, ''), b.slug) AS bot_name, t.slug AS team_slug,
              c.name AS channel_name, c.kind AS channel_kind, c.private AS channel_private, c.team_id AS channel_team_id,
              (SELECT (c2.kind = 'channel' AND NOT c2.private AND c2.team_id = r.team_id)
                 FROM app.threads th JOIN app.channels c2 ON c2.id = th.channel_id WHERE th.root_message_id = r.thread_id) AS thread_public,
              (SELECT a.id FROM app.actors a WHERE a.kind = 'bot' AND a.ref_id = r.bot_id AND a.workspace_id = r.workspace_id) AS bot_actor_id,
              (SELECT p.display_name FROM app.actors a JOIN app.people p ON p.id = a.ref_id WHERE a.id = r.asker_id AND a.kind = 'person') AS asker_name
         FROM app.bot_runs r
         JOIN app.bots b ON b.id = r.bot_id
         JOIN app.teams t ON t.id = r.team_id
         LEFT JOIN app.channels c ON c.id = r.channel_id
        WHERE r.id = $1::uuid`,
      [runId],
    )
  ).rows[0];
  // A run that is gone keeps its summary in the bank, whatever took it: retention pruned its log (the memory outlives the run's log), or its bot
  // was removed. The summary is types and counts, never text, and it was made only for a run the narrowest-source rule allowed; nothing makes
  // forgetting it a requirement, and a re-read (a channel rename) must not turn a pruned log into a forgotten memory.
  if (!r) return skip('gone');
  const at: Provenance = {
    teamId: r.team_id,
    workspaceId: r.workspace_id,
    channelId: r.channel_id,
    runId: r.id,
    actorId: r.asker_id ?? r.bot_actor_id,
    scopes: [],
    link: `/t/${r.team_slug}/bots/${r.bot_slug}`,
  };
  // A run of a private conversation (a person talking to the bot, a private channel or thread) leaves no line, like the private messages it is made
  // of: one line per conversation turn would be a log of who talks to which bot. Decided from the run itself, BEFORE anything it read: a DM run
  // that read a person source is still a DM run, and must not leave a line saying so either. (A run that withholds because of what it READ in a
  // public context still is a line.)
  const publicChannel = r.channel_id === null || (r.channel_kind === 'channel' && r.channel_private === false && r.channel_team_id === r.team_id);
  if (r.trigger_type === 'conversation' || !publicChannel || (r.thread_id !== null && r.thread_public !== true)) return skip('private_context');
  if (r.status === 'running' || r.ended_at === null) return { action: 'defer', at, reason: 'run_open' };

  const verdict = (await tx.query<VerdictRow>('SELECT retain_refusal, narrowest_scope, source_lines, source_scopes FROM app.run_retain_verdict($1::uuid)', [runId])).rows[0];
  at.scopes = verdict?.source_scopes ?? [];
  // The narrowest-source rule: a run's result goes into the team bank only if everything it read is team-visible. Otherwise nothing is
  // retained and the log says which refusal applied (`person_source`, `private_source`, `conversation`, `private_channel`, `private_thread`).
  if (verdict === undefined) return forget('gone');
  if (verdict.retain_refusal !== null) return { action: 'withhold', at, reason: verdict.retain_refusal };

  const sources = (
    await tx.query<{ source_type: string; n: number }>(
      'SELECT source_type, count(*)::int AS n FROM app.run_source_log WHERE run_id = $1::uuid GROUP BY source_type ORDER BY source_type',
      [runId],
    )
  ).rows;
  const text = renderRun({
    botName: r.bot_name,
    teamSlug: r.team_slug,
    trigger: r.trigger_type,
    status: r.status,
    startedAt: iso(r.started_at),
    endedAt: iso(r.ended_at),
    askerName: r.asker_name,
    channelName: r.channel_kind === 'channel' ? r.channel_name : null,
    sources: sources.map((s) => ({ type: s.source_type, count: s.n })),
  });
  return {
    action: 'retain',
    at,
    item: {
      ...text,
      timestamp: iso(r.ended_at),
      tags: ['feed', 'kind:run', tagOf('bot', r.bot_slug), tagOf('trigger', r.trigger_type)],
      metadata: metadataOf({ feed_kind: 'run', feed_id: r.id, actor: at.actorId, actor_name: r.asker_name ?? r.bot_name, occurred_at: iso(r.ended_at), link: at.link, bot: r.bot_slug, status: r.status }),
    },
  };
}
