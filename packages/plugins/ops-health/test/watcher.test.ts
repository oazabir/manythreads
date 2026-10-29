import { describe, expect, it } from 'vitest';
import type { PluginContext } from '@manythreads/sdk';
import { HEALTH_STATE_KEY, parseState, type Monitor } from '../src/monitor.ts';
import { MAIL_QUEUE, sendAlertMail, tickHealth } from '../src/watcher.ts';
import { healthy, at } from './fixtures.ts';

/** The slice of the plugin context the watcher uses, recording what it is asked to do. */
function harness(minute: { n: number }, snapshots: () => ReturnType<typeof healthy>) {
  const kv = new Map<string, unknown>();
  const events: Array<Record<string, unknown>> = [];
  const jobs: Array<{ queue: string; payload: Record<string, unknown>; dedupeKey?: string }> = [];
  const mails: Array<Record<string, unknown>> = [];
  const ctx = {
    runtime: { now: () => at(minute.n), publicUrl: 'https://mt.example' },
    storage: {
      get: async (scope: { id: string }, key: string) => kv.get(`${scope.id}:${key}`),
      set: async (scope: { id: string }, key: string, value: unknown) => void kv.set(`${scope.id}:${key}`, value),
    },
    audit: { emit: async (_tx: unknown, e: Record<string, unknown>) => void events.push(e) },
    jobs: { enqueue: async (_tx: unknown, queue: string, payload: Record<string, unknown>, o?: { dedupeKey?: string }) => void jobs.push({ queue, payload, ...(o?.dedupeKey ? { dedupeKey: o.dedupeKey } : {}) }) },
    mail: { send: async (m: Record<string, unknown>) => void mails.push(m) },
  } as unknown as PluginContext;
  const monitor: Monitor = { measure: async () => ({ snapshot: snapshots(), sections: {} }) };
  const tx = { query: async () => ({ rows: [{ id: '00000000-0000-4000-8000-000000000001' }] }) } as never;
  return { ctx, monitor, tx, kv, events, jobs, mails };
}

const lag = (s: number) => healthy({ outbox: { backlog: 3, retrying: 0, oldestAgeSeconds: s } });

describe('tickHealth', () => {
  it('writes one event and queues one mail when a check trips, however many rounds it stays tripped', async () => {
    const minute = { n: 0 };
    const h = harness(minute, () => lag(300));
    for (minute.n = 0; minute.n < 20; minute.n++) await tickHealth(h.ctx, h.tx, h.monitor, {});
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ type: 'ops.health.changed', check: 'outbox_lag', state: 'breached', threshold: 60, unit: 'seconds' });
    expect(h.jobs).toHaveLength(1);
    expect(h.jobs[0]?.queue).toBe(MAIL_QUEUE);
    expect(h.jobs[0]?.payload).toMatchObject({ check: 'outbox_lag', state: 'breached' });
  });

  it('writes one more when it has been quiet for three rounds, and remembers the state in between', async () => {
    const minute = { n: 0 };
    let value = 300;
    const h = harness(minute, () => lag(value));
    await tickHealth(h.ctx, h.tx, h.monitor, {});
    value = 5;
    for (minute.n = 1; minute.n <= 3; minute.n++) await tickHealth(h.ctx, h.tx, h.monitor, {});
    expect(h.events.map((e) => e['state'])).toEqual(['breached', 'recovered']);
    expect(h.jobs.map((j) => j.payload['state'])).toEqual(['breached', 'recovered']);
    const stored = parseState(h.kv.get(`00000000-0000-4000-8000-000000000001:${HEALTH_STATE_KEY}`));
    expect(stored['outbox_lag']?.breached).toBe(false);
  });

  it('says nothing when everything is fine', async () => {
    const h = harness({ n: 0 }, () => healthy());
    expect(await tickHealth(h.ctx, h.tx, h.monitor, {})).toBe(0);
    expect(h.events).toEqual([]);
    expect(h.jobs).toEqual([]);
  });

  it('writes the event but queues no mail when mail is switched off', async () => {
    const h = harness({ n: 0 }, () => lag(300));
    await tickHealth(h.ctx, h.tx, h.monitor, { MANYTHREADS_ALERT_MAIL: '0' });
    expect(h.events).toHaveLength(1);
    expect(h.jobs).toEqual([]);
  });

  it('does nothing at all when alerts are off', async () => {
    const h = harness({ n: 0 }, () => lag(300));
    expect(await tickHealth(h.ctx, h.tx, h.monitor, { MANYTHREADS_ALERTS: 'off' })).toBe(0);
    expect(h.events).toEqual([]);
    expect(h.kv.size).toBe(0);
  });

  it('uses the limits from the environment', async () => {
    const h = harness({ n: 0 }, () => lag(300));
    await tickHealth(h.ctx, h.tx, h.monitor, { MANYTHREADS_ALERT_OUTBOX_LAG_SECONDS: '600' });
    expect(h.events).toEqual([]);
  });
});

describe('sendAlertMail', () => {
  const WS = '00000000-0000-4000-8000-000000000001';
  const payload = { workspaceId: WS, check: 'outbox_lag', state: 'breached', value: 95, threshold: 60, unit: 'seconds', since: at(0).toISOString() };
  /** The harness after the watcher stored `outbox_lag` as breached (or fine) for the workspace. */
  const withStored = (h: ReturnType<typeof harness>, breached: boolean) =>
    h.kv.set(`${WS}:${HEALTH_STATE_KEY}`, { outbox_lag: { breached, since: breached ? at(0).toISOString() : null, clearRounds: 0, conditionSince: null } });
  const log = { info: () => undefined, warn: () => undefined };
  const jobWith = (admins: string[]) => ({
    log,
    transaction: async <T>(fn: (tx: never) => Promise<T>): Promise<T> =>
      fn({ query: async (sql: string) => ({ rows: /workspace_members/.test(sql) ? admins.map((email) => ({ email })) : [{ name: 'Kahf Software' }] }) } as never),
  });

  it('mails every owner and admin once, with a link to the System health page', async () => {
    const h = harness({ n: 0 }, () => healthy());
    withStored(h, true);
    await sendAlertMail(h.ctx, payload, jobWith(['a@example.com', 'b@example.com']));
    expect(h.mails.map((m) => m['to'])).toEqual(['a@example.com', 'b@example.com']);
    expect(h.mails[0]).toMatchObject({ template: 'ops_alert', workspaceName: 'Kahf Software', state: 'breached', title: 'Outbox lag: 95 s', url: 'https://mt.example/settings/workspace/health' });
  });

  it('writes the words itself: a forged title or detail in the payload never reaches a mail', async () => {
    const h = harness({ n: 0 }, () => healthy());
    withStored(h, true);
    await sendAlertMail(h.ctx, { ...payload, title: 'Your password expired: https://evil.example', detail: 'Sign in again at https://evil.example' }, jobWith(['a@example.com']));
    expect(h.mails).toHaveLength(1);
    expect(JSON.stringify(h.mails[0])).not.toContain('evil.example');
  });

  it('sends nothing for a change the watcher never stored: a made-up check, a state that disagrees, another workspace', async () => {
    const h = harness({ n: 0 }, () => healthy());
    const admins = jobWith(['a@example.com']);
    await sendAlertMail(h.ctx, payload, admins); // nothing stored at all
    withStored(h, true);
    await sendAlertMail(h.ctx, { ...payload, check: 'free_money' }, admins);
    await sendAlertMail(h.ctx, { ...payload, state: 'recovered' }, admins); // stored as breached
    await sendAlertMail(h.ctx, { ...payload, workspaceId: '00000000-0000-4000-8000-000000000002' }, admins);
    await sendAlertMail(h.ctx, { ...payload, workspaceId: 'not-a-uuid' }, admins);
    expect(h.mails).toEqual([]);
  });

  it('survives one bad address but fails when nobody can be reached, so the job is tried again', async () => {
    const h = harness({ n: 0 }, () => healthy());
    withStored(h, true);
    let n = 0;
    (h.ctx.mail as { send: (m: unknown) => Promise<void> }).send = async () => {
      n += 1;
      if (n === 1) throw new Error('bounce');
    };
    await expect(sendAlertMail(h.ctx, payload, jobWith(['a@example.com', 'b@example.com']))).resolves.toBeUndefined();
    (h.ctx.mail as { send: (m: unknown) => Promise<void> }).send = async () => Promise.reject(new Error('smtp down'));
    await expect(sendAlertMail(h.ctx, payload, jobWith(['a@example.com']))).rejects.toThrow(/no health mail/);
  });

  it('drops a payload it cannot read', async () => {
    const h = harness({ n: 0 }, () => healthy());
    await sendAlertMail(h.ctx, { nonsense: true }, jobWith(['a@example.com']));
    expect(h.mails).toEqual([]);
  });
});

describe('parseState', () => {
  it('treats anything unreadable as no memory', () => {
    expect(parseState(undefined)).toEqual({});
    expect(parseState({ outbox_lag: { breached: 'yes' } })).toEqual({});
  });
});
