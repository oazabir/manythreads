import { enqueue, eventToRaw, type EventRow } from '@manythreads/kernel';
import {
  ListDmsResponse,
  ListMessagesResponse,
  ListNotificationsResponse,
  ListRemindersResponse,
  Reminder,
  RemindersReminderChangedEvent,
  parseEvent,
  parseMarkup,
  type Notification,
} from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, drained, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, priya, sameera, tariq, lena } = personas;

// P14-04: `/remind` through the HTTP routes and the minute job. The clock the server reads (`ctx.runtime.now`) is moved by `skewMs`, so a reminder
// can "come due" without waiting. DB-backed: it runs on the devbox when no CI run shares the database.

let skewMs = 0;
const clock = (): Date => new Date(Date.now() + skewMs);
const MINUTE = 60_000;
const at = (minutes: number): string => new Date(clock().getTime() + minutes * MINUTE).toISOString();

let w: World;
let dev = '';
beforeAll(async () => {
  w = await createWorld({ now: clock });
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const create = (who: Persona | null, target: unknown, text: string, remindAt: string, extra: Record<string, unknown> = {}): Promise<ApiResult<Reminder>> =>
  w.call(who, 'POST', '/api/reminders', { target, text, remindAt, ...extra });
const make = async (who: Persona, target: unknown, text: string, minutes = 20): Promise<Reminder> => Reminder.parse(ok(await create(who, target, text, at(minutes)), 201));
const list = async (who: Persona, state: 'pending' | 'history' = 'pending'): Promise<ListRemindersResponse> =>
  ListRemindersResponse.parse(ok(await w.call(who, 'GET', `/api/reminders?state=${state}`)));
const cancel = async (who: Persona, id: string): Promise<boolean> => ok(await w.call<{ cancelled: boolean }>(who, 'DELETE', `/api/reminders/${id}`)).cancelled;
const inbox = async (who: Persona): Promise<Notification[]> => ListNotificationsResponse.parse(ok(await w.call(who, 'GET', '/api/notifications'))).items;
const messagesOf = async (who: Persona, channelId: string) => ListMessagesResponse.parse(ok(await w.call(who, 'GET', `/api/channels/${channelId}/messages`))).items;
/** The person's Reminders conversation, or undefined before the first delivery. */
const remindersDm = async (who: Persona) => ListDmsResponse.parse(ok(await w.call(who, 'GET', '/api/dms'))).items.find((d) => d.channel.dmKey === `reminders:${who.personId}`);
/** Runs the send job once and waits for it and for what its events cause. */
const send = async (): Promise<void> => {
  const id = await w.system(async (tx) => (await enqueue(tx, 'reminders.send_due', {})).id);
  await eventually(
    async () => {
      const row = (await w.system(async (tx) => (await tx.query<{ state: string; last_error: string | null }>('SELECT state, last_error FROM app.jobs WHERE id = $1', [id])).rows[0]))!;
      expect(row.last_error).toBeNull();
      return row.state === 'done' ? true : undefined;
    },
    20_000,
    'the send job',
  );
  await drained(w);
};
/** Moves the clock `minutes` ahead, runs the job, and puts the clock back. */
const sendAfter = async (minutes: number): Promise<void> => {
  skewMs = minutes * MINUTE;
  try {
    await send();
  } finally {
    skewMs = 0;
  }
};
/** Waits for the reminder to be in the history in this state (another run of the job, on its own minute, may have taken the work). */
const settled = (who: Persona, id: string, state: 'sent' | 'refused' | 'cancelled'): Promise<Reminder> =>
  eventually(async () => (await list(who, 'history')).items.find((r) => r.id === id && r.state === state), 20_000, `reminder ${id} to be ${state}`);
const changes = (reminderId: string): Promise<RemindersReminderChangedEvent[]> =>
  w.system(async (tx) => {
    const rows = (
      await tx.query<EventRow>(
        `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events
          WHERE type = 'reminders.reminder.changed' AND payload->>'reminderId' = $1 ORDER BY id`,
        [reminderId],
      )
    ).rows;
    return rows.map((r) => RemindersReminderChangedEvent.parse(parseEvent(eventToRaw(r))));
  });
const privateChannelWith = async (name: string, ...members: Persona[]): Promise<string> => {
  const created = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name, private: true }), 201);
  for (const m of members) ok(await w.call(omar, 'POST', `/api/channels/${created.channel.id}/members`, { personId: m.personId }));
  return created.channel.id;
};

describe('making a reminder', () => {
  it('201 with the reminder; only its maker lists it, soonest first', async () => {
    const later = await make(nadia, { kind: 'me' }, 'water the plants', 90);
    const sooner = await make(nadia, { kind: 'me' }, 'call the plumber', 30);
    expect(sooner).toMatchObject({ targetKind: 'me', person: null, channel: null, text: 'call the plumber', state: 'pending', refusedReason: null, sentAt: null });
    expect(Date.parse(sooner.remindAt) - clock().getTime()).toBeGreaterThan(29 * MINUTE);
    const mine = await list(nadia);
    const ids = mine.items.map((r) => r.id);
    expect(ids.indexOf(sooner.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(sooner.id)).toBeLessThan(ids.indexOf(later.id));
    expect(mine.pendingCount).toBe(mine.items.length);
    // nobody else lists it, an admin included
    for (const other of [omar, rafi, priya]) expect((await list(other)).items.map((r) => r.id)).not.toContain(sooner.id);
  });

  it('trims the text, and refuses empty text, two lines, a past time, a time more than a year ahead, an unknown field and no session', async () => {
    expect((await make(nadia, { kind: 'me' }, '   spaces around   ')).text).toBe('spaces around');
    expect((await create(nadia, { kind: 'me' }, '   ', at(10))).status).toBe(400);
    expect((await create(nadia, { kind: 'me' }, 'one\ntwo', at(10))).status).toBe(400);
    expect((await create(nadia, { kind: 'me' }, 'x'.repeat(501), at(10))).status).toBe(400);
    expect((await create(nadia, { kind: 'me' }, 'in the past', at(-30))).status).toBe(400);
    expect((await create(nadia, { kind: 'me' }, 'too far', at(60 * 24 * 400))).status).toBe(400);
    expect((await create(nadia, { kind: 'me' }, 'not a time', 'tomorrow')).status).toBe(400);
    expect((await create(nadia, { kind: 'me' }, 'extra', at(10), { priority: 'high' })).status).toBe(400);
    expect((await create(nadia, { kind: 'everyone' }, 'unknown target', at(10))).status).toBe(400);
    expect((await create(nadia, { kind: 'channel' }, 'no channel', at(10))).status).toBe(400);
    expect((await create(nadia, { kind: 'me', channelId: dev }, 'a channel for me', at(10))).status).toBe(400);
    expect((await create(null, { kind: 'me' }, 'nobody', at(10))).status).toBe(401);
    expect((await w.call(null, 'GET', '/api/reminders')).status).toBe(401);
    // a few seconds in the past is slack, and counts as now
    ok(await create(nadia, { kind: 'me' }, 'just now', new Date(clock().getTime() - 20_000).toISOString()), 201);
  });

  it('a guest makes none', async () => {
    const res = await create(lena, { kind: 'me' }, 'a guest reminder', at(10));
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('members of the workspace');
  });

  it('a reminder for a channel needs the right to post there; one for a person needs a conversation both read', async () => {
    const channel = await make(nadia, { kind: 'channel', channelId: dev }, 'standup soon');
    expect(channel).toMatchObject({ targetKind: 'channel', person: null, channel: { id: dev, name: 'dev' } });
    const person = await make(nadia, { kind: 'person', personId: rafi.personId, channelId: dev }, 'review the PR');
    expect(person).toMatchObject({ targetKind: 'person', person: { id: rafi.personId, name: 'Rafi' }, channel: { id: dev } });

    // Tariq (Marketing) cannot post in an Engineering channel, so he cannot ask for a reminder there
    expect((await create(tariq, { kind: 'channel', channelId: dev }, 'not mine to post', at(10))).status).toBe(403);
    // Tariq cannot read #dev, so Nadia cannot remind him about it there
    const unreadable = await create(nadia, { kind: 'person', personId: tariq.personId, channelId: dev }, 'look at this', at(10));
    expect(unreadable.status).toBe(409);
    expect(JSON.stringify(unreadable.body)).toContain('cannot read this conversation');
    // yourself is `me`
    expect((await create(nadia, { kind: 'person', personId: nadia.personId, channelId: dev }, 'myself', at(10))).status).toBe(409);
    // a private channel: members only, on both sides
    const priv = await privateChannelWith('remind-private', nadia);
    ok(await create(omar, { kind: 'person', personId: nadia.personId, channelId: priv }, 'private and shared', at(10)), 201);
    expect((await create(omar, { kind: 'person', personId: rafi.personId, channelId: priv }, 'rafi is not in it', at(10))).status).toBe(409);
    expect((await create(priya, { kind: 'person', personId: nadia.personId, channelId: priv }, 'priya cannot read it', at(10))).status).toBe(409);
    expect((await create(priya, { kind: 'channel', channelId: priv }, 'priya cannot post in it', at(10))).status).toBe(403);
    // the person a reminder is for does not see the reminder
    expect((await list(rafi)).items.map((r) => r.id)).not.toContain(person.id);
  });

  it('writes `reminders.reminder.changed` with ids only', async () => {
    const mine = await make(nadia, { kind: 'person', personId: rafi.personId, channelId: dev }, 'SECRET-REMINDER-TEXT');
    const events = await changes(mine.id);
    expect(events.map((e) => e.change)).toEqual(['created']);
    expect(events[0]).toMatchObject({ reminderId: mine.id, creatorId: nadia.personId, targetKind: 'person', recipientId: rafi.personId });
    expect(JSON.stringify(events)).not.toContain('SECRET-REMINDER-TEXT');
    expect(await cancel(nadia, mine.id)).toBe(true);
    expect((await changes(mine.id)).map((e) => e.change)).toEqual(['created', 'cancelled']);
  });

  it('keeps 100 waiting reminders at most, with a sentence', async () => {
    await w.system(async (tx) => {
      await tx.query(
        `INSERT INTO app.reminders (workspace_id, creator_id, target_kind, text, remind_at)
         SELECT $1::uuid, $2::uuid, 'me', 'filler', now() + make_interval(mins => g) FROM generate_series(1, 100) g`,
        [sameera.workspaceId, sameera.personId],
      );
    });
    const res = await create(sameera, { kind: 'me' }, 'one too many', at(10));
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('100 reminders waiting');
    const listed = await list(sameera);
    expect(listed.items).toHaveLength(100);
    expect(listed.pendingCount).toBe(100);
    // cancelling one makes room
    expect(await cancel(sameera, listed.items[0]!.id)).toBe(true);
    ok(await create(sameera, { kind: 'me' }, 'now there is room', at(10)), 201);
  });
});

describe('what one person can be sent', () => {
  it('keeps 20 reminders waiting for one person at most, from all makers together, with a sentence; cancelling makes room', async () => {
    // Priya's twenty (written by the system role: its inserts are not counted against a person's own budget) fill Omar's allowance
    const fillers = await w.system(async (tx) => {
      const res = await tx.query<{ id: string }>(
        `INSERT INTO app.reminders (workspace_id, creator_id, target_kind, target_person_id, channel_id, text, remind_at)
         SELECT $1::uuid, $2::uuid, 'person', $3::uuid, $4::uuid, 'filler', now() + make_interval(mins => g) FROM generate_series(1, 20) g
         RETURNING id`,
        [priya.workspaceId, priya.personId, omar.personId, dev],
      );
      return res.rows.map((r) => r.id);
    });
    try {
      // Nadia has made none for Omar, and is well inside her own limits, yet the sentence refuses her: Omar cannot be flooded by many makers
      const res = await create(nadia, { kind: 'person', personId: omar.personId, channelId: dev }, 'one too many for Omar', at(10));
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('already has many reminders waiting');
      // the allowance is Omar's alone: other people are not affected, and Omar can still remind himself
      ok(await create(nadia, { kind: 'person', personId: rafi.personId, channelId: dev }, 'Rafi is not full', at(10)), 201);
      ok(await create(omar, { kind: 'me' }, 'Omar for himself', at(10)), 201);
      // one fewer waiting makes room for exactly one
      await w.system(async (tx) => {
        await tx.query(`UPDATE app.reminders SET state = 'cancelled' WHERE id = $1::uuid`, [fillers[0]]);
      });
      ok(await create(nadia, { kind: 'person', personId: omar.personId, channelId: dev }, 'room for one', at(10)), 201);
      expect((await create(nadia, { kind: 'person', personId: omar.personId, channelId: dev }, 'and now it is full again', at(10))).status).toBe(409);
    } finally {
      // they must not come due (and be delivered) while the later tests move the clock
      await w.system(async (tx) => {
        await tx.query(`UPDATE app.reminders SET state = 'cancelled' WHERE target_person_id = $1::uuid AND state = 'pending'`, [omar.personId]);
      });
    }
  });
});

describe('cancelling', () => {
  it('cancels a waiting reminder once; it moves to the history; nobody else can cancel it', async () => {
    const mine = await make(rafi, { kind: 'me' }, 'changed my mind');
    expect(await cancel(nadia, mine.id)).toBe(false);
    expect((await list(rafi)).items.map((r) => r.id)).toContain(mine.id);
    expect(await cancel(rafi, mine.id)).toBe(true);
    expect(await cancel(rafi, mine.id)).toBe(false);
    expect((await list(rafi)).items.map((r) => r.id)).not.toContain(mine.id);
    expect((await list(rafi, 'history')).items.find((r) => r.id === mine.id)).toMatchObject({ state: 'cancelled', sentAt: null });
  });

  it('a cancelled reminder is never delivered', async () => {
    const mine = await make(rafi, { kind: 'me' }, 'never delivered', 5);
    expect(await cancel(rafi, mine.id)).toBe(true);
    await sendAfter(10);
    expect((await list(rafi, 'history')).items.find((r) => r.id === mine.id)?.state).toBe('cancelled');
    const dm = await remindersDm(rafi);
    if (dm) expect((await messagesOf(rafi, dm.channel.id)).map((m) => m.body)).not.toContain('Reminder: never delivered');
  });
});

describe('delivery to the person themself', () => {
  it('waits for its time, then arrives once in the Reminders conversation from the "Reminders" sender, with one notification', async () => {
    const mine = await make(nadia, { kind: 'me' }, 'call mum back', 20);
    await send(); // not due yet
    expect((await list(nadia)).items.map((r) => r.id)).toContain(mine.id);

    await sendAfter(21);
    const sent = await settled(nadia, mine.id, 'sent');
    expect(sent.sentAt).not.toBeNull();
    await sendAfter(22); // a second run finds nothing left

    const dm = await eventually(() => remindersDm(nadia), 20_000, 'the Reminders conversation');
    expect(dm.channel).toMatchObject({ kind: 'dm', private: true, teamId: null, dmKey: `reminders:${nadia.personId}` });
    expect(dm.participants.map((p) => p.personId)).toEqual([nadia.personId]);
    const posted = (await messagesOf(nadia, dm.channel.id)).filter((m) => m.body === 'Reminder: call mum back');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.author).toMatchObject({ displayName: 'Reminders', kind: 'system', sender: 'reminders' });

    // one notification, of the kind reminder, for the posted message; the ordinary DM notification is not raised on top of it
    const mineOnMessage = (await inbox(nadia)).filter((n) => n.refId === posted[0]!.id);
    expect(mineOnMessage.map((n) => n.kind)).toEqual(['reminder']);
    expect(mineOnMessage[0]).toMatchObject({ refType: 'reminder', channelId: dm.channel.id, actorName: 'Reminders', preview: 'Reminder: call mum back', readAt: null });

    expect((await changes(mine.id)).map((e) => e.change)).toEqual(['created', 'sent']);
  });

  it('is held by Do not disturb until it ends', async () => {
    const mine = await make(priya, { kind: 'me' }, 'quiet please', 5);
    ok(await w.call(priya, 'PUT', '/api/presence/dnd', { enabled: true }));
    await sendAfter(10);
    await settled(priya, mine.id, 'sent');
    const dm = (await remindersDm(priya))!;
    const message = (await messagesOf(priya, dm.channel.id)).find((m) => m.body === 'Reminder: quiet please')!;
    expect((await inbox(priya)).some((n) => n.refId === message.id)).toBe(false);
    const held = await w.system(async (tx) => (await tx.query<{ held: boolean }>("SELECT held_at IS NOT NULL AS held FROM app.notifications WHERE person_id = $1 AND ref_id = $2 AND kind = 'reminder'", [priya.personId, message.id])).rows);
    expect(held).toEqual([{ held: true }]);
    ok(await w.call(priya, 'PUT', '/api/presence/dnd', { enabled: false }));
    await eventually(async () => ((await inbox(priya)).some((n) => n.refId === message.id && n.kind === 'reminder') ? true : undefined), 20_000, 'the held reminder');
  });
});

describe('delivery to another person and to a channel', () => {
  it('a reminder for a person arrives in THEIR Reminders conversation, under the maker\'s name, and the maker is not notified', async () => {
    const mine = await make(nadia, { kind: 'person', personId: rafi.personId, channelId: dev }, 'review the release PR', 15);
    await sendAfter(16);
    await settled(nadia, mine.id, 'sent');
    const dm = await eventually(() => remindersDm(rafi), 20_000, "Rafi's Reminders conversation");
    const posted = (await messagesOf(rafi, dm.channel.id)).filter((m) => m.body === 'Reminder from Nadia: `review the release PR`');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.author?.displayName).toBe('Reminders');
    expect((await inbox(rafi)).filter((n) => n.refId === posted[0]!.id).map((n) => n.kind)).toEqual(['reminder']);
    // Nadia is told nothing: no notification, and nothing in her own conversation
    expect((await inbox(nadia)).some((n) => n.preview.includes('review the release PR'))).toBe(false);
    const own = await remindersDm(nadia);
    if (own) expect((await messagesOf(nadia, own.channel.id)).some((m) => m.body.includes('review the release PR'))).toBe(false);
    const events = await changes(mine.id);
    expect(events.map((e) => e.change)).toEqual(['created', 'sent']);
    expect(events[1]).toMatchObject({ recipientId: rafi.personId, targetKind: 'person' });
  });

  it('a reminder for a channel is posted in the channel by the "Reminders" sender and pings nobody', async () => {
    const mine = await make(nadia, { kind: 'channel', channelId: dev }, 'standup in five, @rafi and @omar please join', 10);
    await sendAfter(11);
    await settled(nadia, mine.id, 'sent');
    const posted = (await messagesOf(rafi, dev)).find((m) => m.body === 'Reminder from Nadia: `standup in five, @rafi and @omar please join`');
    expect(posted).toBeDefined();
    expect(posted!.author).toMatchObject({ displayName: 'Reminders', kind: 'system', sender: 'reminders' });
    // the text of a reminder is not a mention, whoever it names
    for (const named of [rafi, omar]) expect((await inbox(named)).some((n) => n.refId === posted!.id && n.kind === 'mention')).toBe(false);
    const mentions = await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.message_mentions WHERE message_id = $1', [posted!.id])).rows[0]!.n);
    expect(mentions).toBe(0);
    expect((await inbox(nadia)).some((n) => n.refId === posted!.id)).toBe(false);
  });
});

describe('what another person wrote is shown as plain words', () => {
  it('a link in a reminder for someone else is not a link (no card is fetched under the sender), and a mention is not a mention', async () => {
    const text = 'read https://example.com/a?x=1 and [this](https://example.com/b), thanks @rafi';
    const mine = await make(nadia, { kind: 'channel', channelId: dev }, text, 10);
    await sendAfter(11);
    await settled(nadia, mine.id, 'sent');
    const posted = (await messagesOf(rafi, dev)).find((m) => m.body.includes('https://example.com/a?x=1'));
    expect(posted).toBeDefined();
    expect(posted!.body).toBe(`Reminder from Nadia: \`${text}\``);
    // the markup reader (the link-preview plugin's reader) finds no link and no mention in it
    const types = new Set(parseMarkup(posted!.body).tokens.map((t) => t.type));
    expect(types.has('url')).toBe(false);
    expect(types.has('mention')).toBe(false);
  });

  it('a text with backticks is still one code span, and a reminder for the maker themself stays as written', async () => {
    const tricky = await make(nadia, { kind: 'channel', channelId: dev }, 'run `ls` then ``cat`` https://example.com/c', 10);
    const own = await make(nadia, { kind: 'me' }, 'own note https://example.com/d', 10);
    await sendAfter(11);
    await settled(nadia, tricky.id, 'sent');
    await settled(nadia, own.id, 'sent');
    const posted = (await messagesOf(rafi, dev)).find((m) => m.body.includes('https://example.com/c'));
    expect(posted!.body).toBe('Reminder from Nadia: ```run `ls` then ``cat`` https://example.com/c```');
    const dm = await eventually(() => remindersDm(nadia), 20_000, "Nadia's Reminders conversation");
    expect((await messagesOf(nadia, dm.channel.id)).some((m) => m.body === 'Reminder: own note https://example.com/d')).toBe(true);
  });
});

describe('rights are checked again when the time comes', () => {
  it('a reminder for a channel whose maker can no longer post there is refused, with a sentence, and the maker is told', async () => {
    const priv = await privateChannelWith('remind-lost-post', nadia);
    const mine = await make(nadia, { kind: 'channel', channelId: priv }, 'announce the plan', 5);
    ok(await w.call(omar, 'DELETE', `/api/channels/${priv}/members/${nadia.personId}`));
    await sendAfter(10);
    const refused = await settled(nadia, mine.id, 'refused');
    expect(refused.refusedReason).toBe('You can no longer post in that channel.');
    expect((await messagesOf(omar, priv)).some((m) => m.body.includes('announce the plan'))).toBe(false);
    const dm = (await remindersDm(nadia))!;
    const notice = (await messagesOf(nadia, dm.channel.id)).find((m) => m.body.includes('announce the plan') && m.body.includes('was not sent'));
    expect(notice?.body).toBe('Your reminder “announce the plan” was not sent. You can no longer post in that channel.');
    expect((await inbox(nadia)).some((n) => n.refId === notice!.id && n.kind === 'reminder')).toBe(true);
    expect((await changes(mine.id)).map((e) => e.change)).toEqual(['created', 'refused']);
  });

  it('a reminder for a person who can no longer read the conversation is refused, never delivered around the rule', async () => {
    const priv = await privateChannelWith('remind-lost-read', nadia);
    const mine = await make(omar, { kind: 'person', personId: nadia.personId, channelId: priv }, 'see the private plan', 5);
    ok(await w.call(omar, 'DELETE', `/api/channels/${priv}/members/${nadia.personId}`));
    await sendAfter(10);
    const refused = await settled(omar, mine.id, 'refused');
    expect(refused.refusedReason).toBe('That person can no longer read the conversation this reminder was about.');
    const dm = await remindersDm(nadia);
    if (dm) expect((await messagesOf(nadia, dm.channel.id)).some((m) => m.body.includes('see the private plan') && !m.body.includes('was not sent'))).toBe(false);
  });
});
