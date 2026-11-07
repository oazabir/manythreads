import { HttpError, type JobInfo, type PluginContext, type PluginLogger, type PluginTx } from '@manythreads/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveFrames, lookingLabel, registerStopRoute, trackRun, untrackRun } from '../src/live.ts';

// What live.test.ts leaves out (PLAN P20-16, P20-T4): the whole table of "looking at" phrases, the three ways a run ends, the frames of a person who cannot be
// reached, a push that fails, and the Stop route's four answers. The database and the socket layer are canned.

const RUN = '00000000-0000-7000-8000-0000000c0001';
const ASKER = '00000000-0000-7000-8000-0000000d0001';
const PERSON = '00000000-0000-7000-8000-0000000e0001';
const CHANNEL = '00000000-0000-7000-8000-000000000002';
const THREAD = '00000000-0000-7000-8000-000000000003';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  untrackRun(RUN);
});

describe('lookingLabel', () => {
  it('maps a tool to one fixed phrase, in the order memory, knowledge, web, search, files', () => {
    expect(lookingLabel('memory.search')).toBe('Searching memory');
    expect(lookingLabel('Memory_Recall')).toBe('Searching memory');
    expect(lookingLabel('knowledge.lookup')).toBe('Searching knowledge');
    expect(lookingLabel('web_search')).toBe('Reading the web');
    expect(lookingLabel('browse')).toBe('Reading the web');
    expect(lookingLabel('fetch_url')).toBe('Reading the web');
    expect(lookingLabel('messages.search')).toBe('Searching');
    expect(lookingLabel('repo.blob')).toBe('Reading files');
    expect(lookingLabel('file_get')).toBe('Reading files');
    expect(lookingLabel('pages.get')).toBe('Reading files');
    expect(lookingLabel('')).toBe('Working on it');
    expect(lookingLabel('answer.post')).toBe('Working on it');
  });

  it('puts memory before search, so a memory search reads as memory', () => {
    expect(lookingLabel('memory.search')).not.toBe('Searching');
    expect(lookingLabel('knowledge.search')).not.toBe('Searching');
  });
});

interface Pushed {
  type: string;
  payload: Record<string, unknown>;
}

function rig(opts: { person?: string | null; failPush?: boolean } = {}): { frames: LiveFrames; pushed: Pushed[]; warnings: string[]; lookups: { n: number }; clock: { now: number } } {
  const pushed: Pushed[] = [];
  const warnings: string[] = [];
  const lookups = { n: 0 };
  const clock = { now: 1_000_000 };
  const tx = {
    query: async (): Promise<{ rows: Array<{ ref_id: string }> }> => {
      lookups.n += 1;
      const person = opts.person === undefined ? PERSON : opts.person;
      return { rows: person === null ? [] : [{ ref_id: person }] };
    },
  };
  const ctx = {
    realtime: {
      pushToPerson: async (_tx: unknown, _personId: string, type: string, body: Record<string, unknown>): Promise<void> => {
        if (opts.failPush) throw new Error('socket layer is down');
        pushed.push({ type, payload: body });
      },
    },
  } as unknown as PluginContext;
  const job = { transaction: async <T>(fn: (t: typeof tx) => Promise<T>): Promise<T> => fn(tx) } as unknown as JobInfo;
  const log = { info: () => undefined, warn: (m: string) => warnings.push(m), error: () => undefined, debug: () => undefined } as unknown as PluginLogger;
  const frames = new LiveFrames(ctx, job, { runId: RUN, channelId: CHANNEL, threadRootId: THREAD, askerActorId: ASKER }, log, () => clock.now);
  return { frames, pushed, warnings, lookups, clock };
}

describe('LiveFrames, the ends and the edges', () => {
  it('ends as failed or stopped as it ends as done', async () => {
    for (const status of ['done', 'failed', 'stopped'] as const) {
      const { frames, pushed } = rig();
      await frames.end(status);
      expect(pushed).toEqual([{ type: 'run.ended', payload: { runId: RUN, channelId: CHANNEL, threadRootId: THREAD, status } }]);
    }
  });

  it('sends only the end when nothing was written, and keeps everything written in `full`', async () => {
    const { frames, pushed } = rig();
    frames.text('');
    expect(frames.full).toBe('');
    frames.text('Hello ');
    frames.text('world');
    expect(frames.full).toBe('Hello world');
    await frames.end('done');
    expect(pushed.map((p) => p.type)).toEqual(['run.delta', 'run.delta', 'run.ended']);
    const { frames: empty, pushed: none } = rig();
    await empty.end('done');
    expect(none.map((p) => p.type)).toEqual(['run.ended']);
  });

  it('numbers the frames by the characters before them, across pieces', async () => {
    const { frames, pushed, clock } = rig();
    frames.text('abc');
    clock.now += 100;
    frames.text('de');
    await frames.end('done');
    expect(pushed.filter((p) => p.type === 'run.delta').map((p) => [p.payload['offset'], p.payload['text']])).toEqual([
      [0, 'abc'],
      [3, 'de'],
    ]);
  });

  it('keeps only 80 characters of a tool’s name in the frame', async () => {
    const { frames, pushed } = rig();
    frames.looking(`memory.${'x'.repeat(200)}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(String(pushed[0]?.payload['tool'])).toHaveLength(80);
    expect(pushed[0]?.payload['label']).toBe('Searching memory');
  });

  it('sends nothing to an asker who is not a person (a bot’s run), and does not fail', async () => {
    const { frames, pushed } = rig({ person: null });
    frames.text('hello');
    frames.looking('memory.search');
    await expect(frames.end('done')).resolves.toBeUndefined();
    expect(pushed).toEqual([]);
  });

  it('looks the person up once for all the frames of a run', async () => {
    const { frames, lookups, clock } = rig();
    frames.text('a');
    clock.now += 100;
    frames.text('b');
    frames.looking('memory.search');
    await frames.end('done');
    expect(lookups.n).toBe(1);
  });

  it('drops a frame that cannot be pushed, says so once, and still finishes', async () => {
    const { frames, pushed, warnings, clock } = rig({ failPush: true });
    frames.text('a');
    clock.now += 100;
    frames.text('b');
    frames.looking('memory.search');
    await expect(frames.end('done')).resolves.toBeUndefined();
    expect(pushed).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('socket layer is down');
    expect(warnings[0]).toContain(RUN);
  });
});

interface Route {
  handler: (req: { params: unknown }, tx: PluginTx) => Promise<{ status?: number; body?: unknown }>;
  rateLimit?: { limit: number; windowMs: number };
}

function stopRoute(): Route {
  let found: Route | null = null;
  const ctx = { http: { route: (r: Route) => { found = r; } } } as unknown as PluginContext;
  registerStopRoute(ctx);
  return found as unknown as Route;
}

const txOf = (rows: Array<{ status: string }>): PluginTx => ({ query: async () => ({ rows }) }) as unknown as PluginTx;

describe('POST /api/runs/:runId/stop', () => {
  it('is rate limited', () => {
    expect(stopRoute().rateLimit).toEqual({ limit: 60, windowMs: 60_000 });
  });

  it('is a 404 for a run the caller did not ask, a run that does not exist and a run of nobody: all one answer', async () => {
    const route = stopRoute();
    await expect(route.handler({ params: { runId: RUN } }, txOf([]))).rejects.toMatchObject({ status: 404 });
    await expect(route.handler({ params: { runId: RUN } }, txOf([]))).rejects.toBeInstanceOf(HttpError);
  });

  it('refuses an id that is not a run id before it asks the database', async () => {
    const route = stopRoute();
    const query = vi.fn();
    await expect(route.handler({ params: { runId: 'not-an-id' } }, { query } as unknown as PluginTx)).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it('says nothing was stopped for a run that is no longer running', async () => {
    const route = stopRoute();
    const res = await route.handler({ params: { runId: RUN } }, txOf([{ status: 'succeeded' }]));
    expect(JSON.stringify(res.body ?? res)).toContain('"stopped":false');
  });

  it('stops a running run this process holds, and says false when another process holds it', async () => {
    const route = stopRoute();
    const stop = vi.fn(async () => undefined);
    const entry = trackRun(RUN, ASKER);
    entry.handle = { stop, events: (async function* () {})() } as never;
    const held = await route.handler({ params: { runId: RUN } }, txOf([{ status: 'running' }]));
    expect(JSON.stringify(held.body ?? held)).toContain('"stopped":true');
    expect(stop).toHaveBeenCalledTimes(1);
    untrackRun(RUN);
    const elsewhere = await route.handler({ params: { runId: RUN } }, txOf([{ status: 'running' }]));
    expect(JSON.stringify(elsewhere.body ?? elsewhere)).toContain('"stopped":false');
  });

  it('answers 500 with a plain sentence when the process will not stop', async () => {
    const route = stopRoute();
    const entry = trackRun(RUN, ASKER);
    entry.handle = { stop: async () => { throw new Error('kill failed'); }, events: (async function* () {})() } as never;
    await expect(route.handler({ params: { runId: RUN } }, txOf([{ status: 'running' }]))).rejects.toMatchObject({ status: 500, message: expect.stringContaining('could not be stopped') as unknown as string });
  });
});
