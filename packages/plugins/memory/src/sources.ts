import type { PluginTx } from '@manythreads/sdk';
import { MAX_THREAD_REPLIES, isUuid, metadataOf, renderApproval, renderMessage, renderPage, renderRun, renderThread, tagOf, type FeedItem } from './render.ts';

// What each kind of source is, read as it is NOW (system transaction). An event only says "this changed"; `resolve*` answers what the bank
// should hold for it today:
//
//   retain   put this document in the bank (the feed compares its hash with the newest log line and does nothing when it is the same)
//   forget   the bank should hold nothing for this source (deleted, emptied, or no longer team-visible); a no-op when it never did
//   withhold the source exists and is team-visible, but something it was made from is narrower than the team (the narrowest-source rule):
//            nothing is retained and the log line says why
//   defer    the decision needs a run that has not closed yet: look again later
//   skip     nothing to do now (a pending approval, a reply that its thread document carries)
//
// A source is team-visible when it lives in a PUBLIC channel of a team (`kind = 'channel'`, not private, has a team) or, for a page, in
// the team's repo. Private channels, DMs and bot conversations are never read into a document: the resolver answers `forget` before it
// looks at the text.

export interface Provenance {
  teamId: string;
  workspaceId: string;
  channelId: string | null;
  runId: string | null;
  actorId: string | null;
  scopes: string[];
  link: string;
  /** Messages of a thread that were left out of its document because the run that wrote them read something narrower: one `withheld` line each. */
  excluded?: Array<{ messageId: string; actorId: string; reason: string }>;
}

export type Resolution =
  | { action: 'retain'; at: Provenance; item: FeedItem }
  | { action: 'forget'; reason: string }
  | { action: 'withhold'; at: Provenance; reason: string }
  | { action: 'defer'; at: Provenance; reason: string }
  | { action: 'skip'; reason: string };

const forget = (reason: string): Resolution => ({ action: 'forget', reason });
const skip = (reason: string): Resolution => ({ action: 'skip', reason });

const iso = (d: Date): string => d.toISOString();

interface AuthoredVerdict extends Record<string, unknown> {
  run_open: boolean;
  retain_refusal: string | null;
  runs: number;
}

/** The narrowest-source verdict for something a bot wrote at `at` (see `app.memory_authored_verdict`). */
async function authoredVerdict(tx: PluginTx, botActorId: string, at: Date): Promise<AuthoredVerdict> {
  const res = await tx.query<AuthoredVerdict>('SELECT run_open, retain_refusal, runs FROM app.memory_authored_verdict($1::uuid, $2::timestamptz)', [botActorId, at.toISOString()]);
  return res.rows[0] ?? { run_open: false, retain_refusal: null, runs: 0 };
}

const channelPath = (teamSlug: string, channelName: string): string => `/t/${teamSlug}/c/${encodeURIComponent(channelName)}`;

// Message and thread --------------------------------------------------------------------------------------------------------

interface MessageRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  channel_id: string;
  author_id: string;
  body_plain: string;
  thread_root_id: string | null;
  created_at: Date;
  deleted_at: Date | null;
  channel_kind: string;
  channel_private: boolean;
  channel_team_id: string | null;
  channel_name: string;
  team_slug: string | null;
  author_kind: string;
  author_name: string | null;
  has_replies: boolean;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.workspace_id, m.channel_id, m.author_id, m.body_plain, m.thread_root_id, m.created_at, m.deleted_at,
         c.kind AS channel_kind, c.private AS channel_private, c.team_id AS channel_team_id, c.name AS channel_name, t.slug AS team_slug,
         a.kind AS author_kind,
         CASE a.kind
           WHEN 'person' THEN (SELECT p.display_name FROM app.people p WHERE p.id = a.ref_id)
           WHEN 'bot' THEN (SELECT coalesce(nullif(b.name, ''), b.slug) FROM app.bots b WHERE b.id = a.ref_id)
         END AS author_name,
         EXISTS (SELECT 1 FROM app.messages r WHERE r.thread_root_id = m.id AND r.deleted_at IS NULL) AS has_replies
    FROM app.messages m
    JOIN app.channels c ON c.id = m.channel_id
    LEFT JOIN app.teams t ON t.id = c.team_id
    JOIN app.actors a ON a.id = m.author_id
   WHERE m.id = $1::uuid`;

const teamVisible = (r: Pick<MessageRow, 'channel_kind' | 'channel_private' | 'channel_team_id'>): boolean =>
  r.channel_kind === 'channel' && !r.channel_private && r.channel_team_id !== null;

export async function resolveMessage(tx: PluginTx, messageId: string): Promise<Resolution> {
  if (!isUuid(messageId)) return forget('gone');
  const m = (await tx.query<MessageRow>(MESSAGE_SELECT, [messageId])).rows[0];
  if (!m) return forget('gone');
  if (!teamVisible(m)) return forget('not_team_visible');
  if (m.deleted_at !== null || m.body_plain.trim() === '') return forget('deleted');
  // A reply is part of its thread's document; so is a root that has live replies (the thread document quotes it).
  if (m.thread_root_id !== null) return skip('reply');
  if (m.has_replies) return forget('in_thread');
  const at: Provenance = {
    teamId: m.channel_team_id as string,
    workspaceId: m.workspace_id,
    channelId: m.channel_id,
    runId: null,
    actorId: m.author_id,
    scopes: [],
    link: `${channelPath(m.team_slug ?? '', m.channel_name)}?message=${m.id}`,
  };
  if (m.author_kind === 'bot') {
    const v = await authoredVerdict(tx, m.author_id, m.created_at);
    if (v.run_open) return { action: 'defer', at, reason: 'run_open' };
    if (v.retain_refusal !== null) return { action: 'withhold', at, reason: `authoring run: ${v.retain_refusal}` };
  }
  const text = renderMessage({ channelName: m.channel_name, authorName: m.author_name ?? 'someone', at: iso(m.created_at), body: m.body_plain });
  return {
    action: 'retain',
    at,
    item: {
      ...text,
      timestamp: iso(m.created_at),
      tags: ['feed', 'kind:message', tagOf('channel', m.channel_name)],
      metadata: metadataOf({ feed_kind: 'message', feed_id: m.id, actor: m.author_id, actor_name: m.author_name, occurred_at: iso(m.created_at), link: at.link, channel: m.channel_name }),
    },
  };
}

interface ReplyRow extends Record<string, unknown> {
  id: string;
  author_id: string;
  body_plain: string;
  created_at: Date;
  author_kind: string;
  author_name: string | null;
  run_open: boolean | null;
  retain_refusal: string | null;
}

export async function resolveThread(tx: PluginTx, rootId: string): Promise<Resolution> {
  if (!isUuid(rootId)) return forget('gone');
  const root = (await tx.query<MessageRow>(MESSAGE_SELECT, [rootId])).rows[0];
  if (!root) return forget('gone');
  if (!teamVisible(root)) return forget('not_team_visible');
  if (root.deleted_at !== null || root.body_plain.trim() === '') return forget('deleted');
  if (root.thread_root_id !== null) return skip('reply');
  const replies = (
    await tx.query<ReplyRow>(
      `SELECT m.id, m.author_id, m.body_plain, m.created_at, a.kind AS author_kind,
              CASE a.kind
                WHEN 'person' THEN (SELECT p.display_name FROM app.people p WHERE p.id = a.ref_id)
                WHEN 'bot' THEN (SELECT coalesce(nullif(b.name, ''), b.slug) FROM app.bots b WHERE b.id = a.ref_id)
              END AS author_name,
              v.run_open, v.retain_refusal
         FROM app.messages m
         JOIN app.actors a ON a.id = m.author_id
         LEFT JOIN LATERAL app.memory_authored_verdict(a.id, m.created_at) v ON a.kind = 'bot'
        WHERE m.thread_root_id = $1::uuid AND m.deleted_at IS NULL AND m.body_plain <> ''
        ORDER BY m.id
        LIMIT $2`,
      [rootId, MAX_THREAD_REPLIES + 1],
    )
  ).rows;
  // No live reply: the root is a plain message again (its own document, which the same event marked).
  if (replies.length === 0) return forget('no_replies');

  const at: Provenance = {
    teamId: root.channel_team_id as string,
    workspaceId: root.workspace_id,
    channelId: root.channel_id,
    runId: null,
    actorId: root.author_id,
    scopes: [],
    link: `${channelPath(root.team_slug ?? '', root.channel_name)}?message=${root.id}`,
  };
  const rootVerdict = root.author_kind === 'bot' ? await authoredVerdict(tx, root.author_id, root.created_at) : null;
  if (rootVerdict?.run_open === true || replies.some((r) => r.run_open === true)) return { action: 'defer', at, reason: 'run_open' };

  const quoted: Array<{ authorName: string; at: string; body: string }> = [];
  const excluded: NonNullable<Provenance['excluded']> = [];
  let withheld: string | null = null;
  let rootQuoted = false;
  if (rootVerdict?.retain_refusal != null) {
    withheld = rootVerdict.retain_refusal;
    excluded.push({ messageId: root.id, actorId: root.author_id, reason: `authoring run: ${rootVerdict.retain_refusal}` });
  } else {
    quoted.push({ authorName: root.author_name ?? 'someone', at: iso(root.created_at), body: root.body_plain });
    rootQuoted = true;
  }
  for (const r of replies.slice(0, MAX_THREAD_REPLIES)) {
    // What a bot wrote in a run that read something narrower than the team is left out of the document, like the message itself.
    if (r.retain_refusal !== null) {
      withheld ??= r.retain_refusal;
      excluded.push({ messageId: r.id, actorId: r.author_id, reason: `authoring run: ${r.retain_refusal}` });
      continue;
    }
    quoted.push({ authorName: r.author_name ?? 'someone', at: iso(r.created_at), body: r.body_plain });
  }
  at.excluded = excluded;
  if (quoted.length === 0) return { action: 'withhold', at, reason: `authoring run: ${withheld ?? 'private_source'}` };

  // The title is the root's own first line, taken only from a root that is quoted: `app.threads.title` is a copy of the root's first characters
  // made when it was posted, so reading it would put a withheld root's words in the head of a document that does not quote it.
  const title = rootQuoted ? (root.body_plain.split('\n', 1)[0] ?? '').slice(0, 120) : '';
  const text = renderThread({
    channelName: root.channel_name,
    title,
    messages: quoted,
    moreReplies: Math.max(0, replies.length - MAX_THREAD_REPLIES),
  });
  const last = replies[Math.min(replies.length, MAX_THREAD_REPLIES) - 1] as ReplyRow;
  return {
    action: 'retain',
    at,
    item: {
      ...text,
      timestamp: iso(last.created_at),
      tags: ['feed', 'kind:thread', tagOf('channel', root.channel_name)],
      metadata: metadataOf({ feed_kind: 'thread', feed_id: root.id, actor: root.author_id, actor_name: root.author_name, occurred_at: iso(root.created_at), link: at.link, channel: root.channel_name }),
    },
  };
}

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

interface VerdictRow extends Record<string, unknown> {
  retain_refusal: string | null;
  narrowest_scope: string;
  source_lines: number;
  source_scopes: string[];
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
  if (!r) {
    // A run that retention pruned leaves a memo (migration 0002): the log it was made from is gone, the document made from it is not, and the bank
    // keeps it (the memory outlives the run's log). A run that is gone for any other reason (its bot was removed) has no document to keep.
    const memo = (await tx.query('SELECT 1 FROM app.memory_run_memo WHERE run_id = $1::uuid', [runId])).rows[0];
    return memo !== undefined ? skip('pruned') : forget('gone');
  }
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

// Approval ------------------------------------------------------------------------------------------------------------------

interface ApprovalRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  team_id: string;
  source: string;
  status: string;
  outcome: string;
  outcome_detail: string;
  tool: string;
  summary: string;
  requester_id: string;
  requester_name: string;
  run_id: string | null;
  /** The approval was filed from a run (`run_id` was set at insert); `run_id` is NULL afterwards when that run was deleted. */
  had_run: boolean;
  channel_id: string | null;
  created_at: Date;
  decided_at: Date | null;
  bot_slug: string | null;
  bot_name: string | null;
  decider_name: string | null;
  channel_kind: string | null;
  channel_private: boolean | null;
  channel_team_id: string | null;
  channel_name: string | null;
  team_slug: string;
}

export async function resolveApproval(tx: PluginTx, approvalId: string): Promise<Resolution> {
  if (!isUuid(approvalId)) return forget('gone');
  const a = (
    await tx.query<ApprovalRow>(
      `SELECT a.id, a.workspace_id, a.team_id, a.source, a.status, a.outcome, a.outcome_detail, a.tool, a.summary, a.requester_id, a.requester_name,
              a.run_id, a.had_run, a.channel_id, a.created_at, a.decided_at,
              b.slug AS bot_slug, coalesce(nullif(b.name, ''), b.slug) AS bot_name, d.decider_name,
              c.kind AS channel_kind, c.private AS channel_private, c.team_id AS channel_team_id, c.name AS channel_name, t.slug AS team_slug
         FROM app.approvals a
         JOIN app.teams t ON t.id = a.team_id
         LEFT JOIN app.bots b ON b.id = a.bot_id
         LEFT JOIN app.approval_decisions d ON d.approval_id = a.id
         LEFT JOIN app.channels c ON c.id = a.channel_id
        WHERE a.id = $1::uuid`,
      [approvalId],
    )
  ).rows[0];
  if (!a) return forget('gone');
  // An approval raised in a private channel, a DM or a bot conversation is made of that conversation (summary, preview, excerpt): never fed.
  if (a.channel_id !== null && !(a.channel_kind === 'channel' && a.channel_private === false && a.channel_team_id === a.team_id)) return forget('not_team_visible');
  if (a.status === 'pending') return skip('pending');

  const at: Provenance = {
    teamId: a.team_id,
    workspaceId: a.workspace_id,
    channelId: a.channel_id,
    runId: a.run_id,
    actorId: a.requester_id,
    scopes: [],
    link: `/t/${a.team_slug}/approvals`,
  };
  if (a.run_id !== null) {
    const run = (await tx.query<{ status: string; ended_at: Date | null }>('SELECT status, ended_at FROM app.bot_runs WHERE id = $1::uuid', [a.run_id])).rows[0];
    if (run && run.status === 'running') return { action: 'defer', at, reason: 'run_open' };
    const verdict = (await tx.query<VerdictRow>('SELECT retain_refusal, narrowest_scope, source_lines, source_scopes FROM app.run_retain_verdict($1::uuid)', [a.run_id])).rows[0];
    if (verdict) {
      at.scopes = verdict.source_scopes;
      if (verdict.retain_refusal !== null) return { action: 'withhold', at, reason: verdict.retain_refusal };
    }
  } else if (a.had_run) {
    // The run it was filed from is gone: retention pruned it (and left a memo that remembers this approval), or it was deleted some other way.
    // `approvals.run_id` is SET NULL by the foreign key, so "no run" is not "a run that read nothing narrower": the memo decides, and a run that
    // left no memo cannot be judged, which is a refusal (fail closed, like `inheritSources`).
    const memo = (
      await tx.query<{ retain_refusal: string | null }>('SELECT retain_refusal FROM app.memory_run_memo WHERE approval_ids @> ARRAY[$1::uuid] LIMIT 1', [approvalId])
    ).rows[0];
    if (memo === undefined) return { action: 'withhold', at, reason: 'run_gone' };
    if (memo.retain_refusal !== null) return { action: 'withhold', at, reason: memo.retain_refusal };
  }
  const when = a.decided_at ?? a.created_at;
  const text = renderApproval({
    tool: a.tool,
    source: a.source,
    summary: a.summary,
    status: a.status,
    outcome: a.outcome,
    outcomeDetail: a.outcome_detail,
    requesterName: a.requester_name === '' ? 'someone' : a.requester_name,
    botName: a.bot_name,
    deciderName: a.decider_name,
    decidedAt: a.decided_at === null ? null : iso(a.decided_at),
    channelName: a.channel_kind === 'channel' ? a.channel_name : null,
  });
  return {
    action: 'retain',
    at,
    item: {
      ...text,
      timestamp: iso(when),
      tags: ['feed', 'kind:approval', tagOf('tool', a.tool), tagOf('status', a.status)],
      metadata: metadataOf({ feed_kind: 'approval', feed_id: a.id, actor: a.requester_id, actor_name: a.requester_name, occurred_at: iso(when), link: at.link, tool: a.tool, status: a.status }),
    },
  };
}

// Page ----------------------------------------------------------------------------------------------------------------------

/** A page's source id: the team and the path (a path alone is not unique across teams). */
export const pageSourceId = (teamId: string, path: string): string => `${teamId}/${path}`;

interface PageRow extends Record<string, unknown> {
  team_id: string;
  workspace_id: string;
  team_slug: string;
  path: string;
  text_plain: string | null;
  committed_at: Date;
  indexed_at: Date;
  author_id: string | null;
  author_kind: string | null;
  author_name: string | null;
}

export async function resolvePage(tx: PluginTx, sourceId: string): Promise<Resolution> {
  const slash = sourceId.indexOf('/');
  const teamId = slash < 0 ? '' : sourceId.slice(0, slash);
  const path = slash < 0 ? '' : sourceId.slice(slash + 1);
  if (!isUuid(teamId) || !path.startsWith('pages/')) return forget('gone');
  const p = (
    await tx.query<PageRow>(
      `SELECT e.team_id, t.workspace_id, t.slug AS team_slug, e.path, e.text_plain, c.committed_at, coalesce(c.indexed_at, c.committed_at) AS indexed_at, c.author_id,
              a.kind AS author_kind,
              CASE a.kind
                WHEN 'person' THEN (SELECT pe.display_name FROM app.people pe WHERE pe.id = a.ref_id)
                WHEN 'bot' THEN (SELECT coalesce(nullif(b.name, ''), b.slug) FROM app.bots b WHERE b.id = a.ref_id)
              END AS author_name
         FROM app.repo_entries e
         JOIN app.teams t ON t.id = e.team_id
         JOIN app.repo_commits c ON c.team_id = e.team_id AND c.sha = e.last_commit_sha
         LEFT JOIN app.actors a ON a.id = c.author_id
        WHERE e.team_id = $1::uuid AND e.path = $2`,
      [teamId, path],
    )
  ).rows[0];
  if (!p) return forget('deleted');
  if (p.text_plain === null || p.text_plain.trim() === '') return forget('no_text');
  const at: Provenance = {
    teamId: p.team_id,
    workspaceId: p.workspace_id,
    channelId: null,
    runId: null,
    actorId: p.author_id,
    scopes: [],
    link: `/t/${p.team_slug}/files?open=${encodeURIComponent(p.path)}`,
  };
  // A page a bot wrote during a run is judged by that run, like a message it posted.
  if (p.author_kind === 'bot' && p.author_id !== null) {
    // Two instants: the git author date (to the second, from whichever clock made the commit) and when the index recorded it (the database's
    // clock, the one the runs' times are on). A commit the index caught up with later has an `indexed_at` long after the run; its author date
    // is the one that matches then. Either instant inside a run that read something narrower is enough to refuse.
    const instants = [p.committed_at];
    if (Math.abs(p.indexed_at.getTime() - p.committed_at.getTime()) > 2_000) instants.push(p.indexed_at);
    let open = false;
    let refusal: string | null = null;
    for (const when of instants) {
      const v = await authoredVerdict(tx, p.author_id, when);
      open ||= v.run_open;
      refusal ??= v.retain_refusal;
    }
    if (open) return { action: 'defer', at, reason: 'run_open' };
    if (refusal !== null) return { action: 'withhold', at, reason: `authoring run: ${refusal}` };
  }
  const text = renderPage({ path: p.path, text: p.text_plain, authorName: p.author_name, at: iso(p.committed_at) });
  return {
    action: 'retain',
    at,
    item: {
      ...text,
      timestamp: iso(p.committed_at),
      tags: ['feed', 'kind:page'],
      metadata: metadataOf({ feed_kind: 'page', feed_id: p.path, actor: p.author_id, actor_name: p.author_name, occurred_at: iso(p.committed_at), link: at.link, path: p.path }),
    },
  };
}

export async function resolve(tx: PluginTx, kind: string, sourceId: string): Promise<Resolution> {
  switch (kind) {
    case 'message':
      return resolveMessage(tx, sourceId);
    case 'thread':
      return resolveThread(tx, sourceId);
    case 'run':
      return resolveRun(tx, sourceId);
    case 'approval':
      return resolveApproval(tx, sourceId);
    case 'page':
      return resolvePage(tx, sourceId);
    default:
      return skip('unknown_kind');
  }
}
