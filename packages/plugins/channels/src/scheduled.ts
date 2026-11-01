import { HttpError, type HttpCaller, type PluginLogger, type PluginTx } from '@manythreads/sdk';
import { ChannelScheduledMessageChangedEvent, WS_SCHEDULED_CHANGED, type ScheduledChangedPush } from '@manythreads/shared';
import { postChannelMessage, type Deps } from './service.ts';

/** The job that posts the scheduled messages whose time has come: every minute (the cron grid of the job queue; 5-field cron in UTC). */
export const SEND_QUEUE = 'channels.send_scheduled';
export const SEND_CRON = '* * * * *';

/** Due messages are read this many at a time; a run goes on with the next page until nothing is left or its time budget is spent. */
export const SEND_BATCH = 100;

/** A run stops starting new sends after this long (the next minute's run takes the rest), so one run never outlives its minute by much. */
export const SEND_BUDGET_MS = 45_000;

/** A send that fails for a reason that is not the author's (a database error) is tried again next minute, this many times in all. */
export const MAX_SEND_ATTEMPTS = 3;

/** A post the door asks to try again later (429) is tried again at the time it names, without counting; after this long past the chosen time it is refused. */
export const RETRY_GIVE_UP_MS = 24 * 60 * 60_000;
/** When the door says 429 without a retry-after, wait this long; a retry-after longer than the maximum is cut to it. */
const DEFAULT_RETRY_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;

export type ScheduledChange = ScheduledChangedPush['change'];

/** What the event and the push need of a scheduled message. */
export interface ScheduledRef {
  id: string;
  workspaceId: string;
  channelId: string;
  teamId: string | null;
  authorId: string;
}

/**
 * Writes `channel.scheduled_message.changed` as the transaction's actor. Ids only: no text, no time, no refusal reason (the event log is read by
 * the team's members and admins; the author reads those from their own row).
 */
export async function emitChanged({ ctx }: Deps, tx: PluginTx, ref: ScheduledRef, change: ScheduledChange, extra: { messageId?: string } = {}): Promise<void> {
  await ctx.audit.emit(
    tx,
    ChannelScheduledMessageChangedEvent.parse({
      type: 'channel.scheduled_message.changed',
      schemaVersion: 1,
      workspaceId: ref.workspaceId,
      channelId: ref.channelId,
      teamId: ref.teamId,
      scheduledId: ref.id,
      authorId: ref.authorId,
      change,
      messageId: extra.messageId ?? null,
    }),
  );
}

/** Tells the author's open tabs to read the channel's scheduled list again (delivered when `tx` commits). */
export async function pushChanged({ ctx }: Deps, tx: PluginTx, personId: string, channelId: string, change: ScheduledChange): Promise<void> {
  const payload: ScheduledChangedPush = { channelId, change } as ScheduledChangedPush;
  await ctx.realtime.pushToPerson(tx, personId, WS_SCHEDULED_CHANGED, payload);
}

/** A due row as the job lists it. The two `_text` columns keep the microseconds a JavaScript date drops: they are what the later updates compare with. */
interface DueRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  author_id: string;
  channel_id: string;
  team_id: string | null;
  send_at: Date;
  send_at_text: string;
  updated_at_text: string;
}

type Outcome = { kind: 'sent' } | { kind: 'gone' } | { kind: 'refused'; reason: string } | { kind: 'failed' } | { kind: 'retry'; afterMs: number };

export const GENERIC_REFUSAL = 'Something went wrong while sending this message. It was not posted.';
const STALE_REFUSAL = 'It could not be sent in time, so it was not posted.';

/** Seconds (or an HTTP date) of a `retry-after` header, as milliseconds; a default when absent or unreadable. */
function retryAfterMs(err: HttpError): number {
  const key = Object.keys(err.headers).find((k) => k.toLowerCase() === 'retry-after');
  const raw = key ? err.headers[key] : undefined;
  if (raw === undefined) return DEFAULT_RETRY_MS;
  const seconds = Number(raw);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.round(ms), MAX_RETRY_MS) : DEFAULT_RETRY_MS;
}

/**
 * The sentence a person reads for a post the door refused: the door's own words (never empty), or a plain one for a database denial. A 429 is not a
 * refusal: the door is busy, and the message waits for the time it names.
 */
export function refusalOf(err: unknown): Outcome {
  if (err instanceof HttpError && err.status === 429) return { kind: 'retry', afterMs: retryAfterMs(err) };
  if (err instanceof HttpError && err.status >= 400 && err.status < 500) return { kind: 'refused', reason: err.message.trim().slice(0, 500) || GENERIC_REFUSAL };
  if ((err as { code?: string } | null)?.code === '42501') return { kind: 'refused', reason: 'You can no longer post in this channel.' };
  return { kind: 'failed' };
}

/**
 * Posts one due message **as its author**, in the author's own transaction, through `postChannelMessage` — the same door a typed message uses —
 * so the author's right to post is checked again now (still an active member of the workspace, still able to post in the channel, the channel
 * not archived, a thread's first message still there). The row is locked first (`FOR UPDATE SKIP LOCKED`), the message is posted and the row is
 * deleted in that one transaction: it happens once, a replica that finds the row locked leaves it, and a refusal (a throw) rolls the post back.
 */
async function sendOne(deps: Deps, due: DueRow, now: Date): Promise<Outcome> {
  const { ctx } = deps;
  const caller: HttpCaller = { actorId: due.author_id, kind: 'person', workspaceId: due.workspace_id, personId: null, sessionId: null };
  try {
    return await ctx.db.as(caller, async (tx): Promise<Outcome> => {
      const res = await tx.query<{ body: string; thread_root_id: string | null; team_id: string | null; broadcast_confirmed: boolean }>(
        `SELECT body, thread_root_id, team_id, broadcast_confirmed FROM app.scheduled_messages
          WHERE id = $1 AND state = 'scheduled' AND send_at <= $2::timestamptz AND (retry_at IS NULL OR retry_at <= $2::timestamptz) FOR UPDATE SKIP LOCKED`,
        [due.id, now],
      );
      const row = res.rows[0];
      // cancelled, edited to a later time, or held by another replica meanwhile
      if (!row) return { kind: 'gone' };
      // a text that names @channel / @here for a big room was agreed when it was scheduled; one that was not (the room has grown since) is refused with the plain 409 sentence
      const posted = await postChannelMessage(deps, tx, {
        channelId: due.channel_id,
        body: row.body,
        threadRootId: row.thread_root_id,
        ...(row.broadcast_confirmed ? { confirmBroadcast: true } : {}),
      });
      await tx.query('DELETE FROM app.scheduled_messages WHERE id = $1', [due.id]);
      const person = await tx.query<{ id: string | null }>('SELECT app.person_id() AS id');
      const ref: ScheduledRef = { id: due.id, workspaceId: due.workspace_id, channelId: due.channel_id, teamId: row.team_id, authorId: due.author_id };
      await emitChanged(deps, tx, ref, 'sent', { messageId: posted.id });
      if (person.rows[0]?.id) await pushChanged(deps, tx, person.rows[0].id, due.channel_id, 'sent');
      return { kind: 'sent' };
    });
  } catch (err) {
    return refusalOf(err);
  }
}

/**
 * Marks a message the author could not send. A refusal becomes `refused` with its reason; a failure that is not the author's is counted and the
 * message stays `scheduled` for the next minute, until `MAX_SEND_ATTEMPTS`, when it is refused with a plain sentence rather than retried for ever.
 * Runs as the system (scoped to the workspace); the author is told by a push and finds the draft, with the reason, in their lists. It changes the row
 * only if it is still the row the send tried (`updated_at` unchanged): an edit made while the send was failing wins, and is tried afresh.
 */
async function markRefused(deps: Deps, due: DueRow, now: Date, outcome: { kind: 'refused'; reason: string } | { kind: 'failed' }): Promise<boolean> {
  return deps.ctx.db.system(
    async (tx) => {
      const reason = outcome.kind === 'refused' ? outcome.reason.trim() || GENERIC_REFUSAL : null;
      const res = await tx.query<{ state: string }>(
        `UPDATE app.scheduled_messages
            SET attempts = attempts + $4::int,
                state = CASE WHEN $2::text IS NOT NULL OR attempts + 1 >= $5::int THEN 'refused' ELSE state END,
                refused_reason = CASE WHEN $2::text IS NOT NULL OR attempts + 1 >= $5::int THEN coalesce($2::text, $6::text) ELSE refused_reason END,
                refused_at = CASE WHEN $2::text IS NOT NULL OR attempts + 1 >= $5::int THEN $3::timestamptz ELSE refused_at END,
                retry_at = NULL,
                updated_at = now()
          WHERE id = $1 AND state = 'scheduled' AND send_at <= $3::timestamptz AND updated_at = $7::timestamptz
          RETURNING state`,
        [due.id, reason, now, outcome.kind === 'failed' ? 1 : 0, MAX_SEND_ATTEMPTS, GENERIC_REFUSAL, due.updated_at_text],
      );
      const row = res.rows[0];
      // nothing to do when the message was cancelled, edited or moved meanwhile, or when a failed send was only counted and will be tried again
      if (!row || row.state !== 'refused') return false;
      const person = await tx.query<{ ref_id: string | null }>("SELECT ref_id FROM app.actors WHERE id = $1 AND kind = 'person'", [due.author_id]);
      const ref: ScheduledRef = { id: due.id, workspaceId: due.workspace_id, channelId: due.channel_id, teamId: due.team_id, authorId: due.author_id };
      await emitChanged(deps, tx, ref, 'refused');
      if (person.rows[0]?.ref_id) await pushChanged(deps, tx, person.rows[0].ref_id, due.channel_id, 'refused');
      return true;
    },
    { workspaceId: due.workspace_id },
  );
}

/** The door said "try again later": the row waits until `retry_at` (the job skips it until then). Changes the row only if it is still the one the send tried. */
async function deferSend(deps: Deps, due: DueRow, now: Date, afterMs: number): Promise<void> {
  await deps.ctx.db.system(
    async (tx) => {
      await tx.query(
        `UPDATE app.scheduled_messages SET retry_at = $3::timestamptz
          WHERE id = $1 AND state = 'scheduled' AND updated_at = $2::timestamptz`,
        [due.id, due.updated_at_text, new Date(now.getTime() + afterMs)],
      );
    },
    { workspaceId: due.workspace_id },
  );
}

export interface SendCounts {
  sent: number;
  refused: number;
  /** Failed, counted, and left to be tried again. */
  failed: number;
  /** The door was busy (429): left to be tried again, not counted. */
  deferred: number;
  /** A row whose handling itself threw (the database was unavailable): left as it was. */
  errors: number;
}

/**
 * Sends the scheduled messages whose time has come. `readTx` runs a short system transaction: it only lists the due rows, a page at a time (no lock
 * held, so the run is never one long transaction); each message is then sent in its own transaction as its author, so one author's refusal never
 * holds up or undoes another's, and a row that throws is counted and passed over, never blocking the rows after it. The run goes on page after page
 * until nothing is due or `SEND_BUDGET_MS` is spent.
 */
export async function sendDue(
  deps: Deps,
  readTx: <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>,
  now: Date,
  log?: PluginLogger,
  budgetMs: number = SEND_BUDGET_MS,
): Promise<SendCounts> {
  const counts: SendCounts = { sent: 0, refused: 0, failed: 0, deferred: 0, errors: 0 };
  const started = performance.now();
  const spent = (): boolean => performance.now() - started >= budgetMs;
  // a page is read after the last row of the one before (by time, then id), so a row that stays due (a counted failure, a busy door) is not read again in this run
  let after: { sendAt: string; id: string } | null = null;
  for (;;) {
    const cursor = after;
    const page: { rows: DueRow[] } = await readTx((tx) =>
      tx.query<DueRow>(
        `SELECT id, workspace_id, author_id, channel_id, team_id, send_at, send_at::text AS send_at_text, updated_at::text AS updated_at_text
           FROM app.scheduled_messages
          WHERE state = 'scheduled' AND send_at <= $1::timestamptz AND (retry_at IS NULL OR retry_at <= $1::timestamptz)
            AND ($3::timestamptz IS NULL OR (send_at, id) > ($3::timestamptz, $4::uuid))
          ORDER BY send_at, id LIMIT $2`,
        [now, SEND_BATCH, cursor?.sendAt ?? null, cursor?.id ?? null],
      ),
    );
    for (const row of page.rows) {
      if (spent()) return counts;
      try {
        const outcome = await sendOne(deps, row, now);
        if (outcome.kind === 'sent') counts.sent += 1;
        else if (outcome.kind === 'retry') {
          // too long past its time: stop asking and tell the author; otherwise wait for the time the door named
          if (now.getTime() - row.send_at.getTime() > RETRY_GIVE_UP_MS) {
            if (await markRefused(deps, row, now, { kind: 'refused', reason: STALE_REFUSAL })) counts.refused += 1;
          } else {
            await deferSend(deps, row, now, outcome.afterMs);
            counts.deferred += 1;
          }
        } else if (outcome.kind === 'refused' || outcome.kind === 'failed') {
          if (await markRefused(deps, row, now, outcome)) counts.refused += 1;
          else if (outcome.kind === 'failed') counts.failed += 1;
        }
      } catch (err) {
        counts.errors += 1;
        log?.warn(`channels: scheduled message ${row.id} could not be handled: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }
    const last = page.rows[page.rows.length - 1];
    if (!last || page.rows.length < SEND_BATCH) return counts;
    after = { sendAt: last.send_at_text, id: last.id };
  }
}
