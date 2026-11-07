import type { JobInfo, PluginContext, PluginLogger } from '@manythreads/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyChatAlias, streamsLive } from '../src/chat-run.ts';
import { FRAME_CHARS, FRAME_MS, LiveFrames, lookingLabel, trackRun, untrackRun, wasStopped } from '../src/live.ts';
import { RunPayload, type LoadedDefinition } from '../src/run-job.ts';

// The live side of a conversation run (PLAN P20-16): the frames are throttled, ordered and small, and the picked model is used only when the bot lists it.

const RUN = '00000000-0000-7000-8000-0000000c0001';
const ASKER = '00000000-0000-7000-8000-0000000d0001';
const PERSON = '00000000-0000-7000-8000-0000000e0001';
const CHANNEL = '00000000-0000-7000-8000-000000000002';
const THREAD = '00000000-0000-7000-8000-000000000003';

const payload = (over: Record<string, unknown> = {}): RunPayload =>
  RunPayload.parse({
    workspaceId: '00000000-0000-7000-8000-00000000a001',
    botId: '00000000-0000-7000-8000-000000000001',
    teamId: '00000000-0000-7000-8000-0000000b0001',
    channelId: CHANNEL,
    trigger: 'conversation',
    askerActorId: ASKER,
    replyRootId: THREAD,
    runThreadId: null,
    prompt: 'hello',
    ...over,
  });

interface Pushed {
  type: string;
  payload: Record<string, unknown>;
}

function rig(): { frames: LiveFrames; pushed: Pushed[]; clock: { now: number } } {
  const pushed: Pushed[] = [];
  const clock = { now: 1_000_000 };
  const tx = {
    query: async (): Promise<{ rows: Array<{ ref_id: string }> }> => ({ rows: [{ ref_id: PERSON }] }),
  };
  const ctx = {
    realtime: {
      pushToPerson: async (_tx: unknown, personId: string, type: string, body: Record<string, unknown>): Promise<void> => {
        expect(personId).toBe(PERSON);
        pushed.push({ type, payload: body });
      },
    },
  } as unknown as PluginContext;
  const job = { transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx) } as unknown as JobInfo;
  const log: PluginLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as PluginLogger;
  const frames = new LiveFrames(ctx, job, { runId: RUN, channelId: CHANNEL, threadRootId: THREAD, askerActorId: ASKER }, log, () => clock.now);
  return { frames, pushed, clock };
}

describe('LiveFrames', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the first piece at once, holds the ones that follow within 80 ms, and sends them together when the time is up', async () => {
    const { frames, pushed, clock } = rig();
    frames.text('Hel');
    await vi.advanceTimersByTimeAsync(0);
    expect(pushed.map((p) => p.payload['text'])).toEqual(['Hel']);
    clock.now += 10;
    frames.text('lo ');
    clock.now += 10;
    frames.text('there');
    await vi.advanceTimersByTimeAsync(0);
    expect(pushed).toHaveLength(1);
    clock.now += FRAME_MS;
    await vi.advanceTimersByTimeAsync(FRAME_MS);
    expect(pushed.map((p) => [p.payload['offset'], p.payload['text']])).toEqual([
      [0, 'Hel'],
      [3, 'lo there'],
    ]);
    expect(frames.full).toBe('Hello there');
  });

  it('cuts a long piece into frames of at most the frame size, each with the number of characters before it', async () => {
    const { frames, pushed } = rig();
    frames.text('x'.repeat(FRAME_CHARS * 2 + 5));
    await vi.advanceTimersByTimeAsync(0);
    expect(pushed.map((p) => [p.payload['offset'], (p.payload['text'] as string).length])).toEqual([
      [0, FRAME_CHARS],
      [FRAME_CHARS, FRAME_CHARS],
      [FRAME_CHARS * 2, 5],
    ]);
  });

  it('names what the bot is looking at with a fixed phrase, never the call’s input', async () => {
    const { frames, pushed } = rig();
    frames.looking('memory.search');
    await vi.advanceTimersByTimeAsync(0);
    expect(pushed[0]).toMatchObject({ type: 'run.looking', payload: { label: 'Searching memory', tool: 'memory.search', runId: RUN, threadRootId: THREAD } });
    expect(lookingLabel('knowledge.search')).toBe('Searching knowledge');
    expect(lookingLabel('pages.read')).toBe('Reading files');
    expect(lookingLabel('something.else')).toBe('Working on it');
  });

  it('ends with what is held, then the end, in order', async () => {
    const { frames, pushed, clock } = rig();
    frames.text('a');
    clock.now += 5;
    frames.text('b');
    await frames.end('done');
    expect(pushed.map((p) => p.type)).toEqual(['run.delta', 'run.delta', 'run.ended']);
    expect(pushed.at(-1)!.payload).toMatchObject({ status: 'done', runId: RUN });
  });
});

describe('the live registry', () => {
  it('knows a run that was told to stop, and forgets a run that ended', () => {
    const entry = trackRun(RUN, ASKER);
    expect(wasStopped(RUN)).toBe(false);
    entry.stopped = true;
    expect(wasStopped(RUN)).toBe(true);
    untrackRun(RUN);
    expect(wasStopped(RUN)).toBe(false);
  });
});

describe('streamsLive', () => {
  it('is for a person’s conversation run in a thread, and for nothing else', () => {
    expect(streamsLive(payload())).toBe(true);
    expect(streamsLive(payload({ trigger: 'mention' }))).toBe(false);
    expect(streamsLive(payload({ askerActorId: null }))).toBe(false);
    expect(streamsLive(payload({ replyRootId: null }))).toBe(false);
  });
});

const definition = (aliases: string[], fallbacks: string[] = []): LoadedDefinition =>
  ({ frontmatter: { model: { aliases, fallbacks } }, body: '', alias: aliases[0] ?? null, holdOnDetection: false, approvers: [] }) as unknown as LoadedDefinition;
const quiet: PluginLogger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as unknown as PluginLogger;

describe('applyChatAlias', () => {
  it('puts a picked alias of the definition first, keeping the others', () => {
    const def = definition(['smart', 'fast']);
    expect(applyChatAlias(def, 'fast', quiet)).toBe('fast');
    expect(def.alias).toBe('fast');
    expect(def.frontmatter.model?.aliases).toEqual(['fast', 'smart']);
  });

  it('takes an alias the definition lists as a fallback', () => {
    const def = definition(['smart'], ['fast']);
    expect(applyChatAlias(def, 'fast', quiet)).toBe('fast');
  });

  it('ignores an alias the definition does not list: the bot answers with its first', () => {
    const def = definition(['smart', 'fast']);
    expect(applyChatAlias(def, 'code', quiet)).toBe('smart');
    expect(def.frontmatter.model?.aliases).toEqual(['smart', 'fast']);
  });

  it('changes nothing when no alias was picked', () => {
    const def = definition(['smart', 'fast']);
    expect(applyChatAlias(def, undefined, quiet)).toBe('smart');
  });
});
