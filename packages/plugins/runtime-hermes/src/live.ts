import type { BotRuntimeHandle, JobInfo, PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import { HttpError, json, notFound, route } from '@manythreads/sdk';
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
//  * Stop. `POST /api/runs/:runId/stop` is the asker's alone (404 for anybody else). The handle of a live run is held in this process, so a server with
//    several replicas answers `{ stopped: false }` when the run is on another one (Helm runs one). A stopped run posts what it had written as its answer.

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

interface LiveEntry {
  askerActorId: string;
  handle: BotRuntimeHandle | undefined;
  stopped: boolean;
}

/** The runs this process is running for a person in a conversation, by run id. */
const live = new Map<string, LiveEntry>();

export function trackRun(runId: string, askerActorId: string): LiveEntry {
  const entry: LiveEntry = { askerActorId, handle: undefined, stopped: false };
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
  askerActorId: string;
}

/** Sends the frames of one run, in order, at most one per `FRAME_MS`. Never throws: a frame that cannot be sent is dropped (and logged once). */
export class LiveFrames {
  private personId: string | null | undefined;
  private pending = '';
  private sentChars = 0;
  private lastSentAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warned = false;
  /** Everything the run has written so far. */
  full = '';

  constructor(
    private readonly ctx: PluginContext,
    private readonly job: JobInfo,
    private readonly target: FrameTarget,
    private readonly log: PluginLogger,
    private readonly now: () => number = Date.now,
  ) {}

  /** A piece of the answer. Sent now when the last frame was long enough ago, else held and sent by the timer. */
  text(chunk: string): void {
    if (chunk === '') return;
    this.full += chunk;
    this.pending += chunk;
    if (this.now() - this.lastSentAt >= FRAME_MS) this.drain();
    else this.timer ??= setTimeout(() => this.drain(), FRAME_MS);
  }

  looking(tool: string): void {
    const payload = RunLookingPush.parse({ runId: this.target.runId, channelId: this.target.channelId, threadRootId: this.target.threadRootId, label: lookingLabel(tool), tool: tool.slice(0, 80) });
    this.send(WS_RUN_LOOKING, payload);
  }

  /** The last frames: what is held, then `run.ended`. Waits for every frame before it, so the screen never sees the end first. */
  async end(status: 'done' | 'failed' | 'stopped'): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.drain();
    this.send(WS_RUN_ENDED, RunEndedPush.parse({ runId: this.target.runId, channelId: this.target.channelId, threadRootId: this.target.threadRootId, status }));
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
    this.personId = await this.job.transaction(
      async (tx) => (await tx.query<{ ref_id: string }>("SELECT ref_id FROM app.actors WHERE id = $1::uuid AND kind = 'person'", [this.target.askerActorId])).rows[0]?.ref_id ?? null,
    );
    return this.personId;
  }
}

/** `POST /api/runs/:runId/stop`: the asker stops their own run. */
export function registerStopRoute(ctx: PluginContext): void {
  ctx.http.route({
    method: stopRunRoute.method,
    path: stopRunRoute.path,
    rateLimit: { limit: 60, windowMs: 60_000 },
    schema: { response: RunStopResponse },
    handler: route(async (req, tx: PluginTx) => {
      const { runId } = RunStopPathParams.parse(req.params);
      // the asker reads their own runs (`bot_runs_select`); anybody else's run, a run that does not exist and a run of nobody are all one 404
      const mine = await tx.query<{ status: string }>('SELECT status FROM app.bot_runs WHERE id = $1::uuid AND asker_id = app.actor()', [runId]);
      if (mine.rows.length === 0) throw notFound('No such run');
      if (mine.rows[0]?.status !== 'running') return json(RunStopResponse.parse({ stopped: false }));
      try {
        return json(RunStopResponse.parse({ stopped: await stopTracked(runId) }));
      } catch (err) {
        throw new HttpError(500, 'internal', `The run could not be stopped: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    }),
  });
}

/**
 * The asker's Stop for a run this process holds: marks it stopped and stops its process if it has one yet (a run that is still starting stops the moment it has one).
 * False when this process does not hold the run.
 */
export async function stopTracked(runId: string): Promise<boolean> {
  const entry = live.get(runId);
  if (!entry) return false;
  entry.stopped = true;
  await entry.handle?.stop();
  return true;
}

/** Did the asker stop this run? */
export const wasStopped = (runId: string): boolean => live.get(runId)?.stopped === true;
