import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  AUDIT_ACTIONS,
  OpenTerminalRequest,
  TERMINAL_END_REASONS,
  TERMINAL_END_WORDS,
  TERMINAL_LIMITS,
  TerminalClientFrame,
  TerminalRecording,
  TerminalServerFrame,
  eventRegistry,
  parseEvent,
  placementOfRun,
} from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P7-09 (`pnpm test:events`): the two events a terminal writes, the frames of its socket, the request that opens one, and the definition of a sandbox.

const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('workshop.terminal.opened', () => {
  const valid = {
    type: 'workshop.terminal.opened',
    schemaVersion: 1,
    workspaceId: uuid(1),
    teamId: uuid(2),
    botId: uuid(3),
    sessionId: uuid(4),
    adminId: uuid(5),
    runId: uuid(6),
    credentialsRevoked: 1,
    at: '2026-11-02T08:00:00.000Z',
  };
  it('is registered at version 1 and round-trips', () => {
    expect(Object.keys(eventRegistry['workshop.terminal.opened'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
  });
  it.each([
    ['credentialsRevoked', { credentialsRevoked: -1 }],
    ['runId', { runId: 'run' }],
    ['adminId', { adminId: undefined }],
    ['at', { at: 'now' }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });
});

describe('workshop.terminal.closed', () => {
  const valid = {
    type: 'workshop.terminal.closed',
    schemaVersion: 1,
    workspaceId: uuid(1),
    teamId: uuid(2),
    botId: uuid(3),
    sessionId: uuid(4),
    adminId: uuid(5),
    reason: 'idle',
    durationMs: 1200,
    bytesIn: 4,
    bytesOut: 900,
    truncated: false,
    at: '2026-11-02T08:00:00.000Z',
  };
  it('is registered at version 1 and round-trips', () => {
    expect(Object.keys(eventRegistry['workshop.terminal.closed'])).toEqual(['1']);
    expect(parseEvent(valid)).toEqual(valid);
  });
  it('knows every reason a terminal can end for, and no other', () => {
    for (const reason of TERMINAL_END_REASONS) expect(failsAt({ ...valid, reason })).toEqual([]);
    expect(failsAt({ ...valid, reason: 'whim' })).toContain('reason');
  });
  it.each([
    ['durationMs', { durationMs: -5 }],
    ['bytesOut', { bytesOut: 1.5 }],
    ['truncated', { truncated: 'no' }],
  ])('refuses a bad %s', (field, over) => {
    expect(failsAt({ ...valid, ...over })).toContain(field);
  });
});

describe('terminal vocabulary', () => {
  it('has a plain sentence for every end reason', () => {
    for (const reason of TERMINAL_END_REASONS) expect(TERMINAL_END_WORDS[reason].length, reason).toBeGreaterThan(5);
  });
  it('lists both audit actions', () => {
    expect(Object.keys(AUDIT_ACTIONS)).toEqual(expect.arrayContaining(['terminal.opened', 'terminal.closed']));
  });
});

describe('placementOfRun: what a sandbox is', () => {
  it('is only a rehearsal that was opened as a conversation', () => {
    expect(placementOfRun({ rehearsal: true, trigger: 'conversation' })).toBe('sandbox');
  });
  it.each([
    ['a real conversation', { rehearsal: false, trigger: 'conversation' }],
    ['a mention', { rehearsal: false, trigger: 'mention' }],
    ['a rehearsal flag on a webhook run', { rehearsal: true, trigger: 'webhook' }],
    ['a rehearsal flag on a channel message', { rehearsal: true, trigger: 'channel_message' }],
    ['a routine', { rehearsal: false, trigger: 'routine' }],
    ['a run with no flag', { trigger: 'conversation' }],
    ['a run with a null flag', { rehearsal: null, trigger: 'conversation' }],
    ['a run with no trigger', { rehearsal: true }],
    ['a run with an empty trigger', { rehearsal: true, trigger: '' }],
    ['nothing at all', {}],
  ])('treats %s as production', (_name, run) => {
    expect(placementOfRun(run)).toBe('production');
  });
});

describe('socket frames', () => {
  it('takes typed input and a size, and nothing else', () => {
    expect(TerminalClientFrame.parse({ t: 'in', d: 'ls\n' })).toEqual({ t: 'in', d: 'ls\n' });
    expect(TerminalClientFrame.parse({ t: 'size', cols: 100, rows: 30 })).toEqual({ t: 'size', cols: 100, rows: 30 });
    for (const bad of [{ t: 'in', d: '' }, { t: 'in', d: 'x'.repeat(TERMINAL_LIMITS.inputFrameMax + 1) }, { t: 'size', cols: 5, rows: 30 }, { t: 'size', cols: 100, rows: 9999 }, { t: 'run', d: 'rm -rf /' }, { t: 'in', d: 'a', extra: 1 }, 'ls']) {
      expect(TerminalClientFrame.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it('sends ready, output and end', () => {
    const limits = { idleSeconds: 300, maxSeconds: 1800, outputBytesPerSecond: 131072, outputBytesTotal: 8388608, inputBytesTotal: 1048576, transcriptChars: 262144 };
    expect(TerminalServerFrame.safeParse({ t: 'ready', limits, credentialsRevoked: 1 }).success).toBe(true);
    expect(TerminalServerFrame.safeParse({ t: 'out', d: 'hi' }).success).toBe(true);
    expect(TerminalServerFrame.safeParse({ t: 'end', reason: 'idle', message: 'x' }).success).toBe(true);
    expect(TerminalServerFrame.safeParse({ t: 'end', reason: 'because', message: 'x' }).success).toBe(false);
  });
});

describe('requests and records', () => {
  it('opens with nothing or a run id, and refuses anything else', () => {
    expect(OpenTerminalRequest.parse({})).toEqual({});
    expect(OpenTerminalRequest.parse({ runId: uuid(9) })).toEqual({ runId: uuid(9) });
    expect(OpenTerminalRequest.safeParse({ runId: 'x' }).success).toBe(false);
    expect(OpenTerminalRequest.safeParse({ command: 'ls' }).success).toBe(false);
  });
  it('a recording carries its text and says when it was cut', () => {
    const recording = {
      id: uuid(1),
      botSlug: 'helper',
      status: 'ended',
      admin: { id: uuid(2), name: 'Omar' },
      sandbox: { kind: 'rehearsal', runId: uuid(3) },
      startedAt: '2026-11-02T08:00:00.000Z',
      endedAt: '2026-11-02T08:05:00.000Z',
      endReason: 'closed',
      createdAt: '2026-11-02T07:59:00.000Z',
      bytesIn: 3,
      bytesOut: 40,
      credentialsRevoked: 1,
      limits: { idleSeconds: 300, maxSeconds: 1800, outputBytesPerSecond: 131072, outputBytesTotal: 8388608, inputBytesTotal: 1048576, transcriptChars: 262144 },
      transcript: 'sandbox:/work$ ls\nREADME.txt\n',
      transcriptTruncated: false,
    };
    expect(TerminalRecording.parse(recording)).toEqual(recording);
    expect(TerminalRecording.safeParse({ ...recording, sandbox: { kind: 'production', runId: null } }).success).toBe(false);
  });
});
