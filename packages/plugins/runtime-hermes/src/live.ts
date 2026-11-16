import type { BotRuntimeHandle, JobInfo, PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import { json, notFound, route } from '@manythreads/sdk';
import {
  RunDeltaPush,
  RunEndedPush,
  RunLookingPush,
  RunStopPathParams,
  RunStopResponse,
  WS_RUN_DELTA,
  WS_RUN_ENDED,
  WS_RUN_LOOKING,
  stopRunRoute,
} from '@manythreads/shared';

// The live side of a run in a person's conversation (PLAN P20-16): the words of the answer as they are written, what the bot is looking at, and Stop.
//
//  * Frames. `run.delta` (the next piece of the answer), `run.looking` (a fixed label such as "Searching memory", never a document's text) and `run.ended` go to
//    the asker only, as WebSocket pushes (`ctx.realtime.pushToPerson`, delivered when the short transaction that queued them commits). They are previews: the
//    answer is the message the run posts, so a lost or late frame costs a word of the preview and nothing else. At most one frame per 80 ms, each under 4000
//    characters (a push is capped near 7 KB).
//  * Stop. `POST /api/runs/:runId/stop` is a fact on the run's row (`app.run_stop_request`, P25-08): the asker, the person who started the thread, a lead of the
//    team and a workspace admin may press it (a run in a conversation: its asker alone). The server that holds the run stops it at once; the run job on any other
//    replica sees the flag within a couple of seconds (`RunRecorder.watchStop`). A stopped run posts what it had written as its answer.
//  * A run in a thread (P25-07) streams the words of its answer too, to the people who have that thread open (`thread_watchers`) instead of the asker alone, and
//    sends no `run.ended` from here: the recorder (run-recorder.ts) tells every reader of the channel when the run is over.

export const FRAME_MS = 80;
export const FRAME_CHARS = 3000;
/**
 * The most a frame's text may weigh once written as JSON. The socket layer refuses a push over 7000 bytes (REALTIME_MAX_BYTES) and the frame also carries ids, so
 * 3000 characters of Chinese or Arabic (2 to 3 bytes each) or of quotes and line breaks (2 bytes each) would be dropped and leave a hole in the preview.
 */
export const FRAME_BYTES = 4500;

/** The first piece of `pending` to send: at most FRAME_CHARS characters and FRAME_BYTES bytes as JSON, never ending between the two halves of one emoji. */
export function takePiece(pending: string): string {
  let n = Math.min(pending.length, FRAME_CHARS);
  while (n > 1 && Buffer.byteLength(JSON.stringify(pending.slice(0, n))) > FRAME_BYTES) n = Math.max(1, Math.floor(n * 0.75));
  const last = pending.charCodeAt(n - 1);
  if (n > 1 && n < pending.length && last >= 0xd800 && last <= 0xdbff) n -= 1;
  return pending.slice(0, n);
}

export interface StoppedBy {
  actorId: string | null;
  name: string;
}

interface LiveEntry {
  askerActorId: string | null;
  handle: BotRuntimeHandle | undefined;
  stopped: boolean;
  /** Who pressed Stop, when it was pressed on this server. */
  stoppedBy: StoppedBy | undefined;
}

/** The runs this process is running for a person in a conversation, by run id. */
const live = new Map<string, LiveEntry>();

export function trackRun(runId: string, askerActorId: string | null): LiveEntry {
  const entry: LiveEntry = { askerActorId, handle: undefined, stopped: false, stoppedBy: undefined };
  live.set(runId, entry);
  return entry;
}
export const untrackRun = (runId: string): void => {
  live.delete(runId);
};

/** What a tool call looks like to the asker: a fixed phrase per kind of tool, never the call's input. */
export function lookingLabel(tool: string): string {
  const name = tool.toLowerCase();
  if (name.includes('memory')) return 'Searching memory';
  if (name.includes('knowledge')) return 'Searching knowledge';
  if (name.includes('web') || name.includes('browse') || name.includes('fetch')) return 'Reading the web';
  if (name.includes('search')) return 'Searching';
  if (name.includes('file') || name.includes('page') || name.includes('repo') || name.includes('read')) return 'Reading files';
  return 'Working on it';
}

export interface FrameTarget {
  runId: string;
  channelId: string;
  threadRootId: string;
  /** Who the frames go to when there is no `audience` (the person in the conversation). */
  askerActorId: string | null;
}

export interface FrameOptions {
  /** The people to send each frame to, asked inside the transaction that sends it (a thread's watchers). Without it, the asker alone. */
  audience?: (tx: PluginTx) => Promise<string[]>;
  /** Send `run.ended` from `end()` (default true); a run in a thread is ended for the channel by the recorder instead. */
  sendEnded?: boolean;
  /** Send `run.looking` (default true): a thread run's card has the folded state instead. */
  sendLooking?: boolean;
  /**
   * Make the words of an answer fit for people other than the asker: each piece goes through this (the pre-egress preview) before it is pushed. A piece it answers
   * `null` for could not be made safe: that piece and every one after it are not sent (the answer is the message the run posts). A redacted piece may be shorter or
   * longer than what the agent wrote, so the frame says how many characters of the answer it covers (`span`).
   */
  redact?: (tx: PluginTx, text: string) => Promise<string | null>;
}

/**
 * The people who have a thread open right now (leases the open panel renews, `app.thread_watchers`) AND can read its channel right now (`channel_audience`): a member
 * removed from a private channel, or a guest whose access ended, holds a lease for up to a minute and must not be sent the run's steps or the words of its answer.
 */
export const watchersOf =
  (rootId: string, channelId: string) =>
  async (tx: PluginTx): Promise<string[]> =>
    (
      await tx.query<{ person_id: string }>(
        `SELECT DISTINCT w.person_id FROM app.thread_watchers w
          WHERE w.root_id = $1::uuid AND w.channel_id = $2::uuid AND w.expires_at > now()
            AND w.person_id IN (SELECT a.person_id FROM app.channel_audience($2::uuid) a)`,
        [rootId, channelId],
      )
    ).rows.map((r) => r.person_id);

/**
 * Who gets the folded state of a run (`run.activity`, never the words of its answer): the people who have the thread open (`watchersOf`) and, since P29, the people who have the
 * whole channel open (`app.channel_watchers`: the channel page's task view), each AND able to read the channel right now.
 */
export const activityWatchersOf =
  (rootId: string, channelId: string) =>
  async (tx: PluginTx): Promise<string[]> =>
    (
      await tx.query<{ person_id: string }>(
        `SELECT person_id FROM (
            SELECT w.person_id FROM app.thread_watchers w WHERE w.root_id = $1::uuid AND w.channel_id = $2::uuid AND w.expires_at > now()
            UNION
            SELECT c.person_id FROM app.channel_watchers c WHERE c.channel_id = $2::uuid AND c.expires_at > now()
          ) held
          WHERE person_id IN (SELECT a.person_id FROM app.channel_audience($2::uuid) a)`,
        [rootId, channelId],
      )
    ).rows.map((r) => r.person_id);

/** How long an empty audience is trusted: a thread nobody has open does not cost a transaction per frame. */
const EMPTY_AUDIENCE_MS = 1500;
/** How long an audience that was found is reused: a person who left the thread or the channel stops receiving within this, and the lookups do not come with every frame. */
const AUDIENCE_CACHE_MS = 3000;
/** A frame that must be checked for secrets first is sent less often (one check a frame, not one for every few words). */
const REDACTED_FRAME_MS = 300;
/** A redacted piece may be longer than what was written; a push over about 7 KB is dropped by the socket layer, so past this the preview stops instead of leaving a hole. */
const REDACTED_FRAME_BYTES = 6000;

/** Sends the frames of one run, in order, at most one per `FRAME_MS`. Never throws: a frame that cannot be sent is dropped (and logged once). */
export class LiveFrames {
  private personId: string | null | undefined;
  private pending = '';
  private sentChars = 0;
  private lastSentAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warned = false;
  private emptyAt = -Infinity;
  private cached: { ids: string[]; at: number } | undefined;
  private redactBroken = false;
  /** Everything the run has written so far. */
  full = '';

  constructor(
    private readonly ctx: PluginContext,
    private readonly job: JobInfo,
    private readonly target: FrameTarget,
    private readonly log: PluginLogger,
    private readonly now: () => number = Date.now,
    private readonly options: FrameOptions = {},
  ) {}

  /** A piece of the answer. Sent now when the last frame was long enough ago, else held and sent by the timer. */
  text(chunk: string): void {
    if (chunk === '') return;
    this.full += chunk;
    this.pending += chunk;
    const every = this.options.redact === undefined ? FRAME_MS : REDACTED_FRAME_MS;
    if (this.now() - this.lastSentAt >= every) this.drain();
    else this.timer ??= setTimeout(() => this.drain(), every);
  }

  looking(tool: string): void {
    if (this.options.sendLooking === false) return;
    const payload = RunLookingPush.parse({ runId: this.target.runId, channelId: this.target.channelId, threadRootId: this.target.threadRootId, label: lookingLabel(tool), tool: tool.slice(0, 80) });
    this.send(WS_RUN_LOOKING, payload);
  }

  /** The last frames: what is held, then `run.ended`. Waits for every frame before it, so the screen never sees the end first. */
  async end(status: 'done' | 'failed' | 'stopped'): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.drain();
    if (this.options.sendEnded !== false) {
      this.send(WS_RUN_ENDED, RunEndedPush.parse({ runId: this.target.runId, channelId: this.target.channelId, threadRootId: this.target.threadRootId, status }));
    }
    await this.chain;
  }

  private drain(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    while (this.pending !== '') {
      const piece = takePiece(this.pending);
      this.pending = this.pending.slice(piece.length);
      const offset = this.sentChars;
      this.sentChars += piece.length;
      this.send(WS_RUN_DELTA, RunDeltaPush.parse({ runId: this.target.runId, channelId: this.target.channelId, threadRootId: this.target.threadRootId, offset, text: piece }));
    }
    this.lastSentAt = this.now();
  }

  private send(type: string, payload: Record<string, unknown>): void {
    this.chain = this.chain.then(async () => {
      try {
        const audience = this.options.audience;
        if (audience !== undefined) {
          if (this.redactBroken && type === WS_RUN_DELTA) return;
          if (this.now() - this.emptyAt < EMPTY_AUDIENCE_MS) return;
          await this.job.transaction(async (tx) => {
            let ids: string[];
            if (this.cached !== undefined && this.now() - this.cached.at < AUDIENCE_CACHE_MS) ids = this.cached.ids;
            else {
              ids = await audience(tx);
              this.cached = ids.length === 0 ? undefined : { ids, at: this.now() };
            }
            if (ids.length === 0) {
              this.emptyAt = this.now();
              return;
            }
            let body = payload;
            const redact = this.options.redact;
            if (redact !== undefined && type === WS_RUN_DELTA) {
              const piece = String(payload['text'] ?? '');
              const safe = await redact(tx, piece);
              if (safe === null || Buffer.byteLength(JSON.stringify(safe)) > REDACTED_FRAME_BYTES) {
                // the words could not be checked: the preview stops here for everyone but the asker's own page; the message that is posted has the whole answer
                this.redactBroken = true;
                return;
              }
              body = { ...payload, text: safe, span: piece.length };
            }
            await this.ctx.realtime.pushToPeople(tx, ids, type, body);
          });
          return;
        }
        const personId = await this.resolvePerson();
        if (personId === null) return;
        await this.job.transaction((tx) => this.ctx.realtime.pushToPerson(tx, personId, type, payload));
      } catch (err) {
        if (!this.warned) {
          this.warned = true;
          this.log.warn(`runtime-hermes: run ${this.target.runId}: a live frame could not be sent: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });
  }

  private async resolvePerson(): Promise<string | null> {
    if (this.personId !== undefined) return this.personId;
    const actor = this.target.askerActorId;
    if (actor === null) return (this.personId = null);
    this.personId = await this.job.transaction(
      async (tx) => (await tx.query<{ ref_id: string }>("SELECT ref_id FROM app.actors WHERE id = $1::uuid AND kind = 'person'", [actor])).rows[0]?.ref_id ?? null,
    );
    return this.personId;
  }
}

/**
 * `POST /api/runs/:runId/stop`. The first Stop is written to the run's row (`app.run_stop_request`, which decides who may: the asker, the person who started the thread, a
 * lead of the team, a workspace admin; a run in a conversation, its asker alone), so a run job on any replica sees it. The server that holds the run stops it as soon as the
 * request's transaction has committed (never inside it: stopping waits for a process, and a flag that is rolled back must not have stopped anything); a stop that does not
 * take is tried again by the run job's poll until the run ends. A run with no folded row (it began before runs were kept, or its record could not be opened) is stopped the
 * old way, by its asker, on the server that holds it.
 * `{ stopped: true }` means the Stop is on its way (or was already); anybody who may not stop it, and a run that does not exist, are one 404.
 */
export function registerStopRoute(ctx: PluginContext): void {
  ctx.http.route({
    method: stopRunRoute.method,
    path: stopRunRoute.path,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { response: RunStopResponse },
    handler: route(async (req, tx: PluginTx) => {
      const { runId } = RunStopPathParams.parse(req.params);
      const asked = (await tx.query<{ r: string }>('SELECT app.run_stop_request($1::uuid) AS r', [runId])).rows[0]?.r;
      if (asked === 'ended') return json(RunStopResponse.parse({ stopped: false }));
      if (asked === 'requested' || asked === 'already') {
        const by = (await tx.query<{ stopped_by_actor: string | null; stopped_by_name: string | null }>('SELECT stopped_by_actor, stopped_by_name FROM app.run_view WHERE run_id = $1::uuid', [runId])).rows[0];
        // a run another server holds is stopped by that server's job within a few seconds, from the flag
        stopWhenCommitted(ctx, runId, by === undefined ? undefined : { actorId: by.stopped_by_actor, name: by.stopped_by_name ?? 'Someone' });
        return json(RunStopResponse.parse({ stopped: true }));
      }
      // no folded row, or not this caller's to stop: the asker reads their own runs (`bot_runs_select`); anybody else's run, a run that does not exist and a run of nobody are all one 404
      const mine = await tx.query<{ status: string }>('SELECT status FROM app.bot_runs WHERE id = $1::uuid AND asker_id = app.actor()', [runId]);
      if (mine.rows.length === 0) throw notFound('No such run');
      if (mine.rows[0]?.status !== 'running') return json(RunStopResponse.parse({ stopped: false }));
      // nothing is written for this one, so there is nothing to wait for
      const held = isTracked(runId);
      if (held) setTimeout(() => void stopTracked(runId).catch((err: unknown) => warnStop(runId, err)), 0);
      return json(RunStopResponse.parse({ stopped: held }));
    }),
  });
}

const warnStop = (runId: string, err: unknown): void => {
  process.stderr.write(`runtime-hermes: run ${runId}: the agent could not be stopped: ${err instanceof Error ? err.message : String(err)}\n`);
};

/**
 * Stops a run this process holds once the Stop that was asked for is visible to everyone (the request's transaction has committed). If it never shows up (the
 * transaction was rolled back) nothing is stopped. A failure is logged and left to the run job's poll, which asks again until the run ends.
 */
function stopWhenCommitted(ctx: PluginContext, runId: string, by: StoppedBy | undefined): void {
  if (!isTracked(runId)) return;
  void (async () => {
    for (let i = 0; i < 60; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, i === 0 ? 0 : 50));
      try {
        const seen = await ctx.db.system(async (tx) => (await tx.query('SELECT 1 FROM app.run_view WHERE run_id = $1::uuid AND stop_requested_at IS NOT NULL', [runId])).rows.length > 0);
        if (!seen) continue;
        await stopTracked(runId, by);
        return;
      } catch (err) {
        warnStop(runId, err);
        return;
      }
    }
  })();
}

/**
 * A Stop for a run this process holds: marks it stopped and stops its process if it has one yet (a run that is still starting stops the moment it has one).
 * False when this process does not hold the run (its own job finds the flag on the row). Safe to call again: a stop that did not take is asked for again.
 */
export async function stopTracked(runId: string, by?: StoppedBy): Promise<boolean> {
  const entry = live.get(runId);
  if (!entry) return false;
  entry.stopped = true;
  if (by !== undefined) entry.stoppedBy ??= by;
  await entry.handle?.stop();
  return true;
}

/** Does this process hold the run? */
export const isTracked = (runId: string): boolean => live.has(runId);

/** Did the asker stop this run? */
export const wasStopped = (runId: string): boolean => live.get(runId)?.stopped === true;
