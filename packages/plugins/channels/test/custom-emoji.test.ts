import { AddCustomEmojiResponse, CUSTOM_EMOJI_MAX_BYTES, ListCustomEmojiResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type Persona, type World } from './world.ts';

// P14-02: custom emoji. Admins add and remove pictures; everyone in the workspace lists them and fetches the picture.
const { omar, nadia, lena } = personas;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const png = (extra = 0): Buffer => Buffer.concat([PNG_HEAD, Buffer.alloc(extra, 7)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(20, 1)]);
const body = (name: string, bytes: Buffer, contentType = 'image/png') => ({ name, contentType, data: bytes.toString('base64') });
const add = (who: Persona, name: string, bytes: Buffer = png(), contentType = 'image/png') => w.call<AddCustomEmojiResponse & { error?: { code: string; message: string } }>(who, 'POST', '/api/custom-emoji', body(name, bytes, contentType));
const ok = <T>(res: ApiResult<T>, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const list = async (who: Persona) => ListCustomEmojiResponse.parse(ok(await w.call(who, 'GET', '/api/custom-emoji'))).items;
const events = (name: string): Promise<string[]> =>
  w.system(async (tx) => (await tx.query<{ change: string }>("SELECT payload->>'change' AS change FROM app.events WHERE type = 'channel.custom_emoji.changed' AND payload->>'name' = $1 ORDER BY id", [name])).rows.map((r) => r.change));

/** Removes the pictures a test added for its own purpose, so the next one starts from `party_parrot` and `wave`. */
const tidy = async (): Promise<void> => {
  for (const e of await list(omar)) if (e.name !== 'party_parrot' && e.name !== 'wave') ok(await w.call(omar, 'DELETE', `/api/custom-emoji/${e.id}`));
};

describe('custom emoji', () => {
  let id = '';

  it('an admin adds one: it is listed for everybody, a guest too, and the add is an event', async () => {
    const res = ok(await add(omar, 'party_parrot'), 201);
    id = res.id;
    expect(res).toMatchObject({ name: 'party_parrot', contentType: 'image/png' });
    expect(res).not.toHaveProperty('bytes');
    for (const p of [omar, nadia, lena]) expect((await list(p)).map((e) => e.name), p.name).toEqual(['party_parrot']);
    expect(await events('party_parrot')).toEqual(['added']);
  });

  it('a member cannot add or remove; nothing changes', async () => {
    expect((await add(nadia, 'sneaky')).status).toBe(403);
    expect((await w.call(nadia, 'DELETE', `/api/custom-emoji/${id}`)).status).toBe(403);
    expect((await list(nadia)).length).toBe(1);
  });

  it('refuses a duplicate name with a sentence, and names that are not safe', async () => {
    const dup = await add(omar, 'party_parrot');
    expect(dup.status).toBe(409);
    expect(dup.body.error?.message).toMatch(/already a custom emoji/);
    for (const bad of ['Party', 'a', '9lives', 'with-dash', 'with space', 'x'.repeat(33), '']) expect((await add(omar, bad)).status, bad).toBe(400);
  });

  it('refuses a picture by its bytes, not its label: wrong type, text, SVG, a mismatch, too big', async () => {
    expect((await add(omar, 'not_a_picture', Buffer.from('hello there, I am text'))).status).toBe(400);
    expect((await add(omar, 'svg_one', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).status).toBe(400);
    const mismatch = await add(omar, 'wrong_label', GIF, 'image/png');
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error?.message).toMatch(/image\/gif/);
    expect((await add(omar, 'too_big', png(CUSTOM_EMOJI_MAX_BYTES))).status).toBe(400);
    expect((await list(omar)).map((e) => e.name)).toEqual(['party_parrot']);
  });

  it('accepts a GIF as a GIF', async () => {
    ok(await add(omar, 'wave', GIF, 'image/gif'), 201);
    expect((await list(omar)).map((e) => e.name)).toEqual(['party_parrot', 'wave']);
  });

  it('refuses a picture bigger than 512 by 512 pixels, whatever its kind, and takes 512 by 512', async () => {
    const pngSized = (width: number, height: number): Buffer => {
      const b = Buffer.from(png());
      b.writeUInt32BE(width, 16);
      b.writeUInt32BE(height, 20);
      return b;
    };
    const tooWide = await add(omar, 'wide_png', pngSized(513, 10));
    expect(tooWide.status).toBe(400);
    expect(tooWide.body.error?.message).toMatch(/513 by 10 pixels/);
    expect((await add(omar, 'tall_png', pngSized(10, 4000))).status).toBe(400);
    ok(await add(omar, 'max_png', pngSized(512, 512)), 201);

    const gifSized = (width: number, height: number): Buffer => {
      const b = Buffer.from(GIF);
      b.writeUInt16LE(width, 6);
      b.writeUInt16LE(height, 8);
      return b;
    };
    expect((await add(omar, 'wide_gif', gifSized(600, 20), 'image/gif')).status).toBe(400);

    const webp = (width: number, height: number): Buffer => {
      const head = Buffer.alloc(30);
      head.write('RIFF', 0, 'latin1');
      head.writeUInt32LE(22, 4);
      head.write('WEBPVP8X', 8, 'latin1');
      head.writeUInt32LE(10, 16);
      head.writeUIntLE(width - 1, 24, 3);
      head.writeUIntLE(height - 1, 27, 3);
      return head;
    };
    expect((await add(omar, 'wide_webp', webp(2000, 2000), 'image/webp')).status).toBe(400);
    ok(await add(omar, 'small_webp', webp(64, 64), 'image/webp'), 201);

    const jpeg = (width: number, height: number): Buffer => {
      const b = Buffer.from('ffd8ffc00011080000000003011100021101031101', 'hex');
      b.writeUInt16BE(height, 7);
      b.writeUInt16BE(width, 9);
      return b;
    };
    expect((await add(omar, 'wide_jpeg', jpeg(700, 100), 'image/jpeg')).status).toBe(400);
    ok(await add(omar, 'small_jpeg', jpeg(64, 64), 'image/jpeg'), 201);
    await tidy();
  });

  it('refuses a picture whose size cannot be read', async () => {
    const noHeader = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(30, 9)]);
    const res = await add(omar, 'no_header', noHeader);
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/could not be read/);
  });

  it('caps the frames of an animation at 100', async () => {
    const gifFrames = (frames: number): Buffer => {
      const head = Buffer.alloc(13); // signature, width, height, flags (no colour table), background, aspect
      head.write('GIF89a', 0, 'latin1');
      head.writeUInt16LE(10, 6);
      head.writeUInt16LE(10, 8);
      const frame = Buffer.from('2c000000000a000a0000' + '02' + '010000', 'hex'); // one image: descriptor, code size 2, one data block, end
      return Buffer.concat([head, ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
    };
    ok(await add(omar, 'hundred_frames', gifFrames(100), 'image/gif'), 201);
    const many = await add(omar, 'many_frames', gifFrames(101), 'image/gif');
    expect(many.status).toBe(400);
    expect(many.body.error?.message).toMatch(/more than 100 frames/);
    await tidy();
  });

  it('serves the picture with safe headers, revalidates every time and answers 304 to a matching tag', async () => {
    const res = await fetch(`${w.server.url}/api/custom-emoji/${id}/image`, { headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: nadia.actorId, workspaceId: nadia.workspaceId }) } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    // kept by the browser but asked again each time (the tag answers 304), so a removed emoji stops being served at once
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(Buffer.from(await res.arrayBuffer()).equals(png())).toBe(true);
    const etag = res.headers.get('etag')!;
    const again = await fetch(`${w.server.url}/api/custom-emoji/${id}/image`, {
      headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: nadia.actorId, workspaceId: nadia.workspaceId }), 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
  });

  it('a stranger to the workspace, and an unknown id, get nothing', async () => {
    expect((await w.call(null, 'GET', `/api/custom-emoji/${id}/image`)).status).toBe(401);
    expect((await w.call(nadia, 'GET', '/api/custom-emoji/019a0000-0000-7000-8000-000000000000/image')).status).toBe(404);
  });

  it('an admin removes one: it is gone from the list and the removal is an event', async () => {
    expect(ok(await w.call<{ deleted: boolean }>(omar, 'DELETE', `/api/custom-emoji/${id}`))).toEqual({ deleted: true });
    expect((await list(nadia)).map((e) => e.name)).toEqual(['wave']);
    expect(await events('party_parrot')).toEqual(['added', 'deleted']);
    expect(ok(await w.call<{ deleted: boolean }>(omar, 'DELETE', `/api/custom-emoji/${id}`))).toEqual({ deleted: false });
    expect(await events('party_parrot')).toEqual(['added', 'deleted']);
  });

  it('the name can be used again after a removal', async () => {
    ok(await add(omar, 'party_parrot'), 201);
  });

  it('a reaction with :name: is accepted and summarised like any other emoji', async () => {
    await ensureChannels(w);
    const dev = await w.channelId('engineering', 'dev');
    const sent = ok(await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${dev}/messages`, { channelId: dev, body: 'ship it :party_parrot:', threadRootId: null }), 201);
    const res = ok(await w.call<{ reactions: Array<{ emoji: string; count: number }> }>(omar, 'POST', `/api/channels/${dev}/messages/${sent.id}/reactions`, { emoji: ':party_parrot:' }), 200);
    expect(JSON.stringify(res)).toContain(':party_parrot:');
  });
});
