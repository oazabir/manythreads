import { enqueue } from '@manythreads/kernel';
import { LATER_MAX_ITEMS, LaterItem, ListLaterResponse, ListNotificationsResponse, type Notification } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, drained, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, priya, lena } = personas;

// P14-04: Later and reminders through the HTTP routes. The clock the server reads (`ctx.runtime.now`) is moved by `skewMs`, so a reminder can
// "come due" without waiting.

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
const post = async (who: Persona, channelId: string, body: string): Promise<string> =>
  ok(await w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null }), 201).id;
const save = (who: Persona, messageId: string, body: unknown = {}): Promise<ApiResult<LaterItem>> => w.call(who, 'PUT', `/api/later/messages/${messageId}`, body);
const list = async (who: Persona, state: 'open' | 'done' = 'open'): Promise<ListLaterResponse> => ListLaterResponse.parse(ok(await w.call(who, 'GET', `/api/later?state=${state}`)));
const inbox = async (who: Persona): Promise<Notification[]> => ListNotificationsResponse.parse(ok(await w.call(who, 'GET', '/api/notifications'))).items;
/** Runs the reminders job once and waits for it, then for the notifications it caused. */
const fire = async (): Promise<void> => {
  const id = await w.system(async (tx) => (await enqueue(tx, 'reminders.fire_due', {})).id);
  await eventually(
    async () => {
      const row = (await w.system(async (tx) => (await tx.query<{ state: string; last_error: string | null }>('SELECT state, last_error FROM app.jobs WHERE id = $1', [id])).rows[0]))!;
      expect(row.last_error).toBeNull();
      return row.state === 'done' ? true : undefined;
    },
    20_000,
    'the reminders job',
  );
  await drained(w);
};
const dueEventsFor = async (messageId: string): Promise<number> =>
  w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'reminders.reminder.due' AND payload->>'messageId' = $1", [messageId])).rows[0]!.n);
const dueEvents = async (who: Persona): Promise<number> =>
  w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'reminders.reminder.due' AND payload->>'personId' = $1", [who.personId])).rows[0]!.n);

describe('saving a message for later', () => {
  it('marks a message with no time: 201 with the item, the snippet, author and channel; saving again is a 200 and no second row', async () => {
    const id = await post(nadia, dev, 'Please look at the **release notes** before Friday');
    const created = LaterItem.parse(ok(await save(rafi, id), 201));
    expect(created).toMatchObject({ messageId: id, state: 'open', remindAt: null, due: false, doneAt: null });
    expect(created.message).toMatchObject({ authorName: 'Nadia', snippet: 'Please look at the release notes before Friday', threadRootId: null });
    expect(created.message?.channel).toMatchObject({ name: 'dev', kind: 'channel' });
    const again = LaterItem.parse(ok(await save(rafi, id), 200));
    expect(again.id).toBe(created.id);
    expect((await list(rafi)).items.filter((i) => i.messageId === id)).toHaveLength(1);
  });

  it('is private: the list of another person never holds it, an admin included', async () => {
    const id = await post(nadia, dev, 'only for rafi to keep');
    await save(rafi, id);
    expect((await list(rafi)).items.some((i) => i.messageId === id)).toBe(true);
    expect((await list(nadia)).items.some((i) => i.messageId === id)).toBe(false);
    expect((await list(omar)).items.some((i) => i.messageId === id)).toBe(false);
  });

  it('keeps the thread root of a reply so it can be opened in its thread', async () => {
    const root = await post(nadia, dev, 'a root');
    const reply = ok(await w.call<{ id: string }>(rafi, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'a reply', threadRootId: root }), 201).id;
    const item = LaterItem.parse(ok(await save(rafi, reply), 201));
    expect(item.message?.threadRootId).toBe(root);
  });

  it('refuses a message the person cannot read, a deleted one, a bot, and no session', async () => {
    const created = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'later-private', private: true }), 201);
    const priv = created.channel.id;
    const secret = await post(omar, priv, 'a secret plan');
    expect((await save(priya, secret)).status).toBe(403);
    expect((await save(rafi, '0190a000-0000-7000-8000-00000000dead')).status).toBe(403);
    const gone = await post(nadia, dev, 'soon deleted');
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${gone}`));
    expect((await save(rafi, gone)).status).toBe(404);
    expect((await save(null as never, secret)).status).toBe(401);
    expect((await w.call(null, 'GET', '/api/later')).status).toBe(401);
  });

  it('a guest can save a message of a channel they were let into, and nothing else', async () => {
    const guestChannel = await w.system(async (tx) => (await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.channel_members WHERE person_id = $1 LIMIT 1', [lena.personId])).rows[0]?.channel_id);
    if (!guestChannel) return;
    const id = await post(omar, guestChannel, 'for the guest');
    ok(await save(lena, id), 201);
    expect((await save(lena, await post(nadia, dev, 'not for guests'))).status).toBe(403);
  });
});

describe('reminder times are checked on the server', () => {
  it('accepts a time ahead, shows it, and refuses the past, more than a year ahead, and a malformed time', async () => {
    const id = await post(nadia, dev, 'remind me later');
    const item = LaterItem.parse(ok(await save(rafi, id, { remindAt: at(20) }), 201));
    expect(item.remindAt).toBe(at(20).slice(0, 17) + item.remindAt!.slice(17)); // same minute
    expect(item.due).toBe(false);
    const other = await post(nadia, dev, 'another');
    expect((await save(rafi, other, { remindAt: at(-30) })).status).toBe(400);
    expect((await save(rafi, other, { remindAt: at(60 * 24 * 366) })).status).toBe(400);
    expect((await save(rafi, other, { remindAt: 'tomorrow' })).status).toBe(400);
    expect((await save(rafi, other, { remindAt: at(5), extra: 1 })).status).toBe(400);
    expect((await list(rafi)).items.some((i) => i.messageId === other)).toBe(false);
    // a few seconds in the past is slack, not an error, and counts as now
    const near = LaterItem.parse(ok(await save(rafi, other, { remindAt: new Date(clock().getTime() - 20_000).toISOString() }), 201));
    expect(near.due).toBe(true);
  });

  it('saving again with a time moves the reminder, without a time keeps it, with null clears it', async () => {
    const id = await post(nadia, dev, 'moving reminder');
    const first = LaterItem.parse(ok(await save(priya, id, { remindAt: at(30) }), 201));
    const moved = LaterItem.parse(ok(await save(priya, id, { remindAt: at(90) })));
    expect(Date.parse(moved.remindAt!)).toBeGreaterThan(Date.parse(first.remindAt!));
    expect(LaterItem.parse(ok(await save(priya, id, {}))).remindAt).toBe(moved.remindAt);
    expect(LaterItem.parse(ok(await save(priya, id, { remindAt: null }))).remindAt).toBeNull();
  });
});

describe('the list', () => {
  it('shows due reminders first, then the rest newest first, with counts; done ones have a list of their own', async () => {
    const a = await post(nadia, dev, 'list a');
    const b = await post(nadia, dev, 'list b');
    const c = await post(nadia, dev, 'list c');
    const d = await post(nadia, dev, 'list d');
    ok(await save(omar, a), 201);
    ok(await save(omar, b, { remindAt: at(10) }), 201);
    ok(await save(omar, c, { remindAt: at(5) }), 201);
    const dItem = LaterItem.parse(ok(await save(omar, d), 201));
    skewMs = 8 * MINUTE;        // c is due, b is not
    try {
      const res = await list(omar);
      const ids: string[] = res.items.map((i) => i.messageId);
      expect(ids.slice(0, 1)).toEqual([c]);
      expect(res.items[0]!.due).toBe(true);
      expect(ids.indexOf(d)).toBeLessThan(ids.indexOf(a));          // newest first among the rest
      expect(res.dueCount).toBe(1);
      expect(res.openCount).toBe(res.items.length);
    } finally {
      skewMs = 0;
    }
    ok(await w.call(omar, 'PATCH', `/api/later/items/${dItem.id}`, { state: 'done' }));
    expect((await list(omar)).items.some((i) => i.messageId === d)).toBe(false);
    const done = await list(omar, 'done');
    expect(done.items.map((i) => i.messageId)).toContain(d);
    expect(done.items.find((i) => i.messageId === d)).toMatchObject({ state: 'done', due: false });
    ok(await w.call(omar, 'PATCH', `/api/later/items/${dItem.id}`, { state: 'open' }));
    expect((await list(omar)).items.some((i) => i.messageId === d)).toBe(true);
  });

  it('a person changes and removes only their own items', async () => {
    const id = await post(nadia, dev, 'mine alone');
    const item = LaterItem.parse(ok(await save(rafi, id), 201));
    expect((await w.call(nadia, 'PATCH', `/api/later/items/${item.id}`, { state: 'done' })).status).toBe(404);
    expect((await w.call(nadia, 'DELETE', `/api/later/items/${item.id}`)).status).toBe(404);
    expect((await w.call(rafi, 'PATCH', `/api/later/items/${item.id}`, { state: 'sleeping' })).status).toBe(400);
    ok(await w.call(rafi, 'DELETE', `/api/later/items/${item.id}`));
    expect((await w.call(rafi, 'DELETE', `/api/later/items/${item.id}`)).status).toBe(404);
  });
});

describe('what is shown when the message is no longer there', () => {
  it('a deleted message: the item stays, says it is not available and carries none of its text', async () => {
    const id = await post(nadia, dev, 'TOP-SECRET-CANARY words');
    const item = LaterItem.parse(ok(await save(rafi, id, { remindAt: at(5) }), 201));
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${id}`));
    const after = (await list(rafi)).items.find((i) => i.id === item.id)!;
    expect(after.message).toBeNull();
    expect(JSON.stringify(after)).not.toContain('CANARY');
    ok(await w.call(rafi, 'DELETE', `/api/later/items/${item.id}`));
  });

  it('a private channel the person left: no text, no author, no channel name, and a PATCH or DELETE still works', async () => {
    const created = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'later-short-lived', private: true }), 201);
    const priv = created.channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: rafi.personId }));
    const id = await post(omar, priv, 'PRIVATE-CANARY-TEXT');
    const item = LaterItem.parse(ok(await save(rafi, id), 201));
    expect(item.message?.snippet).toBe('PRIVATE-CANARY-TEXT');
    ok(await w.call(omar, 'DELETE', `/api/channels/${priv}/members/${rafi.personId}`));
    const body = JSON.stringify(ok(await w.call(rafi, 'GET', '/api/later')));
    expect(body).toContain(item.id);
    expect(body).not.toMatch(/PRIVATE-CANARY|later-short-lived|Omar/);
    expect((await list(rafi)).items.find((i) => i.id === item.id)?.message).toBeNull();
    ok(await w.call(rafi, 'PATCH', `/api/later/items/${item.id}`, { state: 'done' }));
    ok(await w.call(rafi, 'DELETE', `/api/later/items/${item.id}`));
  });
});

describe('the limit', () => {
  it(`keeps at most ${LATER_MAX_ITEMS} items per person: a full list makes room by dropping the oldest finished one, else says so`, async () => {
    // Tariq leads Marketing and has saved nothing yet; his list is filled straight in the database (200 rows) through the system role
    const tariq = personas.tariq;
    const channel = await w.channelId('marketing', 'campaigns');
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await post(tariq, channel, `bulk ${i}`));
    const firstMessage = ids[0]!;
    await w.system(async (tx) => {
      await tx.query(
        `INSERT INTO app.later_items (workspace_id, person_id, message_id, channel_id, state, done_at)
         SELECT $1::uuid, $2::uuid, uuidv7(), $3::uuid, 'done', now() - make_interval(secs => g) FROM generate_series(1, $4::int) g`,
        [tariq.workspaceId, tariq.personId, channel, LATER_MAX_ITEMS],
      );
    });
    // all finished: saving a new one drops the oldest finished item and succeeds
    ok(await save(tariq, firstMessage), 201);
    expect((await list(tariq, 'done')).items).toHaveLength(LATER_MAX_ITEMS - 1);
    // now make every item open: a new save is refused with a sentence
    await w.system(async (tx) => {
      await tx.query("UPDATE app.later_items SET state = 'open', done_at = NULL WHERE person_id = $1", [tariq.personId]);
    });
    const res = await save(tariq, ids[1]!);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('200 saved items');
    // saving a message that is already on the list is a change, not an addition, so it still works
    ok(await save(tariq, firstMessage, { remindAt: at(15) }));
  });
});

describe('a due reminder', () => {
  it('fires once: one event, one notification of kind reminder, the item due; nothing more on the next runs', async () => {
    const id = await post(nadia, dev, 'Ship the thing by noon');
    const item = LaterItem.parse(ok(await save(rafi, id, { remindAt: at(20) }), 201));
    await fire();                                                    // this one is not due yet
    expect(await dueEventsFor(id)).toBe(0);
    expect((await inbox(rafi)).some((n) => n.kind === 'reminder' && n.refId === id)).toBe(false);

    skewMs = 21 * MINUTE;
    try {
      await fire();
      await fire();                                                  // a second run finds nothing left
      expect(await dueEventsFor(id)).toBe(1);
      const reminders = (await inbox(rafi)).filter((n) => n.kind === 'reminder' && n.refId === id);
      expect(reminders).toHaveLength(1);
      expect(reminders[0]).toMatchObject({ refType: 'reminder', refId: id, channelId: dev, actorName: 'Nadia', preview: 'Ship the thing by noon', readAt: null });
      expect((await list(rafi)).items.find((i) => i.id === item.id)).toMatchObject({ due: true, state: 'open' });
      // nobody else is told
      expect((await inbox(nadia)).some((n) => n.kind === 'reminder' && n.refId === id)).toBe(false);
      expect((await inbox(priya)).some((n) => n.kind === 'reminder' && n.refId === id)).toBe(false);
    } finally {
      skewMs = 0;
    }
  });

  it('a done item does not fire; moving a fired reminder lets it fire again', async () => {
    const id = await post(nadia, dev, 'done before its time');
    const item = LaterItem.parse(ok(await save(priya, id, { remindAt: at(5) }), 201));
    ok(await w.call(priya, 'PATCH', `/api/later/items/${item.id}`, { state: 'done' }));
    const before = await dueEvents(priya);
    skewMs = 10 * MINUTE;
    try {
      await fire();
      expect(await dueEvents(priya)).toBe(before);
      ok(await w.call(priya, 'PATCH', `/api/later/items/${item.id}`, { state: 'open' }));
      await fire();
      expect(await dueEvents(priya)).toBe(before + 1);                // reopened, and its time had passed
      ok(await save(priya, id, { remindAt: at(30) }));
      await fire();
      expect(await dueEvents(priya)).toBe(before + 1);                // new time, not yet
      skewMs = 45 * MINUTE;
      await fire();
      expect(await dueEvents(priya)).toBe(before + 2);
    } finally {
      skewMs = 0;
    }
  });

  it('a deleted message fires to nobody; lost access to the channel becomes no notification: the item is only marked and no text shows', async () => {
    const created = ok(await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'later-fire-private', private: true }), 201);
    const priv = created.channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${priv}/members`, { personId: priya.personId }));
    const hidden = await post(omar, priv, 'HIDDEN-REMINDER-TEXT');
    const deleted = await post(nadia, dev, 'DELETED-REMINDER-TEXT');
    const a = LaterItem.parse(ok(await save(priya, hidden, { remindAt: at(5) }), 201));
    const b = LaterItem.parse(ok(await save(priya, deleted, { remindAt: at(5) }), 201));
    ok(await w.call(omar, 'DELETE', `/api/channels/${priv}/members/${priya.personId}`));
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${deleted}`));
    const events = await dueEvents(priya);
    const notified = (await inbox(priya)).length;
    skewMs = 10 * MINUTE;
    try {
      await fire();
    } finally {
      skewMs = 0;
    }
    expect(await dueEvents(priya)).toBe(events + 1);                 // the lost channel is announced by id only; the deleted message is not
    expect(await inbox(priya)).toHaveLength(notified);                // and neither becomes a notification
    const fired = await w.system(async (tx) => (await tx.query<{ id: string; fired: boolean }>('SELECT id, fired_at IS NOT NULL AS fired FROM app.later_items WHERE id = ANY ($1::uuid[])', [[a.id, b.id]])).rows);
    expect(fired.every((r) => r.fired)).toBe(true);
    const shown = JSON.stringify(ok(await w.call(priya, 'GET', '/api/later')));
    expect(shown).not.toMatch(/HIDDEN-REMINDER|DELETED-REMINDER/);
  });

  it('a reminder notification disappears with its message and with access to the channel', async () => {
    const id = await post(nadia, dev, 'will be deleted after the reminder');
    ok(await save(omar, id, { remindAt: at(5) }), 201);
    skewMs = 10 * MINUTE;
    try {
      await fire();
    } finally {
      skewMs = 0;
    }
    expect((await inbox(omar)).some((n) => n.refId === id && n.kind === 'reminder')).toBe(true);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${id}`));
    await drained(w);
    expect((await inbox(omar)).some((n) => n.refId === id)).toBe(false);
  });
});

describe('a reminder is something the person asked for', () => {
  it('arrives although the channel is set to "nothing", and is held by Do not disturb until it ends', async () => {
    ok(await w.call(priya, 'PUT', `/api/notifications/levels/${dev}`, { level: 'nothing' }));
    const id = await post(rafi, dev, 'quiet channel, loud reminder');
    ok(await save(priya, id, { remindAt: at(5) }), 201);
    ok(await w.call(priya, 'PUT', '/api/presence/dnd', { enabled: true }));
    skewMs = 10 * MINUTE;
    try {
      await fire();
    } finally {
      skewMs = 0;
    }
    expect((await inbox(priya)).some((n) => n.refId === id)).toBe(false);           // held, not listed
    const held = await w.system(async (tx) => (await tx.query<{ held: boolean }>('SELECT held_at IS NOT NULL AS held FROM app.notifications WHERE person_id = $1 AND ref_id = $2 AND kind = $3', [priya.personId, id, 'reminder'])).rows);
    expect(held).toEqual([{ held: true }]);
    ok(await w.call(priya, 'PUT', '/api/presence/dnd', { enabled: false }));
    await eventually(async () => ((await inbox(priya)).some((n) => n.refId === id && n.kind === 'reminder') ? true : undefined), 20_000, 'the held reminder');
    ok(await w.call(priya, 'PUT', `/api/notifications/levels/${dev}`, { level: null }));
  });

  it('a mention and a reminder on one message are two notifications', async () => {
    const id = await post(nadia, dev, 'hello @rafi please look');
    ok(await save(rafi, id, { remindAt: at(5) }), 201);
    skewMs = 10 * MINUTE;
    try {
      await fire();
    } finally {
      skewMs = 0;
    }
    const mine = (await inbox(rafi)).filter((n) => n.refId === id);
    expect(mine.map((n) => n.kind).sort()).toEqual(['mention', 'reminder']);
  });
});
