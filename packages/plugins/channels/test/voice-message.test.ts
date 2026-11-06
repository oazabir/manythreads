import { ChannelMessage, FileMeta, SearchResponse, voiceFallbackBody, type VoiceMeta } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, ensureChannels, personas, type ApiResult, type FilesWorld } from '../../files/test/world.ts';

// Voice messages (P14-17): the clip is a file attached to the message, `meta.voice` names it, the body is the transcript. The server checks the
// shape (one audio attachment of the author's own in this channel, at most five minutes), refuses guests, and marks an edited transcript.

const { nadia, rafi, lena } = personas;

let w: FilesWorld;
let dev = '';
let releases = '';
beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
  releases = await w.channelId('engineering', 'releases');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
// What a browser's recording starts with: an EBML header (WebM), then some bytes. It sniffs as a video; the declared audio type must win.
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('opus clip bytes')]);
const PDF = Buffer.from('%PDF-1.7\n% not audio\n');
const clip = async (who: typeof nadia, channel: string, name = 'voice.webm'): Promise<FileMeta> =>
  FileMeta.parse(ok(await w.upload(who, channel, WEBM, { name, type: 'audio/webm;codecs=opus' }), 201));
const voiceFor = (fileId: string, over: Partial<VoiceMeta> = {}): VoiceMeta => ({ fileId, durationMs: 42_000, language: 'en', transcript: 'device', peaks: [0, 10, 255], ...over }) as VoiceMeta;
const send = (who: typeof nadia, channel: string, over: Record<string, unknown>): Promise<ApiResult> =>
  w.call(who, 'POST', `/api/channels/${channel}/messages`, { channelId: channel, body: 'This is a test voice message.', threadRootId: null, ...over });

describe('posting a voice message', () => {
  it('stores the clip as audio, the body as the transcript and meta.voice beside the attachment', async () => {
    const f = await clip(nadia, dev);
    expect(f.mime).toBe('audio/webm');
    const posted = ok<{ id: string; body: string; meta: { attachments?: string[]; voice?: VoiceMeta } }>(
      await send(nadia, dev, { attachments: [f.id], voice: voiceFor(f.id) }),
      201,
    );
    expect(posted.body).toBe('This is a test voice message.');
    expect(posted.meta.attachments).toEqual([f.id]);
    expect(posted.meta.voice).toEqual(voiceFor(f.id));
    // the same shape comes back from the list, with the clip's card
    const list = ok<{ items: ChannelMessage[] }>(await w.call(rafi, 'GET', `/api/channels/${dev}/messages`));
    const got = list.items.find((m) => m.id === posted.id)!;
    expect(got.meta.voice).toMatchObject({ fileId: f.id, durationMs: 42_000, transcript: 'device', language: 'en' });
    expect(got.attachments?.[0]).toMatchObject({ id: f.id, mime: 'audio/webm' });
  });

  it('works in a thread reply, and a clip with no transcript keeps the stand-in body', async () => {
    const root = ok<{ id: string }>(await send(nadia, dev, { body: 'voice thread root' }), 201);
    const f = await clip(nadia, dev, 'reply.webm');
    const body = voiceFallbackBody(42_000);
    expect(body).toBe('Voice message (0:42)');
    const reply = ok<{ body: string; threadRootId: string; meta: { voice?: VoiceMeta } }>(
      await send(nadia, dev, { body, threadRootId: root.id, attachments: [f.id], voice: voiceFor(f.id, { transcript: 'none', language: null }) }),
      201,
    );
    expect(reply).toMatchObject({ body, threadRootId: root.id });
    expect(reply.meta.voice).toMatchObject({ transcript: 'none', language: null });
  });

  it('refuses a guest, even one who may post in the channel (403), and records nothing', async () => {
    await w.grant(releases, lena, 'post');
    const f = FileMeta.parse(ok(await w.upload(lena, releases, WEBM, { name: 'guest.webm', type: 'audio/webm' }), 201));
    const res = await send(lena, releases, { attachments: [f.id], voice: voiceFor(f.id) });
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('Guests can play voice messages but not record them.');
    // the same guest can still post an ordinary message with the file
    expect((await send(lena, releases, { body: 'plain', attachments: [f.id] })).status).toBe(201);
    await w.revoke(releases, lena);
  });

  it('refuses a second attachment (409), none at all (409) and a voice.fileId that is not the attachment (400)', async () => {
    const a = await clip(nadia, dev, 'a.webm');
    const b = await clip(nadia, dev, 'b.webm');
    expect((await send(nadia, dev, { attachments: [a.id, b.id], voice: voiceFor(a.id) })).status).toBe(409);
    expect((await send(nadia, dev, { voice: voiceFor(a.id) })).status).toBe(409);
    expect((await send(nadia, dev, { attachments: [a.id], voice: voiceFor(b.id) })).status).toBe(400);
  });

  it('refuses a file that is not audio (400), a file of someone else and one from another channel', async () => {
    const pdf = FileMeta.parse(ok(await w.upload(nadia, dev, PDF, { name: 'not-audio.pdf', type: 'application/pdf' }), 201));
    expect((await send(nadia, dev, { attachments: [pdf.id], voice: voiceFor(pdf.id) })).status).toBe(400);
    const theirs = await clip(rafi, dev, 'rafi.webm');
    expect((await send(nadia, dev, { attachments: [theirs.id], voice: voiceFor(theirs.id) })).status).toBe(400);
    const elsewhere = await clip(nadia, releases, 'elsewhere.webm');
    expect((await send(nadia, dev, { attachments: [elsewhere.id], voice: voiceFor(elsewhere.id) })).status).toBe(400);
  });

  it('refuses a clip longer than five minutes, a too-short one, bad peaks and an unknown field (400)', async () => {
    const f = await clip(nadia, dev, 'long.webm');
    const bad = (voice: Record<string, unknown>) => send(nadia, dev, { attachments: [f.id], voice });
    expect((await bad({ ...voiceFor(f.id), durationMs: 300_001 })).status).toBe(400);
    expect((await bad({ ...voiceFor(f.id), durationMs: 100 })).status).toBe(400);
    expect((await bad({ ...voiceFor(f.id), peaks: Array.from({ length: 65 }, () => 1) })).status).toBe(400);
    expect((await bad({ ...voiceFor(f.id), peaks: [256] })).status).toBe(400);
    expect((await bad({ ...voiceFor(f.id), extra: true })).status).toBe(400);
    // exactly five minutes is allowed
    expect((await bad(voiceFor(f.id, { durationMs: 300_000 }))).status).toBe(201);
  });

  it('still needs a body, as any message does (400)', async () => {
    const f = await clip(nadia, dev, 'nobody.webm');
    expect((await send(nadia, dev, { body: '', attachments: [f.id], voice: voiceFor(f.id) })).status).toBe(400);
  });
});

describe('editing a voice message', () => {
  it('flips the transcript to "edited" and leaves the rest of meta.voice alone; a plain message gains no voice', async () => {
    const f = await clip(nadia, dev, 'edit.webm');
    const body = voiceFallbackBody(42_000);
    const posted = ok<{ id: string }>(await send(nadia, dev, { body, attachments: [f.id], voice: voiceFor(f.id, { transcript: 'none' }) }), 201);
    const msg = ok<ChannelMessage>(await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${posted.id}`, { body: 'Hello, here is what I said.' }));
    expect(msg.body).toBe('Hello, here is what I said.');
    expect(msg.meta.voice).toEqual({ ...voiceFor(f.id), transcript: 'edited' });
    expect(msg.meta.attachments).toEqual([f.id]);

    const plain = ok<{ id: string }>(await send(nadia, dev, { body: 'just text' }), 201);
    const after = ok<ChannelMessage>(await w.call(nadia, 'PATCH', `/api/channels/${dev}/messages/${plain.id}`, { body: 'just other text' }));
    expect(after.meta.voice).toBeUndefined();
  });
});

describe('finding a voice message', () => {
  it('search finds the message by a word of its transcript, as for any message', async () => {
    const f = await clip(nadia, dev, 'search.webm');
    const posted = ok<{ id: string }>(await send(nadia, dev, { body: 'Please review the quokkaplan before Friday.', attachments: [f.id], voice: voiceFor(f.id) }), 201);
    const found = SearchResponse.parse(ok(await w.call(rafi, 'GET', `/api/search?q=${encodeURIComponent('quokkaplan')}`)));
    expect(found.messages.map((m) => m.id)).toContain(posted.id);
  });
});
