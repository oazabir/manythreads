import { describe, expect, it } from 'vitest';
import { checkLabel, evaluate, describeTransition, formatValue, type StateMap, type Transition } from '../src/evaluate.ts';
import { at, healthy, thresholds } from './fixtures.ts';

/** Runs the watcher over a series of snapshots, one a minute, carrying the state forward. */
function run(series: Array<ReturnType<typeof healthy>>, rounds = 3, t = thresholds) {
  let state: StateMap = {};
  const all: Array<{ minute: number; transitions: Transition[]; breached: string[] }> = [];
  series.forEach((snapshot, minute) => {
    const r = evaluate(snapshot, t, state, at(minute), rounds);
    state = r.next;
    all.push({ minute, transitions: r.transitions, breached: r.checks.filter((c) => c.breached).map((c) => c.name) });
  });
  return all;
}

const lag = (seconds: number) => healthy({ outbox: { backlog: 5, retrying: 0, oldestAgeSeconds: seconds } });

describe('evaluate: a healthy system', () => {
  it('trips nothing', () => {
    const r = evaluate(healthy(), thresholds, {}, at(0), 3);
    expect(r.transitions).toEqual([]);
    expect(r.checks.every((c) => !c.breached)).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual(
      expect.arrayContaining(['outbox_lag', 'job_age', 'run_slots', 'approval_age', 'budget_burn', 'db_connections', 'volume_blobs', 'volume_repos']),
    );
  });
});

describe('evaluate: thresholds', () => {
  it('outbox lag trips above 60 s and not at 60 s', () => {
    expect(evaluate(lag(60), thresholds, {}, at(0), 3).transitions).toEqual([]);
    expect(evaluate(lag(61), thresholds, {}, at(0), 3).transitions.map((t) => t.check)).toEqual(['outbox_lag']);
  });

  it('the oldest job trips above 10 minutes', () => {
    const slow = healthy({ jobs: { ready: 3, running: 0, dead: 0, oldestReadyAgeSeconds: 601, queues: [] } });
    expect(evaluate(slow, thresholds, {}, at(0), 3).transitions.map((t) => t.check)).toEqual(['job_age']);
  });

  it('an approval trips after 24 hours', () => {
    const waiting = (s: number) => healthy({ approvals: { pending: 1, oldestPendingAgeSeconds: s } });
    expect(evaluate(waiting(86_400), thresholds, {}, at(0), 3).transitions).toEqual([]);
    expect(evaluate(waiting(86_401), thresholds, {}, at(0), 3).transitions.map((t) => t.check)).toEqual(['approval_age']);
  });

  it('a volume trips above 85 % and names the volume', () => {
    const full = healthy({ volumes: [{ name: 'blobs', totalBytes: 100, freeBytes: 14, usedPercent: 86 }, { name: 'repos', totalBytes: 100, freeBytes: 50, usedPercent: 50 }] });
    const r = evaluate(full, thresholds, {}, at(0), 3);
    expect(r.transitions.map((t) => t.check)).toEqual(['volume_blobs']);
    expect(r.transitions[0]).toMatchObject({ value: 86, threshold: 85, unit: 'percent' });
  });

  it('database connections are judged as a share of the maximum', () => {
    const busy = healthy({ database: { connectionsUsed: 91, connectionsMax: 100 } });
    expect(evaluate(busy, thresholds, {}, at(0), 3).transitions.map((t) => t.check)).toEqual(['db_connections']);
  });

  it('a threshold of 0 switches the check off', () => {
    const off = { ...thresholds, outboxLagSeconds: 0 };
    expect(evaluate(lag(5000), off, {}, at(0), 3).transitions).toEqual([]);
  });
});

describe('evaluate: run slots saturated', () => {
  const saturated = healthy({ runs: { slotsUsed: 6, slotsLimit: 6, queued: 2, oldestQueuedAgeSeconds: 30 } });
  const roomy = healthy({ runs: { slotsUsed: 3, slotsLimit: 6, queued: 0, oldestQueuedAgeSeconds: 0 } });

  it('trips only after the slots have been full, with runs waiting, for more than 10 minutes', () => {
    const rounds = run(Array.from({ length: 13 }, () => saturated));
    const tripped = rounds.find((r) => r.transitions.length > 0);
    expect(tripped?.minute).toBe(11);
    expect(tripped?.transitions[0]).toMatchObject({ check: 'run_slots', state: 'breached', unit: 'seconds' });
  });

  it('starts counting again after a gap, and full slots with nothing waiting never count', () => {
    const series = [...Array.from({ length: 8 }, () => saturated), roomy, ...Array.from({ length: 8 }, () => saturated)];
    expect(run(series).flatMap((r) => r.transitions)).toEqual([]);
    const fullButNoQueue = healthy({ runs: { slotsUsed: 6, slotsLimit: 6, queued: 0, oldestQueuedAgeSeconds: 0 } });
    expect(run(Array.from({ length: 30 }, () => fullButNoQueue)).flatMap((r) => r.transitions)).toEqual([]);
  });
});

describe('evaluate: one message per breach, one on recovery', () => {
  it('says so once however long the breach lasts', () => {
    const rounds = run(Array.from({ length: 30 }, () => lag(300)));
    expect(rounds.flatMap((r) => r.transitions)).toHaveLength(1);
    expect(rounds[0]?.transitions[0]).toMatchObject({ check: 'outbox_lag', state: 'breached', value: 300, threshold: 60 });
  });

  it('says it is fixed only after three quiet rounds in a row', () => {
    const series = [lag(300), lag(10), lag(10), lag(10), lag(10)];
    const events = run(series).flatMap((r) => r.transitions.map((t) => ({ minute: r.minute, state: t.state })));
    expect(events).toEqual([{ minute: 0, state: 'breached' }, { minute: 3, state: 'recovered' }]);
  });

  it('a blip back inside the limit does not recover, and does not raise a second breach', () => {
    const series = [lag(300), lag(10), lag(10), lag(300), lag(10), lag(10), lag(300), lag(300)];
    const events = run(series).flatMap((r) => r.transitions);
    expect(events.map((t) => t.state)).toEqual(['breached']);
  });

  it('flapping across the line makes one pair of messages, not one per swing', () => {
    const swing = Array.from({ length: 12 }, (_, i) => lag(i % 2 === 0 ? 300 : 10));
    const quiet = [lag(10), lag(10), lag(10)];
    const events = run([...swing, ...quiet]).flatMap((r) => r.transitions);
    expect(events.map((t) => t.state)).toEqual(['breached', 'recovered']);
  });

  it('a second, separate breach after a recovery is announced again', () => {
    const series = [lag(300), lag(5), lag(5), lag(5), lag(400)];
    expect(run(series).flatMap((r) => r.transitions).map((t) => t.state)).toEqual(['breached', 'recovered', 'breached']);
  });

  it('a recovery carries the time the breach began', () => {
    const series = [lag(300), lag(5), lag(5), lag(5)];
    const recovered = run(series).flatMap((r) => r.transitions).find((t) => t.state === 'recovered');
    expect(recovered?.since).toBe(at(0).toISOString());
  });

  it('a volume must fall two points under the line to count as clear', () => {
    const vol = (p: number) => healthy({ volumes: [{ name: 'blobs', totalBytes: 100, freeBytes: 100 - p, usedPercent: p }] });
    const series = [vol(90), vol(84.5), vol(84.5), vol(84.5), vol(84.5), vol(82), vol(82), vol(82)];
    const events = run(series).flatMap((r) => r.transitions.map((t) => ({ minute: r.minute, state: t.state })));
    expect(events).toEqual([{ minute: 0, state: 'breached' }, { minute: 7, state: 'recovered' }]);
  });
});

describe('evaluate: a section that could not be read', () => {
  it('keeps the verdict it had and announces nothing', () => {
    const series = [lag(300), healthy({ outbox: null }), healthy({ outbox: null }), healthy({ outbox: null }), healthy({ outbox: null })];
    const rounds = run(series);
    expect(rounds.flatMap((r) => r.transitions).map((t) => t.state)).toEqual(['breached']);
    expect(rounds[4]?.breached).toContain('outbox_lag');
  });

  it('shows a null value rather than zero', () => {
    const r = evaluate(healthy({ outbox: null }), thresholds, {}, at(0), 3);
    expect(r.checks.find((c) => c.name === 'outbox_lag')).toMatchObject({ value: null, breached: false });
  });
});

describe('checkLabel', () => {
  it('agrees with the label every check carries, so the mail job words a change as the panel does', () => {
    const odd = healthy({ volumes: [...healthy().volumes, { name: 'backups', totalBytes: 1, freeBytes: 1, usedPercent: 0 }] });
    for (const c of evaluate(odd, thresholds, {}, at(0), 3).checks) expect(checkLabel(c.name), c.name).toBe(c.label);
    expect(checkLabel('free_money')).toBeNull();
  });
});

describe('describing a change in plain words', () => {
  const base: Transition = { check: 'outbox_lag', label: 'Outbox lag', state: 'breached', value: 95, threshold: 60, unit: 'seconds', since: at(0).toISOString() };

  it('names the number and the limit', () => {
    const d = describeTransition(base);
    expect(d.title).toBe('Outbox lag: 95 s');
    expect(d.detail).toContain('95 s');
    expect(d.detail).toContain('limit 60 s');
  });

  it('says how full a volume is', () => {
    const d = describeTransition({ ...base, check: 'volume_blobs', label: 'Attachment store used', unit: 'percent', value: 91, threshold: 85 });
    expect(d.title).toBe('Attachment store used is 91 % full');
  });

  it('says back to normal on recovery', () => {
    expect(describeTransition({ ...base, state: 'recovered', value: 3 }).title).toBe('Outbox lag: back to normal');
  });

  it('formats durations the way a person reads them', () => {
    expect(formatValue('seconds', 95)).toBe('95 s');
    expect(formatValue('seconds', 600)).toBe('10 min');
    expect(formatValue('seconds', 90_000)).toBe('25 h');
    expect(formatValue('seconds', 4 * 86_400)).toBe('4 d');
    expect(formatValue('percent', 85.04)).toBe('85 %');
  });
});
