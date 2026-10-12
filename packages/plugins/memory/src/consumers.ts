import type { MemoryProvider, PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import {
  ApprovalsApprovalDecidedEvent,
  ApprovalsApprovalResumedEvent,
  BotsRunClosedEvent,
  ChannelChannelUpdatedEvent,
  ChannelMessageDeletedEvent,
  ChannelMessageEditedEvent,
  ChannelMessagePostedEvent,
  PagesPageWrittenEvent,
  RepoRepoCommittedEvent,
} from '@manythreads/shared';
import { feedTuning } from './config.ts';
import { FEED_QUEUE, NOT_CONFIGURED_EVERY_MS } from './constants.ts';
import { pageSourceId } from './sources.ts';

// The event subscriptions. They run inside the outbox consumer's transaction, next to every other plugin's, so they do two cheap things and
// nothing else: they write "this source changed" into the work list (one row per source, a repeat only moves its time) and queue the drain. They
// never read the source's text, never call the engine, and never throw for anything but a database failure: a bad payload is ignored, an
// absent engine is one log line a day. An event can therefore neither be lost nor held up by memory.

type SourceKind = 'message' | 'thread' | 'run' | 'approval' | 'page';
type Source = readonly [SourceKind, string];

/** Events consumed, in the order the manifest lists them. */
export const CONSUMED_EVENTS = [
  'channel.message.posted',
  'channel.message.edited',
  'channel.message.deleted',
  'channel.channel.updated',
  'approvals.approval.decided',
  'approvals.approval.resumed',
  'pages.page.written',
  'repo.repo.committed',
  'bots.run.closed',
] as const;

/** At most this many deleted pages of one commit are looked at. */
const MAX_DELETED_PAGES = 200;

/**
 * Queues a drain for after the debounce. Changes that land in the same time bucket share one job (its dedupe key is the bucket), and a job that
 * is already running holds a bucket that has passed, so a change that arrives mid-drain always gets a drain of its own: a single fixed key would
 * hand it to the running job, which has already read its list.
 */
export async function queueDrain(ctx: PluginContext, tx: PluginTx): Promise<void> {
  const { debounceMs } = feedTuning();
  const bucketMs = Math.max(1_000, debounceMs);
  const due = ctx.runtime.now().getTime() + debounceMs;
  const bucket = Math.floor(due / bucketMs);
  await ctx.jobs.enqueue(tx, FEED_QUEUE, {}, { runAt: new Date((bucket + 1) * bucketMs), dedupeKey: `feed:bucket:${bucket}` });
}

export function registerConsumers(ctx: PluginContext): void {
  const mark = async (tx: PluginTx, workspaceId: string, teamId: string, sources: readonly Source[]): Promise<void> => {
    if (sources.length === 0) return;
    const provider = ctx.providers.get<MemoryProvider>('memory');
    if (!provider || !provider.enabled) {
      // One line per team per day says the feed is off (and why nothing of this team is in the bank); the change itself is not queued.
      const [kind, id] = sources[0] as Source;
      // Events of one batch are handled at the same time: the lock makes the second of two see the first's line (the day's one line per team).
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`memory.not_configured:${teamId}`]);
      await tx.query(
        `INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome, reason)
         SELECT $1::uuid, $2::uuid, '(no engine)', $3, $4, 'not_configured', 'no memory engine is configured in this deployment'
          WHERE NOT EXISTS (
            SELECT 1 FROM app.memory_retain_log
             WHERE team_id = $2::uuid AND outcome = 'not_configured' AND created_at > now() - $5::float8 * interval '1 millisecond')`,
        [workspaceId, teamId, kind, id.slice(0, 1100), NOT_CONFIGURED_EVERY_MS],
      );
      return;
    }
    const { debounceMs } = feedTuning();
    for (const [kind, id] of sources) {
      await tx.query(
        `INSERT INTO app.memory_feed_pending (source_kind, source_id, workspace_id, not_before)
         VALUES ($1, $2, $3::uuid, now() + $4::float8 * interval '1 millisecond')
         ON CONFLICT (source_kind, source_id)
           DO UPDATE SET requested_at = now(), not_before = EXCLUDED.not_before, attempts = 0, last_error = ''`,
        [kind, id.slice(0, 1100), workspaceId, debounceMs],
      );
    }
    await queueDrain(ctx, tx);
  };

  /** A message is fed only from a PUBLIC channel of a team; for anything else nothing is queued, so a private channel costs no work and leaves no line. */
  const inPublicChannel = async (tx: PluginTx, channelId: string): Promise<boolean> =>
    (
      await tx.query<{ ok: boolean }>(
        "SELECT (kind = 'channel' AND NOT private AND team_id IS NOT NULL) AS ok FROM app.channels WHERE id = $1::uuid",
        [channelId],
      )
    ).rows[0]?.ok === true;

  const messageEvent = (schema: typeof ChannelMessagePostedEvent | typeof ChannelMessageEditedEvent | typeof ChannelMessageDeletedEvent, root: 'posted' | 'changed') =>
    async (raw: PluginEvent, tx: PluginTx): Promise<void> => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return;
      const e = parsed.data;
      if (e.teamId === null) return; // a DM or a bot conversation: never
      if (!(await inPublicChannel(tx, e.channelId))) return;
      if (e.threadRootId !== null) {
        // A reply belongs to its thread's document; the root's own document is dropped once it has replies.
        await mark(tx, e.workspaceId, e.teamId, [['thread', e.threadRootId], ['message', e.threadRootId]]);
      } else if (root === 'posted') {
        await mark(tx, e.workspaceId, e.teamId, [['message', e.messageId]]);
      } else {
        await mark(tx, e.workspaceId, e.teamId, [['message', e.messageId], ['thread', e.messageId]]);
      }
    };

  ctx.events.subscribe('channel.message.posted', messageEvent(ChannelMessagePostedEvent, 'posted'));
  ctx.events.subscribe('channel.message.edited', messageEvent(ChannelMessageEditedEvent, 'changed'));
  ctx.events.subscribe('channel.message.deleted', messageEvent(ChannelMessageDeletedEvent, 'changed'));

  // A channel that stopped being team-visible takes its documents out of the bank. Privacy never changes through the API today; this is for the
  // day it does (the event is the same `channel.channel.updated`) and for an operator's change, which the hourly sweep also finds.
  ctx.events.subscribe('channel.channel.updated', async (raw, tx) => {
    const parsed = ChannelChannelUpdatedEvent.safeParse(raw);
    if (!parsed.success || parsed.data.teamId === null) return;
    if (await inPublicChannel(tx, parsed.data.channelId)) return;
    await markRetainedOfChannels(ctx, tx, [parsed.data.channelId]);
  });

  const approval = async (raw: PluginEvent, tx: PluginTx): Promise<void> => {
    const parsed = ApprovalsApprovalDecidedEvent.or(ApprovalsApprovalResumedEvent).safeParse(raw);
    if (!parsed.success) return;
    await mark(tx, parsed.data.workspaceId, parsed.data.teamId, [['approval', parsed.data.approvalId]]);
  };
  ctx.events.subscribe('approvals.approval.decided', approval);
  ctx.events.subscribe('approvals.approval.resumed', approval);

  ctx.events.subscribe('pages.page.written', async (raw, tx) => {
    const parsed = PagesPageWrittenEvent.safeParse(raw);
    if (!parsed.success || !parsed.data.path.startsWith('pages/')) return;
    await mark(tx, parsed.data.workspaceId, parsed.data.teamId, [['page', pageSourceId(parsed.data.teamId, parsed.data.path)]]);
  });

  // `pages.page.written` is not emitted for a delete; the commit event is, and a deleted page forgets its document.
  ctx.events.subscribe('repo.repo.committed', async (raw, tx) => {
    const parsed = RepoRepoCommittedEvent.safeParse(raw);
    if (!parsed.success) return;
    const deleted = parsed.data.paths.filter((p) => p.op === 'delete' && p.path.startsWith('pages/')).slice(0, MAX_DELETED_PAGES);
    await mark(tx, parsed.data.workspaceId, parsed.data.teamId, deleted.map((p): Source => ['page', pageSourceId(parsed.data.teamId, p.path)]));
  });

  ctx.events.subscribe('bots.run.closed', async (raw, tx) => {
    const parsed = BotsRunClosedEvent.safeParse(raw);
    if (!parsed.success) return;
    await mark(tx, parsed.data.workspaceId, parsed.data.teamId, [['run', parsed.data.runId]]);
  });
}

/**
 * Marks every source of these channels whose newest log line says its document is in the bank, so the drain re-reads it (and, the channel no
 * longer being team-visible, forgets it). `channelIds` null: every channel that is not a public channel of a team and has a log line.
 */
export async function markRetainedOfChannels(ctx: PluginContext, tx: PluginTx, channelIds: readonly string[] | null): Promise<number> {
  const res = await tx.query<{ n: number }>(
    `WITH channels AS (
       SELECT c.id FROM app.channels c
        WHERE ($1::uuid[] IS NULL OR c.id = ANY ($1::uuid[]))
          AND (c.private OR c.kind <> 'channel' OR c.team_id IS NULL)
          AND EXISTS (SELECT 1 FROM app.memory_retain_log x WHERE x.channel_id = c.id)
     ), newest AS (
       SELECT DISTINCT ON (l.source_kind, l.source_id) l.source_kind, l.source_id, l.workspace_id, l.outcome
         FROM app.memory_retain_log l
        WHERE l.channel_id IN (SELECT id FROM channels) AND l.source_kind <> 'run_tool'
        ORDER BY l.source_kind, l.source_id, l.id DESC
     ), marked AS (
       INSERT INTO app.memory_feed_pending (source_kind, source_id, workspace_id, not_before)
       SELECT n.source_kind, n.source_id, n.workspace_id, now() FROM newest n WHERE n.outcome = 'retained'
       ON CONFLICT (source_kind, source_id) DO UPDATE SET requested_at = now(), not_before = now(), attempts = 0
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM marked`,
    [channelIds === null ? null : [...channelIds]],
  );
  const n = res.rows[0]?.n ?? 0;
  if (n > 0) await queueDrain(ctx, tx);
  return n;
}
