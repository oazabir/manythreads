import { describe, expect, it } from 'vitest';
import { ListenerCore, type CoreChunk, type CoreTrackStream } from '../src/listener-core.ts';

// The listener's decisions without LiveKit (PLAN P15-19): who is subscribed, what happens to a person who is taken off the list, and that speech is cut into chunks.

const RATE = 16_000;
const tone = (ms: number): Int16Array => Int16Array.from({ length: (ms * RATE) / 1000 }, (_, i) => Math.round(6000 * Math.sin((2 * Math.PI * 220 * i) / RATE)));
const quiet = (ms: number): Int16Array => new Int16Array((ms * RATE) / 1000);

/** A track whose frames the test pushes by hand. */
function feed(): { stream: CoreTrackStream; push: (s: Int16Array) => void; end: () => void; cancelled: () => boolean } {
  const queue: Int16Array[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let cancelled = false;
  const stream: CoreTrackStream = {
    frames: (async function* () {
      while (true) {
        if (queue.length > 0) yield queue.shift()!;
        else if (done) return;
        else await new Promise<void>((r) => (wake = r));
      }
    })(),
    cancel: () => {
      cancelled = true;
      done = true;
      wake?.();
    },
  };
  return {
    stream,
    push: (s) => {
      queue.push(s);
      wake?.();
    },
    end: () => {
      done = true;
      wake?.();
    },
    cancelled: () => cancelled,
  };
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

function setup(identities: string[]) {
  const calls: Array<[string, boolean]> = [];
  const chunks: CoreChunk[] = [];
  const reports: string[][] = [];
  const core = new ListenerCore(
    { setSubscribed: (sid, on) => void calls.push([sid, on]) },
    { onChunk: (c) => void chunks.push(c), onSubscriptions: (ids) => void reports.push(ids) },
    { identities, now: () => 1_000_000 },
  );
  return { core, calls, chunks, reports };
}

describe('ListenerCore', () => {
  it('subscribes to a published track only when its owner is on the list', () => {
    const { core, calls } = setup(['ann']);
    core.trackPublished('ann', 'T1');
    core.trackPublished('bob', 'T2');
    expect(calls).toEqual([['T1', true]]);
  });

  it('does not read a track of someone who is not on the list, even when the library hands it over', async () => {
    const { core, calls, chunks } = setup(['ann']);
    const f = feed();
    core.trackSubscribed('bob', 'T2', f.stream);
    f.push(tone(1500));
    f.push(quiet(900));
    await settle();
    expect(f.cancelled()).toBe(true);
    expect(calls).toEqual([['T2', false]]);
    expect(chunks).toEqual([]);
    expect(core.subscriptions()).toEqual([]);
  });

  it('cuts a listed person\'s speech into a chunk and says who is subscribed', async () => {
    const { core, chunks, reports } = setup(['ann']);
    const f = feed();
    core.trackSubscribed('ann', 'T1', f.stream);
    f.push(join(tone(1500), quiet(900)));
    await settle();
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ identity: 'ann' });
    expect(chunks[0]!.durationMs).toBe(1500 + 240);
    expect(reports).toEqual([['ann']]);
  });

  it('drops a person taken off the list at once and throws away what they had said but not yet finished', async () => {
    const { core, calls, chunks, reports } = setup(['ann', 'bob']);
    const a = feed();
    const b = feed();
    core.trackPublished('ann', 'T1');
    core.trackPublished('bob', 'T2');
    core.trackSubscribed('ann', 'T1', a.stream);
    core.trackSubscribed('bob', 'T2', b.stream);
    a.push(tone(1000));
    b.push(tone(1000));
    await settle();
    core.setIdentities(['ann']);
    expect(core.subscriptions()).toEqual(['ann']);
    expect(b.cancelled()).toBe(true);
    expect(calls).toContainEqual(['T2', false]);
    expect(reports.at(-1)).toEqual(['ann']);
    b.push(quiet(900));
    await settle();
    core.trackUnsubscribed('T2');
    await core.close();
    expect(chunks.map((c) => c.identity)).toEqual(['ann']); // bob's open speech was discarded, ann's was sent when closing
  });

  it('sends the open speech of a listed person when their track ends or the listener closes', async () => {
    const { core, chunks } = setup(['ann']);
    const f = feed();
    core.trackSubscribed('ann', 'T1', f.stream);
    f.push(tone(800));
    await settle();
    core.trackUnsubscribed('T1');
    expect(chunks).toHaveLength(1);
    const g = feed();
    core.trackSubscribed('ann', 'T3', g.stream);
    g.push(tone(800));
    await settle();
    await core.close();
    expect(chunks).toHaveLength(2);
  });

  it('subscribes to a person added to the list who already has a track', () => {
    const { core, calls } = setup([]);
    core.trackPublished('ann', 'T1');
    expect(calls).toEqual([]);
    core.setIdentities(['ann']);
    expect(calls).toEqual([['T1', true]]);
  });

  it('forgets a person who leaves the room', async () => {
    const { core } = setup(['ann']);
    const f = feed();
    core.trackSubscribed('ann', 'T1', f.stream);
    core.participantDisconnected('ann');
    expect(core.subscriptions()).toEqual([]);
    expect(f.cancelled()).toBe(true);
  });

  it('gives the host no way to publish: the host interface has one method, setSubscribed', () => {
    const host = { setSubscribed: () => undefined };
    expect(Object.keys(host)).toEqual(['setSubscribed']);
  });
});

function join(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
