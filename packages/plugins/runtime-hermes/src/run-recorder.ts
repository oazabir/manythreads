import type { BotRuntimeEvent, JobInfo, PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import { RunActivityPush, RunEndedPush, RunStartedPush, WS_RUN_ACTIVITY, WS_RUN_ENDED, WS_RUN_STARTED, type RunCost } from '@manythreads/shared';
import { previewText } from './holds.ts';
import { ActivityFold, fitPush, mapWords, MAX_ROWS, slimOf, type FoldRow, type SlimEvent } from './run-activity.ts';

// Keeps what a run did, and tells the people who are looking (P25-06, P25-07; docs/plans/acp.md §3.4).
//
// One recorder per run, owned by the run job. The job gives it every runtime event; it keeps them in memory and, at most once a second, writes one batch in one short
// transaction: it redacts the words (titles, paths, helper and plan lines go through the same pre-egress chain as an approval's preview, so a key-like string becomes
// `[redacted:...]`, and with no guardrail loaded the words are left out), folds the events (`run-activity.ts`), writes the new lines to `run_activity` and the folded state to
// `run_view`, and pushes the state to the people who have the thread open. A recorder never throws and never holds up the run: a write that fails is tried again with the
// next batch, and after three failures in a row the recorder gives up for this run (logged once) and the run goes on without a record.
//
// Who is told: a run in a thread, the people who have that thread open (`thread_watchers`, a lease the open thread panel renews); a run in a person's own conversation, its
// asker. Everybody who can read the channel is told only that a run began and ended (`run.started`, `run.ended`: the root's "Coder is working" chip).

export interface RunTarget {
  runId: string;
  workspaceId: string;
  teamId: string;
  channelId: string;
  /** Where the reply goes; null for a run that has no thread (a schedule, a mail): it is recorded, nobody is pushed to. */
  threadRootId: string | null;
  botId: string;
  botName: string;
  askerActorId: string | null;
  /** A run in a person's private conversation. */
  conversation: boolean;
}

export interface RecorderOptions {
  /** The least time between two batches (default 1000 ms). */
  flushMs?: number;
  /** How often the job looks for a Stop asked on another server (default 2000 ms). */
  stopPollMs?: number;
  maxRows?: number;
  now?: () => number;
}

export interface StopAsked {
  actorId: string | null;
  name: string;
}

const MAX_FAILURES = 3;
const CACHE_LIMIT = 2000;
/** The text a redaction chain answers with when it could not check the words (holds.ts). */
const NOT_SHOWN = '[the message is not shown';

export class RunRecorder {
  private readonly fold: ActivityFold;
  private readonly flushMs: number;
  private readonly stopPollMs: number;
  private readonly now: () => number;
  private pending: SlimEvent[] = [];
  /** Lines the fold produced that are not yet in the table. */
  private queue: FoldRow[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private lastFlushAt = 0;
  private lastPushed = '';
  private failures = 0;
  private warned = false;
  private disabled = false;
  private started = false;
  private finished: 'done' | 'failed' | 'stopped' | null = null;
  private dirty = false;
  private askerPerson: string | null | undefined;
  private botActorId: string | null = null;
  private stopReason: string | null = null;
  private cost: RunCost | null = null;
  private asked: StopAsked | undefined;
  private onStop: ((by: StopAsked) => Promise<void>) | undefined;
  private stopFired = false;
  private finalDone = false;
  private readonly words = new Map<string, string>();

  constructor(
    private readonly ctx: PluginContext,
    private readonly job: JobInfo,
    readonly target: RunTarget,
    private readonly log: PluginLogger,
    options: RecorderOptions = {},
  ) {
    this.fold = new ActivityFold(options.maxRows ?? MAX_ROWS);
    this.flushMs = options.flushMs ?? 1000;
    this.stopPollMs = options.stopPollMs ?? 2000;
    this.now = options.now ?? Date.now;
  }

  /** Who asked for the stop, once somebody has (read by the job when it writes the closing words). */
  get stopAsked(): StopAsked | undefined {
    return this.asked;
  }
  /** The state the fold is in (for a test). */
  get state(): string {
    return this.fold.state;
  }

  /** Open the run's folded row, and tell the channel a run began. */
  async start(): Promise<void> {
    await this.guarded(async () => {
      await this.job.transaction(async (tx) => {
        const t = this.target;
        const actor = await tx.query<{ id: string }>("SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1::uuid LIMIT 1", [t.botId]);
        this.botActorId = actor.rows[0]?.id ?? null;
        await tx.query(
          `INSERT INTO app.run_view (run_id, workspace_id, team_id, channel_id, thread_root_id, bot_id, bot_actor_id, bot_name, asker_id, conversation, state, started_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8, $9::uuid, $10, 'starting', now())
           ON CONFLICT (run_id) DO NOTHING`,
          [t.runId, t.workspaceId, t.teamId, t.channelId, t.threadRootId, t.botId, this.botActorId, t.botName.slice(0, 200), t.askerActorId, t.conversation],
        );
        if (t.threadRootId !== null && !t.conversation) {
          const startedAt = new Date().toISOString();
          const push = RunStartedPush.parse({ runId: t.runId, channelId: t.channelId, threadRootId: t.threadRootId, botId: t.botId, botActorId: this.botActorId, botName: t.botName.slice(0, 200), startedAt });
          await this.ctx.realtime.pushToPeople(tx, await this.channelReaders(tx), WS_RUN_STARTED, push);
        }
      });
      this.started = true;
    });
    // a record that could not be opened is not kept for this run
    if (!this.started) {
      this.disabled = true;
      this.pending = [];
    }
  }

  /** One runtime event of the run, in order. Cheap: it is kept and written with the next batch. */
  event(event: BotRuntimeEvent): void {
    if (this.disabled || this.finished !== null) return;
    if (event.type === 'result') {
      if (event.stopReason !== undefined) this.stopReason = event.stopReason.slice(0, 60);
      if (event.cost !== undefined) this.cost = event.cost;
      return;
    }
    const slim = slimOf(event);
    if (slim === null) return;
    this.pending.push(slim);
    this.schedule();
  }

  /** A person answered the agent's question (or it was refused): the run is no longer waiting. */
  settle(choice: 'once' | 'session' | 'deny'): void {
    if (this.disabled || this.finished !== null) return;
    this.pending.push({ t: 'approval', phase: choice === 'deny' ? 'denied' : 'approved' });
    this.schedule();
  }

  /**
   * Look every couple of seconds whether somebody asked for the stop (the Stop route writes it to the row, on whichever server took the request). The first time it is
   * seen, from here or from a batch, `onStop` runs once: the job stops the agent.
   */
  watchStop(onStop: (by: StopAsked) => Promise<void>): void {
    if (this.poller || this.disabled) return;
    this.onStop = onStop;
    if (this.asked !== undefined) this.fireStop(this.asked);
    this.poller = setInterval(() => {
      if (this.polling || this.stopFired) return;
      this.polling = true;
      void this.lookForStop()
        .then((by) => {
          if (by !== undefined) this.noticeStop(by);
        })
        .catch((err: unknown) => this.warn(`the stop could not be looked up: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
          this.polling = false;
        });
    }, this.stopPollMs);
    this.poller.unref?.();
  }

  /** Somebody asked for the stop: the card says "stopping" from the next batch on. The Stop route of this server, the poll and a batch all come here. */
  noticeStop(by: StopAsked): void {
    if (this.asked === undefined) {
      this.asked = by;
      this.fold.markStopping(by.name);
      this.dirty = true;
      this.schedule();
    }
    this.fireStop(by);
  }

  private fireStop(by: StopAsked): void {
    if (this.stopFired || this.onStop === undefined) return;
    this.stopFired = true;
    void this.onStop(by).catch((err: unknown) => this.warn(`the agent could not be stopped: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** The run is over: the last batch, the run's final state, and the end pushed to the channel. Idempotent. */
  async end(status: 'done' | 'failed' | 'stopped'): Promise<void> {
    if (this.finished !== null) return this.chain;
    this.finished = status;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
    // the start may still be in flight: it is first on the chain
    this.chain = this.chain.then(() => this.flush()).then(() => (this.finalDone || this.disabled ? undefined : this.flush()));
    await this.chain;
  }

  // ---- the batch ------------------------------------------------------------------------------------------------------------------

  private schedule(): void {
    if (this.timer || this.disabled || this.finished !== null) return;
    const wait = Math.max(0, this.flushMs - (this.now() - this.lastFlushAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.chain = this.chain.then(() => this.flush());
    }, wait);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.disabled || !this.started) return;
    const events = this.pending;
    this.pending = [];
    const final = this.finalDone ? null : this.finished;
    if (events.length === 0 && this.queue.length === 0 && !this.dirty && final === null) return;
    this.lastFlushAt = this.now();
    let pushed = '';
    let sawStop: StopAsked | undefined;
    try {
      await this.job.transaction(async (tx) => {
        // 1. fold (the lines are kept in memory first, so a failed write below does not lose them)
        const clean = await this.redact(tx, events);
        for (const ev of clean) this.queue.push(...this.fold.apply(ev));
        if (final !== null) this.fold.finish(final, { stopReason: this.stopReason, cost: this.cost });
        // 2. write
        if (this.queue.length > 0) await this.writeRows(tx, this.queue);
        const view = this.fold.viewColumns();
        const t = this.target;
        const written = await tx.query<{ stop_requested_at: Date | null; stopped_by_actor: string | null; stopped_by_name: string | null }>(
          `UPDATE app.run_view
              SET state = CASE WHEN stop_requested_at IS NOT NULL AND $2 NOT IN ('done', 'failed', 'stopped') THEN 'stopping' ELSE $2 END,
                  now_step = $3::jsonb, counts = $4::jsonb, helpers = $5::jsonb, plan = $6::jsonb, plan_version = $7, last_seq = $8, stop_reason = $9, cost = $10::jsonb,
                  ended_at = CASE WHEN $11::boolean THEN coalesce(ended_at, now()) ELSE ended_at END,
                  updated_at = now()
            WHERE run_id = $1::uuid
            RETURNING stop_requested_at, stopped_by_actor, stopped_by_name`,
          [
            t.runId,
            view.state,
            view.now_step === null ? null : JSON.stringify(view.now_step),
            JSON.stringify(view.counts),
            JSON.stringify(view.helpers),
            JSON.stringify(view.plan),
            view.plan_version,
            view.last_seq,
            view.stop_reason,
            view.cost === null ? null : JSON.stringify(view.cost),
            final !== null,
          ],
        );
        const row = written.rows[0];
        if (row?.stop_requested_at) {
          sawStop = { actorId: row.stopped_by_actor, name: row.stopped_by_name ?? 'Someone' };
          if (this.asked === undefined) this.fold.markStopping(sawStop.name);
        }
        // leases nobody renewed (a closed laptop) are swept when a run ends
        if (final !== null) await tx.query("DELETE FROM app.thread_watchers WHERE expires_at < now() - interval '1 hour'");
        // 3. tell the ones who are looking
        pushed = await this.push(tx, final);
      });
      this.queue = [];
      this.dirty = false;
      if (pushed !== '') this.lastPushed = pushed;
      if (final !== null) this.finalDone = true;
      this.failures = 0;
      if (sawStop !== undefined) {
        this.asked ??= sawStop;
        this.fireStop(sawStop);
      }
    } catch (err) {
      this.failed(err);
    }
  }

  private async writeRows(tx: PluginTx, rows: readonly FoldRow[]): Promise<void> {
    const t = this.target;
    await tx.query(
      `INSERT INTO app.run_activity (run_id, seq, kind, payload, channel_id, thread_root_id, asker_id, conversation)
       SELECT $1::uuid, r.seq, r.kind, r.payload::jsonb, $2::uuid, $3::uuid, $4::uuid, $5::boolean
         FROM unnest($6::int[], $7::text[], $8::text[]) AS r(seq, kind, payload)
       ON CONFLICT (run_id, seq) DO NOTHING`,
      [t.runId, t.channelId, t.threadRootId, t.askerActorId, t.conversation, rows.map((r) => r.seq), rows.map((r) => r.kind), rows.map((r) => JSON.stringify(r.payload))],
    );
  }

  /** The `run.activity` push to the watchers, and at the end `run.ended` to the channel. Answers the signature of what was pushed ('' when nothing was). */
  private async push(tx: PluginTx, final: 'done' | 'failed' | 'stopped' | null): Promise<string> {
    const t = this.target;
    if (t.threadRootId === null) return '';
    const progress = this.fold.progress();
    const signature = JSON.stringify(progress);
    let sent = '';
    if (final !== null || signature !== this.lastPushed) {
      const audience = await this.watchers(tx);
      if (audience.length > 0) {
        const payload = RunActivityPush.parse(fitPush({ ...progress, runId: t.runId, channelId: t.channelId, threadRootId: t.threadRootId }));
        await this.ctx.realtime.pushToPeople(tx, audience, WS_RUN_ACTIVITY, payload);
      }
      sent = signature;
    }
    // a run in a conversation ends for its asker through the live frames (live.ts); every other run ends for the readers of its channel here
    if (final !== null && !t.conversation) {
      const ended = RunEndedPush.parse({ runId: t.runId, channelId: t.channelId, threadRootId: t.threadRootId, status: final });
      await this.ctx.realtime.pushToPeople(tx, await this.channelReaders(tx), WS_RUN_ENDED, ended);
    }
    return sent;
  }

  // ---- who is told ------------------------------------------------------------------------------------------------------------------

  private async watchers(tx: PluginTx): Promise<string[]> {
    const t = this.target;
    if (t.conversation) {
      const asker = await this.resolveAsker(tx);
      return asker === null ? [] : [asker];
    }
    const r = await tx.query<{ person_id: string }>('SELECT person_id FROM app.thread_watchers WHERE root_id = $1::uuid AND expires_at > now()', [t.threadRootId]);
    return r.rows.map((x) => x.person_id);
  }

  private async channelReaders(tx: PluginTx): Promise<string[]> {
    const r = await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [this.target.channelId]);
    return r.rows.map((x) => x.person_id);
  }

  private async resolveAsker(tx: PluginTx): Promise<string | null> {
    if (this.askerPerson !== undefined) return this.askerPerson;
    const id = this.target.askerActorId;
    this.askerPerson = id === null ? null : ((await tx.query<{ ref_id: string }>("SELECT ref_id FROM app.actors WHERE id = $1::uuid AND kind = 'person'", [id])).rows[0]?.ref_id ?? null);
    return this.askerPerson;
  }

  private async lookForStop(): Promise<StopAsked | undefined> {
    const r = await this.job.transaction((tx) =>
      tx.query<{ stopped_by_actor: string | null; stopped_by_name: string | null }>('SELECT stopped_by_actor, stopped_by_name FROM app.run_view WHERE run_id = $1::uuid AND stop_requested_at IS NOT NULL', [this.target.runId]),
    );
    const row = r.rows[0];
    return row === undefined ? undefined : { actorId: row.stopped_by_actor, name: row.stopped_by_name ?? 'Someone' };
  }

  // ---- the words --------------------------------------------------------------------------------------------------------------------

  /**
   * The titles, paths, helper names and plan lines of the batch, redacted again (the agent's bridge cut them already; a gateway of the customer's own is not ours). One call
   * of the chain for all the new words of the batch; a word seen before is not sent twice. A word the chain could not vouch for is left out.
   */
  private async redact(tx: PluginTx, events: SlimEvent[]): Promise<SlimEvent[]> {
    const fresh = new Set<string>();
    for (const ev of events) mapWords(ev, (s) => (this.words.has(s) ? s : (fresh.add(s), s)));
    const local = new Map<string, string>();
    if (fresh.size > 0) {
      const list = [...fresh];
      let parts: string[] | null = null;
      try {
        const out = await previewText(this.ctx, tx, this.target.workspaceId, list.join('\n'));
        const split = out.split('\n');
        parts = out.startsWith(NOT_SHOWN) || split.length !== list.length ? null : split;
      } catch (err) {
        this.warn(`the words of a step could not be checked: ${err instanceof Error ? err.message : String(err)}`);
      }
      // only a word the chain vouched for is remembered; one it could not check is left out of this batch and asked again the next time it comes
      if (parts !== null) {
        if (this.words.size > CACHE_LIMIT) this.words.clear();
        list.forEach((w, i) => this.words.set(w, (parts[i] ?? '').slice(0, 400)));
      } else {
        for (const w of list) local.set(w, '');
      }
    }
    return events.map((ev) => mapWords(ev, (s) => this.words.get(s) ?? local.get(s) ?? ''));
  }

  // ---- failure ----------------------------------------------------------------------------------------------------------------------

  private async guarded(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.failed(err);
    }
  }

  private failed(err: unknown): void {
    this.failures += 1;
    this.warn(`the record could not be written (${this.failures} of ${MAX_FAILURES}): ${err instanceof Error ? err.message : String(err)}`);
    if (this.failures >= MAX_FAILURES) {
      this.disabled = true;
      this.pending = [];
      this.queue = [];
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private warn(line: string): void {
    if (this.warned) return;
    this.warned = true;
    this.log.warn(`runtime-hermes: run ${this.target.runId}: ${line}`);
  }
}
