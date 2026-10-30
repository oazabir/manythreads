import { describe, expect, it } from 'vitest';
import { RunPayload } from '../src/run-job.ts';
import { REHEARSAL_NOTE, rehearsalBlocker, withRehearsalNote } from '../src/rehearsal.ts';

// What a rehearsal changes in a run's input (PLAN P7-11): a note in front of the prompt, and a refusal for a definition whose own process has tools the
// gateway cannot hold back. The router's decision (which message is a rehearsal) and the gateway's hold-back are tested where they happen.

const payload = (over: Record<string, unknown> = {}): RunPayload =>
  RunPayload.parse({
    workspaceId: '00000000-0000-7000-8000-00000000a001',
    botId: '00000000-0000-7000-8000-000000000001',
    teamId: '00000000-0000-7000-8000-0000000b0001',
    channelId: '00000000-0000-7000-8000-000000000002',
    trigger: 'conversation',
    askerActorId: '00000000-0000-7000-8000-0000000d0001',
    replyRootId: null,
    runThreadId: null,
    prompt: 'What is blocking the release?',
    ...over,
  });

describe('withRehearsalNote', () => {
  it('puts the note in front of a rehearsal prompt and leaves the question after it', () => {
    const out = withRehearsalNote(payload({ rehearsal: true }));
    expect(out.prompt.startsWith(REHEARSAL_NOTE)).toBe(true);
    expect(out.prompt.endsWith('What is blocking the release?')).toBe(true);
  });
  it('tells the model plainly that nothing is done and that a missing knowledge base is to be said', () => {
    expect(REHEARSAL_NOTE).toMatch(/NOT done/);
    expect(REHEARSAL_NOTE).toMatch(/Never say a held-back action happened/);
    expect(REHEARSAL_NOTE).toMatch(/no knowledge base/);
  });
  it('adds it only once, so a run held for an approval and resumed keeps one note', () => {
    const once = withRehearsalNote(payload({ rehearsal: true }));
    expect(withRehearsalNote(once)).toBe(once);
  });
  it('does not touch a run that is not a rehearsal', () => {
    const normal = payload();
    expect(withRehearsalNote(normal)).toBe(normal);
  });
  it('keeps the prompt inside the limit the payload allows', () => {
    const big = withRehearsalNote(payload({ rehearsal: true, prompt: 'x'.repeat(40_000) }));
    expect(big.prompt.length).toBeLessThanOrEqual(40_000);
  });
});

describe('the payload', () => {
  it('only accepts rehearsal: true (a false or a string is no payload at all)', () => {
    expect(() => payload({ rehearsal: false })).toThrow();
    expect(() => payload({ rehearsal: 'yes' })).toThrow();
    expect(payload({ rehearsal: true }).rehearsal).toBe(true);
    expect(payload().rehearsal).toBeUndefined();
  });
});

describe('rehearsalBlocker', () => {
  it('lets a bot with no tools of its own process be tested', () => {
    expect(rehearsalBlocker(undefined)).toBeNull();
    expect(rehearsalBlocker([])).toBeNull();
  });
  it('names what is granted, in the singular or the plural', () => {
    expect(rehearsalBlocker(['shell'])).toMatch(/shell is granted/);
    expect(rehearsalBlocker(['shell', 'files'])).toMatch(/shell, files are granted/);
    expect(rehearsalBlocker(['browser'])).toMatch(/Test a copy without it/);
  });
});
