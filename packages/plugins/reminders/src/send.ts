import { HttpError, type HttpCaller, type MessageProvider, type PluginContext, type PluginLogger, type PluginTx } from '@manythreads/sdk';
import { RemindersReminderChangedEvent, RemindersReminderDueEvent, plainCodeSpan, type ReminderTargetKind } from '@manythreads/shared';

/*
 * Delivery of the reminders made with `/remind` (PLAN P14-04). A minute job takes each pending reminder whose time has come and:
 *   1. checks again, AS THE MAKER, that they may still do it (an active member; for a person, that the maker still reads the place and the person still
 *      does; for a channel, that the maker may still post there) -- a person who lost access is refused, never delivered around;
 *   2. in a system transaction scoped to the workspace, locks the row, acts as the workspace's "Reminders" sender (app.reminders_act_as) and posts the
 *      text through the channels plugin's message door into the person's Reminders conversation (`me`, `person`) or into the channel (`channel`);
 *   3. marks the row sent and writes the events: `reminders.reminder.changed`, and for `me` and `person` also `reminders.reminder.due`, which the
 *      notifications plugin turns into a notification (it ignores mute levels, holds it during Do not disturb).
 * A refusal marks the row `refused` with a sentence and tells the maker in their own Reminders conversation. The checks and the post run in two
 * transactions, so a right taken away between them can still be used once, in the second the sender posts only what the maker's row says.
 */

/** The job: every minute (the cron grid of the job queue; 5-field cron in UTC). */
export const SEND_QUEUE = 'reminders.send_due';
export const SEND_CRON = '* * * * *';
/** Due rows are read this many at a time; a run goes on with the next page until nothing is left or its time budget is spent. */
export const SEND_BATCH = 100;
/** A run stops starting new deliveries after this long (the next minute's run takes the rest). */
export const SEND_BUDGET_MS = 45_000;
/** A delivery that fails for a reason that is not the maker's (a database error) is tried again next minute, this many times in all. */
export const MAX_SEND_ATTEMPTS = 3;
/** A post the door asks to try again later (429) waits for the next minute without counting; after this long past the chosen time it is refused. */
export const RETRY_GIVE_UP_MS = 24 * 60 * 60_000;
/** A finished reminder is removed from the history after this many days. */
export const HISTORY_DAYS = 30;

export const GENERIC_REFUSAL = 'Something went wrong while sending this reminder. It was not delivered.';
const STALE_REFUSAL = 'It could not be delivered in time, so it was not sent.';

/** A due row as the job lists it. The `_text` column keeps the microseconds a JavaScript date drops: later updates compare with it. */
interface DueRow extends Record<string, unknown> {
  id: string;
  workspace_id: string;
  creator_id: string;
  creator_actor_id: string;
  target_kind: ReminderTargetKind;
  target_person_id: string | null;
  channel_id: string | null;
  remind_at: Date;
  remind_at_text: string;
  updated_at_text: string;
}

type Outcome =
  | { kind: 'sent' }
  | { kind: 'gone' }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed' }
  | { kind: 'retry' };

/** Checks the maker's rights now, as the maker. Returns the sentence of the refusal, or null when the reminder may be delivered. */
async function checkMaker(ctx: PluginContext, due: DueRow): Promise<string | null> {
  const caller: HttpCaller = { actorId: due.creator_actor_id, kind: 'person', workspaceId: due.workspace_id, personId: null, sessionId: null };
  return ctx.db.as(caller, async (tx) => {
    const row = (
      await tx.query<{ role: string | null; can_read: boolean; can_post: boolean; target_ok: boolean }>(
        `SELECT app.lookup_workspace_role() AS role,
                coalesce($1::uuid = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]), false) AS can_read,
                coalesce($1::uuid = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]), false) AS can_post,
                CASE WHEN $2::uuid IS NULL OR $1::uuid IS NULL THEN false ELSE app.reminders_target_ok($2::uuid, $1::uuid) END AS target_ok`,
        [due.channel_id, due.target_person_id],
      )
    ).rows[0];
    if (!row?.role || row.role === 'guest') return 'You can no longer use reminders in this workspace.';
    if (due.target_kind === 'person') {
      if (!row.can_read) return 'You can no longer read the conversation this reminder was about.';
      if (!row.target_ok) return 'That person can no longer read the conversation this reminder was about.';
    }
    if (due.target_kind === 'channel' && !row.can_post) return 'You can no longer post in that channel.';
    return null;
  });
}

/**
 * What the sender writes. For the maker themself the text is theirs, as one line. For someone else (a person or a channel) it is what another person
 * typed, so it is shown as a code span: plain words, not a link, a mention or emphasis, and the link-preview plugin does not read a code span, so a link
 * in it makes no card and no fetch by the server. (The post also skips references, so nothing in it is recorded as a mention.) A maker's name that
 * looks like markup or a link gets the same treatment.
 */
export function messageText(kind: ReminderTargetKind, makerName: string, text: string): string {
  if (kind === 'me') return `Reminder: ${text}`;
  const name = /[`*_[\]<>:@\\]|www\./i.test(makerName) ? plainCodeSpan(makerName) : makerName;
  return `Reminder from ${name}: ${plainCodeSpan(text)}`;
}

/** A short form of a reminder's text for a sentence about it. */
function snippet(text: string): string {
  const chars = [...text];
  return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : text;
}

interface Sender {
  /** Posts into a person's Reminders conversation and returns the message and the conversation. */
  toInbox(personId: string, body: string): Promise<{ messageId: string; channelId: string }>;
  /** Posts into a channel. */
  toChannel(channelId: string, body: string): Promise<{ messageId: string }>;
  /** The transaction as the sender: events are written under the actor the session now acts as, or the outbox (which fans out only an event of the session's actor) skips them. */
  tx: PluginTx;
}

/**
 * Switches the system transaction to the workspace's Reminders sender and returns what it can post. The transaction's actor is the sender for the
 * rest of the transaction, so nothing else should be written in it as someone else.
 */
async function actAsSender(sys: PluginTx, messages: MessageProvider, workspaceId: string): Promise<Sender> {
  const actorId = (await sys.query<{ id: string }>('SELECT app.reminders_act_as() AS id')).rows[0]!.id;
  const asSender: PluginTx = { actor: { kind: 'system', id: actorId, workspaceId }, query: (t, v) => sys.query(t, v) };
  return {
    tx: asSender,
    async toInbox(personId, body) {
      const channelId = (await sys.query<{ id: string }>('SELECT app.reminders_inbox($1::uuid) AS id', [personId])).rows[0]!.id;
      const posted = await messages.post(asSender, { channelId, body, skipRefs: true });
      return { messageId: posted.id, channelId };
    },
    async toChannel(channelId, body) {
      const posted = await messages.post(asSender, { channelId, body, skipRefs: true });
      return { messageId: posted.id };
    },
  };
}

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

/** What a failed delivery means: a refusal of the door (4xx) is the maker's, a 429 waits, anything else is counted and tried again. */
function outcomeOf(err: unknown): Outcome {
  const status = err instanceof HttpError ? err.status : statusOf(err);
  if (status === 429) return { kind: 'retry' };
  if (status !== undefined && status >= 400 && status < 500) {
    const message = err instanceof Error ? err.message.trim().slice(0, 500) : '';
    return { kind: 'refused', reason: message || GENERIC_REFUSAL };
  }
  if ((err as { code?: string } | null)?.code === '42501') return { kind: 'refused', reason: 'You can no longer do that here.' };
  return { kind: 'failed' };
}

async function emitChanged(ctx: PluginContext, tx: PluginTx, due: DueRow, change: 'sent' | 'refused'): Promise<void> {
  await ctx.audit.emit(
    tx,
    RemindersReminderChangedEvent.parse({
      type: 'reminders.reminder.changed',
      schemaVersion: 1,
      workspaceId: due.workspace_id,
      reminderId: due.id,
      creatorId: due.creator_id,
      targetKind: due.target_kind,
      recipientId: due.target_kind === 'me' ? due.creator_id : due.target_kind === 'person' ? due.target_person_id : null,
      change,
    }),
  );
}

/** Announces a message in a person's Reminders conversation, so the notifications plugin raises a notification for it. */
async function emitDue(ctx: PluginContext, tx: PluginTx, due: DueRow, personId: string, messageId: string, channelId: string): Promise<void> {
  await ctx.audit.emit(
    tx,
    RemindersReminderDueEvent.parse({
      type: 'reminders.reminder.due',
      schemaVersion: 1,
      workspaceId: due.workspace_id,
      personId,
      itemId: due.id,
      messageId,
      channelId,
    }),
  );
}

/**
 * Delivers one due reminder. The maker's rights are checked first (their own transaction); then the row is locked (`FOR UPDATE SKIP LOCKED`, still
 * pending, still the row listed: an edit or a cancel made meanwhile wins), the text is posted, the row is marked sent and the events are written, all in
 * one system transaction: a failure rolls the post back, so a reminder is delivered once.
 */
async function deliverOne(ctx: PluginContext, messages: MessageProvider, due: DueRow, now: Date): Promise<Outcome> {
  const refusal = await checkMaker(ctx, due);
  if (refusal !== null) return { kind: 'refused', reason: refusal };
  try {
    return await ctx.db.system(
      async (sys): Promise<Outcome> => {
        const row = (
          await sys.query<{ text: string; maker_name: string }>(
            `SELECT r.text, p.display_name AS maker_name
               FROM app.reminders r JOIN app.people p ON p.id = r.creator_id
              WHERE r.id = $1::uuid AND r.state = 'pending' AND r.remind_at <= $2::timestamptz AND r.updated_at = $3::timestamptz
                FOR UPDATE OF r SKIP LOCKED`,
            [due.id, now, due.updated_at_text],
          )
        ).rows[0];
        if (!row) return { kind: 'gone' };
        const sender = await actAsSender(sys, messages, due.workspace_id);
        const body = messageText(due.target_kind, row.maker_name, row.text);
        let messageId: string;
        if (due.target_kind === 'channel') {
          messageId = (await sender.toChannel(due.channel_id!, body)).messageId;
        } else {
          const recipient = due.target_kind === 'me' ? due.creator_id : due.target_person_id!;
          const posted = await sender.toInbox(recipient, body);
          messageId = posted.messageId;
          await emitDue(ctx, sender.tx, due, recipient, posted.messageId, posted.channelId);
        }
        await sys.query(`UPDATE app.reminders SET state = 'sent', sent_message_id = $2::uuid, sent_at = $3::timestamptz, updated_at = now() WHERE id = $1::uuid`, [
          due.id,
          messageId,
          now,
        ]);
        await emitChanged(ctx, sender.tx, due, 'sent');
        return { kind: 'sent' };
      },
      { workspaceId: due.workspace_id },
    );
  } catch (err) {
    return outcomeOf(err);
  }
}

/**
 * Marks a reminder that could not be delivered. A refusal (or the third failure) becomes `refused` with its reason and the maker is told in their
 * Reminders conversation; an earlier failure is counted and the reminder stays pending for the next minute. Changes the row only if it is still the one
 * the delivery tried (`updated_at` unchanged). Returns true when the row became refused.
 */
async function markRefused(ctx: PluginContext, messages: MessageProvider, due: DueRow, outcome: { kind: 'refused'; reason: string } | { kind: 'failed' }): Promise<boolean> {
  const reason = outcome.kind === 'refused' ? outcome.reason.trim().slice(0, 500) || GENERIC_REFUSAL : null;
  const marked = await ctx.db.system(
    async (tx) => {
      const res = await tx.query<{ state: string; text: string; reason: string | null }>(
        `UPDATE app.reminders
            SET attempts = attempts + $4::int,
                state = CASE WHEN $2::text IS NOT NULL OR attempts + 1 >= $5::int THEN 'refused' ELSE state END,
                refused_reason = CASE WHEN $2::text IS NOT NULL OR attempts + 1 >= $5::int THEN coalesce($2::text, $6::text) ELSE refused_reason END,
                updated_at = now()
          WHERE id = $1::uuid AND state = 'pending' AND updated_at = $3::timestamptz
          RETURNING state, text, refused_reason AS reason`,
        [due.id, reason, due.updated_at_text, outcome.kind === 'failed' ? 1 : 0, MAX_SEND_ATTEMPTS, GENERIC_REFUSAL],
      );
      const row = res.rows[0];
      if (!row || row.state !== 'refused') return null;
      await emitChanged(ctx, tx, due, 'refused');
      return { text: row.text, reason: row.reason ?? GENERIC_REFUSAL };
    },
    { workspaceId: due.workspace_id },
  );
  if (!marked) return false;
  // The maker is told in their own Reminders conversation. A failure here (they left the workspace) leaves the refusal as it is.
  try {
    await ctx.db.system(
      async (sys) => {
        const sender = await actAsSender(sys, messages, due.workspace_id);
        const posted = await sender.toInbox(due.creator_id, `Your reminder “${snippet(marked.text)}” was not sent. ${marked.reason}`);
        await emitDue(ctx, sender.tx, due, due.creator_id, posted.messageId, posted.channelId);
      },
      { workspaceId: due.workspace_id },
    );
  } catch {
    /* nobody to tell */
  }
  return true;
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
 * Delivers the reminders whose time has come. `readTx` runs a short system transaction across workspaces: it only lists the due rows, a page at a time
 * (no lock held); each reminder is then delivered in its own transactions, so one refusal never holds up or undoes another's, and a row that throws is
 * counted and passed over. The run goes on page after page until nothing is due or the time budget is spent.
 */
export async function sendDue(
  ctx: PluginContext,
  readTx: <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>,
  now: Date,
  log?: PluginLogger,
  budgetMs: number = SEND_BUDGET_MS,
): Promise<SendCounts> {
  const counts: SendCounts = { sent: 0, refused: 0, failed: 0, deferred: 0, errors: 0 };
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) {
    log?.warn('reminders: the channels plugin is not loaded, nothing was delivered');
    return counts;
  }
  const started = performance.now();
  const spent = (): boolean => performance.now() - started >= budgetMs;
  // a page is read after the last row of the one before (by time, then id), so a row that stays due (a counted failure, a busy door) is not read again in this run
  let after: { at: string; id: string } | null = null;
  for (;;) {
    const cursor = after;
    const page: { rows: DueRow[] } = await readTx((tx) =>
      tx.query<DueRow>(
        `SELECT r.id, r.workspace_id, r.creator_id, a.id AS creator_actor_id, r.target_kind, r.target_person_id, r.channel_id, r.remind_at,
                r.remind_at::text AS remind_at_text, r.updated_at::text AS updated_at_text
           FROM app.reminders r
           JOIN app.actors a ON a.kind = 'person' AND a.ref_id = r.creator_id AND a.workspace_id = r.workspace_id
          WHERE r.state = 'pending' AND r.remind_at <= $1::timestamptz
            AND ($3::timestamptz IS NULL OR (r.remind_at, r.id) > ($3::timestamptz, $4::uuid))
          ORDER BY r.remind_at, r.id LIMIT $2`,
        [now, SEND_BATCH, cursor?.at ?? null, cursor?.id ?? null],
      ),
    );
    for (const row of page.rows) {
      if (spent()) return counts;
      try {
        const outcome = await deliverOne(ctx, messages, row, now);
        if (outcome.kind === 'sent') counts.sent += 1;
        else if (outcome.kind === 'retry') {
          // too long past its time: stop asking and tell the maker; otherwise leave it for the next minute
          if (now.getTime() - row.remind_at.getTime() > RETRY_GIVE_UP_MS) {
            if (await markRefused(ctx, messages, row, { kind: 'refused', reason: STALE_REFUSAL })) counts.refused += 1;
          } else counts.deferred += 1;
        } else if (outcome.kind === 'refused' || outcome.kind === 'failed') {
          if (await markRefused(ctx, messages, row, outcome)) counts.refused += 1;
          else if (outcome.kind === 'failed') counts.failed += 1;
        }
      } catch (err) {
        counts.errors += 1;
        log?.warn(`reminders: reminder ${row.id} could not be handled: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }
    const last = page.rows[page.rows.length - 1];
    if (!last || page.rows.length < SEND_BATCH) return counts;
    after = { at: last.remind_at_text, id: last.id };
  }
}

/** Removes finished reminders (sent, cancelled, refused) older than the history window. Returns how many. */
export async function pruneHistory(readTx: <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>): Promise<number> {
  return readTx(async (tx) => {
    const res = await tx.query<{ id: string }>(
      `DELETE FROM app.reminders WHERE id IN (
         SELECT id FROM app.reminders WHERE state <> 'pending' AND updated_at < now() - make_interval(days => $1::int) LIMIT 1000) RETURNING id`,
      [HISTORY_DAYS],
    );
    return res.rows.length;
  });
}
