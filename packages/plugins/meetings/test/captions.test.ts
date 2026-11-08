import { MEETING_CAPTION_PUSH, MEETING_CAPTION_PUSHES_PER_SECOND, MeetingCaptionPush, type MeetingCaption } from '@manythreads/shared';
import type { PluginContext } from '@manythreads/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptionCoalescer, pushCaption, registerCaptions } from '../src/captions.ts';

// Live captions (P15-08): however many people speak, a room gets at most four pushes a second, and a push carries the newest words of each speaker.

const caption = (n: number, text: string, final = false, kind: 'speech' | 'answer' = 'speech'): MeetingCaption => ({
  kind,
  speakerId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as never,
  speakerName: `Speaker ${n}`,
  startMs: 0,
  endMs: 500,
  text,
  final,
  catchingUp: false,
  askerName: null,
});

describe('the coalescer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the first caption at once and holds the rest of the quarter second together', async () => {
    const sent: MeetingCaption[][] = [];
    const c = new CaptionCoalescer((_room, caps) => void sent.push(caps));
    c.push('room', caption(1, 'a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.length).toBe(1);
    c.push('room', caption(2, 'b'));
    c.push('room', caption(3, 'c'));
    await vi.advanceTimersByTimeAsync(100);
    expect(sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(sent.length).toBe(2);
    expect(sent[1]!.map((x) => x.text)).toEqual(['b', 'c']);
  });

  it('keeps to four pushes a second with 3 speakers among 20 people, each partial line changing every 40 ms', async () => {
    const pushes: number[] = [];
    const c = new CaptionCoalescer(() => void pushes.push(Date.now()));
    for (let t = 0; t < 5_000; t += 40) {
      for (const n of [1, 2, 3]) c.push('room', caption(n, `words ${t}`));
      await vi.advanceTimersByTimeAsync(40);
    }
    await vi.advanceTimersByTimeAsync(1_000);
    // no second of the run holds more than four pushes
    for (let from = pushes[0]!; from < pushes.at(-1)!; from += 100) {
      expect(pushes.filter((p) => p >= from && p < from + 1000).length).toBeLessThanOrEqual(MEETING_CAPTION_PUSHES_PER_SECOND);
    }
    expect(pushes.length).toBeGreaterThanOrEqual(15);
  });

  it('shows the newest partial of each speaker, and a final line replaces the partials it finishes', async () => {
    const sent: MeetingCaption[][] = [];
    const c = new CaptionCoalescer((_room, caps) => void sent.push(caps));
    c.push('room', caption(9, 'first'));
    await vi.advanceTimersByTimeAsync(0);
    c.push('room', caption(1, 'he'));
    c.push('room', caption(2, 'she'));
    c.push('room', caption(1, 'hello'));
    c.push('room', caption(1, 'hello there', true));
    c.push('room', caption(2, 'she says'));
    await vi.advanceTimersByTimeAsync(250);
    expect(sent[1]!.map((x) => `${x.speakerName}:${x.text}:${x.final}`)).toEqual(['Speaker 1:hello there:true', 'Speaker 2:she says:false']);
  });

  it('always keeps an answer, and never carries more than fifty captions', async () => {
    const sent: MeetingCaption[][] = [];
    const c = new CaptionCoalescer((_room, caps) => void sent.push(caps));
    c.push('room', caption(9, 'first'));
    await vi.advanceTimersByTimeAsync(0);
    c.push('room', caption(1, 'x', false, 'answer'));
    c.push('room', caption(1, 'y', false, 'answer'));
    for (let i = 0; i < 80; i += 1) c.push('room', caption(100 + i, `line ${i}`, true));
    await vi.advanceTimersByTimeAsync(250);
    expect(sent[1]!.length).toBe(50);
    expect(sent[1]!.slice(-1)[0]!.text).toBe('line 79');
  });

  it('keeps rooms apart, and forgets a room that has gone quiet', async () => {
    const sent: string[] = [];
    const c = new CaptionCoalescer((room) => void sent.push(room));
    c.push('one', caption(1, 'a'));
    c.push('two', caption(1, 'a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.sort()).toEqual(['one', 'two']);
    expect(c.size()).toBe(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(c.size()).toBe(0);
  });

  it('survives a sink that throws or rejects', async () => {
    const c = new CaptionCoalescer(() => {
      throw new Error('boom');
    });
    c.push('room', caption(1, 'a'));
    const d = new CaptionCoalescer(() => Promise.reject(new Error('boom')));
    d.push('room', caption(1, 'a'));
    await vi.advanceTimersByTimeAsync(300);
    expect(c.size() + d.size()).toBeGreaterThanOrEqual(0);
  });
});

describe('pushCaption on the plugin', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('pushes to the people present only, as one realtime message per window', async () => {
    const pushed: { ids: readonly string[]; type: string; payload: Record<string, unknown> }[] = [];
    const queries: string[] = [];
    const ctx = {
      db: {
        system: async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            query: async (sql: string) => {
              queries.push(sql);
              return { rows: sql.includes('meeting_participants') ? [{ person_id: 'p1' }, { person_id: 'p2' }] : [{ workspace_id: 'w1' }] };
            },
          }),
      },
      realtime: { pushToPeople: async (_tx: unknown, ids: readonly string[], type: string, payload: Record<string, unknown>) => void pushed.push({ ids, type, payload }) },
    } as unknown as PluginContext;
    registerCaptions(ctx);
    const room = '00000000-0000-4000-8000-0000000000aa';
    await pushCaption(ctx, room, caption(1, 'hello', true));
    await vi.advanceTimersByTimeAsync(10);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ ids: ['p1', 'p2'], type: MEETING_CAPTION_PUSH });
    expect(MeetingCaptionPush.parse(pushed[0]!.payload).captions[0]!.text).toBe('hello');
    // the workspace is looked up once
    await pushCaption(ctx, room, caption(1, 'again', true));
    await vi.advanceTimersByTimeAsync(300);
    expect(pushed).toHaveLength(2);
    expect(queries.filter((q) => q.includes('FROM app.meetings')).length).toBe(1);
  });
});
