import { ListDraftsResponse, SaveDraftResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type Persona, type World } from './world.ts';

// P14-02: drafts kept on the server, one per person and box (the channel's own, or one thread's reply box).
const { omar, nadia, rafi, lena } = personas;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let w: World;
let dev = '';
let releases = '';
let root = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  releases = await w.channelId('engineering', 'releases');
  root = (await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'a thread to answer', threadRootId: null })).body.id;
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const save = (who: Persona, channelId: string, text: string, threadRootId?: string) =>
  w.call<unknown>(who, 'PUT', `/api/channels/${channelId}/draft`, { body: text, ...(threadRootId ? { threadRootId } : {}) });
const list = async (who: Persona, channelId: string) => ListDraftsResponse.parse(ok(await w.call(who, 'GET', `/api/channels/${channelId}/drafts`))).items;

describe('drafts on the server', () => {
  it('saves a channel box and a thread box separately, and lists them for the owner only', async () => {
    const a = SaveDraftResponse.parse(ok(await save(nadia, dev, 'half a thought'))).draft;
    expect(a).toMatchObject({ channelId: dev, threadRootId: null, body: 'half a thought' });
    ok(await save(nadia, dev, 'a reply in progress', root));
    const mine = await list(nadia, dev);
    expect(mine.map((d) => d.body).sort()).toEqual(['a reply in progress', 'half a thought']);
    expect(mine.find((d) => d.threadRootId === root)?.body).toBe('a reply in progress');
    expect(await list(rafi, dev)).toEqual([]);
    expect(await list(omar, dev)).toEqual([]);
  });

  it('saving again replaces the text in the same box', async () => {
    expect(SaveDraftResponse.parse(ok(await save(nadia, dev, 'v1'))).draft?.body).toBe('v1');
    expect(SaveDraftResponse.parse(ok(await save(nadia, dev, 'v2'))).draft?.body).toBe('v2');
    expect((await list(nadia, dev)).filter((d) => d.threadRootId === null).map((d) => d.body)).toEqual(['v2']);
  });

  it('another device of the same person reads it (same person, fresh request)', async () => {
    expect((await list(nadia, dev)).some((d) => d.body === 'v2')).toBe(true);
  });

  it('sending a message clears the draft of that box and leaves the other box alone', async () => {
    ok(await w.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'v2', threadRootId: null }), 201);
    const left = await list(nadia, dev);
    expect(left.map((d) => d.threadRootId)).toEqual([root]);
    ok(await w.call(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'the reply', threadRootId: root }), 201);
    expect(await list(nadia, dev)).toEqual([]);
  });

  it('an empty or blank text clears the box, and the delete route does too', async () => {
    ok(await save(nadia, dev, 'something'));
    expect(SaveDraftResponse.parse(ok(await save(nadia, dev, '   '))).draft).toBeNull();
    expect(await list(nadia, dev)).toEqual([]);
    ok(await save(nadia, dev, 'again', root));
    expect(ok(await w.call<{ deleted: boolean }>(nadia, 'DELETE', `/api/channels/${dev}/draft?threadRootId=${root}`))).toEqual({ deleted: true });
    expect(ok(await w.call<{ deleted: boolean }>(nadia, 'DELETE', `/api/channels/${dev}/draft?threadRootId=${root}`))).toEqual({ deleted: false });
  });

  it('refuses a draft where the person may not post, in a message that is not a thread start, and a text over the limit', async () => {
    expect((await save(lena, releases, 'guest draft')).status).toBe(403);
    expect((await save(nadia, dev, 'x', '019a0000-0000-7000-8000-000000000000')).status).toBe(404);
    const reply = ok(await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'inside', threadRootId: root }), 201).id;
    expect((await save(nadia, dev, 'x', reply)).status).toBe(400);
    expect((await save(nadia, dev, 'x'.repeat(40_001))).status).toBe(400);
  });

  it('a null character is refused with a plain sentence, never a server error, and nothing is saved', async () => {
    const res = await save(nadia, dev, 'half\u0000a thought');
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/null character/);
    expect((await list(nadia, dev)).some((d) => d.body.includes('half'))).toBe(false);
  });

  it('a person who is outside the workspace gets no list', async () => {
    expect((await w.call(null, 'GET', `/api/channels/${dev}/drafts`)).status).toBe(401);
  });

  it('a draft is not an event: nothing is announced', async () => {
    const before = (await w.system((tx) => tx.query("SELECT 1 FROM app.events WHERE type LIKE 'channel.%draft%'"))).rows.length;
    ok(await save(nadia, dev, 'quiet'));
    const after = (await w.system((tx) => tx.query("SELECT 1 FROM app.events WHERE type LIKE 'channel.%draft%'"))).rows.length;
    expect(after).toBe(before);
    ok(await w.call(nadia, 'DELETE', `/api/channels/${dev}/draft`));
  });
});
