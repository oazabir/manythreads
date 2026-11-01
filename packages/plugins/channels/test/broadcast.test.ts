import { enqueue } from '@manythreads/kernel';
import { TEAM_IDS } from '@manythreads/test-utils';
import { BroadcastReach } from '@manythreads/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mentionBudget } from '../src/mention-budget.ts';
import { createWorld, ensureChannels, eventually, personas, type ApiResult, type Persona, type World } from './world.ts';

// P14-02: @channel and @here tell the room; a room of more than 20 other readers makes the writer confirm.
const { omar, nadia, rafi, priya, lena } = personas;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let w: World;
let dev = '';
let releases = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  releases = await w.channelId('engineering', 'releases');
}, 180_000);
beforeEach(() => mentionBudget.reset());
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const send = (who: Persona, channelId: string, body: string, extra: Record<string, unknown> = {}) =>
  w.call<{ id: string; error?: { code: string; message: string } }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId: null, ...extra });
const mentioned = (messageId: string): Promise<string[]> =>
  w.system(async (tx) => (await tx.query<{ mentioned_id: string }>("SELECT mentioned_id FROM app.message_mentions WHERE message_id = $1 AND kind = 'person'", [messageId])).rows.map((r) => r.mentioned_id).sort());
const announced = (messageId: string): Promise<string[]> =>
  w.system(async (tx) => (await tx.query<{ id: string }>("SELECT payload->>'mentionedId' AS id FROM app.events WHERE type = 'channel.mention.created' AND payload->>'messageId' = $1", [messageId])).rows.map((r) => r.id).sort());
const reach = async (who: Persona, channelId: string) => BroadcastReach.parse(ok(await w.call(who, 'GET', `/api/channels/${channelId}/broadcast-reach`)));
const setOnline = (who: Persona, online: boolean): Promise<unknown> =>
  w.system(async (tx) => {
    await tx.query('DELETE FROM app.presence WHERE person_id = $1', [who.personId]);
    if (online) await tx.query("INSERT INTO app.presence (person_id, workspace_id, status, seen_at) VALUES ($1, $2, 'online', now())", [who.personId, who.workspaceId]);
  });
describe('@channel and @here in a small room', () => {
  it('@channel tells every reader but the author, once each, without any confirmation', async () => {
    const expected = (await reach(nadia, dev)).channel;
    expect(expected).toBeGreaterThan(1);
    const res = ok(await send(nadia, dev, 'Heads up @channel, the deploy is on'), 201);
    const told = await mentioned(res.id);
    expect(told.length).toBe(expected);
    expect(told).toContain(rafi.actorId);
    expect(told).not.toContain(nadia.actorId);
    expect(await announced(res.id)).toEqual(told);
  });

  it('@here tells only the readers with a fresh heartbeat', async () => {
    await setOnline(rafi, true);
    await setOnline(priya, false);
    try {
      const res = ok(await send(nadia, dev, '@here a quick look please'), 201);
      expect(await mentioned(res.id)).toContain(rafi.actorId);
      expect(await mentioned(res.id)).not.toContain(priya.actorId);
      expect(await mentioned(res.id)).not.toContain(nadia.actorId);
    } finally {
      await setOnline(rafi, false);
    }
  });

  it('the reach route counts both words for the caller', async () => {
    await setOnline(rafi, true);
    try {
      const r = await reach(nadia, dev);
      expect(r.confirmAbove).toBe(20);
      expect(r.channel).toBeGreaterThan(1);
      expect(r.here).toBe(1);
    } finally {
      await setOnline(rafi, false);
    }
  });

  it('a person who cannot read the channel gets the same refusal as for any channel route', async () => {
    const res = await w.call(lena, 'GET', `/api/channels/${dev}/broadcast-reach`);
    expect([403, 404]).toContain(res.status);
  });

  it('words inside code and in an email address tell nobody', async () => {
    const res = ok(await send(nadia, dev, 'Use `@channel` in code, mail me at x@here.example'), 201);
    expect(await mentioned(res.id)).toEqual([]);
  });

  it('an edit that adds the word tells the room once; an edit that keeps it tells nobody twice', async () => {
    const id = ok(await send(nadia, dev, 'plain text'), 201).id;
    expect(await mentioned(id)).toEqual([]);
    ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${id}`, { body: 'now @channel' }));
    const after = await mentioned(id);
    expect(after.length).toBeGreaterThan(1);
    const events = (await announced(id)).length;
    ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${id}`, { body: 'now @channel, reworded' }));
    expect(await mentioned(id)).toEqual(after);
    expect((await announced(id)).length).toBe(events);
    ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${id}`, { body: 'no word any more' }));
    expect(await mentioned(id)).toEqual([]);
  });

  it('a guest writing the words tells nobody', async () => {
    await w.system((tx) =>
      tx.query(
        `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
         VALUES ($1, 'channel', $2, 'person', $3, 'post')`,
        [omar.workspaceId, releases, lena.personId],
      ),
    );
    try {
      const res = ok(await send(lena, releases, 'hello @channel'), 201);
      expect(await mentioned(res.id)).toEqual([]);
      expect(await announced(res.id)).toEqual([]);
    } finally {
      await w.system((tx) => tx.query("DELETE FROM app.acl_entries WHERE resource_type = 'channel' AND subject_id = $1", [lena.personId]));
    }
  });
});

describe('a big room asks first', () => {
  beforeAll(async () => {
    // 24 more people in Engineering (direct inserts: the invitation flow is not under test), 22 of them online
    await w.system(async (tx) => {
      const ws = omar.workspaceId;
      await tx.query(`CREATE TEMP TABLE bc_ids AS SELECT gen_random_uuid() AS pid, gen_random_uuid() AS aid, g FROM generate_series(1, 24) g`);
      await tx.query(`INSERT INTO app.people (id, workspace_id, display_name, primary_email) SELECT pid, $1, 'Room ' || g, 'room' || g || '@room.example' FROM bc_ids`, [ws]);
      await tx.query(`INSERT INTO app.actors (id, kind, workspace_id, ref_id) SELECT aid, 'person', $1, pid FROM bc_ids`, [ws]);
      await tx.query(`INSERT INTO app.workspace_members (workspace_id, person_id, role) SELECT $1, pid, 'member' FROM bc_ids`, [ws]);
      await tx.query(`INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) SELECT $2, aid, $1, 'member' FROM bc_ids`, [ws, TEAM_IDS.Engineering]);
      await tx.query(`INSERT INTO app.presence (person_id, workspace_id, status, seen_at) SELECT pid, $1, 'online', now() FROM bc_ids WHERE g <= 22`, [ws]);
    });
  });

  it('the reach route reports the big numbers', async () => {
    const r = await reach(nadia, dev);
    expect(r.channel).toBeGreaterThan(20);
    expect(r.here).toBeGreaterThan(20);
  });

  it('@channel without confirmation is refused with a plain sentence, and nothing is written', async () => {
    const before = (await w.system((tx) => tx.query('SELECT 1 FROM app.messages WHERE channel_id = $1', [dev]))).rows.length;
    const res = await send(nadia, dev, 'Everyone @channel please read');
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('broadcast_needs_confirmation');
    expect(res.body.error?.message).toMatch(/Confirm to send it\.$/);
    expect(res.body.error?.message).toMatch(/@channel/);
    expect((await w.system((tx) => tx.query('SELECT 1 FROM app.messages WHERE channel_id = $1', [dev]))).rows.length).toBe(before);
  });

  it('with confirmBroadcast it goes out and tells the room', async () => {
    const res = ok(await send(nadia, dev, 'Everyone @channel please read', { confirmBroadcast: true }), 201);
    expect((await mentioned(res.id)).length).toBeGreaterThan(20);
    expect((await announced(res.id)).length).toBeGreaterThan(20);
  });

  it('@here is refused too while more than 20 people are online, and not once few are', async () => {
    expect((await send(nadia, dev, '@here anyone?')).status).toBe(409);
    await w.system((tx) => tx.query("DELETE FROM app.presence WHERE person_id IN (SELECT id FROM app.people WHERE primary_email LIKE 'room%@room.example')"));
    ok(await send(nadia, dev, '@here anyone around?'), 201);
  });

  it('an edit that adds the word is asked the same; one that only keeps it is not', async () => {
    const id = ok(await send(nadia, dev, 'before'), 201).id;
    const refused = await w.call<{ error?: { code: string } }>(nadia, 'PATCH', `/api/channels/${dev}/messages/${id}`, { body: 'before @channel' });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.code).toBe('broadcast_needs_confirmation');
    ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${id}`, { body: 'before @channel', confirmBroadcast: true }));
    ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${id}`, { body: 'before @channel, tidied' }));
  });

  it('a message with a person only, or a word inside code, is never asked', async () => {
    ok(await send(nadia, dev, 'thanks @rafi'), 201);
    ok(await send(nadia, dev, 'the `@channel` word'), 201);
  });
});

describe('a scheduled message that names the room is agreed when it is scheduled', () => {
  const FAR = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();
  const schedule = (who: Persona, body: string, extra: Record<string, unknown> = {}) =>
    w.call<{ id: string; state: string; error?: { code: string; message: string } }>(who, 'POST', `/api/channels/${dev}/scheduled-messages`, { body, sendAt: FAR(30), ...extra });
  const scheduledRows = async (): Promise<number> => (await w.system((tx) => tx.query("SELECT 1 FROM app.scheduled_messages WHERE body LIKE 'SCHED %'"))).rows.length;
  const confirmedFlag = async (id: string): Promise<boolean> => (await w.system((tx) => tx.query<{ c: boolean }>('SELECT broadcast_confirmed AS c FROM app.scheduled_messages WHERE id = $1', [id]))).rows[0]!.c;
  const makeDue = (id: string): Promise<unknown> => w.system((tx) => tx.query("UPDATE app.scheduled_messages SET send_at = now() - interval '1 minute' WHERE id = $1", [id]));
  const runJob = async (): Promise<void> => {
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
  const posted = async (marker: string): Promise<{ id: string }[]> =>
    (await w.system((tx) => tx.query<{ id: string }>('SELECT id FROM app.messages WHERE channel_id = $1 AND body LIKE $2 AND deleted_at IS NULL', [dev, `%${marker}%`]))).rows;

  it('without the agreement a big room is refused with the plain sentence, and nothing is scheduled', async () => {
    const before = await scheduledRows();
    const res = await schedule(nadia, 'SCHED one @channel please read');
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('broadcast_needs_confirmation');
    expect(res.body.error?.message).toMatch(/@channel will notify \d+ people\. Confirm to send it\.$/);
    expect(await scheduledRows()).toBe(before);
  });

  it('with the agreement it is kept, and the job posts it later and tells the room', async () => {
    const made = ok(await schedule(nadia, 'SCHED two @channel please read', { confirmBroadcast: true }), 201);
    expect(await confirmedFlag(made.id)).toBe(true);
    await makeDue(made.id);
    await runJob();
    const [msg] = await posted('SCHED two');
    expect(msg).toBeDefined();
    expect((await mentioned(msg!.id)).length).toBeGreaterThan(20);
    expect((await w.system((tx) => tx.query('SELECT 1 FROM app.scheduled_messages WHERE id = $1', [made.id]))).rows.length).toBe(0);
  });

  it('a text that names no room word needs no agreement and keeps no flag', async () => {
    const made = ok(await schedule(nadia, 'SCHED three thanks @rafi', { confirmBroadcast: true }), 201);
    expect(await confirmedFlag(made.id)).toBe(false);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${made.id}`));
  });

  it('an edit keeps the agreement for the same text, and asks again for a changed one', async () => {
    const made = ok(await schedule(nadia, 'SCHED four @channel', { confirmBroadcast: true }), 201);
    // only the time changes: the agreement stands
    ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/scheduled-messages/${made.id}`, { sendAt: FAR(45) }));
    expect(await confirmedFlag(made.id)).toBe(true);
    // the text changes: asked again
    const changed = await w.call<{ error?: { code: string } }>(nadia, 'PATCH', `/api/channels/${dev}/scheduled-messages/${made.id}`, { body: 'SCHED four @channel, changed' });
    expect(changed.status).toBe(409);
    expect(changed.body.error?.code).toBe('broadcast_needs_confirmation');
    expect(await confirmedFlag(made.id)).toBe(true);
    ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/scheduled-messages/${made.id}`, { body: 'SCHED four @channel, changed', confirmBroadcast: true }));
    // the room word is taken out: the flag goes with it
    ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/scheduled-messages/${made.id}`, { body: 'SCHED four, nobody told' }));
    expect(await confirmedFlag(made.id)).toBe(false);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${made.id}`));
  });

  it('a message scheduled when the room was small and found big at its time is refused with the sentence, not posted, and editing it asks again', async () => {
    // the row as an earlier, small room would have left it: no agreement kept
    const id = (
      await w.system((tx) =>
        tx.query<{ id: string }>(
          `INSERT INTO app.scheduled_messages (workspace_id, channel_id, author_id, team_id, body, send_at)
           VALUES ($1, $2, $3, $4, 'SCHED five @channel', now() - interval '1 minute') RETURNING id`,
          [nadia.workspaceId, dev, nadia.actorId, TEAM_IDS.Engineering],
        ),
      )
    ).rows[0]!.id;
    await runJob();
    expect(await posted('SCHED five')).toHaveLength(0);
    const row = (await w.system((tx) => tx.query<{ state: string; refused_reason: string }>('SELECT state, refused_reason FROM app.scheduled_messages WHERE id = $1', [id]))).rows[0]!;
    expect(row.state).toBe('refused');
    expect(row.refused_reason).toMatch(/@channel will notify \d+ people\./);
    const again = await w.call<{ error?: { code: string } }>(nadia, 'PATCH', `/api/channels/${dev}/scheduled-messages/${id}`, { sendAt: FAR(20) });
    expect(again.status).toBe(409);
    ok(await w.call(nadia, 'PATCH', `/api/channels/${dev}/scheduled-messages/${id}`, { sendAt: FAR(20), confirmBroadcast: true }));
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/scheduled-messages/${id}`));
  });

  it('a null character in a scheduled text is refused with a sentence, never a server error', async () => {
    const res = await schedule(nadia, 'SCHED six\u0000 hidden');
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/null character/);
  });
});

describe('a null character in a message', () => {
  it('a posted text is refused with a plain sentence, an edit too', async () => {
    const bad = await send(nadia, dev, 'before\u0000after');
    expect(bad.status).toBe(400);
    expect(bad.body.error?.message).toMatch(/null character/);
    const id = ok(await send(nadia, dev, 'fine text'), 201).id;
    const edit = await w.call<{ error?: { message: string } }>(nadia, 'PATCH', `/api/channels/${dev}/messages/${id}`, { body: 'oops\u0000' });
    expect(edit.status).toBe(400);
    expect(edit.body.error?.message).toMatch(/null character/);
  });
});
