import { randomUUID } from 'node:crypto';
import { createReadStateService, withActor } from '@manythreads/kernel';
import { GetReadStateResponse, MarkReadResponse, GetUnreadSummaryResponse } from '@manythreads/shared';
import { createPersonas, personaActor, personas, startTestServer, type Persona, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { nadia, rafi, priya } = personas;

let server: TestServer;
/** Messages by channel, newest last: the counter below stands in for the channels plugin. */
const messages = new Map<string, string[]>();

beforeAll(async () => {
  server = await startTestServer();
  await createPersonas(server.db);
  server.host.registries.unreadCounters.set('channel', {
    plugin: 'test',
    counter: (_tx, target, after) => Promise.resolve((messages.get(target.targetId) ?? []).filter((id) => id > after).length),
  });
}, 120_000);
afterAll(async () => {
  await server?.close();
});

const call = async (who: Persona | null, method: string, path: string, body?: unknown) => {
  const headers: Record<string, string> = {};
  if (who) headers['x-manythreads-dev-actor'] = JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId });
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${server.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as unknown };
};

/** `author` posts to `channel`; the other people listed get an unread. */
async function post(channel: string, author: Persona, recipients: Persona[]): Promise<string> {
  const svc = createReadStateService({ counters: server.host.registries.unreadCounters });
  return withActor(
    personaActor(author),
    async (tx) => {
      const id = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]?.id ?? '';
      messages.set(channel, [...(messages.get(channel) ?? []), id]);
      await svc.onPosted(tx as never, { targetType: 'channel', targetId: channel, messageId: id, authorId: author.actorId, recipientPersonIds: recipients.map((p) => p.personId) });
      return id;
    },
    { pool: server.pools.app },
  );
}

describe('GET /api/read-state', () => {
  it('needs a signed-in person', async () => {
    expect((await call(null, 'GET', `/api/read-state?targets=channel:${randomUUID()}`)).status).toBe(401);
    expect((await call(null, 'GET', '/api/read-state/summary')).status).toBe(401);
    expect((await call(null, 'POST', '/api/read-state/mark', {})).status).toBe(401);
  });

  it("answers one entry per target in order: the caller's own counters, zeros for the rest", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await post(a, rafi, [nadia, priya]);
    await post(a, rafi, [nadia]);
    const res = await call(nadia, 'GET', `/api/read-state?targets=channel:${b},channel:${a}`);
    expect(res.status).toBe(200);
    const { states } = GetReadStateResponse.parse(res.body);
    expect(states.map((s) => [s.targetId, s.unreadCount])).toEqual([[b, 0], [a, 2]]);
    const priyaStates = GetReadStateResponse.parse((await call(priya, 'GET', `/api/read-state?targets=channel:${a}`)).body).states;
    expect(priyaStates[0]?.unreadCount).toBe(1);
  });

  it('rejects a malformed or oversized targets list with 400', async () => {
    for (const q of ['', 'targets=', 'targets=channel:nope', `targets=dm:${randomUUID()}`, 'targets=' + Array.from({ length: 101 }, () => `channel:${randomUUID()}`).join(','), `targets=channel:${randomUUID()}&x=1`]) {
      const res = await call(nadia, 'GET', `/api/read-state?${q}`);
      expect(res.status, q).toBe(400);
    }
  });
});

describe('POST /api/read-state/mark', () => {
  it('marks the caller read up to a message, monotonic, and the summary follows', async () => {
    const ch = randomUUID();
    const [m1, m2, m3] = [await post(ch, rafi, [nadia]), await post(ch, rafi, [nadia]), await post(ch, rafi, [nadia])] as [string, string, string];
    const mark = (upTo: string) => call(nadia, 'POST', '/api/read-state/mark', { targetType: 'channel', targetId: ch, upTo });
    const r1 = await mark(m2);
    expect(r1.status).toBe(200);
    expect(MarkReadResponse.parse(r1.body)).toMatchObject({ lastReadId: m2, unreadCount: 1 });
    expect(MarkReadResponse.parse((await mark(m1)).body)).toMatchObject({ lastReadId: m2, unreadCount: 1 }); // older: unchanged
    expect(MarkReadResponse.parse((await mark(m3)).body)).toMatchObject({ lastReadId: m3, unreadCount: 0 });
    const summary = GetUnreadSummaryResponse.parse((await call(nadia, 'GET', '/api/read-state/summary')).body);
    expect(summary.channels.map((c) => c.channelId)).not.toContain(ch);
  });

  it("never touches someone else's state", async () => {
    const ch = randomUUID();
    const m1 = await post(ch, nadia, [rafi]);
    await call(priya, 'POST', '/api/read-state/mark', { targetType: 'channel', targetId: ch, upTo: m1 });
    const rafiState = GetReadStateResponse.parse((await call(rafi, 'GET', `/api/read-state?targets=channel:${ch}`)).body).states[0];
    expect(rafiState).toMatchObject({ unreadCount: 1, lastReadId: null });
  });

  it('is strict about its body (400) and says so when nothing can count the target (501)', async () => {
    const ch = randomUUID();
    expect((await call(nadia, 'POST', '/api/read-state/mark', { targetType: 'channel', targetId: ch, upTo: randomUUID(), extra: 1 })).status).toBe(400);
    expect((await call(nadia, 'POST', '/api/read-state/mark', { targetType: 'channel', targetId: 'nope', upTo: randomUUID() })).status).toBe(400);
    expect((await call(nadia, 'POST', '/api/read-state/mark', { targetType: 'dm', targetId: ch, upTo: randomUUID() })).status).toBe(400);
    // The channels plugin registers the `thread` counter; take it away to see what a target nobody can count answers.
    server.host.registries.unreadCounters.delete('thread');
    const noCounter = await call(nadia, 'POST', '/api/read-state/mark', { targetType: 'thread', targetId: ch, upTo: randomUUID() });
    expect(noCounter.status).toBe(501);
  });

  it('pushes the change to the person over their socket', async () => {
    const ch = randomUUID();
    const frames: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws`, {
      headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: nadia.actorId, workspaceId: nadia.workspaceId }) },
    } as never);
    ws.addEventListener('message', (e) => frames.push(JSON.parse(String(e.data))));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('socket failed')));
    });
    // the server attaches the socket once it knows the person; give it a moment
    await expect.poll(() => server.app.realtime.connections(nadia.personId), { timeout: 5_000 }).toBe(1);
    const m1 = await post(ch, rafi, [nadia, priya]);
    await expect.poll(() => frames.length, { timeout: 5_000 }).toBe(1);
    expect(frames[0]).toMatchObject({ type: 'reading.state.changed', payload: { targetId: ch, unreadCount: 1, reason: 'posted' } });
    await call(nadia, 'POST', '/api/read-state/mark', { targetType: 'channel', targetId: ch, upTo: m1 });
    await expect.poll(() => frames.length, { timeout: 5_000 }).toBe(2);
    expect(frames[1]?.payload).toMatchObject({ unreadCount: 0, lastReadId: m1, reason: 'read' });
    ws.close();
    await expect.poll(() => server.app.realtime.connections(nadia.personId), { timeout: 5_000 }).toBe(0);
  });
});
