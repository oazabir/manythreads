import { randomUUID } from 'node:crypto';
import { MessageDeletedPush, MessagePostedPush, ReactionChangedPush, ChannelCreatedPush } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type Persona, type World } from './world.ts';

const { omar, nadia, rafi, sameera, priya, lena } = personas;

interface Frame {
  type: string;
  id: string;
  payload: Record<string, unknown>;
}

/** A WebSocket signed in through the test-only dev header (a browser would carry the session cookie instead). */
class Socket {
  readonly frames: Frame[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => void this.frames.push(JSON.parse(String(e.data)) as Frame);
  }
  static async open(url: string, who: Persona, origin?: string): Promise<Socket> {
    const header = JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId });
    const headers: Record<string, string> = { 'x-manythreads-dev-actor': header, ...(origin ? { origin } : {}) };
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { headers } as never);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('socket failed to open'));
    });
    const s = new Socket(ws);
    // The server attaches the socket once it knows the person: a ping round trip proves the upgrade was handled, the short wait
    // lets the person lookup finish.
    ws.send(JSON.stringify({ type: 'ping', id: 'hello', payload: {} }));
    await s.waitFor((f) => f.type === 'pong');
    await new Promise((r) => setTimeout(r, 150));
    return s;
  }
  async waitFor(match: (f: Frame) => boolean, ms = 1_000): Promise<Frame | undefined> {
    const until = Date.now() + ms;
    for (;;) {
      const hit = this.frames.find(match);
      if (hit || Date.now() > until) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  close(): void {
    this.ws.close();
  }
}

let w: World;
let dev = '';
const sockets: Socket[] = [];
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
}, 180_000);
afterAll(async () => {
  for (const s of sockets) s.close();
  await w?.close();
});

const open = async (who: Persona): Promise<Socket> => {
  const s = await Socket.open(w.server.url, who);
  sockets.push(s);
  return s;
};
const post = (who: Persona, channelId: string, body: string, threadRootId: string | null = null) =>
  w.call<{ id: string }>(who, 'POST', `/api/channels/${channelId}/messages`, { channelId, body, threadRootId });

describe('who may open a socket', () => {
  it('a page of another origin gets its socket closed and no pushes; the same origin is fine', async () => {
    const header = JSON.stringify({ kind: 'person', id: rafi.actorId, workspaceId: rafi.workspaceId });
    const evil = new WebSocket(w.server.url.replace('http', 'ws') + '/ws', { headers: { 'x-manythreads-dev-actor': header, origin: 'http://evil.example' } } as never);
    const closed = await new Promise<number>((resolve, reject) => {
      evil.onclose = (e) => resolve(e.code);
      evil.onerror = () => resolve(-1);
      setTimeout(() => reject(new Error('the foreign-origin socket stayed open')), 3_000);
    });
    expect([1008, -1]).toContain(closed);
    const same = await Socket.open(w.server.url, rafi, w.server.url);
    sockets.push(same);
    await post(nadia, dev, 'for same-origin sockets');
    expect(await same.waitFor((f) => f.type === 'message.posted')).toBeDefined();
  });
});

describe('live pushes reach exactly the people who can see the channel', () => {
  it("Rafi sees Nadia's post within a second, in full; Priya (same team) too; Sameera and Lena do not", async () => {
    const [rSock, pSock, sSock, lSock] = await Promise.all([open(rafi), open(priya), open(sameera), open(lena)]);
    const started = Date.now();
    const sent = await post(nadia, dev, 'Merged the rollback fix');
    expect(sent.status).toBe(201);
    const frame = await rSock.waitFor((f) => f.type === 'message.posted');
    expect(frame, 'Rafi got no message.posted').toBeDefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    const push = MessagePostedPush.parse(frame?.payload);
    expect(push).toMatchObject({ channelId: dev, messageId: sent.body.id, threadRootId: null });
    expect(push.message).toMatchObject({ body: 'Merged the rollback fix', authorId: nadia.actorId, replyCount: 0, reactions: [] });
    expect(await pSock.waitFor((f) => f.type === 'message.posted')).toBeDefined();
    await new Promise((r) => setTimeout(r, 400));
    expect(sSock.frames.filter((f) => f.type !== 'pong')).toEqual([]);
    expect(lSock.frames.filter((f) => f.type !== 'pong')).toEqual([]);
  });

  it('a guest with a read grant gets that one channel, and only after the grant', async () => {
    const releases = await w.channelId('engineering', 'releases');
    const lSock = await open(lena);
    await post(nadia, releases, 'before the grant');
    await new Promise((r) => setTimeout(r, 300));
    expect(lSock.frames.filter((f) => f.type === 'message.posted')).toEqual([]);
    await w.system(async (tx) => {
      await tx.query(
        `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
         VALUES ($1, 'channel', $2, 'person', $3, 'read')`,
        [lena.workspaceId, releases, lena.personId],
      );
    });
    const sent = await post(nadia, releases, 'after the grant');
    const frame = await lSock.waitFor((f) => f.type === 'message.posted');
    expect(MessagePostedPush.parse(frame?.payload).messageId).toBe(sent.body.id);
    await post(nadia, dev, 'not for Lena');
    await new Promise((r) => setTimeout(r, 300));
    expect(lSock.frames.filter((f) => f.type === 'message.posted')).toHaveLength(1);
  });

  it('a private channel pushes only to its members; a rolled-back post pushes nothing', async () => {
    const created = await w.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'leads-live', private: true });
    const id = created.body.channel.id;
    const [oSock, nSock] = await Promise.all([open(omar), open(nadia)]);
    const sent = await post(omar, id, 'only leads');
    expect(sent.status).toBe(201);
    expect(await oSock.waitFor((f) => f.type === 'message.posted' && (f.payload as { channelId?: string }).channelId === id)).toBeDefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(nSock.frames.filter((f) => (f.payload as { channelId?: string }).channelId === id)).toEqual([]);
    const before = oSock.frames.length;
    expect((await w.call(omar, 'POST', `/api/channels/${id}/messages`, { channelId: id, body: '', threadRootId: null })).status).toBe(400);
    expect((await post(omar, id, 'x', randomUUID())).status).toBe(404);
    await new Promise((r) => setTimeout(r, 300));
    expect(oSock.frames.length).toBe(before);
  });

  it('edits, deletes, reactions and new channels are pushed too', async () => {
    const rSock = await open(rafi);
    const sent = await post(nadia, dev, 'v1');
    await rSock.waitFor((f) => f.type === 'message.posted' && (f.payload as { messageId?: string }).messageId === sent.body.id);
    await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${sent.body.id}`, { body: 'v2' });
    const edited = await rSock.waitFor((f) => f.type === 'message.edited');
    expect(MessagePostedPush.parse(edited?.payload).message?.body).toBe('v2');
    await w.call(rafi, 'POST', `/api/channels/${dev}/messages/${sent.body.id}/reactions`, { emoji: '👍' });
    const reaction = await rSock.waitFor((f) => f.type === 'reaction.changed');
    expect(ReactionChangedPush.parse(reaction?.payload)).toMatchObject({ messageId: sent.body.id, emoji: '👍', added: true, count: 1, actorId: rafi.actorId });
    await w.call(nadia, 'DELETE', `/api/channels/${dev}/messages/${sent.body.id}`);
    const deleted = await rSock.waitFor((f) => f.type === 'message.deleted');
    expect(MessageDeletedPush.parse(deleted?.payload).messageId).toBe(sent.body.id);
    await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'live-new' });
    const channel = await rSock.waitFor((f) => f.type === 'channel.created');
    expect(ChannelCreatedPush.parse(channel?.payload).channel.name).toBe('live-new');
  });
});
