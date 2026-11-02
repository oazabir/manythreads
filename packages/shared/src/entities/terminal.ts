import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, RunId, TerminalSessionId } from '../ids.ts';

// A terminal into a bot's sandbox (PLAN P7-09, SPEC section 9): a workspace admin opens a shell to debug how a bot behaves in a test. It is never a window into real work.
//   * The sandbox is a throwaway: a fresh, empty working folder on the server and a rehearsal run (the kind the Workshop's Rehearse mode opens). Nothing of a bot's real placement
//     (the Hermes host gateway, a team pod, a runner) is reachable, and a real run is refused by name (`terminal/placement.ts`).
//   * Every credential minted for that run is revoked at the moment the terminal opens, so the shell holds none.
//   * Every session is recorded: who, which bot, when it started and ended, why it ended, and the screen text, cut at a size limit and passed through the data-protection redaction.

/** What is allowed to hold a terminal: only a rehearsal's sandbox. There is no other kind, and a request for any other is refused. */
export const TERMINAL_SANDBOX_KINDS = ['rehearsal'] as const;
export const TerminalSandboxKind = z.enum(TERMINAL_SANDBOX_KINDS);
export type TerminalSandboxKind = z.infer<typeof TerminalSandboxKind>;

/**
 * What counts as a sandbox, in one place. A run is a sandbox only when its own row says it is a rehearsal and it was opened as a conversation (the Workshop's Rehearse mode and the bot page's
 * Test action both open exactly that, and nothing else sets the flag: it is written by the platform, never by a caller). EVERY other run is production, and anything this function cannot tell is
 * production too: a webhook, a schedule, a mention, a task, a channel message, an inbound mail, a run a Hermes host gateway or a team pod is serving, a runner's job. A terminal is refused for
 * all of them; there is no override.
 */
export function placementOfRun(run: { rehearsal?: boolean | null; trigger?: string | null }): 'sandbox' | 'production' {
  return run.rehearsal === true && run.trigger === 'conversation' ? 'sandbox' : 'production';
}

/** `waiting` the record exists and the page has not connected yet (it expires); `open` a shell is running; `ended` it is over. */
export const TERMINAL_STATUSES = ['waiting', 'open', 'ended'] as const;
export const TerminalStatus = z.enum(TERMINAL_STATUSES);
export type TerminalStatus = z.infer<typeof TerminalStatus>;

/**
 * Why a terminal ended. `closed` the admin closed it (or the page went away); `ended_by_admin` an admin pressed End; `idle` nothing was typed for too long; `max_duration` it ran for the
 * longest time allowed; `output_limit` it printed more than the limit; `input_limit` more was typed or pasted than the limit; `session_ended` the admin signed out or lost the admin role; `server_stop` the server stopped; `unused` the page
 * never connected; `error` the shell could not be kept running.
 */
export const TERMINAL_END_REASONS = ['closed', 'ended_by_admin', 'idle', 'max_duration', 'output_limit', 'input_limit', 'session_ended', 'server_stop', 'unused', 'error'] as const;
export const TerminalEndReason = z.enum(TERMINAL_END_REASONS);
export type TerminalEndReason = z.infer<typeof TerminalEndReason>;

/** The plain sentence for each reason; the page and the audit log use these words. */
export const TERMINAL_END_WORDS: Readonly<Record<TerminalEndReason, string>> = {
  closed: 'Closed.',
  ended_by_admin: 'Ended by an admin.',
  idle: 'Closed because nothing was typed for a while.',
  max_duration: 'Closed because it reached the longest time a terminal may stay open.',
  output_limit: 'Closed because it printed more than a terminal may.',
  input_limit: 'Closed because more was typed or pasted than a terminal may take.',
  session_ended: 'Closed because the admin signed out or is no longer an admin.',
  server_stop: 'Closed because the server stopped.',
  unused: 'Never opened.',
  error: 'Closed because the shell could not be kept running.',
};

/** The hard limits, in one place so the server, the page and the docs agree. The server may be configured with lower ones, never higher. */
export const TERMINAL_LIMITS = {
  /** Closed when no key was typed for this long. */
  idleSeconds: 300,
  /** The longest a terminal stays open. */
  maxSeconds: 1800,
  /** Output is read from the shell no faster than this; a shell that prints more is slowed down, not cut. */
  outputBytesPerSecond: 131_072,
  /** A shell that prints more than this in one session is closed. */
  outputBytesTotal: 8 * 1024 * 1024,
  /** What an admin may type or paste into one session. */
  inputBytesTotal: 1024 * 1024,
  /** One input frame. */
  inputFrameMax: 4096,
  /** What is kept of the screen text of one session. */
  transcriptChars: 262_144,
  /** A terminal that was asked for and never connected is dropped after this long. */
  waitingSeconds: 60,
  cols: { min: 20, max: 300, default: 100 },
  rows: { min: 5, max: 120, default: 30 },
} as const;

export const TerminalLimitsShape = z.strictObject({
  idleSeconds: z.number().int().positive(),
  maxSeconds: z.number().int().positive(),
  outputBytesPerSecond: z.number().int().positive(),
  outputBytesTotal: z.number().int().positive(),
  inputBytesTotal: z.number().int().positive(),
  transcriptChars: z.number().int().positive(),
});
export type TerminalLimitsShape = z.infer<typeof TerminalLimitsShape>;

/** One recorded terminal, without its screen text. */
export const TerminalSession = z.object({
  id: TerminalSessionId,
  botSlug: z.string().min(1).max(100),
  status: TerminalStatus,
  admin: z.object({ id: ActorId, name: z.string().max(200) }),
  sandbox: z.object({ kind: TerminalSandboxKind, runId: RunId.nullable() }),
  /** When the shell started; null while the page has not connected. */
  startedAt: IsoDateTime.nullable(),
  endedAt: IsoDateTime.nullable(),
  endReason: TerminalEndReason.nullable(),
  createdAt: IsoDateTime,
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
  /** How many credentials minted for the sandbox run were revoked as the terminal opened. */
  credentialsRevoked: z.number().int().nonnegative(),
  limits: TerminalLimitsShape,
});
export type TerminalSession = z.infer<typeof TerminalSession>;

/** The same with the recorded screen text (what the shell printed, escape codes removed, secrets redacted). */
export const TerminalRecording = TerminalSession.extend({
  transcript: z.string().max(TERMINAL_LIMITS.transcriptChars + 400),
  /** True when the text was cut at the size limit. */
  transcriptTruncated: z.boolean(),
});
export type TerminalRecording = z.infer<typeof TerminalRecording>;

// The socket's frames. Text frames of JSON; the server closes the socket on anything else.
export const TerminalClientFrame = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('in'), d: z.string().min(1).max(TERMINAL_LIMITS.inputFrameMax) }),
  z.strictObject({
    t: z.literal('size'),
    cols: z.number().int().min(TERMINAL_LIMITS.cols.min).max(TERMINAL_LIMITS.cols.max),
    rows: z.number().int().min(TERMINAL_LIMITS.rows.min).max(TERMINAL_LIMITS.rows.max),
  }),
]);
export type TerminalClientFrame = z.infer<typeof TerminalClientFrame>;

export const TerminalServerFrame = z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('ready'), limits: TerminalLimitsShape, credentialsRevoked: z.number().int().nonnegative() }),
  z.strictObject({ t: z.literal('out'), d: z.string() }),
  z.strictObject({ t: z.literal('end'), reason: TerminalEndReason, message: z.string().max(300) }),
]);
export type TerminalServerFrame = z.infer<typeof TerminalServerFrame>;
