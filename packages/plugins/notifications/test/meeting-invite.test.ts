import { emit } from '@manythreads/kernel';
import { ListNotificationsResponse, OpenDmResponse, StartMeetingResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meetingInvitePreview } from '../src/meeting-invite.ts';
import { prefKey } from '../src/prefs.ts';
import { PRIVATE_BODY, buildPushPayload, type PushFacts } from '../src/push.ts';
import { createWorld, drained, ensureChannels, eventually, personas, type ApiResult, type World } from './world.ts';

const { nadia, rafi, omar, priya, sameera } = personas;

// P15-27: the line a person reads when someone asks them to a call ("Nadia invited you to Design review"), its push, and the guards of the subscriber. The start route's
// own part (who may be asked, the whole list or nothing) is in meetings/test/call-start.test.ts.

describe('the invitation line', () => {
  it('names who asked and the call', () => {
    expect(meetingInvitePreview('Nadia', 'Design review')).toBe('Nadia invited you to Design review');
  });
  it('collapses white space and has words for an empty name or title', () => {
    expect(meetingInvitePreview('  Nadia \n Hassan ', '  Design \n review ')).toBe('Nadia Hassan invited you to Design review');
    expect(meetingInvitePreview('', '   ')).toBe('Someone invited you to a call');
  });
  it('stays short whatever the title is, and cuts only the title', () => {
    const line = meetingInvitePreview('Nadia', 'x'.repeat(500));
    expect([...line].length).toBeLessThanOrEqual(140);
    expect(line.startsWith('Nadia invited you to x')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
  });
  it('is switched with the same setting as a mention', () => {
    expect(prefKey('meeting_invite')).toBe('mention');
  });
});

describe('the invitation push', () => {
  const base: PushFacts = {
    notificationId: '0198f000-0000-7000-8000-000000000001',
    kind: 'meeting_invite',
    keyword: null,
    actorName: 'Nadia',
    preview: 'Nadia invited you to Design review',
    channelId: '0198f000-0000-7000-8000-0000000000aa',
    channelKind: 'channel',
    channelName: 'dev',
    channelPrivate: false,
    messageId: '0198f000-0000-7000-8000-0000000000bb',
    threadRootId: '0198f000-0000-7000-8000-0000000000cc',
  };
  it('says "You are invited to a call", names an open channel, and opens the call card (its start message)', () => {
    const p = buildPushPayload(base);
    expect(p.title).toBe('You are invited to a call in #dev');
    expect(p.body).toBe('Nadia invited you to Design review');
    expect(p.url).toBe(`/open?channel=${base.channelId}&message=${base.threadRootId}`);
  });
  it('keeps a private channel’s name and the title off the lock screen', () => {
    const p = buildPushPayload({ ...base, channelPrivate: true, channelName: 'secret-launch', preview: 'Nadia invited you to Secret launch' });
    expect(p.title).toBe('You are invited to a call');
    expect(p.body).toBe(PRIVATE_BODY);
    expect(JSON.stringify(p)).not.toContain('ecret');
  });
  it('opens the channel when the call has no card', () => {
    expect(buildPushPayload({ ...base, threadRootId: null }).url).toBe(`/open?channel=${base.channelId}`);
  });
});

// Each case emits the event the meetings plugin would say, waits for the outbox to drain, then reads what the subscriber wrote (the rows of one call are told apart by
// the meeting's id).
describe('the invitation subscriber', () => {
  let w: World;
  let general = '';
  const savedProvider = process.env['MANYTHREADS_MEDIA_PROVIDER'];
  beforeAll(async () => {
    // the last case starts a real call through the meetings plugin
    process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
    w = await createWorld();
    await ensureChannels(w);
    general = await w.channelId('engineering', 'general');
  }, 180_000);
  afterAll(async () => {
    await w?.close();
    if (savedProvider === undefined) delete process.env['MANYTHREADS_MEDIA_PROVIDER'];
    else process.env['MANYTHREADS_MEDIA_PROVIDER'] = savedProvider;
  });

  const ok = <T>(res: ApiResult<T>, status = 200): T => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body;
  };
  /** A live call in the channel with its start message, made by SQL as the system role (the call side is not under test). */
  const makeCall = (channelId: string, title: string, state: 'live' | 'ended' = 'live'): Promise<{ id: string; root: string }> =>
    w.system(async (tx) => {
      // one live call per channel: the call before this one is over
      await tx.query("UPDATE app.meetings SET state = 'ended', ended_at = now(), end_reason = 'person' WHERE channel_id = $1 AND state = 'live'", [channelId]);
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.meetings (workspace_id, channel_id, title, started_by, organizer_id, state, ended_at, end_reason)
           VALUES ($1, $2, $3, $4, $4, $5, CASE WHEN $5 = 'ended' THEN now() END, CASE WHEN $5 = 'ended' THEN 'person' END) RETURNING id`,
          [nadia.workspaceId, channelId, title, nadia.actorId, state],
        )
      ).rows[0]!.id;
      const root = (
        await tx.query<{ id: string }>('INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, meta) VALUES ($1, $2, $3, $4, $4, $5::jsonb) RETURNING id', [
          nadia.workspaceId,
          channelId,
          nadia.actorId,
          `Started a call: ${title}`,
          JSON.stringify({ meeting: { meetingId: id } }),
        ])
      ).rows[0]!.id;
      if (state === 'live') await tx.query('UPDATE app.meetings SET thread_root_id = $2 WHERE id = $1', [id, root]);
      return { id, root };
    });
  /** Says the invitation event once, as the meetings plugin does. */
  const say = async (meetingId: string, channelId: string, people: string[], invitedBy = nadia.actorId): Promise<void> => {
    await w.system((tx) =>
      emit(tx, {
        type: 'meetings.invite.sent',
        schemaVersion: 1,
        workspaceId: nadia.workspaceId,
        teamId: null,
        channelId,
        meetingId,
        invitedBy,
        personIds: people,
        first: true,
        at: new Date().toISOString(),
      }),
    );
    await drained(w);
  };
  const rowsOf = (meetingId: string) =>
    w.system(async (tx) =>
      (
        await tx.query<{ id: string; person_id: string; kind: string; ref_type: string; preview: string; actor_name: string; thread_root_id: string | null; held: boolean }>(
          `SELECT id, person_id, kind, ref_type, preview, actor_name, thread_root_id, held_at IS NOT NULL AS held
             FROM app.notifications WHERE ref_id = $1 ORDER BY person_id`,
          [meetingId],
        )
      ).rows,
    );

  it('writes one row for each person asked who can read the channel, from the person who asked, opening the call card', async () => {
    const call = await makeCall(general, 'Design review');
    await say(call.id, general, [rafi.personId, omar.personId]);
    const rows = await rowsOf(call.id);
    expect(rows.map((r) => r.person_id).sort()).toEqual([omar.personId, rafi.personId].sort());
    for (const r of rows) {
      expect(r).toMatchObject({ kind: 'meeting_invite', ref_type: 'meeting_invite', preview: 'Nadia invited you to Design review', actor_name: 'Nadia', thread_root_id: call.root, held: false });
    }
    const listed = ListNotificationsResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications'))).items;
    expect(listed.find((n) => n.refId === call.id)).toMatchObject({ kind: 'meeting_invite', refType: 'meeting_invite', threadRootId: call.root, channelId: general });
  });

  it('names the person who asked with "Invite more", not the starter', async () => {
    const call = await makeCall(general, 'Second round');
    await say(call.id, general, [priya.personId], rafi.actorId);
    expect((await rowsOf(call.id)).map((r) => r.preview)).toEqual(['Rafi invited you to Second round']);
  });

  it('says nothing for a call that has ended, nor in a direct message (the ring is the invitation)', async () => {
    const ended = await makeCall(general, 'Over already', 'ended');
    await say(ended.id, general, [rafi.personId]);
    expect(await rowsOf(ended.id)).toEqual([]);
    const dmRes = await w.call(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] });
    expect(dmRes.status, JSON.stringify(dmRes.body)).toBeLessThan(300);
    const dm = OpenDmResponse.parse(dmRes.body).dm.channel.id;
    const call = await makeCall(dm, 'Quick call');
    await say(call.id, dm, [rafi.personId]);
    expect(await rowsOf(call.id)).toEqual([]);
  });

  it('skips a person who cannot read the channel, and one who lost access since', async () => {
    const created = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'invite-private', private: true }), 201);
    const priv = created.channel.id;
    for (const who of [nadia, rafi, priya]) expect((await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: who.personId })).status).toBeLessThan(300);
    ok(await w.call(omar, 'DELETE', `/api/channels/${priv}/members/${priya.personId}`));
    const call = await makeCall(priv, 'Private sync');
    await say(call.id, priv, [rafi.personId, priya.personId, sameera.personId]);
    expect((await rowsOf(call.id)).map((r) => r.person_id)).toEqual([rafi.personId]);
  });

  it('holds the row while Do not disturb is on, and delivers it when it ends', async () => {
    const call = await makeCall(general, 'Held call');
    ok(await w.call(rafi, 'PUT', '/api/presence/dnd', { enabled: true }));
    await say(call.id, general, [rafi.personId, omar.personId]);
    const rows = await rowsOf(call.id);
    expect(rows.find((r) => r.person_id === rafi.personId)?.held).toBe(true);
    expect(rows.find((r) => r.person_id === omar.personId)?.held).toBe(false);
    const listed = ListNotificationsResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications'))).items;
    expect(listed.some((n) => n.refId === call.id)).toBe(false);
    ok(await w.call(rafi, 'PUT', '/api/presence/dnd', { enabled: false }));
    await eventually(async () => ListNotificationsResponse.parse(ok(await w.call(rafi, 'GET', '/api/notifications'))).items.some((n) => n.refId === call.id), 30_000, 'the held invitation');
  }, 60_000);

  it('leaves out a person who muted the channel, set it to "nothing" or switched mentions off in the app; "mentions" lets it through', async () => {
    const created = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'invite-settings' }), 201);
    const ch = created.channel.id;
    type Prefs = { mention: { inApp: boolean; browser: boolean }; reply: { inApp: boolean; browser: boolean }; dm: { inApp: boolean; browser: boolean }; mutedChannels: string[] };
    const prefsOf = async (who: typeof rafi): Promise<Prefs> => {
      const p = ok(await w.call<Prefs>(who, 'GET', '/api/notifications/prefs'));
      return { mention: p.mention, reply: p.reply, dm: p.dm, mutedChannels: p.mutedChannels };
    };
    // Rafi mutes the channel in his settings, Priya sets its level to "nothing", Omar switches mentions off in the app; Nadia's level is "mentions"
    ok(await w.call(rafi, 'PUT', '/api/notifications/prefs', { ...(await prefsOf(rafi)), mutedChannels: [ch] }));
    ok(await w.call(priya, 'PUT', `/api/notifications/levels/${ch}`, { level: 'nothing' }));
    const omarPrefs = await prefsOf(omar);
    ok(await w.call(omar, 'PUT', '/api/notifications/prefs', { ...omarPrefs, mention: { ...omarPrefs.mention, inApp: false } }));
    ok(await w.call(nadia, 'PUT', `/api/notifications/levels/${ch}`, { level: 'mentions' }));
    try {
      const call = await makeCall(ch, 'Settings call');
      await say(call.id, ch, [rafi.personId, priya.personId, omar.personId, nadia.personId], priya.actorId);
      expect((await rowsOf(call.id)).map((r) => r.person_id)).toEqual([nadia.personId]);
    } finally {
      ok(await w.call(rafi, 'PUT', '/api/notifications/prefs', { ...(await prefsOf(rafi)), mutedChannels: [] }));
      ok(await w.call(omar, 'PUT', '/api/notifications/prefs', omarPrefs));
    }
  });

  it('writes one row per person and call when the event comes twice', async () => {
    const call = await makeCall(general, 'Twice');
    await say(call.id, general, [rafi.personId]);
    await say(call.id, general, [rafi.personId]);
    expect(await rowsOf(call.id)).toHaveLength(1);
  });

  // the whole path: the meetings plugin's start route, the event, this subscriber
  it('puts "Nadia invited you to …" in the inbox of each person asked, and nothing in the starter’s', async () => {
    // the calls the cases above made by hand are over
    await w.system((tx) => tx.query("UPDATE app.meetings SET state = 'ended', ended_at = now(), end_reason = 'person' WHERE channel_id = $1 AND state = 'live'", [general]));
    const res = await w.call(nadia, 'POST', `/api/channels/${general}/meetings`, { title: 'Planning', inviteeIds: [rafi.personId] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const started = StartMeetingResponse.parse(res.body);
    expect(started).toMatchObject({ created: true, invited: 1 });
    const m = started.meeting;
    await drained(w);
    const rafis = ListNotificationsResponse.parse((await w.call(rafi, 'GET', '/api/notifications')).body).items.filter((n) => String(n.refId) === m.id);
    expect(rafis).toHaveLength(1);
    expect(rafis[0]).toMatchObject({ kind: 'meeting_invite', preview: 'Nadia invited you to Planning', threadRootId: m.threadRootId });
    const nadias = ListNotificationsResponse.parse((await w.call(nadia, 'GET', '/api/notifications')).body).items.filter((n) => String(n.refId) === m.id);
    expect(nadias).toEqual([]);
    expect((await w.call(nadia, 'POST', `/api/meetings/${m.id}/end`)).status).toBe(200);
  });
});
