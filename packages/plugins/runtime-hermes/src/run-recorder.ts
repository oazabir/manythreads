import type { BotRuntimeEvent, JobInfo, PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import { RunActivityPush, RunEndedPush, RunStartedPush, WS_RUN_ACTIVITY, WS_RUN_ENDED, WS_RUN_STARTED, type RunCost } from '@manythreads/shared';
import { previewText } from './holds.ts';
import { watchersOf } from './live.ts';
import { ActivityFold, clip, fitPush, mapWords, MAX_ROWS, slimOf, type FoldRow, type SlimEvent } from './run-activity.ts';

// Keeps what a run did, and tells the people who are looking (P25-06, P25-07; docs/plans/acp.md §3.4).
//
// One recorder per run, owned by the run job. The job gives it every runtime event; it keeps them in memory and, at most once a second, writes one batch. A batch is
// separate pieces of work, so none of them can spoil another:
//
//   1. the words: titles, paths, helper and plan lines go through the same pre-egress chain as an approval's preview (a key-like string becomes `[redacted:...]`; with no
//      guardrail loaded the words are left out), in a transaction of their own;
//   2. the write: the new lines to `run_activity` and the folded state to `run_view`, in one short transaction. A write the database refuses for its content (SQLSTATE class
//      22 or 23: a CHECK, a character it cannot hold) is a poison pill and is never sent again as it was: the folded state alone is written, then the lines one by one (the
//      offending one is dropped), then, if even the state is refused, a bare state. A write that fails for any other reason is tried again with the next batch;
//   3. the pushes to the people who have the thread open, in a transaction of their own.
//
// The run's END is not a batch. The final state (ended_at, the closing state, who stopped it) is one small statement with nothing else in it, retried with a back-off, and it
// is written whatever happened before: a recorder that gave up on its batches, or never opened, still closes its row. As a backstop `run-sweep.ts` closes any row whose
// `bot_runs` row is no longer running (on the `bots.run.closed` event, and every couple of minutes), so a card never stays "working" for a run that is over.
//
// A recorder never throws and never holds up the run. Who is told: a run in a thread, the people who have that thread open (`thread_watchers`, a lease the open panel renews)
// and can still read its channel; a run in a person's own conversation, its asker. Everybody who can read the channel is told only that a run began and ended (`run.started`,
// `run.ended`: the root's "Coder is working" chip).

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
  /** How often a live run says it is alive, while the poll runs (default 30 s). */
  heartbeatMs?: number;
  /** The waits between the tries of the run's first write and of its final state (default 0, 0.3, 1, 3, 6 seconds). */
  retryMs?: readonly number[];
  maxRows?: number;
  now?: () => number;
}

export interface StopAsked {
  actorId: string | null;
  name: string;
}

/** Batches that fail this many times in a row are given up for the run (the final state and the Stop are not). */
const MAX_FAILURES = 5;
const CACHE_LIMIT = 2000;
/** What waits in memory for the next batch, at most (a plan and an approval always get in). */
const MAX_PENDING = 5000;
const DEFAULT_RETRY_MS: readonly number[] = [0, 300, 1000, 3000, 6000];
/** The text a redaction chain answers with when it could not check the words (holds.ts). */
const NOT_SHOWN = '[the message is not shown';

/** The database refused the content, not the connection: a CHECK, a character it cannot store. The same write will be refused again. */
export const isPoison = (err: unknown): boolean => /^2[23]/.test(String((err as { code?: unknown } | null)?.code ?? ''));
const sleep = (ms: number): Promise<void> => (ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

type WriteMode = 'full' | 'view' | 'bare';

export class RunRecorder {
  private readonly fold: ActivityFold;
  private readonly flushMs: number;
  private readonly stopPollMs: number;
  private readonly heartbeatMs: number;
  private readonly retryMs: readonly number[];
  private readonly now: () => number;
  private pending: SlimEvent[] = [];
  /** Lines the fold produced that are not yet in the table. */
  private queue: FoldRow[] = [];
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private lastFlushAt = 0;
  private lastBeatAt = 0;
  private lastPushed = '';
  private failures = 0;
  private warned = false;
  /** The batches are given up for this run (many failures in a row); the final state and the Stop are not. */
  private disabled = false;
  /** The folded state could not be written in full once: it is written bare from then on. */
  private bare = false;
  private started = false;
  private announced = false;
  private finished: 'done' | 'failed' | 'stopped' | null = null;
  private endedPushed = false;
  private dirty = false;
  private askerPerson: string | null | undefined;
  private botActorId: string | null = null;
  private stopReason: string | null = null;
  private cost: RunCost | null = null;
  private asked: StopAsked | undefined;
  private onStop: ((by: StopAsked) => Promise<void>) | undefined;
  private firing = false;
  private finalDone = false;
  private lastWasAnswering = false;
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
    this.heartbeatMs = options.heartbeatMs ?? 30_000;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
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

  /**
   * Open the run's folded row, and tell the channel a run began. A row that cannot be opened now (the database blinked) is tried again, a few times here and then with every
   * batch; the recorder is never switched off for it.
   */
  async start(): Promise<void> {
    for (const wait of this.retryMs.slice(0, 3)) {
      await sleep(wait);
      if (await this.open()) return;
    }
  }

  /** One runtime event of the run, in order. Cheap: it is kept and written with the next batch. */
  event(event: BotRuntimeEvent): void {
    if (this.disabled || this.finished !== null) return;
    if (event.type === 'result') {
      if (event.stopReason !== undefined) this.stopReason = clip(event.stopReason, 60);
      if (event.cost !== undefined) this.cost = event.cost;
      return;
    }
    const slim = slimOf(event);
    if (slim === null) return;
    this.take(slim);
  }

  /** A person answered the agent's question (or it was refused, or the run ended while it waited): the run is no longer waiting. */
  settle(choice: 'once' | 'session' | 'deny' | 'ended'): void {
    if (this.disabled || this.finished !== null) return;
    this.take({ t: 'approval', phase: choice === 'deny' ? 'denied' : choice === 'ended' ? 'ended' : 'approved' });
  }

  private take(slim: SlimEvent): void {
    // the answer's words arrive a few at a time: one note that the answer began is all the fold uses
    if (slim.t === 'answering') {
      if (this.lastWasAnswering) return;
      this.lastWasAnswering = true;
    } else {
      this.lastWasAnswering = false;
    }
    if (this.pending.length >= MAX_PENDING && slim.t !== 'approval' && slim.t !== 'plan') return;
    this.pending.push(slim);
    this.schedule();
  }

  /**
   * Look every couple of seconds whether somebody asked for the stop (the Stop route writes it to the row, on whichever server took the request). Once it is asked, `onStop`
   * runs every time the poll comes round until the run ends, so a stop that did not take (the agent's gateway did not answer) is tried again. The poll also says the run is
   * alive (`run_view.updated_at`) from time to time, so a run that waits for a person for a long time is not taken for a dead one.
   */
  watchStop(onStop: (by: StopAsked) => Promise<void>): void {
    if (this.poller) return;
    this.onStop = onStop;
    if (this.asked !== undefined) this.fireStop(this.asked);
    this.poller = setInterval(() => {
      if (this.polling) return;
      if (this.asked !== undefined) {
        this.fireStop(this.asked);
        return;
      }
      this.polling = true;
      void this.lookForStop()
        .then((by) => {
          if (by !== undefined) this.noticeStop(by);
        })
        .catch((err: unknown) => this.warn(`the stop could not be looked up: ${reason(err)}`))
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
    if (this.firing || this.onStop === undefined || this.finished !== null) return;
    this.firing = true;
    void this.onStop(by)
      .catch((err: unknown) => this.warn(`the agent could not be stopped: ${reason(err)}`))
      .finally(() => {
        this.firing = false;
      });
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
    this.chain = this.chain.then(() => this.flush());
    await this.chain;
  }

  // ---- opening ----------------------------------------------------------------------------------------------------------------------

  /** Insert the run's row (once it is in, it stays) and announce the run. False when the database did not take the row. */
  private async open(): Promise<boolean> {
    if (!this.started) {
      try {
        await this.job.transaction(async (tx) => {
          const t = this.target;
          const actor = await tx.query<{ id: string }>("SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1::uuid LIMIT 1", [t.botId]);
          this.botActorId = actor.rows[0]?.id ?? null;
          await tx.query(
            `INSERT INTO app.run_view (run_id, workspace_id, team_id, channel_id, thread_root_id, bot_id, bot_actor_id, bot_name, asker_id, conversation, state, started_at)
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8, $9::uuid, $10, 'starting', now())
             ON CONFLICT (run_id) DO NOTHING`,
            [t.runId, t.workspaceId, t.teamId, t.channelId, t.threadRootId, t.botId, this.botActorId, clip(t.botName, 200), t.askerActorId, t.conversation],
          );
        });
        this.started = true;
      } catch (err) {
        this.warn(`the run's row could not be opened: ${reason(err)}`);
        return false;
      }
    }
    await this.announce();
    return true;
  }

  /** "A run began", to every reader of the channel; its own transaction, so a push that fails never costs the row (it is tried again with the next batch). */
  private async announce(): Promise<void> {
    const t = this.target;
    if (this.announced || t.threadRootId === null || t.conversation) return;
    try {
      await this.job.transaction(async (tx) => {
        const push = RunStartedPush.parse({
          runId: t.runId,
          channelId: t.channelId,
          threadRootId: t.threadRootId,
          botId: t.botId,
          botActorId: this.botActorId,
          botName: clip(t.botName, 200),
          startedAt: new Date().toISOString(),
        });
        await this.ctx.realtime.pushToPeople(tx, await this.channelReaders(tx), WS_RUN_STARTED, push);
      });
      this.announced = true;
    } catch (err) {
      this.warn(`the start of the run could not be announced: ${reason(err)}`);
    }
  }

  // ---- the batch ------------------------------------------------------------------------------------------------------------------

  private schedule(): void {
    if (this.timer || this.disabled || this.finished !== null) return;
    // after failures the wait doubles (up to a minute), so a database that is down is not asked every second
    const backoff = this.failures === 0 ? 1 : Math.min(60, 2 ** this.failures);
    const wait = Math.max(0, this.flushMs * backoff - (this.now() - this.lastFlushAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.chain = this.chain.then(() => this.flush());
    }, wait);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    const final = this.finalDone ? null : this.finished;
    if (final === null && this.disabled) return;
    if (!this.started && !(await this.open()) && final === null) {
      // the row is not there yet: what was seen stays in memory for the next try
      if (this.pending.length > 0 || this.dirty) this.schedule();
      return;
    }
    if (final === null && this.started && !this.announced) await this.announce();
    const events = this.pending;
    this.pending = [];
    if (events.length === 0 && this.queue.length === 0 && !this.dirty && final === null) return;
    this.lastFlushAt = this.now();

    // 1. the words, then the fold (in memory: it cannot fail, so the lines are never lost to a write that does)
    const clean = events.length > 0 ? await this.redact(events) : [];
    for (const ev of clean) this.queue.push(...this.fold.apply(ev));
    if (final !== null) this.fold.finish(final, { stopReason: this.stopReason, cost: this.cost });

    // 2. the write
    if (this.started && !this.disabled) await this.write();

    // 3. the end of the run: nothing but the state, whatever happened above
    if (final !== null) await this.writeFinal(final);

    // 4. the people who are looking
    await this.pushes(final);
  }

  /** One try of the batch in a given way; `poison` when the database refused the content (and so will refuse it again). */
  private async attempt(mode: WriteMode): Promise<{ ok: true; stop: StopAsked | undefined } | { ok: false; poison: boolean; err: unknown }> {
    try {
      return { ok: true, stop: await this.job.transaction((tx) => this.writeBatch(tx, mode)) };
    } catch (err) {
      return { ok: false, poison: isPoison(err), err };
    }
  }

  /** The lines and the folded columns, in one transaction. What the database refuses for its content is dropped, never tried again as it was. */
  private async write(): Promise<void> {
    const lines = this.queue;
    const first = await this.attempt(this.bare ? 'bare' : lines.length > 0 ? 'full' : 'view');
    if (first.ok) {
      this.done(first.stop);
      return;
    }
    if (!first.poison) {
      this.failed(first.err);
      return;
    }
    this.warn(`the database refused the record: ${reason(first.err)}`);
    // the state alone: if it goes in, a line of the batch was what the table refused, so the lines are written one by one and the bad one is dropped
    let landed: { ok: true; stop: StopAsked | undefined } | undefined;
    if (!this.bare && lines.length > 0) {
      const second = await this.attempt('view');
      if (second.ok) landed = second;
      else if (!second.poison) {
        this.failed(second.err);
        return;
      }
    }
    if (landed === undefined) {
      // the folded state itself is refused: write it bare from now on
      const third = await this.attempt('bare');
      if (!third.ok) {
        if (!third.poison) this.failed(third.err);
        else this.give();
        return;
      }
      this.bare = true;
      landed = third;
    }
    this.queue = [];
    this.dirty = false;
    this.failures = 0;
    for (const line of lines) {
      try {
        await this.job.transaction((tx) => this.writeRows(tx, [line]));
      } catch (err) {
        if (!isPoison(err)) {
          this.failed(err);
          return;
        }
        this.warn(`a line the database refused was dropped (${line.kind}, ${line.seq})`);
      }
    }
    this.noticeFlag(landed.stop);
  }

  private done(stop: StopAsked | undefined): void {
    this.queue = [];
    this.dirty = false;
    this.failures = 0;
    this.noticeFlag(stop);
  }

  private give(): void {
    this.queue = [];
    this.dirty = false;
  }

  private noticeFlag(stop: StopAsked | undefined): void {
    if (stop === undefined) return;
    this.asked ??= stop;
    this.fold.markStopping(stop.name);
    this.fireStop(stop);
  }

  private async writeBatch(tx: PluginTx, mode: WriteMode): Promise<StopAsked | undefined> {
    const t = this.target;
    if (mode === 'full' && this.queue.length > 0) await this.writeRows(tx, this.queue);
    const view = this.fold.viewColumns();
    const bare = mode === 'bare';
    const written = await tx.query<{ stop_requested_at: Date | null; stopped_by_actor: string | null; stopped_by_name: string | null }>(
      `UPDATE app.run_view
          SET state = CASE WHEN $2 IN ('done', 'failed', 'stopped') THEN state WHEN stop_requested_at IS NOT NULL THEN 'stopping' ELSE $2 END,
              now_step = $3::jsonb, counts = $4::jsonb, helpers = $5::jsonb, plan = $6::jsonb, plan_version = $7, last_seq = $8,
              updated_at = now()
        WHERE run_id = $1::uuid AND ended_at IS NULL
        RETURNING stop_requested_at, stopped_by_actor, stopped_by_name`,
      [
        t.runId,
        view.state,
        bare || view.now_step === null ? null : JSON.stringify(view.now_step),
        JSON.stringify(view.counts),
        bare ? '[]' : JSON.stringify(view.helpers),
        bare ? '[]' : JSON.stringify(view.plan),
        view.plan_version,
        view.last_seq,
      ],
    );
    const row = written.rows[0];
    return row?.stop_requested_at ? { actorId: row.stopped_by_actor, name: row.stopped_by_name ?? 'Someone' } : undefined;
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

  /**
   * The run's closing state: one small statement, no words, no pushes. Retried with a back-off; if the database stays away the row is left to the sweep (which closes any
   * run row whose `bot_runs` row is over). A Stop that did not take effect (the run ended by itself, or failed) leaves nobody's name on it.
   */
  private async writeFinal(final: 'done' | 'failed' | 'stopped'): Promise<void> {
    const t = this.target;
    const view = this.fold.viewColumns();
    for (let attempt = 0; attempt < this.retryMs.length; attempt += 1) {
      await sleep(this.retryMs[attempt] ?? 0);
      try {
        if (!this.started && !(await this.open())) continue;
        // a reason or a cost the table cannot hold is not worth keeping the run open for: the last tries leave them out
        const bareTail = attempt >= 2;
        await this.job.transaction((tx) =>
          tx.query(
            `UPDATE app.run_view
                SET state = $2, ended_at = greatest(started_at, coalesce(ended_at, now())), now_step = NULL, last_seq = $3, stop_reason = $4, cost = $5::jsonb,
                    stopped_by_actor = CASE WHEN $2 = 'stopped' THEN stopped_by_actor END,
                    stopped_by_name = CASE WHEN $2 = 'stopped' THEN stopped_by_name END,
                    updated_at = now()
              WHERE run_id = $1::uuid`,
            [t.runId, final, view.last_seq, bareTail ? null : view.stop_reason, bareTail || view.cost === null ? null : JSON.stringify(view.cost)],
          ),
        );
        this.finalDone = true;
        return;
      } catch (err) {
        this.warn(`the end of the run could not be written (try ${attempt + 1} of ${this.retryMs.length}): ${reason(err)}`);
      }
    }
    // not written: the sweep closes it from `bot_runs`; the pushes below still go out so the screens do not wait
    this.finalDone = true;
  }

  // ---- the pushes -------------------------------------------------------------------------------------------------------------------

  /** The `run.activity` push to the watchers, and at the end `run.ended` to the channel; each in a transaction of its own, so neither costs the other (or the record). */
  private async pushes(final: 'done' | 'failed' | 'stopped' | null): Promise<void> {
    const t = this.target;
    const root = t.threadRootId;
    if (root === null) return;
    const progress = this.fold.progress();
    const signature = JSON.stringify(progress);
    if (final !== null || signature !== this.lastPushed) {
      try {
        await this.job.transaction(async (tx) => {
          const audience = await this.watchers(tx);
          if (audience.length === 0) return;
          const payload = RunActivityPush.parse(fitPush({ ...progress, runId: t.runId, channelId: t.channelId, threadRootId: root }));
          await this.ctx.realtime.pushToPeople(tx, audience, WS_RUN_ACTIVITY, payload);
        });
        this.lastPushed = signature;
      } catch (err) {
        this.warn(`the state of the run could not be pushed: ${reason(err)}`);
      }
    }
    // a run in a conversation ends for its asker through the live frames (live.ts); every other run ends for the readers of its channel here
    if (final !== null && !t.conversation && !this.endedPushed) {
      for (let attempt = 0; attempt < 2 && !this.endedPushed; attempt += 1) {
        try {
          await this.job.transaction(async (tx) => {
            const ended = RunEndedPush.parse({ runId: t.runId, channelId: t.channelId, threadRootId: root, status: final });
            await this.ctx.realtime.pushToPeople(tx, await this.channelReaders(tx), WS_RUN_ENDED, ended);
          });
          this.endedPushed = true;
        } catch (err) {
          this.warn(`the end of the run could not be pushed: ${reason(err)}`);
        }
      }
    }
  }

  // ---- who is told ------------------------------------------------------------------------------------------------------------------

  private async watchers(tx: PluginTx): Promise<string[]> {
    const t = this.target;
    if (t.conversation) {
      const asker = await this.resolveAsker(tx);
      return asker === null ? [] : [asker];
    }
    // the people who hold a lease on the thread AND can still read its channel right now (a member removed since still holds a lease for up to a minute)
    return watchersOf(t.threadRootId!, t.channelId)(tx);
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

  /** Is a Stop on the run's row? Also says the run is alive from time to time. */
  private async lookForStop(): Promise<StopAsked | undefined> {
    const beat = this.now() - this.lastBeatAt >= this.heartbeatMs;
    const r = await this.job.transaction(async (tx) => {
      if (beat) await tx.query('UPDATE app.run_view SET updated_at = now() WHERE run_id = $1::uuid AND ended_at IS NULL', [this.target.runId]);
      return tx.query<{ stopped_by_actor: string | null; stopped_by_name: string | null }>(
        'SELECT stopped_by_actor, stopped_by_name FROM app.run_view WHERE run_id = $1::uuid AND stop_requested_at IS NOT NULL',
        [this.target.runId],
      );
    });
    if (beat) this.lastBeatAt = this.now();
    const row = r.rows[0];
    return row === undefined ? undefined : { actorId: row.stopped_by_actor, name: row.stopped_by_name ?? 'Someone' };
  }

  // ---- the words --------------------------------------------------------------------------------------------------------------------

  /**
   * The titles, paths, helper names and plan lines of the batch, redacted again (the agent's bridge cut them already; a gateway of the customer's own is not ours). One call
   * of the chain for all the new words of the batch, in a transaction of its own; a word seen before is not sent twice. A word the chain could not vouch for is left out.
   */
  private async redact(events: SlimEvent[]): Promise<SlimEvent[]> {
    const fresh = new Set<string>();
    for (const ev of events) mapWords(ev, (s) => (this.words.has(s) ? s : (fresh.add(s), s)));
    const local = new Map<string, string>();
    if (fresh.size > 0) {
      const list = [...fresh];
      let parts: string[] | null = null;
      try {
        // a word is one line (the fold made it so), so the words of the batch are told apart by the line break
        const out = await this.job.transaction((tx) => previewText(this.ctx, tx, this.target.workspaceId, list.join('\n')));
        const split = out.split('\n');
        parts = out.startsWith(NOT_SHOWN) || split.length !== list.length ? null : split;
      } catch (err) {
        this.warn(`the words of a step could not be checked: ${reason(err)}`);
      }
      // only a word the chain vouched for is remembered; one it could not check is left out of this batch and asked again the next time it comes
      if (parts !== null) {
        if (this.words.size > CACHE_LIMIT) this.words.clear();
        list.forEach((w, i) => this.words.set(w, clip(parts[i] ?? '', 400)));
      } else {
        for (const w of list) local.set(w, '');
      }
    }
    return events.map((ev) => mapWords(ev, (s) => this.words.get(s) ?? local.get(s) ?? ''));
  }

  // ---- failure ----------------------------------------------------------------------------------------------------------------------

  private failed(err: unknown): void {
    this.failures += 1;
    this.warn(`the record could not be written (${this.failures} of ${MAX_FAILURES}): ${reason(err)}`);
    if (this.failures >= MAX_FAILURES) {
      this.disabled = true;
      this.pending = [];
      this.queue = [];
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      return;
    }
    // the lines stay in `queue` for the next batch; make sure there is one
    this.dirty = true;
    this.schedule();
  }

  private warn(line: string): void {
    if (this.warned) return;
    this.warned = true;
    this.log.warn(`runtime-hermes: run ${this.target.runId}: ${line}`);
  }
}
