import { describe, expect, it } from 'vitest';
import { RUNNER_LINE_PIECE_CHARS, RUNNER_MAX_FRAME_BYTES, RunnerExit, RunnerHello, RunnerJobFrame, RunnerToServer, ServerToRunner, splitRunnerLine } from '../src/runner/protocol.ts';

// The wire between the server and a runner (PLAN P6-06): the frames, their strictness, and the splitting of a long stdout line so no frame passes
// the 64 KiB the server accepts for one WebSocket message.

const JOB = '11111111-1111-4111-8111-111111111111';

describe('runner frames', () => {
  it('accept exactly the documented shapes and refuse extra keys', () => {
    expect(RunnerToServer.parse({ type: 'hello', protocol: 1, version: '0.1.0', host: 'h', capabilities: ['docker', 'hermes'], maxJobs: 2 }).type).toBe('hello');
    expect(RunnerToServer.parse({ type: 'heartbeat', running: 1 }).type).toBe('heartbeat');
    expect(RunnerToServer.parse({ type: 'line', jobId: JOB, line: '{"type":"text"}' }).type).toBe('line');
    expect(RunnerToServer.parse({ type: 'exit', jobId: JOB, code: 0, signal: null, stderrTail: '' }).type).toBe('exit');
    expect(() => RunnerToServer.parse({ type: 'heartbeat', running: 1, extra: true })).toThrow();
    expect(() => RunnerToServer.parse({ type: 'job', jobId: JOB })).toThrow(); // a runner cannot send the server's frames
    expect(() => ServerToRunner.parse({ type: 'hello' })).toThrow(); // nor the server the runner's
  });

  it('hello names only capability words and a protocol version this server speaks', () => {
    const ok = { type: 'hello', protocol: 1, version: '1', host: 'h', capabilities: [], maxJobs: 1 };
    expect(RunnerHello.safeParse(ok).success).toBe(true);
    expect(RunnerHello.safeParse({ ...ok, protocol: 2 }).success).toBe(false);
    expect(RunnerHello.safeParse({ ...ok, capabilities: ['Docker'] }).success).toBe(false);
    expect(RunnerHello.safeParse({ ...ok, capabilities: ['rm -rf'] }).success).toBe(false);
    expect(RunnerHello.safeParse({ ...ok, maxJobs: 0 }).success).toBe(false);
  });

  it('a job carries the prompt as data and only path-safe profile names', () => {
    const job = { type: 'job', jobId: JOB, runId: JOB, profile: { home: `coder-${JOB}`, files: { 'config.yaml': 'a: 1', 'SOUL.md': 'x' } }, prompt: 'hi; rm -rf /', runBudgetSeconds: 120, maxTurns: null, killGraceSeconds: 15 };
    expect(RunnerJobFrame.safeParse(job).success).toBe(true);
    expect(RunnerJobFrame.safeParse({ ...job, profile: { ...job.profile, home: '../escape' } }).success).toBe(false);
    expect(RunnerJobFrame.safeParse({ ...job, profile: { ...job.profile, home: '/abs' } }).success).toBe(false);
    expect(RunnerJobFrame.safeParse({ ...job, profile: { ...job.profile, files: { '../x': 'y' } } }).success).toBe(false);
    expect(RunnerJobFrame.safeParse({ ...job, profile: { ...job.profile, files: { 'a/b': 'y' } } }).success).toBe(false);
  });

  it('bounds the stderr tail of an exit', () => {
    expect(RunnerExit.safeParse({ type: 'exit', jobId: JOB, code: 1, signal: 'SIGTERM', stderrTail: 'x'.repeat(2000) }).success).toBe(true);
    expect(RunnerExit.safeParse({ type: 'exit', jobId: JOB, code: 1, signal: null, stderrTail: 'x'.repeat(2001) }).success).toBe(false);
  });
});

describe('splitRunnerLine', () => {
  it('sends a short line as one piece, an empty line as one empty piece', () => {
    expect(splitRunnerLine('abc', JOB)).toEqual([{ type: 'line', jobId: JOB, line: 'abc' }]);
    expect(splitRunnerLine('', JOB)).toEqual([{ type: 'line', jobId: JOB, line: '' }]);
  });

  it('splits a long line so that joining the pieces gives it back, and only the last piece lacks `more`', () => {
    const line = 'é'.repeat(RUNNER_LINE_PIECE_CHARS * 3 + 7);
    const pieces = splitRunnerLine(line, JOB);
    expect(pieces).toHaveLength(4);
    expect(pieces.map((p) => p.more === true)).toEqual([true, true, true, false]);
    expect(pieces.map((p) => p.line).join('')).toBe(line);
  });

  it('keeps every frame under the size the server accepts, even for four-byte characters', () => {
    const line = '😀'.repeat(RUNNER_LINE_PIECE_CHARS * 2 + 1); // a surrogate pair is 2 chars and 4 bytes
    for (const piece of splitRunnerLine(line, JOB)) {
      expect(RunnerToServer.safeParse(piece).success).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(piece))).toBeLessThan(RUNNER_MAX_FRAME_BYTES);
    }
  });

  it('a piece edge inside a surrogate pair survives the JSON round trip', () => {
    // pieces are cut by UTF-16 units; the joined text must still be identical (a lone surrogate survives JSON round trips)
    const line = '😀'.repeat(5000);
    const joined = splitRunnerLine(line, JOB, 4999).map((p) => JSON.parse(JSON.stringify(p)).line).join('');
    expect(joined).toBe(line);
  });
});
