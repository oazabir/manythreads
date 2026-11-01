import { enqueue, eventToRaw, type EventRow } from '@manythreads/kernel';
import { ChannelScheduledMessageChangedEvent, ListMessagesResponse, ListScheduledResponse, ScheduledMessage, parseEvent } from '@manythreads/shared';
import { ownerSql } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

// P14-05: scheduled send through the HTTP routes and the minute job. The clock the server reads (`ctx.runtime.now`) is moved by `skewMs`, so a
// message can come due without waiting; DB-backed, so it runs on the devbox when no CI run shares the database.

const { omar, nadia, rafi, lena } = personas;
const MINUTE = 60_000;

let skewMs = 0;
const clock = (): Date => new Date(Date.now() + skewMs);
const at = (minutes: number): string => new Date(Date.now() + minutes * MINUTE).toISOString();

let w: World;
let dev = '';
beforeAll(async () => {
  w = await createWorld({ now: clock });
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  await w.call(nadia, 'POST', `/api/channels/${dev}/join`);
  await w.call(rafi, 'POST', `/api/channels/${dev}/join`);
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const schedule = (who: Persona, channelId: string, body: Record<string, unknown>) => w.call<ScheduledMessage>(who, 'POST', `/api/channels/${channelId}/scheduled-messages`, body);
const list = async (who: Persona, channelId: string): Promise<ScheduledMessage[]> =>
  ListScheduledResponse.parse(ok(await w.call(who, 'GET', `/api/channels/${channelId}/scheduled-messages`))).items;
const messages = async (who: Persona, channelId: string): Promise<string[]> =>
  ListMessagesResponse.parse(ok(await w.call(who, 'GET', `/api/channels/${channelId}/messages`))).items.map((m) => m.body);
/** Runs the send job once and waits for it. */
const send = async (): Promise<void> => {
  const id = await w.system(async (tx) => (await enqueue(tx, 'channels.send_scheduled', {})).id);
  await eventually(
    async () => {
      const row = (await w.system(async (tx) => (await tx.query<{ state: string; last_error: string | null }>('SELECT state, last_error FROM app.jobs WHERE id = $1', [id])).rows[0]))!;
      expect(row.last_error).toBeNull();
      return row.state === 'done' ? true : undefined;
    },
    20_000,
    'the send job',
  );
};
const changes = (scheduledId: string): Promise<ChannelScheduledMessageChangedEvent[]> =>
  w.system(async (tx) => {
    const rows = (
      await tx.query<EventRow>(
        `SELECT id, occurred_at, workspace_id, team_id, actor_id, type, schema_version, payload FROM app.events
          WHERE type = 'channel.scheduled_message.changed' AND payload->>'scheduledId' = $1 ORDER BY id`,
        [scheduledId],
      )
    ).rows;
    return rows.map((r) => ChannelScheduledMessageChangedEvent.parse(parseEvent(eventToRaw(r))));
  });

describe('scheduling a message', () => {
  it('201 with the scheduled message; only its author lists it', async () => {
    const created = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'Later, **bold**', sendAt: at(30) }), 201));
    expect(created).toMatchObject({ channelId: dev, threadRootId: null, body: 'Later, **bold**', state: 'scheduled', refusedReason: null });
    expect((await list(nadia, dev)).map((m) => m.id)).toContain(created.id);
    expect((await list(rafi, dev)).map((m) => m.id)).not.toContain(created.id);
    expect((await list(omar, dev)).map((m) => m.id)).not.toContain(created.id);
    // nothing is posted yet
    expect(await messages(rafi, dev)).not.toContain('Later, **bold**');
    expect((await changes(created.id)).map((e) => e.change)).toEqual(['scheduled']);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${created.id}`));
  });

  it('refuses a time in the past, a time more than a year ahead, an empty text and an unknown field', async () => {
    expect((await schedule(nadia, dev, { body: 'x', sendAt: at(-10) })).status).toBe(400);
    expect((await schedule(nadia, dev, { body: 'x', sendAt: at(400 * 24 * 60) })).status).toBe(400);
    expect((await schedule(nadia, dev, { body: '   ', sendAt: at(10) })).status).toBe(400);
    expect((await schedule(nadia, dev, { body: 'x', sendAt: at(10), attachments: [] })).status).toBe(400);
  });

  it('is refused for someone who cannot post there, who cannot see it, or who is not signed in', async () => {
    expect((await schedule(lena, dev, { body: 'x', sendAt: at(10) })).status).toBe(403);
    expect((await w.call(null, 'GET', `/api/channels/${dev}/scheduled-messages`)).status).toBe(401);
    const hidden = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'sched-private', private: true }), 201).channel.id;
    expect((await schedule(rafi, hidden, { body: 'x', sendAt: at(10) })).status).toBe(403);
    // listing asks for no right to read the channel (a draft of someone who lost access must stay findable); it only ever shows the caller's own rows
    expect(await list(rafi, hidden)).toEqual([]);
  });

  it('a bot has no scheduled messages: every route answers 403 for a bot, and 401 without a sign-in', async () => {
    const botHeader = JSON.stringify({ kind: 'bot', id: '00000000-0000-7000-8000-00000000b077', workspaceId: nadia.workspaceId });
    const asBot = async (method: string, path: string, body?: unknown): Promise<number> =>
      (
        await fetch(`${w.server.url}${path}`, {
          method,
          headers: { 'x-manythreads-dev-actor': botHeader, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        })
      ).status;
    const item = '00000000-0000-7000-8000-0000000000cc';
    expect(await asBot('GET', `/api/channels/${dev}/scheduled-messages`)).toBe(403);
    expect(await asBot('GET', '/api/scheduled-messages')).toBe(403);
    expect(await asBot('POST', `/api/channels/${dev}/scheduled-messages`, { body: 'x', sendAt: at(10) })).toBe(403);
    expect(await asBot('PATCH', `/api/channels/${dev}/scheduled-messages/${item}`, { body: 'x' })).toBe(403);
    expect(await asBot('DELETE', `/api/channels/${dev}/scheduled-messages/${item}`)).toBe(403);
    for (const [method, path] of [['GET', '/api/scheduled-messages'], ['POST', `/api/channels/${dev}/scheduled-messages`], ['PATCH', `/api/channels/${dev}/scheduled-messages/${item}`], ['DELETE', `/api/channels/${dev}/scheduled-messages/${item}`]] as const) {
      expect((await w.call(null, method, path, method === 'POST' || method === 'PATCH' ? { body: 'x', sendAt: at(10) } : undefined)).status, `${method} ${path}`).toBe(401);
    }
  });

  it('the list of every channel shows only the caller\'s own messages, from any channel', async () => {
    const a = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'all-list one', sendAt: at(50) }), 201));
    const all = ListScheduledResponse.parse(ok(await w.call(nadia, 'GET', '/api/scheduled-messages'))).items.map((m) => m.id);
    expect(all).toContain(a.id);
    expect(ListScheduledResponse.parse(ok(await w.call(rafi, 'GET', '/api/scheduled-messages'))).items.map((m) => m.id)).not.toContain(a.id);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${a.id}`));
  });

  it('a reply in a thread needs its first message to exist', async () => {
    const root = ok<{ id: string }>(await w.call(rafi, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'thread root', threadRootId: null }), 201).id;
    const reply = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'a reply', sendAt: at(5), threadRootId: root }), 201));
    expect(reply.threadRootId).toBe(root);
    expect((await schedule(nadia, dev, { body: 'x', sendAt: at(5), threadRootId: '00000000-0000-7000-8000-0000000000aa' })).status).toBe(404);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${reply.id}`));
  });

  it('keeps at most 100 per person', async () => {
    // filled by SQL: the schedule route is rate limited to 60 a minute
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.scheduled_messages (workspace_id, channel_id, author_id, body, send_at)
         SELECT $1, $2, $3, 'cap ' || g, now() + interval '10 days' FROM generate_series(1, 100) g`,
        [rafi.workspaceId, dev, rafi.actorId],
      ),
    );
    const over = await schedule(rafi, dev, { body: 'one too many', sendAt: at(900) });
    expect(over.status).toBe(409);
    expect(JSON.stringify(over.body)).toMatch(/100 scheduled messages/);
    await w.system((tx) => tx.query("DELETE FROM app.scheduled_messages WHERE author_id = $1 AND body LIKE 'cap %'", [rafi.actorId]));
  });
});

describe('editing and cancelling', () => {
  it('an edit changes the text and the time; another person gets 404; cancelling twice is fine', async () => {
    const m = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'draft one', sendAt: at(20) }), 201));
    const when = at(45);
    const edited = ScheduledMessage.parse(ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/scheduled-messages/${m.id}`, { body: 'draft two', sendAt: when })));
    expect(edited).toMatchObject({ id: m.id, body: 'draft two', sendAt: when });
    expect((await w.call(rafi, 'PATCH', `/api/channels/${dev}/scheduled-messages/${m.id}`, { body: 'mine now' })).status).toBe(404);
    expect((await w.call(rafi, 'DELETE', `/api/channels/${dev}/scheduled-messages/${m.id}`)).body).toEqual({ cancelled: false });
    expect(ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${m.id}`))).toEqual({ cancelled: true });
    expect(ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${m.id}`))).toEqual({ cancelled: false });
    expect((await list(nadia, dev)).map((x) => x.id)).not.toContain(m.id);
    expect((await changes(m.id)).map((e) => e.change)).toEqual(['scheduled', 'edited', 'cancelled']);
  });

  it('an edit to the past is refused', async () => {
    const m = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'keep', sendAt: at(20) }), 201));
    expect((await w.call(nadia, 'PATCH', `/api/channels/${dev}/scheduled-messages/${m.id}`, { sendAt: at(-30) })).status).toBe(400);
    expect((await w.call(nadia, 'PATCH', `/api/channels/${dev}/scheduled-messages/${m.id}`, {})).status).toBe(400);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${m.id}`));
  });
});

describe('the send job', () => {
  it('posts a due message as its author, once, even when the job runs twice; a message not yet due waits; a cancelled one is never posted', async () => {
    const due = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'DUE-CANARY text', sendAt: at(10) }), 201));
    const later = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'LATER-CANARY text', sendAt: at(120) }), 201));
    const gone = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'GONE-CANARY text', sendAt: at(10) }), 201));
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${gone.id}`));
    skewMs = 15 * MINUTE;
    try {
      await send();
      await send();
    } finally {
      skewMs = 0;
    }
    const posted = ListMessagesResponse.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages`))).items.filter((m) => m.body === 'DUE-CANARY text');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.authorId).toBe(nadia.actorId);
    expect(await messages(rafi, dev)).not.toContain('LATER-CANARY text');
    expect(await messages(rafi, dev)).not.toContain('GONE-CANARY text');
    // the row is gone once sent; the later one still waits
    const mine = (await list(nadia, dev)).map((m) => m.id);
    expect(mine).not.toContain(due.id);
    expect(mine).toContain(later.id);
    const sent = (await changes(due.id)).map((e) => e.change);
    expect(sent).toEqual(['scheduled', 'sent']);
    const event = (await changes(due.id))[1]!;
    expect(event).toMatchObject({ messageId: posted[0]!.id, authorId: nadia.actorId });
    // the event log never carries the text, the time or a reason (it is readable by the team; the draft is private to its author)
    const raw = await w.system(async (tx) => JSON.stringify((await tx.query("SELECT payload FROM app.events WHERE type = 'channel.scheduled_message.changed'")).rows));
    expect(raw).not.toMatch(/CANARY/);
    expect(raw).not.toMatch(/sendAt|reason/);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${later.id}`));
  });

  it('a reply is posted into its thread', async () => {
    const root = ok<{ id: string }>(await w.call(rafi, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'root for scheduled reply', threadRootId: null }), 201).id;
    ok(await schedule(nadia, dev, { body: 'scheduled reply', sendAt: at(5), threadRootId: root }), 201);
    skewMs = 10 * MINUTE;
    try {
      await send();
    } finally {
      skewMs = 0;
    }
    const replies = ListMessagesResponse.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages?threadRootId=${root}`))).items;
    expect(replies.map((m) => m.body)).toEqual(['scheduled reply']);
    expect(replies[0]!.authorId).toBe(nadia.actorId);
  });

  it('checks again that the author may still post: an archived channel refuses, the draft comes back with the reason, and an edit schedules it again', async () => {
    const ch = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'sched-archive' }), 201).channel.id;
    await w.call(nadia, 'POST', `/api/channels/${ch}/join`);
    const m = ScheduledMessage.parse(ok(await schedule(nadia, ch, { body: 'ARCHIVED-CANARY text', sendAt: at(10) }), 201));
    ok(await w.call(omar, 'POST', `/api/channels/${ch}/archive`));
    skewMs = 15 * MINUTE;
    try {
      await send();
      const refused = (await list(nadia, ch)).find((x) => x.id === m.id)!;
      expect(refused).toMatchObject({ state: 'refused', body: 'ARCHIVED-CANARY text', refusedReason: 'This channel is archived' });
      expect(refused.refusedAt).not.toBeNull();
      expect(await messages(omar, ch)).toEqual([]);
      const [, last] = await changes(m.id);
      expect(last).toMatchObject({ change: 'refused', authorId: nadia.actorId });
      // the next run leaves a refused message alone
      await send();
      expect((await changes(m.id)).map((e) => e.change)).toEqual(['scheduled', 'refused']);
      // still archived: editing it to a new time is refused until the channel is open again
      expect((await w.call(nadia, 'PATCH', `/api/channels/${ch}/scheduled-messages/${m.id}`, { sendAt: at(30 + 15) })).status).toBe(409);
      ok(await w.call(omar, 'POST', `/api/channels/${ch}/unarchive`));
      const again = ScheduledMessage.parse(ok(await w.call(nadia, 'PATCH', `/api/channels/${ch}/scheduled-messages/${m.id}`, { sendAt: new Date(Date.now() + 20 * MINUTE).toISOString() })));
      expect(again).toMatchObject({ state: 'scheduled', refusedReason: null, refusedAt: null });
      skewMs = 40 * MINUTE;
      await send();
    } finally {
      skewMs = 0;
    }
    expect(await messages(omar, ch)).toEqual(['ARCHIVED-CANARY text']);
    expect((await changes(m.id)).map((e) => e.change)).toEqual(['scheduled', 'refused', 'edited', 'sent']);
  });

  it('an author who left the channel is refused, and the text is not lost', async () => {
    const ch = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'sched-private-left', private: true }), 201).channel.id;
    ok(await w.call(omar, 'POST', `/api/channels/${ch}/members`, { personId: rafi.personId }));
    const m = ScheduledMessage.parse(ok(await schedule(rafi, ch, { body: 'LEFT-CANARY text', sendAt: at(5) }), 201));
    ok(await w.call(omar, 'DELETE', `/api/channels/${ch}/members/${rafi.personId}`));
    skewMs = 10 * MINUTE;
    try {
      await send();
    } finally {
      skewMs = 0;
    }
    expect(await messages(omar, ch)).toEqual([]);
    // the channel is hidden from them now, yet the draft is still theirs to find, in the channel's list and in the list of every channel
    const left = (await list(rafi, ch)).find((x) => x.id === m.id);
    expect(left).toMatchObject({ state: 'refused', body: 'LEFT-CANARY text' });
    expect(left?.refusedReason).toMatch(/cannot see this channel/);
    expect(ListScheduledResponse.parse(ok(await w.call(rafi, 'GET', '/api/scheduled-messages'))).items.map((x) => x.id)).toContain(m.id);
    // they cannot edit it (no right to post there) ...
    expect((await w.call(rafi, 'PATCH', `/api/channels/${ch}/scheduled-messages/${m.id}`, { body: 'again' })).status).toBe(403);
    // ... but they can dismiss it, and the event still names the team although they cannot read the channel
    expect(ok(await w.call(rafi, 'DELETE', `/api/channels/${ch}/scheduled-messages/${m.id}`))).toEqual({ cancelled: true });
    const team = await w.system(async (tx) => (await tx.query<{ team_id: string }>("SELECT id AS team_id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.team_id);
    expect((await changes(m.id)).map((e) => [e.change, e.teamId])).toEqual([['scheduled', team], ['refused', team], ['cancelled', team]]);
  });
});

// ---- the cases a reviewer asked for: what the job does when the post cannot be made, and when someone else is changing the row ----

const rowOf = (id: string) =>
  w.system(async (tx) =>
    (await tx.query<{ state: string; attempts: number; refused_reason: string | null; send_at: Date }>('SELECT state, attempts, refused_reason, send_at FROM app.scheduled_messages WHERE id = $1', [id])).rows[0],
  );
const runAt = async (minutes: number): Promise<void> => {
  skewMs = minutes * MINUTE;
  try {
    await send();
  } finally {
    skewMs = 0;
  }
};

describe('a post that cannot be made at send time', () => {
  it('a reply whose thread\'s first message was deleted meanwhile is refused with the reason, and the text is kept', async () => {
    const root = ok<{ id: string }>(await w.call(rafi, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'root to delete', threadRootId: null }), 201).id;
    const m = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'ROOTGONE-CANARY reply', sendAt: at(5), threadRootId: root }), 201));
    ok(await w.call(rafi, 'DELETE', `/api/channels/${dev}/messages/${root}`));
    await runAt(10);
    const refused = (await list(nadia, dev)).find((x) => x.id === m.id)!;
    expect(refused).toMatchObject({ state: 'refused', body: 'ROOTGONE-CANARY reply', threadRootId: root });
    expect(refused.refusedReason).toMatch(/deleted/i);
    const replies = ListMessagesResponse.parse(ok(await w.call(rafi, 'GET', `/api/channels/${dev}/messages?threadRootId=${root}`))).items;
    expect(replies.map((r) => r.body)).not.toContain('ROOTGONE-CANARY reply');
    // the draft is in the channel's list (with its thread root), so the channel's strip shows it; it can be dismissed
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${m.id}`));
  });

  it('an author who was suspended meanwhile is refused (the post door checks the person again)', async () => {
    const m = ScheduledMessage.parse(ok(await schedule(rafi, dev, { body: 'SUSPENDED-CANARY text', sendAt: at(5) }), 201));
    await w.system((tx) => tx.query("UPDATE app.people SET status = 'suspended' WHERE id = $1", [rafi.personId]));
    try {
      await runAt(10);
    } finally {
      await w.system((tx) => tx.query("UPDATE app.people SET status = 'active' WHERE id = $1", [rafi.personId]));
    }
    expect(await messages(nadia, dev)).not.toContain('SUSPENDED-CANARY text');
    const row = await rowOf(m.id);
    expect(row).toMatchObject({ state: 'refused' });
    expect(row?.refused_reason).toBeTruthy();
    ok(await w.call(rafi, 'DELETE', `/api/channels/${dev}/scheduled-messages/${m.id}`));
  });

  it('a failure that is not the author\'s is tried again each minute, counted, and refused with a plain sentence on the third; an edit starts it over', async () => {
    // a test-only trigger makes the insert of this one text fail with a database error (not a refusal)
    await ownerSql(
      w.server.db.ownerUrl,
      `CREATE FUNCTION app.sched_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
       CREATE TRIGGER sched_test_fail BEFORE INSERT ON app.messages FOR EACH ROW WHEN (NEW.body = 'FAIL-CANARY') EXECUTE FUNCTION app.sched_test_fail();`,
    );
    try {
      const m = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'FAIL-CANARY', sendAt: at(5) }), 201));
      await runAt(10);
      expect(await rowOf(m.id)).toMatchObject({ state: 'scheduled', attempts: 1 });
      await runAt(11);
      expect(await rowOf(m.id)).toMatchObject({ state: 'scheduled', attempts: 2 });
      expect((await changes(m.id)).map((e) => e.change)).toEqual(['scheduled']);
      await runAt(12);
      const last = await rowOf(m.id);
      expect(last).toMatchObject({ state: 'refused', attempts: 3 });
      expect(last?.refused_reason).toMatch(/Something went wrong/);
      expect((await changes(m.id)).map((e) => e.change)).toEqual(['scheduled', 'refused']);
      // once the cause is gone, editing schedules it again from the start
      await ownerSql(w.server.db.ownerUrl, 'DROP TRIGGER sched_test_fail ON app.messages');
      ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/scheduled-messages/${m.id}`, { sendAt: at(20) }));
      expect(await rowOf(m.id)).toMatchObject({ state: 'scheduled', attempts: 0 });
      await runAt(40);
      expect(await messages(rafi, dev)).toContain('FAIL-CANARY');
    } finally {
      await ownerSql(w.server.db.ownerUrl, 'DROP TRIGGER IF EXISTS sched_test_fail ON app.messages; DROP FUNCTION IF EXISTS app.sched_test_fail()');
    }
  });
});

describe('an edit or a cancel racing the job', () => {
  it('a row held by an edit or a cancel in progress is skipped by the job; what the edit or cancel decides then stands', async () => {
    const edited = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'RACE-EDIT-CANARY', sendAt: at(5) }), 201));
    const cancelled = ScheduledMessage.parse(ok(await schedule(nadia, dev, { body: 'RACE-CANCEL-CANARY', sendAt: at(5) }), 201));
    // this transaction stands for the edit and the cancel being in the middle of their work: it holds both rows' locks while the job runs
    await w.system(async (tx) => {
      await tx.query('SELECT id FROM app.scheduled_messages WHERE id = ANY ($1::uuid[]) FOR UPDATE', [[edited.id, cancelled.id]]);
      await runAt(10);
      await tx.query("UPDATE app.scheduled_messages SET send_at = now() + interval '3 hours' WHERE id = $1", [edited.id]);
      await tx.query('DELETE FROM app.scheduled_messages WHERE id = $1', [cancelled.id]);
    });
    expect(await messages(rafi, dev)).not.toContain('RACE-EDIT-CANARY');
    expect(await messages(rafi, dev)).not.toContain('RACE-CANCEL-CANARY');
    expect(await rowOf(edited.id)).toMatchObject({ state: 'scheduled' });
    expect(await rowOf(cancelled.id)).toBeUndefined();
    // the next run finds the edited one not due, and sends nothing
    await runAt(10);
    expect(await messages(rafi, dev)).not.toContain('RACE-EDIT-CANARY');
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${edited.id}`));
  });
});

describe('a direct message (no team)', () => {
  it('can hold a scheduled message, which is sent into it, and its events carry a null team', async () => {
    const dm = await w.call<{ dm: { channel: { id: string } } }>(nadia, 'POST', '/api/dms', { personIds: [rafi.personId] });
    expect([200, 201]).toContain(dm.status);
    const ch = dm.body.dm.channel.id;
    const m = ScheduledMessage.parse(ok(await schedule(nadia, ch, { body: 'DM-CANARY hello', sendAt: at(5) }), 201));
    await runAt(10);
    expect(await messages(rafi, ch)).toContain('DM-CANARY hello');
    const events = await changes(m.id);
    expect(events.map((e) => e.change)).toEqual(['scheduled', 'sent']);
    expect(events.every((e) => e.teamId === null)).toBe(true);
  });
});
