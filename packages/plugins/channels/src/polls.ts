import type { HttpCaller, PluginLogger, PluginTx } from '@manythreads/sdk';
import {
  ChannelPollClosedEvent,
  PollChangedPush,
  PollView,
  WS_POLL_CHANGED,
  pollResultText,
} from '@manythreads/shared';
import { forbidden, notFound } from './http.ts';
import { createPollPushCoalescer, type PollPushCoalescer } from './poll-push.ts';
import { findPoll } from './poll-views.ts';
import { POLL_MINE_JOIN, POLL_SELECT, toPollView, type PollRow } from './rows.ts';
import { audience, can, postChannelMessage, type Deps } from './service.ts';

// The write side that routes and the minute job share: telling readers the counts changed, and closing a poll with its plain-text result.

/** The job that closes polls at their closing time: every minute (the cron grid of the job queue; 5-field cron in UTC). */
export const CLOSE_QUEUE = 'channels.close_polls';
export const CLOSE_CRON = '* * * * *';
/** Due polls are read this many at a time; a run goes on until nothing is left or its time budget is spent. */
export const CLOSE_BATCH = 100;
export const CLOSE_BUDGET_MS = 45_000;

/** Sends the totals of a poll to everyone who can read its channel (delivered when `tx` commits). Totals only: no reader-specific field, no voter. */
async function pushTotals({ ctx }: Deps, tx: PluginTx, row: PollRow): Promise<void> {
  const payload: PollChangedPush = PollChangedPush.parse({
    channelId: row.channel_id,
    messageId: row.message_id,
    pollId: row.id,
    votes: row.options.map((_, i) => row.vote_counts[i] ?? 0),
    voters: row.voter_count,
    version: row.version,
    closed: row.closed,
    closedAt: row.closed_at?.toISOString() ?? null,
    resultMessageId: row.result_message_id,
  });
  await ctx.realtime.pushToPeople(tx, await audience(tx, row.channel_id), WS_POLL_CHANGED, payload);
}

const pushers = new WeakMap<Deps, PollPushCoalescer>();

/** The pace of this instance's pushes (see poll-push.ts); one per `Deps`. A waiting push reads the committed poll in a system transaction when its time comes. */
function pusherOf(deps: Deps): PollPushCoalescer {
  let pusher = pushers.get(deps);
  if (!pusher) {
    pusher = createPollPushCoalescer(
      {
        now: () => Date.now(),
        setTimer: (run, ms) => {
          const handle = setTimeout(run, ms);
          handle.unref();
          return handle;
        },
        clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      async (pollId) => {
        // a system transaction without a workspace has the nil workspace, and a push is addressed by workspace and person: find the poll's workspace first
        const workspaceId = await deps.ctx.db.system(async (tx) => (await tx.query<{ workspace_id: string }>('SELECT workspace_id FROM app.polls WHERE id = $1', [pollId])).rows[0]?.workspace_id);
        if (!workspaceId) return;
        await deps.ctx.db.system(
          async (tx) => {
            const res = await tx.query<PollRow>(`SELECT ${POLL_SELECT} FROM app.polls p LEFT JOIN app.poll_votes mv ON false WHERE p.id = $1`, [pollId]);
            if (res.rows[0]) await pushTotals(deps, tx, res.rows[0]);
          },
          { workspaceId },
        );
      },
      () => {
        // a push that could not be sent is not worth more than the next change: the page also reads the poll fresh when it is opened
      },
    );
    pushers.set(deps, pusher);
  }
  return pusher;
}

/**
 * Tells the readers of the channel that a poll's totals changed. Not every change goes out at once (an anonymous poll's totals wait a few seconds so a
 * page cannot see which vote moved them; a burst on a named poll is one push), and a close (`immediate`) always does. Pushes carry the poll's version,
 * so a page ignores any that arrives late.
 */
export async function pushPollChanged(deps: Deps, tx: PluginTx, row: PollRow, options: { immediate?: boolean } = {}): Promise<void> {
  const verdict = pusherOf(deps).decide({ id: row.id, anonymous: row.anonymous }, options.immediate === true);
  if (verdict === 'now') await pushTotals(deps, tx, row);
}

/** The poll as the caller sees it after a change, read again so the totals are the committed ones of this transaction. */
export async function reloadPoll(tx: PluginTx, channelId: string, pollId: string): Promise<{ row: PollRow; view: PollView }> {
  const row = await findPoll(tx, channelId, pollId);
  if (!row) throw notFound('No such poll');
  return { row, view: toPollView(row) };
}

export type CloseReason = 'author' | 'time';

export interface CloseOutcome {
  /** This call closed it (false: it was closed already). */
  closed: boolean;
  /** Nothing was changed because the caller may not post the result and `requirePostRight` was asked (the job then tries somebody else). */
  cannotPost: boolean;
  view: PollView;
}

/**
 * Closes one poll **as the transaction's actor** (its author, a team lead of the channel's team or a workspace admin; anybody else is refused 403) and
 * posts the plain-text result as a new message of the same channel (in the same thread when the poll was a reply) by that actor. The poll row is
 * locked first, so the votes that were accepted are exactly the votes counted in the result (a vote in flight waits for the lock and then finds the
 * poll closed). Closing a poll that is already closed changes nothing and posts nothing.
 *
 * A result needs a channel that is not archived, a message that was not deleted and an actor who may post. When one of these is missing the poll is
 * closed anyway, without a message (`resultMessageId` stays null: the last resort), unless `requirePostRight` says the caller would rather leave it
 * to somebody who can post: then only an actor who has lost the right to post gets `cannotPost` back and nothing changes.
 */
export async function closePoll(
  deps: Deps,
  tx: PluginTx,
  channelId: string,
  pollId: string,
  reason: CloseReason,
  options: { requirePostRight?: boolean } = {},
): Promise<CloseOutcome> {
  const { ctx } = deps;
  // Who may close is decided first, on a plain read; then the poll is locked by a definer function (`SELECT ... FOR UPDATE` obeys the update policy, which
  // is the author's alone, so for a team lead or an admin it would find no row), and only then are the totals read that the result will print.
  const who = await tx.query<{ author_id: string }>('SELECT author_id FROM app.polls WHERE id = $1 AND channel_id = $2', [pollId, channelId]);
  if (!who.rows[0]) throw notFound('No such poll');
  if (who.rows[0].author_id !== tx.actor.id && !(await can(tx, channelId, 'manage'))) throw forbidden('Only the author, a team lead or an admin can close this poll');
  await tx.query('SELECT app.polls_lock($1)', [pollId]);
  const locked = await tx.query<PollRow & { team_id: string | null; thread_root_id: string | null; message_deleted: boolean; channel_archived: boolean }>(
    `SELECT ${POLL_SELECT}, c.team_id, m.thread_root_id, (m.deleted_at IS NOT NULL) AS message_deleted, (c.archived_at IS NOT NULL) AS channel_archived
       FROM app.polls p ${POLL_MINE_JOIN}
       JOIN app.channels c ON c.id = p.channel_id JOIN app.messages m ON m.id = p.message_id
      WHERE p.id = $1 AND p.channel_id = $2`,
    [pollId, channelId],
  );
  const row = locked.rows[0];
  if (!row) throw notFound('No such poll');
  if (row.closed_at) return { closed: false, cannotPost: false, view: toPollView(row) };
  const wantsResult = !row.message_deleted && !row.channel_archived;
  const mayPost = wantsResult && (await can(tx, channelId, 'post'));
  if (wantsResult && !mayPost && options.requirePostRight) return { closed: false, cannotPost: true, view: toPollView(row) };
  let resultMessageId: string | null = null;
  if (mayPost) {
    const posted = await postChannelMessage(deps, tx, {
      channelId,
      body: pollResultText({
        question: row.question,
        options: row.options.map((text, i) => ({ text, votes: row.vote_counts[i] ?? 0 })),
        voters: row.voter_count,
        anonymous: row.anonymous,
        closedEarly: reason === 'author',
      }),
      threadRootId: row.thread_root_id,
      // `pollResult` keeps it out of the bot routers (whatever the options said, the result starts nobody); no mention is recorded either
      meta: { pollResult: { id: pollId } },
      skipRefs: true,
    });
    resultMessageId = posted.id;
  }
  const closedNow = (await tx.query<{ ok: boolean }>('SELECT app.polls_close($1, $2) AS ok', [pollId, resultMessageId])).rows[0]?.ok === true;
  const { row: closed, view } = await reloadPoll(tx, channelId, pollId);
  if (!closedNow) return { closed: false, cannotPost: false, view };
  await ctx.audit.emit(
    tx,
    ChannelPollClosedEvent.parse({
      type: 'channel.poll.closed',
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      channelId,
      teamId: row.team_id,
      pollId,
      messageId: row.message_id,
      reason,
      closedBy: reason === 'author' ? tx.actor.id : null,
      voters: row.voter_count,
      resultMessageId,
    }),
  );
  await pushPollChanged(deps, tx, closed, { immediate: true });
  return { closed: true, cannotPost: false, view };
}

/**
 * Closes a poll as the system, with no result message: the last resort when neither the author nor an admin of the workspace can post it (all lost
 * access to the channel). The poll still stops taking votes at its time; nobody is told in the channel.
 */
async function closeWithoutAuthor(deps: Deps, due: DueRow): Promise<boolean> {
  return deps.ctx.db.system(
    async (tx) => {
      const res = await tx.query<{ team_id: string | null; message_id: string; voter_count: number }>(
        `UPDATE app.polls p SET closed_at = now(), closed_by = NULL
          WHERE p.id = $1 AND p.closed_at IS NULL
          RETURNING (SELECT c.team_id FROM app.channels c WHERE c.id = p.channel_id) AS team_id, p.message_id, p.voter_count`,
        [due.id],
      );
      const r = res.rows[0];
      if (!r) return false;
      await deps.ctx.audit.emit(
        tx,
        ChannelPollClosedEvent.parse({
          type: 'channel.poll.closed',
          schemaVersion: 1,
          workspaceId: due.workspace_id,
          channelId: due.channel_id,
          teamId: r.team_id,
          pollId: due.id,
          messageId: r.message_id,
          reason: 'time',
          closedBy: null,
          voters: r.voter_count,
          resultMessageId: null,
        }),
      );
      const row = await tx.query<PollRow>(`SELECT ${POLL_SELECT} FROM app.polls p LEFT JOIN app.poll_votes mv ON false WHERE p.id = $1`, [due.id]);
      if (row.rows[0]) await pushPollChanged(deps, tx, row.rows[0], { immediate: true });
      return true;
    },
    { workspaceId: due.workspace_id },
  );
}

interface DueRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  author_id: string;
  channel_id: string;
}

export interface CloseCounts {
  /** Closed in the author's own transaction, with the result message. */
  closed: number;
  /** Closed with the result posted by a workspace admin, because the author could no longer post. */
  closedByAdmin: number;
  /** Closed with no result message (nobody who could post was left, or the channel was archived or the message deleted). */
  closedQuietly: number;
  /** Rows whose handling threw (the database was unavailable): left as they were. */
  errors: number;
}

/** Who else may post the result of a poll whose author cannot: up to three owners or admins of the workspace who can read the channel, owners first. */
export async function adminPosters(deps: Deps, due: { workspace_id: string; channel_id: string }): Promise<string[]> {
  return deps.ctx.db.system(
    async (tx) => {
      const res = await tx.query<{ actor_id: string }>(
        `SELECT a.id AS actor_id
           FROM app.channel_audience($1) ca
           JOIN app.workspace_members wm ON wm.person_id = ca.person_id AND wm.workspace_id = $2 AND wm.role IN ('owner', 'admin')
           JOIN app.actors a ON a.kind = 'person' AND a.ref_id = ca.person_id
          ORDER BY (wm.role = 'owner') DESC, a.id LIMIT 3`,
        [due.channel_id, due.workspace_id],
      );
      return res.rows.map((r) => r.actor_id);
    },
    { workspaceId: due.workspace_id },
  );
}

/** A refusal that belongs to the actor (no right to post, no access any more, a row-level denial), as opposed to a busy door or a database failure. */
function isRefusal(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  const code = (err as { code?: string } | null)?.code;
  return (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) || code === '42501';
}

/**
 * Closes the polls whose time has come. `readTx` runs a short system transaction that lists the due polls (no lock held); each poll is then closed in
 * a person's own transaction, so the result message is posted by a real author with the right to post checked now:
 *   1. the poll's author, when they may still post;
 *   2. otherwise (they lost the right, or the access) a workspace owner or admin who can read the channel (`posters`);
 *   3. otherwise the system closes the poll with no result message, so it never stays open past its time.
 * A poll in an archived channel, or whose message was deleted, is closed by its author without a message (nobody may post there).
 * `now` is the server clock (`ctx.runtime.now()`), which tests move.
 */
export async function closeDue(
  deps: Deps,
  readTx: <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>,
  now: Date,
  log?: PluginLogger,
  budgetMs: number = CLOSE_BUDGET_MS,
  posters: (due: { workspace_id: string; channel_id: string }) => Promise<string[]> = (due) => adminPosters(deps, due),
): Promise<CloseCounts> {
  const counts: CloseCounts = { closed: 0, closedByAdmin: 0, closedQuietly: 0, errors: 0 };
  const started = performance.now();
  const attempt = (due: DueRow, actorId: string): Promise<CloseOutcome> => {
    const caller: HttpCaller = { actorId, kind: 'person', workspaceId: due.workspace_id, personId: null, sessionId: null };
    return deps.ctx.db.as(caller, (tx) => closePoll(deps, tx, due.channel_id, due.id, 'time', { requirePostRight: true }));
  };
  for (;;) {
    const page = await readTx((tx) =>
      tx.query<DueRow>(
        `SELECT id, workspace_id, author_id, channel_id FROM app.polls
          WHERE closed_at IS NULL AND closes_at IS NOT NULL AND closes_at <= $1::timestamptz ORDER BY closes_at, id LIMIT $2`,
        [now, CLOSE_BATCH],
      ),
    );
    let progressed = 0;
    for (const due of page.rows) {
      if (performance.now() - started >= budgetMs) return counts;
      try {
        let settled = false;
        // 1. the author
        try {
          const out = await attempt(due, due.author_id);
          if (!out.cannotPost) {
            settled = true;
            if (out.closed) counts.closed += 1;
          }
        } catch (err) {
          if (!isRefusal(err)) throw err;
        }
        // 2. an owner or admin of the workspace
        if (!settled) {
          for (const actorId of await posters(due)) {
            if (actorId === due.author_id) continue;
            try {
              const out = await attempt(due, actorId);
              if (!out.cannotPost) {
                settled = true;
                if (out.closed) counts.closedByAdmin += 1;
                break;
              }
            } catch (err) {
              if (!isRefusal(err)) throw err;
            }
          }
        }
        // 3. nobody could post it: the system closes it quietly
        if (!settled && (await closeWithoutAuthor(deps, due))) counts.closedQuietly += 1;
        progressed += 1;
      } catch (err) {
        counts.errors += 1;
        log?.warn(`channels: poll ${due.id} could not be closed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }
    // a page in which nothing could be closed (every row failed) would be read again for ever: stop, the next minute tries again
    if (page.rows.length < CLOSE_BATCH || progressed === 0) return counts;
  }
}

/** The sentence for a vote on a closed poll (the trigger raises the same words). */
export const POLL_CLOSED = 'This poll is closed';
