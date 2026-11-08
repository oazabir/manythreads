import { emit } from '@manythreads/kernel';
import { ListNotificationsResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meetingSoonPreview } from '../src/meeting-soon.ts';
import { prefKey } from '../src/prefs.ts';
import { createWorld, drained, ensureChannels, personas, type ApiResult, type World } from './world.ts';

const { nadia, rafi, omar, priya, sameera } = personas;

// P16-05: the line a person reads five minutes before a planned room. The whole path (the reminder job, the event, one row for each invited person) is in meetings/test/scheduled-reminders.test.ts.

describe('the "starts in 5 minutes" notification', () => {
  it('names the meeting and says when', () => {
    expect(meetingSoonPreview('Design review')).toBe('Design review starts in 5 minutes');
  });

  it('collapses white space and has a word for an empty title', () => {
    expect(meetingSoonPreview('  Design \n  review ')).toBe('Design review starts in 5 minutes');
    expect(meetingSoonPreview('   ')).toBe('A meeting starts in 5 minutes');
  });

  it('stays short whatever the title is, and keeps its tail', () => {
    const line = meetingSoonPreview('x'.repeat(500));
    expect(line.length).toBeLessThanOrEqual(140);
    expect(line.endsWith(' starts in 5 minutes')).toBe(true);
  });

  it('is switched with the same setting as a mention', () => {
    expect(prefKey('meeting_soon')).toBe('mention');
  });
});

// The guards of the subscriber: the event names people by id and the row is written only for the ones who still may be told. Each case emits the event the reminder job would say, waits for the
// outbox to drain, then reads what the subscriber wrote (the rows of one plan are told apart by the plan's id).
describe('the "starts in 5 minutes" subscriber', () => {
  let w: World;
  let general = '';
  beforeAll(async () => {
    w = await createWorld();
    await ensureChannels(w);
    general = await w.channelId('engineering', 'general');
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  const ok = <T>(res: ApiResult<T>, status = 200): T => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body;
  };
  /** A plan in the channel, made by SQL (the calendar side is not under test). */
  const makePlan = (channelId: string, title: string, status = 'scheduled'): Promise<string> =>
    w.system(async (tx) =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.scheduled_meetings (workspace_id, team_id, channel_id, organizer_id, provider, title, starts_at, ends_at, status)
           SELECT c.workspace_id, c.team_id, c.id, $2::uuid, 'google', $3, now() + interval '4 minutes', now() + interval '34 minutes', $4
             FROM app.channels c WHERE c.id = $1::uuid
           RETURNING id`,
          [channelId, nadia.actorId, title, status],
        )
      ).rows[0]!.id,
    );
  /** Says the reminder event once, as the reminder job does. `at` defaults to now; a later `at` is a second reminder of a moved plan. */
  const say = async (planId: string, channelId: string, people: string[], at = new Date()): Promise<void> => {
    await w.system((tx) =>
      emit(tx, {
        type: 'meetings.scheduled.starting_soon',
        schemaVersion: 1,
        workspaceId: nadia.workspaceId,
        teamId: null,
        channelId,
        scheduledMeetingId: planId,
        attendeePersonIds: people,
        startsAt: new Date(Date.now() + 4 * 60_000).toISOString(),
        at: at.toISOString(),
      }),
    );
    await drained(w);
  };
  const rowsOf = (planId: string) =>
    w.system(async (tx) =>
      (
        await tx.query<{ id: string; person_id: string; preview: string; held: boolean; read: boolean; created_at: Date }>(
          'SELECT id, person_id, preview, held_at IS NOT NULL AS held, read_at IS NOT NULL AS read, created_at FROM app.notifications WHERE ref_id = $1 ORDER BY person_id',
          [planId],
        )
      ).rows,
    );
  const announced = (personId: string) =>
    w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'notifications.notification.created' AND payload->>'personId' = $1", [personId])).rows[0]!.n);

  it('writes one row for each invited person who can read the channel, from the organizer, and nothing for a cancelled plan', async () => {
    const live = await makePlan(general, 'Design review');
    const cancelled = await makePlan(general, 'Dropped', 'cancelled');
    const started = await makePlan(general, 'Already open', 'started');
    await say(cancelled, general, [rafi.personId, omar.personId]);
    await say(started, general, [rafi.personId]);
    await say(live, general, [rafi.personId, omar.personId]);
    expect(await rowsOf(cancelled)).toEqual([]);
    expect(await rowsOf(started)).toEqual([]);
    const rows = await rowsOf(live);
    expect(rows.map((r) => r.person_id).sort()).toEqual([omar.personId, rafi.personId].sort());
    for (const r of rows) expect(r).toMatchObject({ preview: 'Design review starts in 5 minutes', held: false, read: false });
  });

  it('skips a person who never could read the channel and one who lost access since the plan was made', async () => {
    const created = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'meeting-soon-private', private: true }), 201);
    const priv = created.channel.id;
    for (const who of [nadia, rafi, priya]) expect((await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: who.personId })).status).toBeLessThan(300);
    const plan = await makePlan(priv, 'Private sync');
    ok(await w.call(omar, 'DELETE', `/api/channels/${priv}/members/${priya.personId}`));

    // Priya was removed, Sameera was never in the channel (nor on the team), Rafi stays
    await say(plan, priv, [rafi.personId, priya.personId, sameera.personId]);
    expect((await rowsOf(plan)).map((r) => r.person_id)).toEqual([rafi.personId]);
    // and a plan whose whole list lost access writes nothing at all
    const none = await makePlan(priv, 'Nobody left');
    await say(none, priv, [priya.personId, sameera.personId]);
    expect(await rowsOf(none)).toEqual([]);
  });

  it('holds the row while Do not disturb is on: written, not listed, not announced; delivered when it ends', async () => {
    const plan = await makePlan(general, 'Held one');
    const before = await announced(rafi.personId);
    ok(await w.call(rafi, 'PUT', '/api/presence/dnd', { enabled: true }));
    await say(plan, general, [rafi.personId, omar.personId]);

    const rows = await rowsOf(plan);
    expect(rows.find((r) => r.person_id === rafi.personId)?.held).toBe(true);
    expect(rows.find((r) => r.person_id === omar.personId)?.held).toBe(false);
    const listed = ListNotificationsResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications'))).items;
    expect(listed.some((n) => n.kind === 'meeting_soon' && n.preview.startsWith('Held one'))).toBe(false);
    expect(await announced(rafi.personId)).toBe(before);

    ok(await w.call(rafi, 'PUT', '/api/presence/dnd', { enabled: false }));
    const delivered = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        const items = ListNotificationsResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications'))).items;
        if (items.some((n) => n.kind === 'meeting_soon' && n.preview.startsWith('Held one'))) return true;
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    })();
    expect(delivered).toBe(true);
  }, 60_000);

  it('says nothing new when the same event is delivered twice; a later reminder of a moved plan raises the same row', async () => {
    const plan = await makePlan(general, 'Twice');
    const at = new Date();
    await say(plan, general, [rafi.personId], at);
    const [first] = await rowsOf(plan);
    expect(first).toBeDefined();
    ok(await w.call(rafi, 'POST', '/api/notifications/mark-read', { ids: [first!.id] }));

    // the very same event again (same `at`): the row is still read and has the same time, and there is still one row
    await say(plan, general, [rafi.personId], at);
    const again = await rowsOf(plan);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ id: first!.id, read: true });
    expect(again[0]!.created_at.getTime()).toBe(first!.created_at.getTime());

    // a later reminder (the plan moved): the same row, unread again, newer, with the title as it is now
    await w.system((tx) => tx.query("UPDATE app.scheduled_meetings SET title = 'Twice, moved' WHERE id = $1", [plan]));
    await say(plan, general, [rafi.personId], new Date(Date.now() + 60_000));
    const raised = await rowsOf(plan);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ id: first!.id, read: false, preview: 'Twice, moved starts in 5 minutes' });
    expect(raised[0]!.created_at.getTime()).toBeGreaterThan(first!.created_at.getTime());
  });
});
