import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import {
  ChannelIncidentChangedEvent,
  IncidentResponse,
  OpenIncidentParams,
  OpenIncidentRequest,
  ResolveIncidentParams,
  ResolveIncidentRequest,
  openIncidentRoute,
  resolveIncidentRoute,
  Incident,
} from '@manythreads/shared';
import { conflict, forbidden, json, notFound, route } from './http.ts';
import { CHANNEL_COLUMNS, type ChannelRow } from './rows.ts';
import { authorsFor, postChannelMessage, pushChannelCreated, type Deps } from './service.ts';

/*
 * Incidents (P35-07, P18-07). `/incident <title>` opens `#inc-<yyyymmdd>-<slug>` in the team (any member may: `app.incidents_open` checks), posts its
 * opening message as the person (naming @on-call, so the role group is paged by the ordinary mention path), points to it from the channel the command was
 * typed in, and raises `channel.incident.changed` (opened): the runtime wakes the team's alert-triage bot in the opening message's thread. A job raises the
 * same event (update_due) on the incident's rhythm while it is open. `/incident resolve <summary>` closes it, drafts the post-mortem page in the team's
 * repository (the timeline from the channel's messages, the sections the people and the bot fill in) and raises it once more (resolved).
 */

export const INCIDENT_RHYTHM_QUEUE = 'channels.incident-rhythm';
const TIMELINE_MAX = 400;

/** The words of a title as a channel name part: lower case letters and digits, dashes between words, at most 40 characters. */
export function incidentSlug(title: string): string {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  let out = '';
  for (const w of words ?? []) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > 40) break;
    out = next;
  }
  return out || 'incident';
}

/** `inc-20261123-checkout-errors`. */
export const incidentChannelName = (title: string, at: Date): string => `inc-${at.toISOString().slice(0, 10).replace(/-/g, '')}-${incidentSlug(title)}`;

interface IncidentRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  channel_id: string;
  channel_name: string;
  title: string;
  status: 'open' | 'resolved';
  root_message_id: string | null;
  opened_by: string | null;
  opened_at: Date;
  resolved_at: Date | null;
  summary: string | null;
  postmortem_path: string | null;
}

const INCIDENT_SELECT = `SELECT i.id, i.workspace_id, i.team_id, i.channel_id, c.name AS channel_name, i.title, i.status, i.root_message_id, i.opened_by, i.opened_at,
  i.resolved_at, i.summary, i.postmortem_path FROM app.incidents i JOIN app.channels c ON c.id = i.channel_id`;

const toIncident = (r: IncidentRow): Incident =>
  Incident.parse({
  id: r.id,
  channelId: r.channel_id,
  channelName: r.channel_name,
  title: r.title,
  status: r.status,
  openedAt: r.opened_at.toISOString(),
  resolvedAt: r.resolved_at?.toISOString() ?? null,
  postmortemPath: r.postmortem_path,
  });

const hhmm = (d: Date): string => d.toISOString().slice(11, 16);
const oneLine = (s: string, max: number): string => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const minutesBetween = (a: Date, b: Date): number => Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));

/** The post-mortem draft: what is known for certain (times, people, the timeline from the channel), and the sections people and the bot fill in. */
export function postmortemDraft(input: {
  title: string;
  channelName: string;
  openedAt: Date;
  resolvedAt: Date;
  openedBy: string;
  resolvedBy: string;
  summary: string | null;
  timeline: ReadonlyArray<{ at: Date; who: string; text: string; reply: boolean }>;
  people: readonly string[];
}): string {
  const took = minutesBetween(input.openedAt, input.resolvedAt);
  const lines = [
    `# Post-mortem: ${oneLine(input.title, 200)}`,
    '',
    `- **Channel:** #${input.channelName}`,
    `- **Opened:** ${input.openedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC by ${input.openedBy}`,
    `- **Resolved:** ${input.resolvedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC by ${input.resolvedBy} (${took < 60 ? `${took} min` : `${Math.floor(took / 60)} h ${took % 60} min`})`,
    `- **People and bots involved:** ${input.people.join(', ') || '—'}`,
    '',
    '_This is a draft written when the incident was resolved. Edit it: the sections below the timeline are for the team to fill in._',
    '',
    '## Summary',
    '',
    input.summary ? input.summary : '_What happened, in two or three sentences._',
    '',
    '## Timeline (UTC)',
    '',
    ...(input.timeline.length === 0
      ? ['_Nothing was written in the channel._']
      : input.timeline.map((t) => `- ${hhmm(t.at)} ${t.reply ? '↳ ' : ''}**${t.who}:** ${oneLine(t.text, 240)}`)),
    '',
    '## Impact',
    '',
    '_Who or what was affected, for how long, and how badly._',
    '',
    '## Root cause',
    '',
    '_Why it happened. Facts, not blame._',
    '',
    '## What went well',
    '',
    '- ',
    '',
    '## What could have gone better',
    '',
    '- ',
    '',
    '## Action items',
    '',
    '- [ ] ',
    '',
  ];
  return lines.join('\n');
}

const emitChange = (ctx: PluginContext, tx: PluginTx, r: { workspace_id: string; team_id: string; id: string; channel_id: string; root_message_id: string }, change: 'opened' | 'update_due' | 'resolved', actorId: string | null, postmortemPath: string | null = null) =>
  ctx.audit.emit(
    tx,
    ChannelIncidentChangedEvent.parse({
      type: 'channel.incident.changed',
      schemaVersion: 1,
      workspaceId: r.workspace_id,
      teamId: r.team_id,
      incidentId: r.id,
      channelId: r.channel_id,
      rootMessageId: r.root_message_id,
      change,
      actorId,
      postmortemPath,
    }),
  );

/** One pass of the status rhythm: every open incident whose update is due gets its event, and its next one is set. Returns how many were due. */
export async function incidentRhythmPass(ctx: PluginContext): Promise<number> {
  return ctx.db.system(async (tx) => {
    const due = (
      await tx.query<{ id: string; workspace_id: string; team_id: string; channel_id: string; root_message_id: string; opened_by: string | null }>(
        `UPDATE app.incidents SET next_update_at = now() + make_interval(mins => update_every_minutes)
          WHERE status = 'open' AND next_update_at <= now() AND root_message_id IS NOT NULL
          RETURNING id, workspace_id, team_id, channel_id, root_message_id, opened_by`,
      )
    ).rows;
    for (const r of due) await emitChange(ctx, tx, r, 'update_due', r.opened_by);
    return due.length;
  });
}

export function registerIncidents(deps: Deps): void {
  const { ctx } = deps;

  ctx.http.route({
    ...openIncidentRoute,
    schema: { body: OpenIncidentRequest, response: IncidentResponse },
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { slug } = OpenIncidentParams.parse(req.params);
      const body = OpenIncidentRequest.parse(req.body);
      const team = (await tx.query<{ id: string }>('SELECT id FROM app.teams WHERE slug = $1', [slug])).rows[0];
      if (!team) throw forbidden('You cannot see this team');
      const opened = (
        await tx
          .query<{ channel_id: string; incident_id: string; name: string }>('SELECT channel_id, incident_id, name FROM app.incidents_open($1, $2, $3)', [
            team.id,
            incidentChannelName(body.title, ctx.runtime.now()),
            body.title,
          ])
          .catch((err: unknown) => {
            if ((err as { code?: string }).code === '42501') throw forbidden('Only a member of the team can open an incident');
            if ((err as { code?: string }).code === '23505') throw conflict('Too many incidents with this name today. Give it another title.');
            throw err;
          })
      ).rows[0]!;
      const channel = (await tx.query<ChannelRow>(`SELECT ${CHANNEL_COLUMNS} FROM app.channels c WHERE c.id = $1`, [opened.channel_id])).rows[0]!;
      await ctx.audit.emit(tx, { type: 'channel.channel.created', channelId: opened.channel_id, teamId: team.id, name: opened.name, kind: 'channel', private: false });
      await pushChannelCreated(deps, tx, channel);
      let from: { id: string; name: string } | undefined;
      if (body.fromChannelId && body.fromChannelId !== opened.channel_id) {
        from = (await tx.query<{ id: string; name: string }>("SELECT id, name FROM app.channels WHERE id = $1 AND team_id = $2 AND kind = 'channel'", [body.fromChannelId, team.id])).rows[0];
      }
      const root = await postChannelMessage(deps, tx, {
        channelId: opened.channel_id,
        body: `🚨 **Incident: ${oneLine(body.title, 200)}**\n\n@on-call you are paged.${from ? ` Opened from #${from.name}.` : ''} Join the voice room from the header, and keep what you find in this thread: the triage bot gathers logs and a timeline here, and posts a status update every 30 minutes until it is resolved with \`/incident resolve <summary>\`.`,
        threadRootId: null,
      });
      await tx.query('SELECT app.incidents_set_root($1, $2)', [opened.incident_id, root.id]);
      if (from) {
        // the pointer is a courtesy: a channel the person may only read (an announcements channel) must not stop the incident
        await tx.query('SAVEPOINT incident_pointer');
        try {
          await postChannelMessage(deps, tx, { channelId: from.id, body: `🚨 Incident opened: **${oneLine(body.title, 200)}** in #${opened.name}`, threadRootId: null });
          await tx.query('RELEASE SAVEPOINT incident_pointer');
        } catch {
          await tx.query('ROLLBACK TO SAVEPOINT incident_pointer');
        }
      }
      const row = (await tx.query<IncidentRow>(`${INCIDENT_SELECT} WHERE i.id = $1`, [opened.incident_id])).rows[0]!;
      await emitChange(ctx, tx, { ...row, root_message_id: root.id }, 'opened', tx.actor.id);
      return json(IncidentResponse.parse({ incident: toIncident(row) }), 201);
    }),
  });

  ctx.http.route({
    ...resolveIncidentRoute,
    schema: { body: ResolveIncidentRequest, response: IncidentResponse },
    rateLimit: { limit: 10, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { channelId } = ResolveIncidentParams.parse(req.params);
      const body = ResolveIncidentRequest.parse(req.body ?? {});
      const inc = (await tx.query<IncidentRow>(`${INCIDENT_SELECT} WHERE i.channel_id = $1`, [channelId])).rows[0];
      if (!inc) throw notFound('This channel is not an incident channel');
      if (inc.status === 'resolved') throw conflict('This incident is already resolved');
      const now = ctx.runtime.now();
      // the timeline: what was written in the channel since it opened, oldest first, as the person resolving it reads it
      const msgs = (
        await tx.query<{ id: string; author_id: string; body_plain: string; created_at: Date; thread_root_id: string | null }>(
          `SELECT id, author_id, body_plain, created_at, thread_root_id FROM app.messages
            WHERE channel_id = $1 AND deleted_at IS NULL AND body_plain <> '' ORDER BY created_at, id LIMIT ${TIMELINE_MAX}`,
          [channelId],
        )
      ).rows;
      const authors = await authorsFor(tx, msgs.map((m) => m.id));
      const nameOf = (actorId: string | null): string => (actorId ? (authors.get(actorId)?.displayName ?? 'Someone') : 'Someone');
      const resolverName =
        (
          await tx.query<{ display_name: string }>(
            `SELECT coalesce(pe.display_name, 'Someone') AS display_name FROM app.actors a LEFT JOIN app.people pe ON a.kind = 'person' AND pe.id = a.ref_id WHERE a.id = app.actor()`,
          )
        ).rows[0]?.display_name ?? 'Someone';
      const people = [...new Set(msgs.map((m) => nameOf(m.author_id)))];
      const path = `pages/incidents/${inc.channel_name}-postmortem.md`;
      const draft = postmortemDraft({
        title: inc.title,
        channelName: inc.channel_name,
        openedAt: inc.opened_at,
        resolvedAt: now,
        openedBy: nameOf(inc.opened_by),
        resolvedBy: resolverName,
        summary: body.summary ?? null,
        timeline: msgs.map((m) => ({ at: m.created_at, who: nameOf(m.author_id), text: m.body_plain, reply: m.thread_root_id !== null })),
        people,
      });
      const repo = ctx.providers.get<RepoProvider>('repo');
      let written: string | null = null;
      if (repo) {
        try {
          await tx.query('SAVEPOINT incident_postmortem');
          await repo.write(tx, inc.team_id, { id: tx.actor.id, kind: tx.actor.kind as 'person' }, [{ path, op: 'put', content: draft }], `Post-mortem draft: ${oneLine(inc.title, 120)}`);
          await tx.query('RELEASE SAVEPOINT incident_postmortem');
          written = path;
        } catch {
          // the incident is resolved whether or not the page could be written (the message says so); the savepoint keeps this transaction usable
          await tx.query('ROLLBACK TO SAVEPOINT incident_postmortem');
        }
      }
      const changed = (await tx.query<{ ok: boolean }>('SELECT app.incidents_resolve($1, $2, $3) AS ok', [channelId, body.summary ?? null, written])).rows[0]?.ok === true;
      if (!changed) throw conflict('This incident is already resolved');
      const took = minutesBetween(inc.opened_at, now);
      await postChannelMessage(deps, tx, {
        channelId,
        body: `✅ **Resolved** after ${took < 60 ? `${took} min` : `${Math.floor(took / 60)} h ${took % 60} min`}.${body.summary ? ` ${body.summary}` : ''}\n\n${written ? `The post-mortem draft, with the timeline from this channel, is in Files: \`${written}\`. Fill in the impact, the root cause and the action items.` : 'The post-mortem page could not be written; the timeline is this channel.'}`,
        threadRootId: null,
      });
      const row = (await tx.query<IncidentRow>(`${INCIDENT_SELECT} WHERE i.id = $1`, [inc.id])).rows[0]!;
      if (row.root_message_id) await emitChange(ctx, tx, { ...row, root_message_id: row.root_message_id }, 'resolved', tx.actor.id, written);
      return json(IncidentResponse.parse({ incident: toIncident(row) }));
    }),
  });

  // the status rhythm: each open incident is due an update every `update_every_minutes`
  ctx.jobs.register(
    INCIDENT_RHYTHM_QUEUE,
    async () => {
      await incidentRhythmPass(ctx);
    },
    { cron: '* * * * *', maxAttempts: 1, concurrency: 1, detached: true },
  );
}
