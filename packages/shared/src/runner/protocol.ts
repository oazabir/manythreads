import { z } from 'zod';
import { RunnerCapability } from '../entities/task.ts';

// The wire protocol between the server and a runner (SPEC §7.4; PLAN P6-06). A runner is one program on a machine outside the cluster; it
// opens ONE outbound WebSocket to `GET /api/runners/connect` (a bearer runner token in the upgrade request) and everything below travels
// over it as JSON text frames, one object per frame. The server never connects to the runner, so a runner behind a firewall or a home
// router works, and the only thing the machine exposes is nothing.
//
//   runner → server   hello       the first frame: what this runner is and can do
//   server → runner   welcome     the connection is accepted: whose runner it is, how often to heartbeat
//   runner → server   heartbeat   every `heartbeatSeconds`: still here, `running` jobs in flight
//   server → runner   job         run one turn of a bot (the profile to write, the prompt, the budgets)
//   runner → server   line        one line of the agent's stdout (large lines arrive in pieces: `more`)
//   runner → server   exit        the agent process ended (or could not start): its code, its signal, the tail of its stderr
//   server → runner   stop        stop that job now (signal its process group)
//
// The prompt travels inside `job` as data. It is never an argument of any command, on either side.

export const RUNNER_PROTOCOL_VERSION = 1;

/** A frame from the runner may be at most this many bytes of text, because the server reads at most one WebSocket message of that size. */
export const RUNNER_MAX_FRAME_BYTES = 64 * 1024;

/** A `line` frame carries at most this many characters (four bytes each in the worst case stays under the frame limit); longer lines are split. */
export const RUNNER_LINE_PIECE_CHARS = 12_000;

/** A whole stdout line, joined from its pieces, may be at most this long; the server drops the rest of an endless line. */
export const RUNNER_MAX_LINE_CHARS = 8 * 1024 * 1024;

export const RunnerHello = z.strictObject({
  type: z.literal('hello'),
  protocol: z.literal(RUNNER_PROTOCOL_VERSION),
  /** The runner program's version, for the roster; free text. */
  version: z.string().max(40),
  /** The machine's name, for the roster; free text. */
  host: z.string().max(120),
  capabilities: z.array(RunnerCapability).max(32),
  /** How many jobs this runner runs at once; the server sends no more than this. */
  maxJobs: z.number().int().min(1).max(64),
});
export type RunnerHello = z.infer<typeof RunnerHello>;

export const RunnerHeartbeat = z.strictObject({
  type: z.literal('heartbeat'),
  running: z.number().int().min(0).max(64),
});
export type RunnerHeartbeat = z.infer<typeof RunnerHeartbeat>;

export const RunnerLine = z.strictObject({
  type: z.literal('line'),
  jobId: z.uuid(),
  line: z.string().max(RUNNER_LINE_PIECE_CHARS * 2),
  /** True when this piece is not the end of the line: the next `line` frame of the job continues it. */
  more: z.boolean().optional(),
});
export type RunnerLine = z.infer<typeof RunnerLine>;

export const RunnerExit = z.strictObject({
  type: z.literal('exit'),
  jobId: z.uuid(),
  code: z.number().int().nullable(),
  signal: z.string().max(20).nullable(),
  /** The last few lines the process wrote to stderr, or the reason it could not start; at most 2000 characters. */
  stderrTail: z.string().max(2000),
});
export type RunnerExit = z.infer<typeof RunnerExit>;

/** Every frame a runner may send. */
export const RunnerToServer = z.discriminatedUnion('type', [RunnerHello, RunnerHeartbeat, RunnerLine, RunnerExit]);
export type RunnerToServer = z.infer<typeof RunnerToServer>;

export const RunnerWelcome = z.strictObject({
  type: z.literal('welcome'),
  runnerId: z.uuid(),
  name: z.string(),
  teamSlug: z.string(),
  heartbeatSeconds: z.number().int().min(1).max(300),
});
export type RunnerWelcome = z.infer<typeof RunnerWelcome>;

export const RunnerJobFrame = z.strictObject({
  type: z.literal('job'),
  jobId: z.uuid(),
  runId: z.uuid(),
  /** The profile to write: `home` is a directory name (a bot slug and the run id), `files` are by relative path. */
  profile: z.strictObject({
    home: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,200}$/),
    files: z.record(z.string().regex(/^[A-Za-z0-9._-]+$/), z.string().max(2_000_000)),
  }),
  prompt: z.string().max(200_000),
  runBudgetSeconds: z.number().int().positive().nullable(),
  maxTurns: z.number().int().positive().nullable(),
  killGraceSeconds: z.number().int().min(1).max(300),
});
export type RunnerJobFrame = z.infer<typeof RunnerJobFrame>;

export const RunnerStop = z.strictObject({ type: z.literal('stop'), jobId: z.uuid() });
export type RunnerStop = z.infer<typeof RunnerStop>;

/** Every frame the server may send. */
export const ServerToRunner = z.discriminatedUnion('type', [RunnerWelcome, RunnerJobFrame, RunnerStop]);
export type ServerToRunner = z.infer<typeof ServerToRunner>;

/** Split one stdout line into the pieces that go on the wire: all but the last carry `more`. Pure; an empty line is one empty piece. */
export function splitRunnerLine(line: string, jobId: string, piece: number = RUNNER_LINE_PIECE_CHARS): RunnerLine[] {
  if (line.length <= piece) return [{ type: 'line', jobId, line }];
  const out: RunnerLine[] = [];
  for (let at = 0; at < line.length; at += piece) {
    const last = at + piece >= line.length;
    out.push({ type: 'line', jobId, line: line.slice(at, at + piece), ...(last ? {} : { more: true }) });
  }
  return out;
}
