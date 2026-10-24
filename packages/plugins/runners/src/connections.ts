import {
  RUNNER_MAX_LINE_CHARS,
  RunnerToServer,
  type RunnerHello,
  type RunnerJobFrame,
  type ServerToRunner,
} from '@manythreads/shared';
import type { HttpRequest, PluginContext, PluginSocket, RunnerProcessExit } from '@manythreads/sdk';
import { LineChannel } from './channel.ts';
import { bearerRunnerToken, resolveRunnerToken, tokenIsLive, type ResolvedRunner } from './tokens.ts';

// The runners' live connections (SPEC §7.4, PLAN P6-06). One WebSocket per runner, opened by the runner; this file is the server's half
// of the protocol in packages/shared/src/runner/protocol.ts. Connections live in THIS process's memory: a runner is connected to one server
// replica, and a job can only be sent from that replica (docs/plugins/runners.md, "More than one server replica").

/** How often a runner is told to heartbeat, and how many beats of silence end its connection. */
export const HEARTBEAT_SECONDS = 20;
const SILENT_AFTER_BEATS = 3;

/** A job in flight on one connection. */
export interface JobState {
  jobId: string;
  lines: LineChannel;
  /** The pieces of a line that has not ended yet. */
  piece: string;
  /** True while the rest of an over-long line is being thrown away (until a piece without `more` ends it). */
  skipping: boolean;
  /** Fires when a stop was sent (or could not be) and no `exit` came back. */
  backstop?: NodeJS.Timeout;
  exited: Promise<RunnerProcessExit>;
  settle: (exit: RunnerProcessExit) => void;
  done: boolean;
}

export interface RunnerConnection {
  resolved: ResolvedRunner;
  hello: RunnerHello;
  socket: PluginSocket;
  jobs: Map<string, JobState>;
  closed: boolean;
  close(code: number, reason: string, why: 'closed' | 'silent' | 'revoked' | 'replaced' | 'protocol'): void;
}

const keyOf = (teamId: string, name: string): string => `${teamId}\u0000${name}`;

/** The connections of this process. Exported as a class so a test can hold its own. */
export class ConnectionRegistry {
  private readonly byRunner = new Map<string, RunnerConnection>();

  get(teamId: string, name: string): RunnerConnection | undefined {
    const conn = this.byRunner.get(keyOf(teamId, name));
    return conn && !conn.closed ? conn : undefined;
  }

  set(conn: RunnerConnection): RunnerConnection | undefined {
    const key = keyOf(conn.resolved.teamId, conn.resolved.name);
    const previous = this.byRunner.get(key);
    this.byRunner.set(key, conn);
    return previous;
  }

  /** Forget `conn` if it is still the registered one (a newer connection of the same runner stays). Answers whether it was. */
  remove(conn: RunnerConnection): boolean {
    const key = keyOf(conn.resolved.teamId, conn.resolved.name);
    if (this.byRunner.get(key) !== conn) return false;
    this.byRunner.delete(key);
    return true;
  }

  byId(runnerId: string): RunnerConnection[] {
    return [...this.byRunner.values()].filter((conn) => conn.resolved.runnerId === runnerId);
  }
}

export function newJobState(jobId: string, maxQueuedChars?: number): JobState {
  let settle!: (exit: RunnerProcessExit) => void;
  const exited = new Promise<RunnerProcessExit>((resolve) => {
    settle = resolve;
  });
  return { jobId, lines: new LineChannel(maxQueuedChars), piece: '', skipping: false, exited, settle, done: false };
}

/** Finish a job: a half-received line is delivered as it is, the line stream ends, the exit settles. Idempotent. */
export function finishJob(job: JobState, exit: RunnerProcessExit): void {
  if (job.done) return;
  job.done = true;
  if (job.backstop) clearTimeout(job.backstop);
  if (job.piece !== '' && !job.skipping) job.lines.push(job.piece);
  job.piece = '';
  job.lines.end();
  job.settle(exit);
}

export const sendFrame = (socket: PluginSocket, frame: ServerToRunner): void => socket.send(JSON.stringify(frame));

export const jobFrame = (frame: Omit<RunnerJobFrame, 'type'>): RunnerJobFrame => ({ type: 'job', ...frame });

/** Serve one upgrade: authenticate the bearer token, take the runner's hello, then relay lines and exits until it goes. */
export async function serveRunnerSocket(ctx: PluginContext, registry: ConnectionRegistry, socket: PluginSocket, request: HttpRequest): Promise<void> {
  // Frames can arrive before the token has been looked up (a runner says hello the moment the socket opens): listen at once and hold
  // them until the connection is authenticated, in order.
  const early: (string | Uint8Array)[] = [];
  const hooks: { onFrame?: (data: string | Uint8Array) => void; onClose?: () => void; timer?: NodeJS.Timeout } = {};
  let closedEarly = false;
  socket.on('message', (data) => (hooks.onFrame ? hooks.onFrame(data) : early.push(data)));
  socket.on('close', () => {
    closedEarly = true;
    hooks.onClose?.();
  });
  socket.on('error', () => undefined);

  const token = bearerRunnerToken(request.headers['authorization']);
  let found: ResolvedRunner | null;
  try {
    found = token === null ? null : await ctx.db.system((tx) => resolveRunnerToken(tx, token));
  } catch {
    // a database hiccup must close this socket, not become an unhandled rejection that takes the server down
    socket.close(1011, 'internal');
    return;
  }
  if (found === null) {
    socket.close(1008, 'unauthorized');
    return;
  }
  if (closedEarly) return;
  const resolved: ResolvedRunner = found;

  let hello: RunnerHello | null = null;
  let conn: RunnerConnection | null = null;
  let lastFrameAt = Date.now();
  let ending = false;

  const end = (code: number, reason: string, why: 'closed' | 'silent' | 'revoked' | 'replaced' | 'protocol'): void => {
    if (ending) return;
    ending = true;
    if (hooks.timer) clearInterval(hooks.timer);
    const mine = conn;
    if (mine) {
      mine.closed = true;
      const wasRegistered = registry.remove(mine);
      for (const job of mine.jobs.values()) {
        finishJob(job, { code: null, signal: null, stderrTail: `the runner "${resolved.name}" disconnected (${why})` });
      }
      mine.jobs.clear();
      void ctx.db
        .system(async (tx) => {
          // A newer connection of the same runner has already marked it online: only the registered one marks it offline.
          if (wasRegistered) await tx.query("UPDATE app.runners SET status = 'offline' WHERE id = $1::uuid", [resolved.runnerId]);
          await ctx.audit.emit(tx, {
            type: 'runners.runner.disconnected',
            workspaceId: resolved.workspaceId,
            teamId: resolved.teamId,
            runnerId: resolved.runnerId,
            name: resolved.name,
            reason: why,
            at: ctx.runtime.now().toISOString(),
          });
        })
        .catch(() => undefined);
    }
    try {
      socket.close(code, reason);
    } catch {
      /* already closing */
    }
  };
  hooks.onClose = () => end(1000, 'closed', 'closed');
  if (closedEarly) return end(1000, 'closed', 'closed');

  const onFrame = (raw: string | Uint8Array): void => {
    lastFrameAt = Date.now();
    if (typeof raw !== 'string') return end(1003, 'text frames only', 'protocol');
    let frame: RunnerToServer;
    try {
      frame = RunnerToServer.parse(JSON.parse(raw));
    } catch {
      return end(1008, 'invalid frame', 'protocol');
    }
    if (frame.type === 'hello') {
      if (hello !== null) return end(1008, 'hello twice', 'protocol');
      hello = frame;
      open(frame).catch(() => end(1011, 'internal', 'protocol'));
      return;
    }
    if (conn === null) return end(1008, 'hello first', 'protocol');
    if (frame.type === 'heartbeat') {
      void beat(conn);
      return;
    }
    const job = conn.jobs.get(frame.jobId);
    if (!job) return; // a late frame of a job that has ended: nothing waits for it
    if (frame.type === 'line') {
      if (job.skipping) {
        // the rest of an over-long line: thrown away up to its end, never delivered as a line of its own
        if (frame.more !== true) job.skipping = false;
        return;
      }
      job.piece += frame.line;
      if (job.piece.length > RUNNER_MAX_LINE_CHARS) {
        job.piece = '';
        job.skipping = frame.more === true;
        return;
      }
      if (frame.more !== true) {
        const text = job.piece;
        job.piece = '';
        if (text !== '' && !job.lines.push(text)) overflow(conn, job);
      }
      return;
    }
    // exit
    conn.jobs.delete(job.jobId);
    finishJob(job, { code: frame.code, signal: frame.signal, stderrTail: frame.stderrTail });
  };

  /** The reader is not keeping up and the queue hit its limit: stop the job and fail it rather than hold the output in memory. */
  const overflow = (mine: RunnerConnection, job: JobState): void => {
    mine.jobs.delete(job.jobId);
    try {
      sendFrame(socket, { type: 'stop', jobId: job.jobId });
    } catch {
      /* the connection is going anyway */
    }
    finishJob(job, { code: null, signal: null, stderrTail: 'the run produced more output than the server will hold; it was stopped' });
  };

  const open = async (frame: RunnerHello): Promise<void> => {
    const mine: RunnerConnection = {
      resolved,
      hello: frame,
      socket,
      jobs: new Map(),
      closed: false,
      close: (code, reason, why) => end(code, reason, why),
    };
    conn = mine;
    await ctx.db.system(async (tx) => {
      await tx.query(
        "UPDATE app.runners SET status = 'online', capabilities = $2::jsonb, last_seen_at = now() WHERE id = $1::uuid",
        [resolved.runnerId, JSON.stringify(frame.capabilities)],
      );
      await ctx.audit.emit(tx, {
        type: 'runners.runner.connected',
        workspaceId: resolved.workspaceId,
        teamId: resolved.teamId,
        runnerId: resolved.runnerId,
        name: resolved.name,
        capabilities: frame.capabilities,
        maxJobs: frame.maxJobs,
        at: ctx.runtime.now().toISOString(),
      });
    });
    if (ending) return;
    // The runner ignores frames before it has been welcomed, so the connection becomes reachable (a job may be sent on it) only once the
    // welcome is on the wire. A newer connection of the same runner replaces the older one at that moment, not before.
    sendFrame(socket, { type: 'welcome', runnerId: resolved.runnerId, name: resolved.name, teamSlug: resolved.teamSlug, heartbeatSeconds: HEARTBEAT_SECONDS });
    const previous = registry.set(mine);
    previous?.close(4000, 'replaced by a newer connection', 'replaced');
  };

  const beat = async (mine: RunnerConnection): Promise<void> => {
    try {
      const live = await ctx.db.system(async (tx) => {
        if (!(await tokenIsLive(tx, resolved.tokenId))) return false;
        await tx.query("UPDATE app.runners SET last_seen_at = now(), status = 'online' WHERE id = $1::uuid", [resolved.runnerId]);
        return true;
      });
      if (!live) mine.close(1008, 'token revoked', 'revoked');
    } catch {
      // a database hiccup is not the runner's fault: the next beat asks again
    }
  };

  hooks.timer = setInterval(() => {
    if (Date.now() - lastFrameAt > HEARTBEAT_SECONDS * SILENT_AFTER_BEATS * 1000) end(1001, 'silent', 'silent');
  }, 5_000);
  hooks.timer.unref?.();

  hooks.onFrame = onFrame;
  for (const data of early.splice(0)) onFrame(data);
}
