import type { PluginContext } from '@manythreads/sdk';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, personas, type FilesWorld } from '../../files/test/world.ts';
import { incidentChannelName, incidentRhythmPass, incidentSlug, postmortemDraft } from '../src/incidents.ts';

// P35-07 through the real server: a member (not a lead) opens an incident from #general; it gets its own channel in the "Incidents" group, an opening
// message that names @on-call, a line in #general and the `opened` event; the same title again gets the next name; a person off the team and a guest are
// refused; the rhythm raises `update_due` when an update is due and moves the next one on; resolving drafts the post-mortem page with the timeline and
// raises `resolved`; a second resolve and a channel that is no incident are refused.

const { omar, nadia, tariq, lena } = personas;
vi.setConfig({ testTimeout: 90_000 });

let world: FilesWorld;
let general = '';
let since = new Date(0);

type Inc = { id: string; channelId: string; channelName: string; title: string; status: string; postmortemPath: string | null };
const open = (who: typeof omar, title: string) => world.call<{ incident: Inc }>(who, 'POST', '/api/teams/engineering/incidents', { title, fromChannelId: general });
const events = async (): Promise<Array<Record<string, unknown>>> =>
  (await world.system((tx) => tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = 'channel.incident.changed' AND occurred_at >= $1 ORDER BY id`, [since]))).rows.map((r) => r.payload);
const messagesIn = async (channelId: string) =>
  (await world.system((tx) => tx.query<{ body: string; thread_root_id: string | null }>('SELECT body, thread_root_id FROM app.messages WHERE channel_id = $1 ORDER BY created_at, id', [channelId]))).rows;

let first: Inc;

beforeAll(async () => {
  world = await createWorld();
  since = (await world.system((tx) => tx.query<{ now: Date }>('SELECT clock_timestamp() AS now'))).rows[0]!.now;
  await world.call(omar, 'GET', '/api/teams/engineering/channels');
  general = (
    await world.system((tx) =>
      tx.query<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.kind = 'channel' AND NOT c.private ORDER BY c.name LIMIT 1`),
    )
  ).rows[0]!.id;
}, 180_000);

afterAll(async () => {
  await world?.close();
});

describe('incident names', () => {
  it('a title becomes a short channel name', () => {
    expect(incidentSlug('Checkout errors on the payment page!')).toBe('checkout-errors-on-the-payment-page');
    expect(incidentSlug('Ünïcode — café down')).toBe('unicode-cafe-down');
    expect(incidentSlug('!!!')).toBe('incident');
    expect(incidentChannelName('DB down', new Date('2026-11-23T10:00:00Z'))).toBe('inc-20261123-db-down');
  });

  it('the post-mortem draft holds the times, the people and the timeline', () => {
    const md = postmortemDraft({
      title: 'DB down',
      channelName: 'inc-20261123-db-down',
      openedAt: new Date('2026-11-23T10:00:00Z'),
      resolvedAt: new Date('2026-11-23T11:05:00Z'),
      openedBy: 'Nadia',
      resolvedBy: 'Omar',
      summary: 'The primary ran out of disk.',
      timeline: [{ at: new Date('2026-11-23T10:02:00Z'), who: 'Omar', text: 'Looking at the disk', reply: true }],
      people: ['Nadia', 'Omar'],
    });
    expect(md).toContain('# Post-mortem: DB down');
    expect(md).toContain('1 h 5 min');
    expect(md).toContain('- 10:02 ↳ **Omar:** Looking at the disk');
    expect(md).toContain('The primary ran out of disk.');
    expect(md).toContain('## Action items');
  });
});

describe('incidents (P35-07)', () => {
  it('a member opens one: its own channel in Incidents, @on-call named, a line where it was typed, and the opened event', async () => {
    const res = await open(nadia, 'Checkout errors on payment');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    first = res.body.incident;
    expect(first).toMatchObject({ title: 'Checkout errors on payment', status: 'open', postmortemPath: null });
    expect(first.channelName).toMatch(/^inc-\d{8}-checkout-errors-on-payment$/);
    const ch = (
      await world.system((tx) =>
        tx.query<{ private: boolean; group_name: string; purpose: string }>('SELECT c.private, g.name AS group_name, c.purpose FROM app.channels c JOIN app.channel_groups g ON g.id = c.group_id WHERE c.id = $1', [first.channelId]),
      )
    ).rows[0]!;
    expect(ch).toEqual({ private: false, group_name: 'Incidents', purpose: 'Incident: Checkout errors on payment' });
    const inside = await messagesIn(first.channelId);
    expect(inside).toHaveLength(1);
    expect(inside[0]!.body).toContain('@on-call');
    expect((await messagesIn(general)).at(-1)!.body).toContain(`#${first.channelName}`);
    const opened = (await events()).filter((e) => e['change'] === 'opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ channelId: first.channelId, incidentId: first.id, actorId: nadia.actorId });
    // the person reads the channel as any public channel of the team
    expect((await world.call(omar, 'GET', `/api/channels/${first.channelId}`)).status).toBe(200);
  });

  it('the same title again gets the next name; a person off the team and a guest are refused', async () => {
    const again = await open(omar, 'Checkout errors on payment');
    expect(again.status).toBe(201);
    expect(again.body.incident.channelName).toBe(`${first.channelName}-2`);
    expect((await open(tariq, 'Not my team')).status).toBe(403);
    expect((await open(lena, 'A guest')).status).toBe(403);
  });

  it('the rhythm raises an update when one is due and sets the next', async () => {
    const emitted: Array<Record<string, unknown>> = [];
    const ctx = { db: { system: (fn: never) => world.system(fn) }, audit: { emit: async (_tx: unknown, e: Record<string, unknown>) => void emitted.push(e) } } as unknown as PluginContext;
    expect(await incidentRhythmPass(ctx)).toBe(0);
    await world.system((tx) => tx.query(`UPDATE app.incidents SET next_update_at = now() - interval '1 minute' WHERE id = $1`, [first.id]));
    expect(await incidentRhythmPass(ctx)).toBe(1);
    expect(emitted[0]).toMatchObject({ change: 'update_due', incidentId: first.id });
    expect(await incidentRhythmPass(ctx)).toBe(0);
  });

  it('resolving drafts the post-mortem page with the timeline and raises resolved; again, or in another channel, is refused', async () => {
    await world.call(omar, 'POST', `/api/channels/${first.channelId}/messages`, { channelId: first.channelId, body: 'The payment provider returns 502 since the deploy at 10:00.', threadRootId: null });
    const res = await world.call<{ incident: Inc }>(omar, 'POST', `/api/channels/${first.channelId}/incident/resolve`, { summary: 'Rolled back the deploy.' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.incident).toMatchObject({ status: 'resolved', postmortemPath: `pages/incidents/${first.channelName}-postmortem.md` });
    const last = (await messagesIn(first.channelId)).at(-1)!;
    expect(last.body).toContain('Resolved');
    expect(last.body).toContain(`pages/incidents/${first.channelName}-postmortem.md`);
    const page = await world.call<{ content?: string; text?: string }>(omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(`pages/incidents/${first.channelName}-postmortem.md`)}`);
    expect(page.status, JSON.stringify(page.body)).toBe(200);
    expect(JSON.stringify(page.body)).toContain('returns 502 since the deploy');
    expect((await events()).filter((e) => e['change'] === 'resolved')[0]).toMatchObject({ incidentId: first.id, postmortemPath: `pages/incidents/${first.channelName}-postmortem.md` });
    expect((await world.call(omar, 'POST', `/api/channels/${first.channelId}/incident/resolve`, {})).status).toBe(409);
    expect((await world.call(omar, 'POST', `/api/channels/${general}/incident/resolve`, {})).status).toBe(404);
  });
});
