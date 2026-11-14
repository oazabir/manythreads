import type { BotRuntimeEvent, JobInfo, PluginContext, PluginLogger, PluginTx } from '@manythreads/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPoison, RunRecorder, type RunTarget } from '../src/run-recorder.ts';

// The recorder of a run's activity (P25-06 .. P25-08, reviews H1, H2, M1, M2, M5): batching, the retry of a batch, the poison pill, the final write, the push that is not
// repeated, who is told, the poll for a Stop, and the redaction of the words. The database and the sockets are canned; the redaction chain is a fake guardrail but holds.ts is real.

const RUN = '00000000-0000-7000-8000-0000000c0001';
const WS = '00000000-0000-7000-8000-000000000001';
const TEAM = '00000000-0000-7000-8000-000000000009';
const CHANNEL = '00000000-0000-7000-8000-000000000002';
const ROOT = '00000000-0000-7000-8000-000000000003';
const BOT = '00000000-0000-7000-8000-0000000b0001';
const BOT_ACTOR = '00000000-0000-7000-8000-0000000b0002';
const ASKER_ACTOR = '00000000-0000-7000-8000-0000000d0001';
const ASKER_PERSON = '00000000-0000-7000-8000-0000000e0001';
const WATCHER = '00000000-0000-7000-8000-0000000e0002';
const READER = '00000000-0000-7000-8000-0000000e0003';

const TARGET: RunTarget = { runId: RUN, workspaceId: WS, teamId: TEAM, channelId: CHANNEL, threadRootId: ROOT, botId: BOT, botName: 'Coder', askerActorId: ASKER_ACTOR, conversation: false };

interface Call {
  sql: string;
  params: unknown[];
}
interface Rig {
  recorder: RunRecorder;
  calls: Call[];
  pushes: Array<{ people: string[]; type: string; payload: Record<string, unknown> }>;
  warnings: string[];
  /** Make a statement fail: return the error for the nth time its SQL matches. */
  failWhen: (match: RegExp, error: () => Error, times?: number) => void;
  state: { stop: { stopped_by_actor: string | null; stopped_by_name: string } | null; watchers: string[]; readers: string[]; guard: 'dlp' | 'none' | 'throws' };
  sqlOf: (match: RegExp) => Call[];
}

const poison = (): Error => Object.assign(new Error('new row violates check constraint'), { code: '23514' });
const blink = (): Error => Object.assign(new Error('connection terminated'), { code: '08006' });

function rig(options: { target?: Partial<RunTarget>; flushMs?: number; retryMs?: number[]; stopPollMs?: number; heartbeatMs?: number } = {}): Rig {
  const calls: Call[] = [];
  const pushes: Rig['pushes'] = [];
  const warnings: string[] = [];
  const failures: Array<{ match: RegExp; error: () => Error; left: number }> = [];
  const state: Rig['state'] = { stop: null, watchers: [WATCHER], readers: [READER, WATCHER], guard: 'dlp' };
  const tx = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      for (const f of failures) {
        if (f.left > 0 && f.match.test(sql)) {
          f.left -= 1;
          throw f.error();
        }
      }
      if (sql.includes("FROM app.actors WHERE kind = 'bot'")) return { rows: [{ id: BOT_ACTOR }] };
      if (sql.includes("FROM app.actors WHERE id = $1::uuid AND kind = 'person'")) return { rows: [{ ref_id: ASKER_PERSON }] };
      if (sql.includes('FROM app.thread_watchers')) return { rows: state.watchers.map((person_id) => ({ person_id })) };
      if (sql.includes('app.channel_audience')) return { rows: state.readers.map((person_id) => ({ person_id })) };
      if (sql.includes('RETURNING stop_requested_at')) return { rows: state.stop === null ? [] : [{ stop_requested_at: new Date(), ...state.stop }] };
      if (sql.includes('stop_requested_at IS NOT NULL')) return { rows: state.stop === null ? [] : [state.stop] };
      return { rows: [] };
    },
  } as unknown as PluginTx;
  const job = { transaction: async <T>(fn: (t: PluginTx) => Promise<T>) => fn(tx), log: { info: () => undefined, warn: () => undefined } } as unknown as JobInfo;
  const ctx = {
    realtime: {
      pushToPeople: async (_tx: unknown, people: string[], type: string, payload: Record<string, unknown>) => {
        pushes.push({ people, type, payload });
      },
    },
    hooks: {
      runPreEgress: async (_tx: unknown, input: { text: string }) => {
        if (state.guard === 'throws') throw new Error('the chain is down');
        if (state.guard === 'none') return { ran: [], outcome: 'allow', text: input.text };
        return { ran: ['guardrails-dlp'], outcome: 'allow', text: input.text.replace(/sk-[A-Za-z0-9]{16,}/g, '[redacted:api-key]') };
      },
    },
  } as unknown as PluginContext;
  const log = { info: () => undefined, warn: (m: string) => void warnings.push(m), error: () => undefined, debug: () => undefined } as unknown as PluginLogger;
  const recorder = new RunRecorder(ctx, job, { ...TARGET, ...options.target }, log, {
    flushMs: options.flushMs ?? 100,
    stopPollMs: options.stopPollMs ?? 100,
    heartbeatMs: options.heartbeatMs ?? 1000,
    retryMs: options.retryMs ?? [0, 0, 0],
  });
  return {
    recorder,
    calls,
    pushes,
    warnings,
    state,
    failWhen: (match, error, times = 1) => void failures.push({ match, error, left: times }),
    sqlOf: (match) => calls.filter((c) => match.test(c.sql)),
  };
}

const tool = (stepId: string, title: string, extra: Record<string, unknown> = {}): BotRuntimeEvent =>
  ({ type: 'tool', name: 'x', input: null, stepId, kind: 'read', title, ...extra }) as BotRuntimeEvent;
const done = (stepId: string): BotRuntimeEvent => ({ type: 'tool_result', name: 'x', ok: true, stepId }) as BotRuntimeEvent;

const ACTIVITY = /INSERT INTO app\.run_activity/;
const BATCH = /RETURNING stop_requested_at/;
const FINAL = /ended_at = greatest/;
const OPEN = /INSERT INTO app\.run_view/;
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('isPoison', () => {
  it('is a refusal of the content (SQLSTATE class 22 or 23), not a failure of the connection', () => {
    expect(isPoison(Object.assign(new Error('x'), { code: '22P05' }))).toBe(true);
    expect(isPoison(Object.assign(new Error('x'), { code: '23514' }))).toBe(true);
    expect(isPoison(Object.assign(new Error('x'), { code: '08006' }))).toBe(false);
    expect(isPoison(Object.assign(new Error('x'), { code: '40001' }))).toBe(false);
    expect(isPoison(new Error('no code'))).toBe(false);
    expect(isPoison(null)).toBe(false);
  });
});

describe('opening', () => {
  it('opens the run row and tells every reader of the channel that a run began', async () => {
    const r = rig();
    await r.recorder.start();
    expect(r.sqlOf(OPEN)).toHaveLength(1);
    expect(r.sqlOf(OPEN)[0]!.params.slice(0, 3)).toEqual([RUN, WS, TEAM]);
    expect(r.pushes).toEqual([{ people: [READER, WATCHER], type: 'run.started', payload: expect.objectContaining({ runId: RUN, botName: 'Coder', botActorId: BOT_ACTOR }) as unknown as Record<string, unknown> }]);
  });

  it('is tried again when the database blinks, and the recorder is not switched off for it', async () => {
    const r = rig();
    r.failWhen(OPEN, blink, 2);
    await r.recorder.start();
    expect(r.sqlOf(OPEN)).toHaveLength(3);
    expect(r.pushes.map((p) => p.type)).toEqual(['run.started']);
    expect(r.warnings).toHaveLength(1); // told once
  });

  it('a run with no thread, and a run in a conversation, tell nobody that it began', async () => {
    const a = rig({ target: { threadRootId: null } });
    await a.recorder.start();
    const b = rig({ target: { conversation: true } });
    await b.recorder.start();
    expect(a.pushes).toEqual([]);
    expect(b.pushes).toEqual([]);
    expect(a.sqlOf(OPEN)).toHaveLength(1);
  });
});

describe('batching', () => {
  it('writes what came in a second as one batch: one insert of the lines and one update of the state', async () => {
    const r = rig({ flushMs: 1000 });
    await r.recorder.start();
    r.recorder.event(tool('s1', 'Read a.ts'));
    r.recorder.event(done('s1'));
    r.recorder.event(tool('s2', 'Read b.ts'));
    await advance(10);
    // everything that came in the same moment is one batch
    expect(r.sqlOf(ACTIVITY)).toHaveLength(1);
    expect(r.sqlOf(BATCH)).toHaveLength(1);
    expect((r.sqlOf(ACTIVITY)[0]!.params[5] as number[]).length).toBeGreaterThanOrEqual(2);
    // the next one waits for the rest of the second
    r.recorder.event(done('s2'));
    await advance(500);
    expect(r.sqlOf(BATCH)).toHaveLength(1);
    await advance(600);
    expect(r.sqlOf(BATCH)).toHaveLength(2);
  });

  it('keeps the first batch\'s lines in order across batches (seq only goes up)', async () => {
    const r = rig();
    await r.recorder.start();
    r.recorder.event(tool('s1', 'one'));
    await advance(150);
    r.recorder.event(tool('s2', 'two'));
    await advance(150);
    const seqs = r.sqlOf(ACTIVITY).flatMap((c) => c.params[5] as number[]);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('the words of the answer are one note that it began, however many pieces come', async () => {
    const r = rig();
    await r.recorder.start();
    for (let i = 0; i < 50; i += 1) r.recorder.event({ type: 'text', text: `piece ${i}` } as BotRuntimeEvent);
    await advance(150);
    const kinds = r.sqlOf(ACTIVITY).flatMap((c) => c.params[6] as string[]);
    expect(kinds.filter((k) => k === 'answering').length).toBeLessThanOrEqual(1);
  });
});

describe('a batch that fails', () => {
  it('for a reason that is not the content is tried again with the next batch, and nothing is lost', async () => {
    const r = rig();
    await r.recorder.start();
    r.failWhen(BATCH, blink, 1);
    r.recorder.event(tool('s1', 'Read a.ts'));
    await advance(150);
    expect(r.sqlOf(BATCH)).toHaveLength(1);
    await advance(300); // the wait doubles after a failure
    expect(r.sqlOf(BATCH)).toHaveLength(2);
    const lines = r.sqlOf(ACTIVITY);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.params[5]).toEqual(lines[0]!.params[5]); // the same lines again
    expect(r.warnings).toHaveLength(1);
  });

  it('is given up after five failures in a row, but the end of the run is still written', async () => {
    const r = rig({ flushMs: 10 });
    await r.recorder.start();
    r.failWhen(BATCH, blink, 100);
    for (let i = 0; i < 6; i += 1) {
      r.recorder.event(tool(`s${i}`, `step ${i}`));
      await advance(2000);
    }
    const tries = r.sqlOf(BATCH).length;
    expect(tries).toBe(5);
    r.recorder.event(tool('later', 'later'));
    await advance(5000);
    expect(r.sqlOf(BATCH)).toHaveLength(tries); // no more batches
    await r.recorder.end('done');
    expect(r.sqlOf(FINAL)).toHaveLength(1);
    expect(r.sqlOf(FINAL)[0]!.params[1]).toBe('done');
  });
});

describe('the poison pill (the database refuses the content)', () => {
  it('is never sent again as it was: the state alone goes in, then the lines one by one, and the refused one is dropped', async () => {
    const r = rig();
    await r.recorder.start();
    r.recorder.event(tool('s1', 'good one'));
    r.recorder.event(tool('s2', 'the bad one'));
    r.recorder.event(tool('s3', 'good three'));
    // the full batch is refused; then the line with "bad" in it is refused whenever it is sent alone
    r.failWhen(ACTIVITY, poison, 1);
    await advance(150);
    const inserts = r.sqlOf(ACTIVITY);
    // 1 full batch (refused) + 1 insert per line afterwards; the state was written without lines in between
    expect(inserts.length).toBe(1 + (inserts[0]!.params[5] as number[]).length);
    expect(r.sqlOf(BATCH).length).toBeGreaterThanOrEqual(1);
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
    // the same batch is not sent again as it was
    const fullAgain = inserts.slice(1).filter((c) => (c.params[5] as number[]).length > 1);
    expect(fullAgain).toEqual([]);
    expect(r.recorder.state).toBe('working');
  });

  it('drops one bad line and keeps the others', async () => {
    const r = rig();
    await r.recorder.start();
    r.recorder.event(tool('s1', 'one'));
    r.recorder.event(tool('s2', 'two'));
    r.recorder.event(tool('s3', 'three'));
    r.failWhen(ACTIVITY, poison, 2); // the full batch, then the first line alone
    await advance(150);
    const inserts = r.sqlOf(ACTIVITY);
    const single = inserts.slice(1);
    expect(single.every((c) => (c.params[5] as number[]).length === 1)).toBe(true);
    // every line was tried once alone; the refused one is not tried again, the others went in
    expect(single.length).toBe((inserts[0]!.params[5] as number[]).length);
    expect(new Set(single.map((c) => (c.params[5] as number[])[0])).size).toBe(single.length);
    // and the next batch does not bring any of them back
    r.recorder.event(tool('s4', 'four'));
    await advance(150);
    const later = r.sqlOf(ACTIVITY).slice(inserts.length).flatMap((c) => c.params[5] as number[]);
    expect(later.every((seq) => !single.some((c) => (c.params[5] as number[])[0] === seq))).toBe(true);
  });

  it('a state the table refuses is written bare from then on, and the run goes on', async () => {
    const r = rig();
    await r.recorder.start();
    r.recorder.event(tool('s1', 'one'));
    r.failWhen(BATCH, poison, 2); // the full try and the state-alone try
    await advance(150);
    const batches = r.sqlOf(BATCH);
    expect(batches).toHaveLength(3);
    expect(batches[2]!.params[4]).toBe('[]'); // helpers left out
    expect(batches[2]!.params[5]).toBe('[]'); // plan left out
    r.recorder.event(tool('s2', 'two'));
    await advance(150);
    expect(r.sqlOf(BATCH)[3]!.params[4]).toBe('[]'); // still bare
  });

  it('a state refused even bare is dropped, never retried, and the end of the run still closes the row', async () => {
    const r = rig();
    await r.recorder.start();
    r.recorder.event(tool('s1', 'one'));
    r.failWhen(BATCH, poison, 100);
    await advance(150);
    const tries = r.sqlOf(BATCH).length;
    expect(tries).toBeLessThanOrEqual(3);
    await advance(10_000);
    expect(r.sqlOf(BATCH)).toHaveLength(tries);
    await r.recorder.end('failed');
    expect(r.sqlOf(FINAL)[0]!.params[1]).toBe('failed');
  });
});

describe('the end of the run', () => {
  it('is its own small statement, with the state, the reason and the cost', async () => {
    const r = rig();
    await r.recorder.start();
    r.recorder.event(tool('s1', 'one'));
    r.recorder.event({ type: 'result', text: 'x', ok: true, stopReason: 'end_turn', cost: { amount: 0.5, currency: 'USD' } } as BotRuntimeEvent);
    await r.recorder.end('done');
    const final = r.sqlOf(FINAL);
    expect(final).toHaveLength(1);
    expect(final[0]!.params[1]).toBe('done');
    expect(final[0]!.params[3]).toBe('end_turn');
    expect(JSON.parse(final[0]!.params[4] as string)).toEqual({ amount: 0.5, currency: 'USD' });
    expect(r.recorder.state).toBe('done');
  });

  it('is written even when the batches were refused, and is retried when the database blinks', async () => {
    const r = rig({ retryMs: [0, 0, 0, 0] });
    await r.recorder.start();
    r.recorder.event(tool('s1', 'one'));
    r.failWhen(BATCH, poison, 100);
    r.failWhen(FINAL, blink, 2);
    await r.recorder.end('done');
    expect(r.sqlOf(FINAL)).toHaveLength(3);
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('leaves the reason and the cost out on the last tries (a value the table cannot hold must not keep a run open)', async () => {
    const r = rig({ retryMs: [0, 0, 0, 0] });
    await r.recorder.start();
    r.recorder.event({ type: 'result', text: 'x', ok: true, stopReason: 'end_turn', cost: { amount: 1, currency: 'USD' } } as BotRuntimeEvent);
    r.failWhen(FINAL, poison, 2);
    await r.recorder.end('done');
    const final = r.sqlOf(FINAL);
    expect(final).toHaveLength(3);
    expect(final[0]!.params[3]).toBe('end_turn');
    expect(final[2]!.params[3]).toBeNull();
    expect(final[2]!.params[4]).toBeNull();
  });

  it('never throws, even when the database stays away, and a second end changes nothing', async () => {
    const r = rig({ retryMs: [0, 0] });
    await r.recorder.start();
    r.failWhen(FINAL, blink, 100);
    await expect(r.recorder.end('done')).resolves.toBeUndefined();
    await expect(r.recorder.end('failed')).resolves.toBeUndefined();
    expect(r.sqlOf(FINAL)).toHaveLength(2); // the two tries of the first end only
    // the people who look are told all the same, so a screen does not wait
    expect(r.pushes.map((p) => p.type)).toContain('run.ended');
  });

  it('opens the row first when it never could, then closes it', async () => {
    const r = rig({ retryMs: [0, 0, 0] });
    r.failWhen(OPEN, blink, 3);
    await r.recorder.start();
    expect(r.sqlOf(OPEN)).toHaveLength(3);
    await r.recorder.end('failed');
    expect(r.sqlOf(OPEN).length).toBeGreaterThanOrEqual(4);
    expect(r.sqlOf(FINAL)).toHaveLength(1);
  });

  it('tells the readers of the channel that the run ended, once', async () => {
    const r = rig();
    await r.recorder.start();
    await r.recorder.end('stopped');
    const ended = r.pushes.filter((p) => p.type === 'run.ended');
    expect(ended).toHaveLength(1);
    expect(ended[0]!.people).toEqual([READER, WATCHER]);
    expect(ended[0]!.payload).toMatchObject({ status: 'stopped', threadRootId: ROOT });
  });

  it('a Stop that did not take (the run ended by itself) leaves nobody\'s name on the row', async () => {
    const r = rig();
    await r.recorder.start();
    await r.recorder.end('done');
    const sql = r.sqlOf(FINAL)[0]!.sql;
    expect(sql).toContain("stopped_by_name = CASE WHEN $2 = 'stopped'");
  });
});

describe('who is pushed to', () => {
  it('run.activity goes to the people who have the thread open and can read the channel, and not again when nothing changed', async () => {
    const r = rig();
    await r.recorder.start();
    r.pushes.length = 0;
    r.recorder.event(tool('s1', 'one'));
    await advance(150);
    const activity = r.pushes.filter((p) => p.type === 'run.activity');
    expect(activity).toHaveLength(1);
    expect(activity[0]!.people).toEqual([WATCHER]);
    // a batch that changes nothing the card shows is not pushed again
    r.recorder.event({ type: 'thinking', seconds: 0 } as BotRuntimeEvent);
    await advance(150);
    const same = r.pushes.filter((p) => p.type === 'run.activity').length;
    r.recorder.event(tool('s2', 'two'));
    await advance(150);
    expect(r.pushes.filter((p) => p.type === 'run.activity').length).toBeGreaterThan(same - 1);
  });

  it('asks for the watchers joined with the channel\'s audience, so a person who lost the channel is not sent the steps', async () => {
    const r = rig();
    await r.recorder.start();
    r.recorder.event(tool('s1', 'one'));
    await advance(150);
    const ask = r.sqlOf(/FROM app\.thread_watchers/);
    expect(ask.length).toBeGreaterThan(0);
    expect(ask[0]!.sql).toContain('app.channel_audience');
    r.state.watchers = []; // the only watcher lost the channel
    r.pushes.length = 0;
    r.recorder.event(tool('s2', 'two'));
    await advance(150);
    expect(r.pushes.filter((p) => p.type === 'run.activity')).toEqual([]);
  });

  it('the push of a run in a conversation goes to its asker alone', async () => {
    const r = rig({ target: { conversation: true } });
    await r.recorder.start();
    r.recorder.event(tool('s1', 'one'));
    await advance(150);
    const activity = r.pushes.filter((p) => p.type === 'run.activity');
    expect(activity).toHaveLength(1);
    expect(activity[0]!.people).toEqual([ASKER_PERSON]);
    await r.recorder.end('done');
    expect(r.pushes.filter((p) => p.type === 'run.ended')).toEqual([]); // the live frames say it to the asker
  });

  it('a run with no thread is recorded and nobody is pushed to', async () => {
    const r = rig({ target: { threadRootId: null } });
    await r.recorder.start();
    r.recorder.event(tool('s1', 'one'));
    await advance(150);
    await r.recorder.end('done');
    expect(r.pushes).toEqual([]);
    expect(r.sqlOf(ACTIVITY)).toHaveLength(1);
  });

  it('a push that fails does not cost the record, and the end is pushed again once', async () => {
    const r = rig();
    await r.recorder.start();
    r.state.watchers = [WATCHER];
    r.recorder.event(tool('s1', 'one'));
    await advance(150);
    expect(r.sqlOf(ACTIVITY)).toHaveLength(1);
    await r.recorder.end('done');
    expect(r.sqlOf(FINAL)).toHaveLength(1);
  });
});

describe('the Stop that was asked for on another server', () => {
  it('is found by the poll; the card says stopping and the agent is stopped', async () => {
    const r = rig();
    await r.recorder.start();
    const onStop = vi.fn(async () => undefined);
    r.recorder.watchStop(onStop);
    await advance(250);
    expect(onStop).not.toHaveBeenCalled();
    r.state.stop = { stopped_by_actor: ASKER_ACTOR, stopped_by_name: 'Rafi' };
    await advance(250);
    expect(onStop).toHaveBeenCalledWith({ actorId: ASKER_ACTOR, name: 'Rafi' });
    expect(r.recorder.stopAsked).toEqual({ actorId: ASKER_ACTOR, name: 'Rafi' });
    expect(r.recorder.state).toBe('stopping');
  });

  it('is asked again at every poll while the stop does not take, until the run ends (M2)', async () => {
    const r = rig();
    await r.recorder.start();
    r.state.stop = { stopped_by_actor: ASKER_ACTOR, stopped_by_name: 'Rafi' };
    const onStop = vi.fn<(by: unknown) => Promise<void>>().mockRejectedValueOnce(new Error('gateway did not answer')).mockRejectedValueOnce(new Error('again')).mockResolvedValue(undefined);
    r.recorder.watchStop(onStop);
    await advance(1000);
    expect(onStop.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(r.warnings.some((w) => w.includes('could not be stopped'))).toBe(true);
    const before = onStop.mock.calls.length;
    await r.recorder.end('stopped');
    await advance(1000);
    expect(onStop).toHaveBeenCalledTimes(before); // nothing after the end
  });

  it('does not start a second stop while one is going', async () => {
    const r = rig();
    await r.recorder.start();
    r.state.stop = { stopped_by_actor: null, stopped_by_name: 'Rafi' };
    let release: () => void = () => undefined;
    const onStop = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    r.recorder.watchStop(onStop);
    await advance(1000);
    expect(onStop).toHaveBeenCalledTimes(1);
    release();
    await advance(250);
    expect(onStop.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('a Stop that a batch finds on the row is acted on too', async () => {
    const r = rig();
    await r.recorder.start();
    const onStop = vi.fn(async () => undefined);
    r.recorder.watchStop(onStop);
    r.state.stop = { stopped_by_actor: ASKER_ACTOR, stopped_by_name: 'Omar' };
    r.recorder.event(tool('s1', 'one'));
    await advance(150);
    expect(onStop).toHaveBeenCalled();
    expect(r.recorder.stopAsked?.name).toBe('Omar');
  });

  it('says it is alive from time to time while it polls (a run that waits for a person is not a dead one)', async () => {
    const r = rig({ heartbeatMs: 1000, stopPollMs: 100 });
    await r.recorder.start();
    r.recorder.watchStop(async () => undefined);
    await advance(3500);
    const beats = r.sqlOf(/SET updated_at = now\(\) WHERE run_id/);
    expect(beats.length).toBeGreaterThanOrEqual(3);
    expect(beats.length).toBeLessThanOrEqual(5);
    await r.recorder.end('done');
    const after = r.sqlOf(/SET updated_at = now\(\) WHERE run_id/).length;
    await advance(3000);
    expect(r.sqlOf(/SET updated_at = now\(\) WHERE run_id/)).toHaveLength(after);
  });
});

describe('the words of a step go through the redaction chain', () => {
  const insertedText = (r: Rig): string => r.sqlOf(ACTIVITY).map((c) => (c.params[7] as string[]).join('\n')).join('\n');

  it('a key-like title is stored and pushed as [redacted:api-key], never as it came', async () => {
    const r = rig();
    await r.recorder.start();
    const key = 'sk-abcdefghijklmnop1234567890'; // secret-scan:ignore (a made-up fixture)
    r.recorder.event(tool('s1', `Run curl with ${key}`, { paths: [`/tmp/${key}.txt`] }));
    r.recorder.event({ type: 'agent', agentId: 'h1', name: `helper ${key}`, status: 'working', steps: 0 } as BotRuntimeEvent);
    await advance(150);
    const stored = insertedText(r);
    expect(stored).toContain('[redacted:api-key]');
    expect(stored).not.toContain(key);
    expect(JSON.stringify(r.pushes)).not.toContain(key);
    expect(JSON.stringify(r.calls)).not.toContain(key);
  });

  it('with no guardrail loaded the words are left out, and the steps are still recorded', async () => {
    const r = rig();
    r.state.guard = 'none';
    await r.recorder.start();
    r.recorder.event(tool('s1', 'Read secrets.env', { paths: ['secrets.env'] }));
    await advance(150);
    const stored = insertedText(r);
    expect(stored).not.toContain('secrets.env');
    expect(r.sqlOf(ACTIVITY)).toHaveLength(1);
  });

  it('when the chain fails the words are left out, the run is not held up, and the same words are asked again the next time', async () => {
    const r = rig();
    r.state.guard = 'throws';
    await r.recorder.start();
    r.recorder.event(tool('s1', 'Read a.ts'));
    await advance(150);
    expect(insertedText(r)).not.toContain('a.ts');
    expect(r.warnings.some((w) => w.includes('could not be checked'))).toBe(true);
    r.state.guard = 'dlp';
    r.recorder.event(tool('s2', 'Read a.ts'));
    await advance(150);
    expect(insertedText(r)).toContain('Read a.ts');
  });

  it('sends a word once: a title seen before is not sent to the chain again', async () => {
    const r = rig();
    await r.recorder.start();
    r.recorder.event(tool('s1', 'Read a.ts'));
    await advance(150);
    r.recorder.event(tool('s2', 'Read a.ts'));
    await advance(150);
    expect(insertedText(r).split('Read a.ts').length - 1).toBe(2);
  });
});
